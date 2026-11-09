//! Thin wrapper over the git CLI. Everything shells out to `git` so behaviour (ignore rules,
//! attributes, object formats) matches what the user's own git does.

use anyhow::{Context, Result, anyhow, bail};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Mutex, OnceLock};

#[derive(Debug)]
pub struct Git {
    pub root: PathBuf,
    empty_tree: OnceLock<String>,
}

fn base(root: &Path) -> Command {
    let mut c = Command::new("git");
    c.args(["-c", "core.quotepath=false", "-c", "color.ui=false"])
        .current_dir(root)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null());
    c
}

pub fn find_repo_root(start: &Path) -> Option<PathBuf> {
    let out = base(start).args(["rev-parse", "--show-toplevel"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(PathBuf::from(s)) }
}

pub type Entries = Vec<RawEntry>;

/// One line of `git diff-tree --raw`.
#[derive(Debug, Clone)]
pub struct RawEntry {
    pub status: char,
    pub old_mode: String,
    pub new_mode: String,
    pub old_blob: Option<String>,
    pub new_blob: Option<String>,
    pub path: String,
    pub old_path: Option<String>,
}

impl Git {
    pub fn new(root: PathBuf) -> Git {
        Git { root, empty_tree: OnceLock::new() }
    }

    pub fn cmd(&self) -> Command {
        base(&self.root)
    }

    pub fn run(&self, args: &[&str]) -> Result<String> {
        self.run_env(args, &[])
    }

    pub fn run_env(&self, args: &[&str], env: &[(&str, &str)]) -> Result<String> {
        let mut c = self.cmd();
        c.args(args);
        for (k, v) in env {
            c.env(k, v);
        }
        let out = c.output().with_context(|| "could not run git (is it installed?)")?;
        if !out.status.success() {
            bail!("git {} failed: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim());
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// Trimmed stdout, or None when the command fails or prints nothing.
    pub fn try_run(&self, args: &[&str]) -> Option<String> {
        let out = self.cmd().args(args).stderr(Stdio::null()).output().ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() { None } else { Some(s) }
    }

    pub fn rev_parse(&self, rev: &str) -> Option<String> {
        self.try_run(&["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")])
    }

    pub fn head(&self) -> Option<String> {
        self.rev_parse("HEAD")
    }

    pub fn current_branch(&self) -> Option<String> {
        self.try_run(&["symbolic-ref", "--short", "-q", "HEAD"])
    }

    pub fn default_branch(&self) -> Option<String> {
        if let Some(r) = self.try_run(&["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]) {
            return Some(r.trim_start_matches("refs/remotes/").to_string());
        }
        ["main", "master", "develop"]
            .into_iter()
            .find(|n| self.rev_parse(&format!("refs/heads/{n}")).is_some())
            .map(String::from)
    }

    pub fn merge_base(&self, a: &str, b: &str) -> Option<String> {
        self.try_run(&["merge-base", a, b])
    }

    pub fn commit_subject(&self, rev: &str) -> String {
        self.try_run(&["log", "-1", "--format=%s", rev]).unwrap_or_default()
    }

    /// The empty tree id for this repository's object format (SHA-1 or SHA-256).
    pub fn empty_tree(&self) -> String {
        self.empty_tree
            .get_or_init(|| {
                self.try_run(&["hash-object", "-t", "tree", "/dev/null"])
                    .unwrap_or_else(|| "4b825dc642cb6eb9a060e54bf8d69288fbee4904".into())
            })
            .clone()
    }

    fn index_path(&self) -> Result<PathBuf> {
        let p = self.run(&["rev-parse", "--git-path", "index"])?;
        Ok(self.root.join(p.trim()))
    }

    /// Run `f` with GIT_INDEX_FILE pointing at a private copy of the real index. The copy keeps
    /// git's stat cache warm (only changed files get re-hashed) and never touches the user's index.
    fn with_temp_index<T>(&self, f: impl FnOnce(&str) -> Result<T>) -> Result<T> {
        let tmp = std::env::temp_dir().join(format!("sift-index-{}-{}", std::process::id(), crate::util::short_id(8)));
        let idx = self.index_path()?;
        if idx.exists() {
            // Write a fresh file rather than fs::copy: copy keeps the old mtime, which makes git treat
            // every recently touched entry as "racily clean" and re-hash it (slow with LFS filters).
            std::fs::write(&tmp, std::fs::read(&idx)?).context("copying the git index")?;
        }
        let tmp_s = tmp.to_string_lossy().into_owned();
        let r = f(&tmp_s);
        let _ = std::fs::remove_file(&tmp);
        r
    }

    /// The whole working tree (tracked + untracked, honouring .gitignore) as a tree object.
    pub fn snapshot_tree(&self) -> Result<String> {
        self.with_temp_index(|idx| {
            let env = [("GIT_INDEX_FILE", idx)];
            self.run_env(&["add", "-A", "--", "."], &env)?;
            Ok(self.run_env(&["write-tree"], &env)?.trim().to_string())
        })
    }

    /// Tree of the staged changes. Written from a copy so the real index is not rewritten.
    pub fn index_tree(&self) -> Result<String> {
        self.with_temp_index(|idx| Ok(self.run_env(&["write-tree"], &[("GIT_INDEX_FILE", idx)])?.trim().to_string()))
    }

    /// Snapshot the working tree into a commit pinned under `refname` so gc never drops it.
    pub fn snapshot_commit(&self, refname: &str, message: &str) -> Result<String> {
        let tree = self.snapshot_tree()?;
        let head = self.head();
        let mut args = vec!["commit-tree", tree.as_str()];
        if let Some(h) = head.as_deref() {
            args.extend(["-p", h]);
        }
        args.extend(["-m", message]);
        let env = [
            ("GIT_AUTHOR_NAME", "sift"),
            ("GIT_AUTHOR_EMAIL", "sift@localhost"),
            ("GIT_COMMITTER_NAME", "sift"),
            ("GIT_COMMITTER_EMAIL", "sift@localhost"),
        ];
        let commit = self.run_env(&args, &env)?.trim().to_string();
        self.run(&["update-ref", refname, &commit])?;
        Ok(commit)
    }

    /// Changed paths between two tree-ishes, with blob ids and rename detection.
    pub fn diff_tree(&self, base: &str, head: &str) -> Result<Entries> {
        let out = self
            .cmd()
            .args(["diff-tree", "-r", "-z", "-M", "--raw", "--no-commit-id", base, head])
            .stderr(Stdio::piped())
            .output()?;
        if !out.status.success() {
            bail!("git diff-tree failed: {}", String::from_utf8_lossy(&out.stderr).trim());
        }
        Ok(parse_raw(&out.stdout))
    }

    pub fn blob_id(&self, rev: &str, path: &str) -> Option<String> {
        self.try_run(&["rev-parse", "--verify", "--quiet", &format!("{rev}:{path}")])
    }
}

fn is_null(sha: &str) -> bool {
    sha.bytes().all(|b| b == b'0')
}

pub fn parse_raw(out: &[u8]) -> Entries {
    let mut entries = Vec::new();
    let mut parts = out.split(|&b| b == 0).map(|p| String::from_utf8_lossy(p).into_owned());
    while let Some(head) = parts.next() {
        let Some(meta) = head.strip_prefix(':') else { continue };
        let f: Vec<&str> = meta.split(' ').collect();
        if f.len() < 5 {
            continue;
        }
        let status = f[4].chars().next().unwrap_or('M');
        let first = parts.next().unwrap_or_default();
        let (old_path, path) = if status == 'R' || status == 'C' {
            (Some(first), parts.next().unwrap_or_default())
        } else {
            (None, first)
        };
        let blob = |s: &str, mode: &str| (!is_null(s) && mode != "160000").then(|| s.to_string());
        entries.push(RawEntry {
            status,
            old_mode: f[0].into(),
            new_mode: f[1].into(),
            old_blob: blob(f[2], f[0]),
            new_blob: blob(f[3], f[1]),
            path,
            old_path,
        });
    }
    entries
}

/// A long-running `git cat-file --batch`: one process serves thousands of object reads.
pub struct CatFile {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl CatFile {
    pub fn spawn(root: &Path) -> Result<CatFile> {
        let mut child = base(root)
            .args(["cat-file", "--batch"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
        let stdout = BufReader::with_capacity(1 << 16, child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?);
        Ok(CatFile { child, stdin, stdout })
    }

    /// Read one object (`<sha>` or `<rev>:<path>`).
    pub fn read(&mut self, spec: &str) -> Result<Option<Vec<u8>>> {
        if spec.contains('\n') {
            return Ok(None);
        }
        writeln!(self.stdin, "{spec}")?;
        self.stdin.flush()?;
        read_reply(&mut self.stdout)
    }

    /// Read a handful of objects with one flush (requests are tiny, so the pipe never fills).
    pub fn read_few(&mut self, specs: &[&str]) -> Result<Vec<Option<Vec<u8>>>> {
        for s in specs {
            writeln!(self.stdin, "{s}")?;
        }
        self.stdin.flush()?;
        specs.iter().map(|_| read_reply(&mut self.stdout)).collect()
    }
}

fn read_reply(stdout: &mut BufReader<ChildStdout>) -> Result<Option<Vec<u8>>> {
    let mut header = String::new();
    if stdout.read_line(&mut header)? == 0 {
        bail!("git cat-file exited");
    }
    let h = header.trim_end();
    if h.ends_with(" missing") || h.ends_with(" ambiguous") {
        return Ok(None);
    }
    let mut f = h.rsplitn(3, ' ');
    let size: usize = f.next().and_then(|s| s.parse().ok()).ok_or_else(|| anyhow!("bad cat-file header: {h}"))?;
    let kind = f.next().unwrap_or("");
    let mut buf = vec![0u8; size + 1];
    stdout.read_exact(&mut buf)?;
    buf.truncate(size);
    Ok(if kind == "blob" { Some(buf) } else { None })
}

impl Drop for CatFile {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A few persistent cat-file processes shared by request handlers.
pub struct CatPool {
    root: PathBuf,
    slots: Vec<Mutex<Option<CatFile>>>,
}

impl CatPool {
    pub fn new(root: PathBuf, size: usize) -> CatPool {
        CatPool { root, slots: (0..size.max(1)).map(|_| Mutex::new(None)).collect() }
    }

    pub fn read(&self, spec: &str) -> Option<Vec<u8>> {
        let start = fastrand::usize(..self.slots.len());
        // Prefer an idle slot; fall back to waiting on one.
        let slot = (0..self.slots.len())
            .find_map(|i| self.slots[(start + i) % self.slots.len()].try_lock().ok())
            .unwrap_or_else(|| self.slots[start].lock().unwrap_or_else(|e| e.into_inner()));
        let mut slot = slot;
        for _ in 0..2 {
            if slot.is_none() {
                *slot = CatFile::spawn(&self.root).ok();
            }
            let cf = slot.as_mut()?;
            match cf.read(spec) {
                Ok(v) => return v,
                Err(_) => *slot = None, // process died; respawn once
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_parsing() {
        let z = |s: &str| s.replace('|', "\0");
        let out = z(":100644 100644 aaaa bbbb M|src/a.ts|:000000 100644 0000 cccc A|new file.txt|:100644 100644 dddd eeee R087|old/x.rs|new/x.rs|:100644 000000 ffff 0000 D|gone.md|");
        let e = parse_raw(out.as_bytes());
        assert_eq!(e.len(), 4);
        assert_eq!(e[0].status, 'M');
        assert_eq!(e[1].old_blob, None);
        assert_eq!(e[1].path, "new file.txt");
        assert_eq!(e[2].status, 'R');
        assert_eq!(e[2].old_path.as_deref(), Some("old/x.rs"));
        assert_eq!(e[2].path, "new/x.rs");
        assert_eq!(e[3].new_blob, None);
    }
}
