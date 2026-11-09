//! Builds what the UI shows: the list of review sources, the changed files with stats and
//! importance, and notes/comments re-anchored against the code being viewed. All diff work is
//! cached by blob id, so after the first load only files that changed again are recomputed.

use crate::engine::{self, DiffOut, Side, Stats};
use crate::git::{CatFile, CatPool, Git, RawEntry};
use crate::highlight::{self, TokenCache};
use crate::store::Store;
use crate::types::*;
use crate::util::{glob_to_regex, now, rel_time, sha1_hex, split_lines};
use anyhow::{Result, anyhow};
use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;

type StatKey = (String, String, bool);

pub struct Repo {
    pub root: PathBuf,
    pub git: Git,
    pub store: Store,
    pub cat: CatPool,
    pub tokens: TokenCache,
    stats: Mutex<HashMap<StatKey, Stats>>,
    snapshot: Mutex<Option<(u64, String)>>,
    /// Bumped by the file watcher on every relevant change; snapshots are reused while it is unchanged.
    pub generation: AtomicU64,
    pub watching: AtomicBool,
}

pub struct ResolvedSource {
    pub source: SourceOption,
    pub base: String,
    pub head: String,
    pub session: Option<Session>,
}

fn opt(label: &str, id: &str, kind: &str, detail: Option<String>) -> SourceOption {
    SourceOption { id: id.into(), kind: kind.into(), label: label.into(), detail }
}

impl Repo {
    pub fn open(root: PathBuf) -> Arc<Repo> {
        Arc::new(Repo {
            git: Git::new(root.clone()),
            store: Store::new(&root),
            cat: CatPool::new(root.clone(), 4),
            tokens: TokenCache::new(192 << 20),
            stats: Mutex::new(HashMap::new()),
            snapshot: Mutex::new(None),
            generation: AtomicU64::new(0),
            watching: AtomicBool::new(false),
            root,
        })
    }

    pub fn invalidate(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    /// Tree of the current working tree. Reused until the watcher reports a change.
    pub fn working_tree(&self) -> Result<String> {
        let watching = self.watching.load(Ordering::SeqCst);
        let generation = self.generation.load(Ordering::SeqCst);
        if watching {
            if let Some((g, t)) = self.snapshot.lock().unwrap().as_ref() {
                if *g == generation {
                    return Ok(t.clone());
                }
            }
        }
        let tree = self.git.snapshot_tree()?;
        if watching {
            *self.snapshot.lock().unwrap() = Some((generation, tree.clone()));
        }
        Ok(tree)
    }

    // ---- sources ---------------------------------------------------------------------------

    pub fn meta(&self) -> Meta {
        let (branch, head, def) = (self.git.current_branch(), self.git.head(), self.git.default_branch());
        let sessions = self.store.list_sessions();
        let mut sources: Vec<SourceOption> = sessions
            .iter()
            .map(|s| {
                let mut d = vec![];
                if let Some(a) = &s.agent {
                    d.push(a.clone());
                }
                d.push(rel_time(&s.created_at));
                if s.status == "closed" {
                    d.push("closed".into());
                }
                opt(&s.title, &format!("session:{}", s.id), "session", Some(d.join(" · ")))
            })
            .collect();
        sources.push(opt("Uncommitted changes", "working", "working", Some("HEAD → working tree".into())));
        sources.push(opt("Staged changes", "staged", "staged", Some("HEAD → index".into())));
        if let (Some(d), Some(b)) = (&def, &branch) {
            if d != b && d.trim_start_matches("origin/") != b {
                sources.push(opt(&format!("This branch vs {d}"), &format!("branch:{d}"), "branch", Some("merge-base → working tree".into())));
            }
        }
        if head.is_some() {
            sources.push(opt("Last commit", "commit:HEAD", "commit", Some(self.git.commit_subject("HEAD"))));
        }
        let active = self.store.get_active();
        let default_source = sessions
            .iter()
            .find(|s| Some(&s.id) == active.as_ref() && s.status == "open")
            .or_else(|| sessions.iter().find(|s| s.status == "open"))
            .map(|s| format!("session:{}", s.id))
            .unwrap_or_else(|| "working".into());
        Meta {
            repo: self.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            root: self.root.to_string_lossy().into_owned(),
            branch,
            head,
            sources,
            default_source,
            sessions,
        }
    }

    pub fn resolve_source(&self, id: &str) -> Result<ResolvedSource> {
        let head_or_empty = || self.git.head().unwrap_or_else(|| self.git.empty_tree());
        let (kind, rest) = id.split_once(':').unwrap_or((id, ""));
        Ok(match kind {
            "session" => {
                let s = self.store.find_session(rest).ok_or_else(|| anyhow!("No session \"{rest}\". Pick another source."))?;
                ResolvedSource {
                    source: opt(&s.title, &format!("session:{}", s.id), "session", None),
                    base: s.base.clone(),
                    head: self.working_tree()?,
                    session: Some(s),
                }
            }
            "staged" => ResolvedSource {
                source: opt("Staged changes", id, "staged", None),
                base: head_or_empty(),
                head: self.git.index_tree()?,
                session: None,
            },
            "branch" => {
                let mb = self.git.merge_base(rest, "HEAD").ok_or_else(|| anyhow!("No common ancestor between {rest} and HEAD."))?;
                ResolvedSource {
                    source: opt(&format!("This branch vs {rest}"), id, "branch", None),
                    base: mb,
                    head: self.working_tree()?,
                    session: None,
                }
            }
            "commit" => {
                let r = if rest.is_empty() { "HEAD" } else { rest };
                let c = self.git.rev_parse(r).ok_or_else(|| anyhow!("Unknown commit \"{r}\"."))?;
                let parent = self.git.rev_parse(&format!("{c}^")).unwrap_or_else(|| self.git.empty_tree());
                ResolvedSource {
                    source: opt(&format!("Commit {}", &c[..7]), id, "commit", Some(self.git.commit_subject(&c))),
                    base: parent,
                    head: c,
                    session: None,
                }
            }
            "ref" => {
                let c = self.git.rev_parse(rest).ok_or_else(|| anyhow!("Unknown revision \"{rest}\"."))?;
                ResolvedSource { source: opt(&format!("Since {rest}"), id, "ref", None), base: c, head: self.working_tree()?, session: None }
            }
            _ => ResolvedSource {
                source: opt("Uncommitted changes", "working", "working", None),
                base: head_or_empty(),
                head: self.working_tree()?,
                session: None,
            },
        })
    }

    // ---- stats -----------------------------------------------------------------------------

    /// Stats for every entry; cache misses are diffed in parallel, one cat-file per worker.
    pub fn stats_for(&self, entries: &[RawEntry], ws: bool) -> Vec<Stats> {
        let key = |e: &RawEntry| (e.old_blob.clone().unwrap_or_default(), e.new_blob.clone().unwrap_or_default(), ws);
        let mut out = vec![Stats::default(); entries.len()];
        let mut missing = Vec::new();
        {
            let cache = self.stats.lock().unwrap();
            for (i, e) in entries.iter().enumerate() {
                match cache.get(&key(e)) {
                    Some(s) => out[i] = *s,
                    None if e.old_blob.is_none() && e.new_blob.is_none() => {}
                    None => missing.push(i),
                }
            }
        }
        if missing.is_empty() {
            return out;
        }
        // Workers pull files from a shared counter (sizes vary wildly), each with its own cat-file.
        let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 12).min(missing.len());
        let next = std::sync::atomic::AtomicUsize::new(0);
        let computed: Vec<(usize, Stats)> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..workers)
                .map(|_| {
                    scope.spawn(|| {
                        let mut res: Vec<(usize, Stats)> = Vec::new();
                        let Ok(mut cf) = CatFile::spawn(&self.root) else { return res };
                        loop {
                            let k = next.fetch_add(1, Ordering::Relaxed);
                            let Some(&i) = missing.get(k) else { break };
                            let e = &entries[i];
                            let specs: Vec<&str> = [e.old_blob.as_deref(), e.new_blob.as_deref()].into_iter().flatten().collect();
                            let Ok(got) = cf.read_few(&specs) else { break };
                            let mut it = got.into_iter();
                            let old = if e.old_blob.is_some() { it.next().flatten() } else { None };
                            let new = if e.new_blob.is_some() { it.next().flatten() } else { None };
                            res.push((i, engine::stats(old.as_deref(), new.as_deref(), ws)));
                        }
                        res
                    })
                })
                .collect();
            handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
        });
        let mut cache = self.stats.lock().unwrap();
        for (i, s) in computed {
            out[i] = s;
            cache.insert(key(&entries[i]), s);
        }
        out
    }

    // ---- review ----------------------------------------------------------------------------

    pub fn review(&self, source_id: &str, ws: bool) -> Result<Review> {
        let started = Instant::now();
        let rs = self.resolve_source(source_id)?;
        let t_source = started.elapsed();
        let entries = self.git.diff_tree(&rs.base, &rs.head)?;
        let t_tree = started.elapsed();
        let stats = self.stats_for(&entries, ws);
        let t_stats = started.elapsed();
        let files = classify(&entries, &stats, rs.session.as_ref());
        if std::env::var_os("SIFT_DEBUG").is_some() {
            eprintln!("sift: source {t_source:?}, diff-tree {:?}, stats {:?} ({} files)", t_tree - t_source, t_stats - t_tree, entries.len());
        }

        let in_diff: HashMap<&str, &FileEntry> = files.iter().map(|f| (f.path.as_str(), f)).collect();
        let mut content: HashMap<(bool, String), Option<Arc<Vec<String>>>> = HashMap::new();
        let mut lines_at = |old: bool, path: &str| -> Option<Arc<Vec<String>>> {
            content
                .entry((old, path.to_string()))
                .or_insert_with(|| {
                    let spec = match in_diff.get(path) {
                        Some(f) if old => f.old_blob.clone()?,
                        Some(f) => f.new_blob.clone()?,
                        None => format!("{}:{}", if old { &rs.base } else { &rs.head }, path),
                    };
                    let data = self.cat.read(&spec)?;
                    Some(Arc::new(split_lines(&String::from_utf8_lossy(&data)).into_iter().map(String::from).collect()))
                })
                .clone()
        };

        let open_sessions: Vec<Session> = self.store.list_sessions().into_iter().filter(|s| s.status == "open").collect();
        let raw_notes: Vec<Note> = match &rs.session {
            Some(s) => self.store.notes(&s.id),
            None => open_sessions
                .iter()
                .flat_map(|s| self.store.notes(&s.id))
                .filter(|n| n.file.as_deref().is_some_and(|f| in_diff.contains_key(f)))
                .collect(),
        };
        let notes = raw_notes
            .into_iter()
            .map(|n| resolve_item(n, &in_diff, &mut lines_at))
            .collect();

        let session_id = rs.session.as_ref().map(|s| s.id.clone());
        let feedback = self
            .store
            .feedback()
            .into_iter()
            .filter(|f| {
                let file_in = f.file.as_deref().is_some_and(|p| in_diff.contains_key(p));
                match &session_id {
                    Some(sid) => f.session.as_ref() == Some(sid) || (file_in && f.session.is_none()),
                    None => file_in || (f.file.is_none() && f.session.is_none()),
                }
            })
            .map(|f| resolve_item(f, &in_diff, &mut lines_at))
            .collect();

        let state = self.store.state();
        Ok(Review {
            source: rs.source,
            base_rev: rs.base,
            head_rev: rs.head,
            files,
            notes,
            feedback,
            session: rs.session,
            viewed: state.viewed,
            acked: state.acked,
            generated_at: now(),
            ignore_whitespace: ws,
            took_ms: started.elapsed().as_millis() as u64,
        })
    }

    // ---- per-file content ------------------------------------------------------------------

    fn tokens(&self, blob: &str, path: &str, text: &str) -> Arc<Option<engine::Tokens>> {
        let ext = path.rsplit('.').next().unwrap_or("");
        self.tokens.get_or(&format!("{blob}.{ext}"), || highlight::highlight(path, text))
    }

    /// Hunks for one file, with syntax tokens and intra-line emphasis.
    pub fn file_diff(&self, path: &str, old_blob: Option<&str>, new_blob: Option<&str>, ws: bool) -> DiffOut {
        let read = |b: Option<&str>| b.and_then(|b| self.cat.read(b)).unwrap_or_default();
        let (od, nd) = (read(old_blob), read(new_blob));
        if engine::is_binary(&od) || engine::is_binary(&nd) {
            return DiffOut { binary: true, ..Default::default() };
        }
        let (ot, nt) = (String::from_utf8_lossy(&od), String::from_utf8_lossy(&nd));
        if od.len() > engine::MAX_DIFF_BYTES || nd.len() > engine::MAX_DIFF_BYTES {
            return DiffOut {
                too_large: true,
                old_lines: split_lines(&ot).len() as u32,
                new_lines: split_lines(&nt).len() as u32,
                ..Default::default()
            };
        }
        let otoks = old_blob.map(|b| self.tokens(b, path, &ot));
        let ntoks = new_blob.map(|b| self.tokens(b, path, &nt));
        let old = Side { lines: split_lines(&ot), toks: otoks.as_deref().and_then(|t| t.as_ref()) };
        let new = Side { lines: split_lines(&nt), toks: ntoks.as_deref().and_then(|t| t.as_ref()) };
        engine::render(&old, &new, ws)
    }

    /// Selected lines of a blob (or `rev:path`), with tokens: used to expand context and for excerpts.
    pub fn lines(&self, spec: &str, path: &str, ranges: &[(u32, u32)]) -> Option<LinesOut> {
        let blob = if spec.contains(':') { self.git.blob_id(spec.split_once(':')?.0, path)? } else { spec.to_string() };
        let data = self.cat.read(&blob)?;
        if engine::is_binary(&data) {
            return None;
        }
        let text = String::from_utf8_lossy(&data);
        let all = split_lines(&text);
        let toks = self.tokens(&blob, path, &text);
        let mut lines = Vec::new();
        for &(a, b) in ranges {
            for n in a.max(1)..=b.min(all.len() as u32) {
                let k = toks.as_ref().as_ref().and_then(|t| t.get(n as usize - 1)).cloned().unwrap_or_default();
                lines.push((n, all[n as usize - 1].to_string(), k));
            }
        }
        Some(LinesOut { blob, total: all.len() as u32, lines })
    }
}

#[derive(Serialize)]
pub struct LinesOut {
    pub blob: String,
    pub total: u32,
    pub lines: Vec<(u32, String, Vec<u16>)>,
}

fn resolve_item<T: Anchored>(
    mut item: T,
    in_diff: &HashMap<&str, &FileEntry>,
    lines_at: &mut impl FnMut(bool, &str) -> Option<Arc<Vec<String>>>,
) -> Resolved<T> {
    let file = item.file().map(String::from);
    let is_in = file.as_deref().is_some_and(|f| in_diff.contains_key(f));
    let (line, end) = item.range();
    let (Some(file), Some(_)) = (file, line) else { return Resolved { item, stale: None, in_diff: is_in } };
    let lines = lines_at(item.side() == "old", &file);
    let refs: Option<Vec<&str>> = lines.as_ref().map(|l| l.iter().map(String::as_str).collect());
    let r = resolve_anchor(refs.as_deref(), line, end, item.anchor());
    item.set_range(r.0, r.1);
    Resolved { item, stale: r.2.then_some(true), in_diff: is_in }
}

/// Follow an anchor line that may have moved since the note was written.
/// Returns (line, endLine, stale).
pub fn resolve_anchor(lines: Option<&[&str]>, line: Option<u32>, end: Option<u32>, anchor: Option<&str>) -> (Option<u32>, Option<u32>, bool) {
    let Some(line) = line.filter(|l| *l > 0) else { return (line, end, false) };
    let Some(lines) = lines else { return (Some(line), end, true) };
    let len = lines.len() as i64;
    let span = end.filter(|e| *e > line).map(|e| e - line).unwrap_or(0) as i64;
    let clamp = |l: i64| l.clamp(1, len.max(1)) as u32;
    let with_span = |l: i64| (Some(clamp(l)), (span > 0).then(|| clamp(l + span)));
    let Some(anchor) = anchor.filter(|a| !a.is_empty()) else {
        let (a, b) = with_span(line as i64);
        return (a, b, false);
    };
    let at = |l: i64| l >= 1 && l <= len && lines[(l - 1) as usize].trim() == anchor;
    let l0 = line as i64;
    if at(l0) {
        return (Some(line), (span > 0).then(|| (l0 + span) as u32), false);
    }
    for d in 1..=600 {
        for l in [l0 - d, l0 + d] {
            if at(l) {
                let (a, b) = with_span(l);
                return (a, b, false);
            }
        }
    }
    let (a, b) = with_span(l0);
    (a, b, true)
}

// ---- classification -------------------------------------------------------------------------

static AUTO_NOISE: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(^|/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|go\.sum|Podfile\.lock|packages-lock\.json|flake\.lock)$",
        r"\.meta$",
        r"\.min\.(js|css)$",
        r"\.(js|css)\.map$",
        r"\.snap$",
        r"(^|/)(dist|build|out|Library|Temp|obj|\.next|coverage)/",
        r"(^|/)__generated__/",
        r"\.g\.(cs|dart)$",
        r"(?i)\.designer\.cs$",
    ]
    .iter()
    .map(|r| Regex::new(r).unwrap())
    .collect()
});

// Serialized Unity assets and similar: real changes, but rarely worth reading line by line.
static AUTO_LOW: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"\.(unity|prefab|asset|mat|controller|anim|overrideController|physicMaterial|mask|playable|signal|lighting|spriteatlas|shadergraph|vfx)$",
        r"(^|/)ProjectSettings/",
        r"(^|/)Packages/packages-lock\.json$",
        r"\.(svg|pbxproj|xcscheme)$",
    ]
    .iter()
    .map(|r| Regex::new(r).unwrap())
    .collect()
});

pub fn classify(entries: &[RawEntry], stats: &[Stats], session: Option<&Session>) -> Vec<FileEntry> {
    let globs: Vec<Regex> = session.map(|s| s.noise.iter().filter_map(|g| glob_to_regex(g)).collect()).unwrap_or_default();
    entries
        .iter()
        .zip(stats)
        .map(|(e, s)| {
            let meta = session.and_then(|s| s.files.get(&e.path));
            let (importance, source) = if let Some(i) = meta.and_then(|m| m.importance.clone()) {
                (i, "agent")
            } else if globs.iter().any(|g| g.is_match(&e.path)) {
                ("noise".into(), "agent")
            } else if AUTO_NOISE.iter().any(|r| r.is_match(&e.path)) {
                ("noise".into(), "auto")
            } else if AUTO_LOW.iter().any(|r| r.is_match(&e.path)) {
                ("low".into(), "auto")
            } else {
                ("normal".into(), "default")
            };
            let status = match e.status {
                'A' | 'D' | 'R' | 'C' | 'T' => e.status,
                _ if e.old_mode != e.new_mode && s.additions + s.deletions == 0 => 'T',
                _ => 'M',
            };
            let hash = sha1_hex(&[
                e.path.as_bytes(),
                e.old_blob.as_deref().unwrap_or("").as_bytes(),
                e.new_blob.as_deref().unwrap_or("").as_bytes(),
                e.new_mode.as_bytes(),
            ]);
            FileEntry {
                path: e.path.clone(),
                old_path: e.old_path.clone().filter(|p| p != &e.path),
                status: status.to_string(),
                binary: s.binary || (e.old_blob.is_none() && e.new_blob.is_none()),
                additions: s.additions,
                deletions: s.deletions,
                rows: s.rows,
                hunks: s.hunks,
                old_lines: s.old_lines,
                new_lines: s.new_lines,
                old_blob: e.old_blob.clone(),
                new_blob: e.new_blob.clone(),
                hash: hash[..16].to_string(),
                importance,
                importance_source: source.into(),
                summary: meta.and_then(|m| m.summary.clone()),
                large: s.too_large || s.rows > 6000,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchors() {
        let lines = ["a", "b", "target", "c"];
        assert_eq!(resolve_anchor(Some(&lines), Some(3), None, Some("target")), (Some(3), None, false));
        let shifted = ["x", "y", "a", "b", "target", "c"];
        assert_eq!(resolve_anchor(Some(&shifted), Some(3), Some(4), Some("target")), (Some(5), Some(6), false));
        assert_eq!(resolve_anchor(Some(&lines), Some(2), None, Some("gone")), (Some(2), None, true));
        assert_eq!(resolve_anchor(None, Some(2), None, Some("x")), (Some(2), None, true));
        assert_eq!(resolve_anchor(Some(&lines), Some(9), None, None), (Some(4), None, false));
    }

    #[test]
    fn classification() {
        let e = |p: &str| RawEntry {
            status: 'M',
            old_mode: "100644".into(),
            new_mode: "100644".into(),
            old_blob: Some("a".into()),
            new_blob: Some("b".into()),
            path: p.into(),
            old_path: None,
        };
        let entries = vec![e("package-lock.json"), e("Assets/Hero.prefab"), e("src/app.ts"), e("gen/x.ts"), e("src/core.ts")];
        let stats = vec![Stats::default(); entries.len()];
        let mut s = Session { noise: vec!["gen/**".into()], ..Default::default() };
        s.files.insert("src/core.ts".into(), FileMeta { importance: Some("high".into()), summary: None });
        let f = classify(&entries, &stats, Some(&s));
        let imp: Vec<&str> = f.iter().map(|f| f.importance.as_str()).collect();
        assert_eq!(imp, ["noise", "low", "normal", "noise", "high"]);
    }
}
