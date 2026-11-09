use crate::git::{self, Git};
use crate::review::{Repo, resolve_anchor};
use crate::store::Store;
use crate::types::{FileMeta, IMPORTANCE, NOTE_KINDS, Note, Session};
use crate::util::{now, rel_time, split_lines};
use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand};
use serde_json::{Value, json};
use std::io::{IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const SKILL: &str = include_str!("../skill/SKILL.md");

#[derive(Parser)]
#[command(
    name = "sift",
    version,
    about = "Review what your agents changed: annotated diffs, guided walkthroughs, and a feedback loop.",
    after_help = "Run `sift` in a repo to open the review UI. Agents: see `sift skill print` for the workflow."
)]
pub struct Cli {
    /// Run as if started in this directory
    #[arg(short = 'C', long = "repo", global = true, value_name = "DIR")]
    repo: Option<PathBuf>,
    /// Session to write to (default: $SIFT_SESSION, then the active session)
    #[arg(long, global = true, env = "SIFT_SESSION", value_name = "ID")]
    session: Option<String>,
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Args, Default)]
struct ServeArgs {
    /// Port to listen on (default: a stable port per repository, 4800-4899)
    #[arg(long, env = "SIFT_PORT")]
    port: Option<u16>,
    /// Do not open the browser
    #[arg(long)]
    no_open: bool,
    /// Address to bind
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
    /// Start a new server even if one is already running for this repo
    #[arg(long)]
    force: bool,
}

#[derive(Subcommand)]
enum Cmd {
    /// Open the review UI for this repo (reuses a running one)
    #[command(visible_aliases = ["open", "ui"])]
    Serve(ServeArgs),
    /// Print the URL of the running UI
    Url,
    /// Active session, UI address, open comments
    Status,

    /// Start a session: snapshots the working tree as the baseline
    #[command(visible_alias = "start")]
    Begin {
        title: Vec<String>,
        #[arg(long)]
        agent: Option<String>,
        /// Use HEAD as the baseline instead of a snapshot of the working tree
        #[arg(long)]
        from_head: bool,
        #[arg(long)]
        json: bool,
    },
    /// Rename the session
    Title { title: Vec<String> },
    /// Set the session brief: what changed and why (markdown; `-` reads stdin, `@file` reads a file)
    #[command(visible_alias = "brief")]
    Summary {
        text: Vec<String>,
        #[arg(long, short = 'b')]
        body: Option<String>,
        /// Append to the existing summary
        #[arg(long)]
        append: bool,
        /// Also rename the session
        #[arg(long)]
        title: Option<String>,
    },
    /// Annotate code: sift note <file>[:line[-end]] --kind K --title "..." [--body ...]
    #[command(visible_alias = "n")]
    Note {
        /// <file>[:line[-end]]; omit for a note on the whole change
        target: Option<String>,
        /// Title words (alternative to --title)
        rest: Vec<String>,
        /// important | why | risk | question | verify | todo | info
        #[arg(long, short = 'k')]
        kind: Option<String>,
        #[arg(long, short = 't')]
        title: Option<String>,
        /// Markdown body; `-` reads stdin, `@file` reads a file
        #[arg(long, short = 'b')]
        body: Option<String>,
        /// Position in the walkthrough (1, 2, 3...)
        #[arg(long)]
        step: Option<i64>,
        /// Anchor on removed code (line numbers refer to the baseline)
        #[arg(long)]
        old: bool,
        /// N or N-M (alternative to file:N-M)
        #[arg(long)]
        line: Option<String>,
        /// Text on the first line of the range; Sift finds the line (no counting needed)
        #[arg(long)]
        at: Option<String>,
        /// Text on the last line of the range (searched from the first line down)
        #[arg(long)]
        to: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Rank a file and say what changed in it
    File {
        path: String,
        /// critical | high | normal | low | noise
        #[arg(long, short = 'i')]
        importance: Option<String>,
        #[arg(long, short = 's')]
        summary: Option<String>,
    },
    /// Collapse generated or mechanical files (globs)
    Noise { globs: Vec<String> },
    /// Bulk annotate from JSON: {title, summary, files:{path:{importance,summary}}, noise:[], notes:[...]}
    Import {
        /// JSON file, or `-` for stdin
        src: Option<String>,
    },
    /// Files changed in the session (or any source) with stats and importance
    Changes {
        /// session:<id> | working | staged | branch:<name> | commit:<rev> | ref:<rev>
        #[arg(long)]
        source: Option<String>,
        /// Also list noise files (otherwise they are counted on one line)
        #[arg(long)]
        all: bool,
        #[arg(long)]
        json: bool,
    },
    /// List notes in the session
    #[command(visible_alias = "ls")]
    Notes {
        #[arg(long)]
        json: bool,
    },
    /// Change a note
    Edit {
        id: String,
        #[arg(long, short = 't')]
        title: Option<String>,
        #[arg(long, short = 'b')]
        body: Option<String>,
        #[arg(long, short = 'k')]
        kind: Option<String>,
        #[arg(long)]
        step: Option<i64>,
    },
    /// Delete notes
    Rm { ids: Vec<String> },
    /// Close the session
    End,

    /// Comments the reviewer left, with the code they point at
    #[command(visible_alias = "comments")]
    Feedback {
        /// Include resolved comments
        #[arg(long)]
        all: bool,
        #[arg(long)]
        json: bool,
    },
    /// Reply to a review comment
    Reply {
        id: String,
        message: Vec<String>,
        #[arg(long, short = 'b')]
        body: Option<String>,
        /// Mark it resolved
        #[arg(long)]
        resolve: bool,
    },
    /// Mark review comments resolved
    Resolve { ids: Vec<String> },

    /// List sessions (* = active)
    Sessions {
        #[arg(long)]
        json: bool,
    },
    /// Make a session active (reopens it if closed)
    Use { id: String },
    /// Install the agent skill: sift skill install [--dir D] | path | print
    Skill {
        #[arg(default_value = "install")]
        action: String,
        /// Skills directory (default: ~/.claude/skills)
        #[arg(long)]
        dir: Option<PathBuf>,
        #[arg(long)]
        force: bool,
    },
}

struct Ctx {
    root: PathBuf,
    git: Git,
    store: Store,
    session: Option<String>,
    cwd: PathBuf,
}

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("sift: {msg}");
    std::process::exit(1)
}

fn read_stdin() -> String {
    let mut s = String::new();
    let _ = std::io::stdin().read_to_string(&mut s);
    s
}

/// `-` means stdin; `@path` means file contents; literal `\n` becomes a newline.
fn text_arg(v: Option<String>) -> Option<String> {
    let v = v?;
    if v == "-" {
        if std::io::stdin().is_terminal() {
            fail("expected text on stdin (you passed \"-\").");
        }
        return Some(read_stdin().trim_end().to_string());
    }
    if let Some(p) = v.strip_prefix('@') {
        if let Ok(s) = std::fs::read_to_string(p) {
            return Some(s.trim_end().to_string());
        }
    }
    Some(v.replace("\\n", "\n"))
}

fn parse_kind(v: Option<&str>) -> String {
    let k = v.unwrap_or("info").to_lowercase();
    if !NOTE_KINDS.contains(&k.as_str()) {
        fail(format!("unknown kind \"{k}\". Use one of: {}.", NOTE_KINDS.join(", ")));
    }
    k
}

fn parse_importance(v: &str) -> String {
    let k = v.to_lowercase();
    if !IMPORTANCE.contains(&k.as_str()) {
        fail(format!("unknown importance \"{v}\". Use one of: {}.", IMPORTANCE.join(", ")));
    }
    k
}

fn parse_target(t: &str) -> (String, Option<u32>, Option<u32>) {
    if let Some((file, range)) = t.rsplit_once(':') {
        let (a, b) = range.split_once('-').unwrap_or((range, ""));
        if let Ok(a) = a.parse::<u32>() {
            return (file.to_string(), Some(a), b.parse().ok());
        }
    }
    (t.to_string(), None, None)
}

fn default_port(root: &Path) -> u16 {
    let d = sha1_smol::Sha1::from(root.to_string_lossy().as_bytes()).digest().bytes();
    4800 + (u16::from_be_bytes([d[0], d[1]]) % 100)
}

/// GET /api/ping on a local port, without pulling in an HTTP client.
fn ping(port: u16) -> Option<Value> {
    let mut s = std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(400)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    s.write_all(b"GET /api/ping HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").ok()?;
    let mut buf = String::new();
    s.read_to_string(&mut buf).ok()?;
    let body = buf.split_once("\r\n\r\n")?.1;
    serde_json::from_str(body.trim()).ok()
}

impl Ctx {
    fn repo_path(&self, p: &str) -> String {
        let abs = if Path::new(p).is_absolute() { PathBuf::from(p) } else { self.cwd.join(p) };
        let norm = |s: &str| s.replace('\\', "/");
        match abs.strip_prefix(&self.root).or_else(|_| abs.strip_prefix(self.root.canonicalize().unwrap_or_default())) {
            Ok(rel) if abs.exists() || !self.root.join(p).exists() => norm(&rel.to_string_lossy()),
            _ if self.root.join(p).exists() || !Path::new(p).is_absolute() => norm(p.trim_start_matches("./")),
            _ => fail(format!("{p} is outside the repository.")),
        }
    }

    fn begin(&self, title: &str, agent: Option<String>, from_head: bool) -> Result<Session> {
        self.store.ensure()?;
        let id = self.store.new_session_id();
        let head = self.git.head();
        let base = match (&head, from_head) {
            (Some(h), true) => h.clone(),
            _ => self.git.snapshot_commit(&format!("refs/sift/sessions/{id}"), &format!("sift: baseline for \"{title}\""))?,
        };
        let mut s = Session {
            id: id.clone(),
            title: title.into(),
            agent,
            base,
            base_head: head,
            created_at: now(),
            status: "open".into(),
            ..Default::default()
        };
        self.store.save_session(&mut s)?;
        self.store.set_active(Some(&id))?;
        Ok(s)
    }

    /// Session agents write to: --session, $SIFT_SESSION, the active one, or a new one based on HEAD.
    fn target(&self, auto_create: bool) -> Result<Session> {
        if let Some(want) = &self.session {
            return Ok(self.store.find_session(want).unwrap_or_else(|| fail(format!("no session \"{want}\". Run `sift sessions` to list them."))));
        }
        if let Some(s) = self.store.get_active().and_then(|a| self.store.get_session(&a)) {
            if s.status == "open" {
                return Ok(s);
            }
        }
        if !auto_create {
            fail("no open session. Start one with `sift begin \"<title>\"`.");
        }
        let s = self.begin("Untitled changes", None, true)?;
        eprintln!("sift: no open session, so started {} against HEAD. Name it with `sift title \"...\"`.", s.id);
        Ok(s)
    }

    fn file_lines(&self, base: Option<&str>, path: &str, old: bool) -> Option<Vec<String>> {
        let text = if old {
            let out = self.git.cmd().args(["cat-file", "blob", &format!("{}:{path}", base?)]).output().ok()?;
            if !out.status.success() || crate::engine::is_binary(&out.stdout) {
                return None;
            }
            String::from_utf8_lossy(&out.stdout).into_owned()
        } else {
            let data = std::fs::read(self.root.join(path)).ok()?;
            String::from_utf8_lossy(&data).into_owned()
        };
        Some(split_lines(&text).into_iter().map(String::from).collect())
    }

    fn make_note(&self, s: &Session, input: NoteInput, warn: &mut Vec<String>) -> Result<Note> {
        let NoteInput { file, mut line, mut end, at, to, old, kind, title, body, step } = input;
        let Some(title) = title.filter(|t| !t.trim().is_empty()) else { fail("every note needs a title.") };
        let file = file.map(|f| self.repo_path(&f));
        let mut side_old = old;
        let mut anchor = None;
        if let Some(f) = &file {
            let mut lines = self.file_lines(Some(&s.base), f, side_old);
            if lines.is_none() && !side_old {
                // File was deleted: anchor on the old side automatically.
                if let Some(o) = self.file_lines(Some(&s.base), f, true) {
                    side_old = true;
                    lines = Some(o);
                }
            }
            if let Some(ls) = &lines {
                if let Some(text) = at.as_deref() {
                    line = find_text(ls, text, 1, line, f, "at", warn);
                    if line.is_none() {
                        end = None;
                    }
                }
                if let (Some(text), Some(l)) = (to.as_deref(), line) {
                    end = find_text(ls, text, l, None, f, "to", warn);
                }
            }
            if let (Some(a), Some(b)) = (line, end) {
                if b < a {
                    (line, end) = (Some(b), Some(a));
                }
            }
            if end == line {
                end = None;
            }
            match (&lines, line) {
                (None, _) => warn.push(format!(
                    "{f} does not exist (on the {} side); the note will be attached without a line.",
                    if side_old { "old" } else { "new" }
                )),
                (Some(ls), Some(l)) => {
                    let len = ls.len() as u32;
                    if l > len {
                        warn.push(format!("{f} has {len} lines; clamped line {l}."));
                        line = Some(len.max(1));
                        end = end.map(|e| e.min(len)).filter(|e| Some(*e) != line);
                    }
                    anchor = line.and_then(|l| ls.get(l as usize - 1)).map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
                }
                _ => {}
            }
        }
        let has_file = file.is_some();
        self.store.add_note(Note {
            session: s.id.clone(),
            kind: parse_kind(kind.as_deref()),
            title,
            body: body.filter(|b| !b.is_empty()),
            file,
            line: if has_file { line } else { None },
            end_line: if has_file && line.is_some() { end } else { None },
            side: if side_old { "old".into() } else { "new".into() },
            anchor,
            step,
            ..Default::default()
        })
    }
}

/// What an agent asked for; `make_note` turns it into a stored, anchored note.
#[derive(Default)]
struct NoteInput {
    file: Option<String>,
    line: Option<u32>,
    end: Option<u32>,
    /// Text on the first line of the range: Sift finds the line, so the agent need not count.
    at: Option<String>,
    /// Text on the last line of the range, searched from the first line down.
    to: Option<String>,
    old: bool,
    kind: Option<String>,
    title: Option<String>,
    body: Option<String>,
    step: Option<i64>,
}

/// 1-based number of the line containing `text` (its first non-empty line, trimmed), searching from
/// line `from`. Several matches: the one nearest `near` if given, else the first, with a warning.
fn find_text(lines: &[String], text: &str, from: u32, near: Option<u32>, file: &str, field: &str, warn: &mut Vec<String>) -> Option<u32> {
    let needle = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    if needle.is_empty() {
        return near;
    }
    let hits: Vec<u32> = (from.max(1)..=lines.len() as u32).filter(|&i| lines[i as usize - 1].contains(needle)).collect();
    let pick = match near {
        Some(n) => hits.iter().copied().min_by_key(|&h| h.abs_diff(n)),
        None => hits.first().copied(),
    };
    match (pick, hits.len()) {
        (None, _) => {
            warn.push(format!("{file}: {field} text {needle:?} not found{}.", if near.is_some() { "; kept the given line" } else { "" }));
            return near;
        }
        // `to` means "the first match below the start", so only an ambiguous `at` is worth a warning.
        (Some(p), n) if n > 1 && near.is_none() && field == "at" => {
            let list: Vec<String> = hits.iter().take(6).map(u32::to_string).collect();
            warn.push(format!("{file}: {field} text {needle:?} is on lines {}; used {p}. Use a longer, unique text.", list.join(", ")));
        }
        _ => {}
    }
    pick
}

fn loc(n: &Note) -> String {
    match &n.file {
        Some(f) => {
            let mut s = f.clone();
            if let Some(l) = n.line {
                s.push_str(&format!(":{l}"));
                if let Some(e) = n.end_line {
                    s.push_str(&format!("-{e}"));
                }
            }
            s
        }
        None => "(session)".into(),
    }
}

pub fn main() -> Result<()> {
    let cli = Cli::parse();
    let cmd = cli.cmd.unwrap_or(Cmd::Serve(ServeArgs { host: "127.0.0.1".into(), ..Default::default() }));
    if let Cmd::Skill { action, dir, force } = &cmd {
        return skill(action, dir.clone(), *force);
    }
    let cwd = std::env::current_dir()?;
    let start = cli.repo.clone().map(|r| cwd.join(r)).unwrap_or_else(|| cwd.clone());
    let root = git::find_repo_root(&start).unwrap_or_else(|| fail(format!("{} is not inside a git repository.", start.display())));
    let ctx = Ctx { git: Git::new(root.clone()), store: Store::new(&root), root, session: cli.session.clone(), cwd: start };

    match cmd {
        Cmd::Serve(a) => serve(&ctx, a),
        Cmd::Url => {
            match ctx.store.server_info().filter(|i| ping(i.port).is_some()) {
                Some(i) => println!("http://127.0.0.1:{}/", i.port),
                None => fail("Sift is not running for this repository. Start it with `sift`."),
            }
            Ok(())
        }
        Cmd::Status => {
            let s = ctx.store.get_active().and_then(|a| ctx.store.get_session(&a));
            let ui = ctx.store.server_info().filter(|i| ping(i.port).is_some());
            let open = ctx.store.feedback().iter().filter(|f| f.status == "open").count();
            println!("repo     {}", ctx.root.display());
            match s {
                Some(s) => println!("session  {} {} ({}, {} notes)", s.id, s.title, s.status, ctx.store.notes(&s.id).len()),
                None => println!("session  none"),
            }
            match ui {
                Some(i) => println!("ui       http://127.0.0.1:{}/", i.port),
                None => println!("ui       not running (start with `sift`)"),
            }
            println!("feedback {open} open comment{}", if open == 1 { "" } else { "s" });
            Ok(())
        }
        Cmd::Begin { title, agent, from_head, json } => {
            let title = title.join(" ");
            if title.trim().is_empty() {
                fail("usage: sift begin \"<what you are about to do>\"");
            }
            let s = ctx.begin(title.trim(), agent, from_head)?;
            if json {
                println!("{}", json!({ "id": s.id, "base": s.base }));
            } else {
                let base = if from_head { "HEAD" } else { "working tree" };
                println!("Started session {} against the {base} ({}). Other agents in this repo? Pass --session {}.", s.id, &s.base[..10], s.id);
            }
            Ok(())
        }
        Cmd::Title { title } => {
            let title = title.join(" ");
            if title.trim().is_empty() {
                fail("usage: sift title \"<title>\"");
            }
            let mut s = ctx.target(true)?;
            s.title = title.trim().into();
            ctx.store.save_session(&mut s)?;
            println!("Session {} is now titled: {}", s.id, s.title);
            Ok(())
        }
        Cmd::Summary { text, body, append, title } => {
            let raw = text.join(" ");
            let text = text_arg(body.or(Some(if raw.is_empty() { "-".into() } else { raw })))
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| fail("usage: sift summary \"<markdown>\"   (or pipe markdown on stdin with `-`)"));
            let mut s = ctx.target(true)?;
            s.summary = Some(match (append, &s.summary) {
                (true, Some(old)) => format!("{old}\n\n{text}"),
                _ => text,
            });
            if let Some(t) = title {
                s.title = t;
            }
            ctx.store.save_session(&mut s)?;
            println!("Summary saved on session {}.", s.id);
            Ok(())
        }
        Cmd::Note { target, rest, kind, title, body, step, old, line, at, to, json } => {
            let s = ctx.target(true)?;
            let (file, mut l, mut e) = match &target {
                Some(t) => {
                    let (f, a, b) = parse_target(t);
                    (Some(f), a, b)
                }
                None => (None, None, None),
            };
            if let Some(spec) = line {
                let (a, b) = spec.split_once('-').unwrap_or((&spec, ""));
                l = Some(a.parse().unwrap_or_else(|_| fail("--line takes N or N-M")));
                e = b.parse().ok();
            }
            let title = title.or_else(|| (!rest.is_empty()).then(|| rest.join(" ")));
            let mut warn = Vec::new();
            let input = NoteInput { file, line: l, end: e, at, to, old, kind, title, body: text_arg(body), step };
            let n = ctx.make_note(&s, input, &mut warn)?;
            for w in warn {
                eprintln!("sift: {w}");
            }
            if json {
                println!("{}", serde_json::to_string(&n)?);
            } else {
                println!("{}  {:<9} {}  {}", n.id, n.kind, loc(&n).replace("(session)", "session"), n.title);
            }
            Ok(())
        }
        Cmd::File { path, importance, summary } => {
            let mut s = ctx.target(true)?;
            let p = ctx.repo_path(&path);
            let m = s.files.entry(p.clone()).or_insert_with(FileMeta::default);
            if let Some(i) = importance {
                m.importance = Some(parse_importance(&i));
            }
            if let Some(sum) = text_arg(summary) {
                m.summary = Some(sum);
            }
            let desc = [m.importance.clone(), m.summary.clone()].into_iter().flatten().collect::<Vec<_>>().join(" — ");
            ctx.store.save_session(&mut s)?;
            println!("{p}: {desc}");
            Ok(())
        }
        Cmd::Noise { globs } => {
            if globs.is_empty() {
                fail("usage: sift noise <glob> [<glob>...]");
            }
            let mut s = ctx.target(true)?;
            for g in globs {
                if !s.noise.contains(&g) {
                    s.noise.push(g);
                }
            }
            ctx.store.save_session(&mut s)?;
            println!("Noise patterns on {}: {}", s.id, s.noise.join(", "));
            Ok(())
        }
        Cmd::Import { src } => import(&ctx, src.as_deref().unwrap_or("-")),
        Cmd::Changes { source, all, json } => changes(&ctx, source, all, json),
        Cmd::Notes { json } => {
            let s = ctx.target(false)?;
            let mut notes = ctx.store.notes(&s.id);
            if json {
                println!("{}", serde_json::to_string_pretty(&json!({ "session": s, "notes": notes }))?);
                return Ok(());
            }
            println!("{}  {}  ({} notes)", s.id, s.title, notes.len());
            notes.sort_by_key(|n| n.step.unwrap_or(i64::MAX));
            for n in notes {
                let step = n.step.map(|s| format!("#{s}")).unwrap_or_default();
                println!("  {}  {:<4}{:<10}{}  {}", n.id, step, n.kind, loc(&n), n.title);
            }
            Ok(())
        }
        Cmd::Edit { id, title, body, kind, step } => {
            let n = ctx.store.find_note(&id).unwrap_or_else(|| fail(format!("no note \"{id}\"")));
            let mut patch = serde_json::Map::new();
            if let Some(t) = title {
                patch.insert("title".into(), t.into());
            }
            if let Some(b) = text_arg(body) {
                patch.insert("body".into(), b.into());
            }
            if let Some(k) = kind {
                patch.insert("kind".into(), parse_kind(Some(&k)).into());
            }
            if let Some(s) = step {
                patch.insert("step".into(), s.into());
            }
            ctx.store.update_note(&n, Value::Object(patch))?;
            println!("Updated {}.", n.id);
            Ok(())
        }
        Cmd::Rm { ids } => {
            if ids.is_empty() {
                fail("usage: sift rm <note-id>...");
            }
            for id in ids {
                match ctx.store.find_note(&id) {
                    Some(n) => {
                        ctx.store.delete_note(&n)?;
                        println!("Removed {}: {}", n.id, n.title);
                    }
                    None => eprintln!("sift: no note \"{id}\""),
                }
            }
            Ok(())
        }
        Cmd::End => {
            let mut s = ctx.target(false)?;
            s.status = "closed".into();
            ctx.store.save_session(&mut s)?;
            if ctx.store.get_active().as_deref() == Some(&s.id) {
                ctx.store.set_active(None)?;
            }
            println!("Closed session {}: {}", s.id, s.title);
            Ok(())
        }
        Cmd::Feedback { all, json } => feedback(&ctx, all, json),
        Cmd::Reply { id, message, body, resolve } => {
            let body = text_arg(body.or_else(|| (!message.is_empty()).then(|| message.join(" "))))
                .filter(|b| !b.is_empty())
                .unwrap_or_else(|| fail("usage: sift reply <comment-id> \"<message>\" [--resolve]"));
            let f = ctx.store.find_feedback(&id).unwrap_or_else(|| fail(format!("no comment \"{id}\". Run `sift feedback --all`.")));
            ctx.store.reply_feedback(&f.id, "agent", &body)?;
            if resolve {
                ctx.store.set_feedback_status(&f.id, "resolved")?;
            }
            println!("Replied to {}{}.", f.id, if resolve { " and marked it resolved" } else { "" });
            Ok(())
        }
        Cmd::Resolve { ids } => {
            if ids.is_empty() {
                fail("usage: sift resolve <comment-id>...");
            }
            for id in ids {
                match ctx.store.find_feedback(&id) {
                    Some(f) => {
                        ctx.store.set_feedback_status(&f.id, "resolved")?;
                        println!("Resolved {}.", f.id);
                    }
                    None => eprintln!("sift: no comment \"{id}\""),
                }
            }
            Ok(())
        }
        Cmd::Sessions { json } => {
            let list = ctx.store.list_sessions();
            if json {
                println!("{}", serde_json::to_string_pretty(&list)?);
                return Ok(());
            }
            if list.is_empty() {
                println!("No sessions yet. Start one with `sift begin \"<title>\"`.");
            }
            let active = ctx.store.get_active();
            for s in list {
                let n = ctx.store.notes(&s.id).len();
                let mark = if active.as_deref() == Some(&s.id) { '*' } else { ' ' };
                println!("{mark} {}  {:<6}  {:<8}  {n:>3} notes  {}", s.id, s.status, rel_time(&s.created_at), s.title);
            }
            Ok(())
        }
        Cmd::Use { id } => {
            let mut s = ctx.store.find_session(&id).unwrap_or_else(|| fail(format!("no session \"{id}\"")));
            if s.status == "closed" {
                s.status = "open".into();
                ctx.store.save_session(&mut s)?;
            }
            ctx.store.set_active(Some(&s.id))?;
            println!("Active session: {} {}", s.id, s.title);
            Ok(())
        }
        Cmd::Skill { .. } => unreachable!(),
    }
}

fn serve(ctx: &Ctx, a: ServeArgs) -> Result<()> {
    if !a.force {
        if let Some(info) = ctx.store.server_info() {
            let same = ping(info.port).is_some_and(|p| p["root"].as_str().map(PathBuf::from).as_ref() == Some(&ctx.root));
            if same {
                let url = format!("http://127.0.0.1:{}/", info.port);
                println!("Sift is already running for {}\n  {url}", ctx.root.display());
                if !a.no_open {
                    crate::server::open_browser(&url);
                }
                return Ok(());
            }
        }
    }
    let port = a.port.unwrap_or_else(|| default_port(&ctx.root));
    crate::server::run(Repo::open(ctx.root.clone()), a.host, port, !a.no_open)
}

fn import(ctx: &Ctx, src: &str) -> Result<()> {
    let text = if src == "-" { read_stdin() } else { std::fs::read_to_string(src).with_context(|| format!("reading {src}"))? };
    let doc: Value = serde_json::from_str(&text).unwrap_or_else(|e| fail(format!("import expects JSON: {e}")));
    let str_of = |v: &Value| v.as_str().map(String::from).or_else(|| (!v.is_null()).then(|| v.to_string()));
    let text_of = |n: &Value, k: &str| n.get(k).and_then(Value::as_str).map(String::from);

    // Parse and validate everything before writing, so a bad entry never leaves a half import behind.
    let mut inputs = Vec::new();
    for (i, n) in doc.get("notes").and_then(Value::as_array).into_iter().flatten().enumerate() {
        let num = |k: &str| n.get(k).and_then(Value::as_u64).map(|v| v as u32);
        let mut file = text_of(n, "file");
        let (mut line, mut end) = (num("line"), num("endLine").or_else(|| num("end_line")));
        if let (Some(f), None) = (&file, line) {
            let (pf, a, b) = parse_target(f);
            if a.is_some() {
                (file, line, end) = (Some(pf), a, b);
            }
        }
        let title = text_of(n, "title").filter(|t| !t.trim().is_empty());
        if title.is_none() {
            fail(format!("note {} has no title; nothing was imported.", i + 1));
        }
        let kind = text_of(n, "kind");
        parse_kind(kind.as_deref());
        inputs.push(NoteInput {
            file,
            line,
            end,
            at: text_of(n, "at"),
            to: text_of(n, "to"),
            old: n.get("side").and_then(Value::as_str) == Some("old") || n.get("old").and_then(Value::as_bool) == Some(true),
            kind,
            title,
            body: text_of(n, "body"),
            step: n.get("step").and_then(Value::as_i64),
        });
    }
    let files = doc.get("files").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut metas = Vec::new();
    for (path, m) in &files {
        // `"path": "high"` is short for `{"importance": "high"}`; any other string is a summary.
        let (importance, summary) = match m {
            Value::String(v) if IMPORTANCE.contains(&v.to_lowercase().as_str()) => (Some(parse_importance(v)), None),
            Value::String(v) => (None, Some(v.clone())),
            _ => (m.get("importance").and_then(Value::as_str).map(parse_importance), text_of(m, "summary")),
        };
        metas.push((ctx.repo_path(path), importance, summary));
    }

    let mut s = ctx.target(true)?;
    if let Some(t) = doc.get("title").and_then(str_of) {
        s.title = t;
    }
    if let Some(t) = doc.get("summary").and_then(str_of) {
        s.summary = Some(t);
    }
    if let Some(t) = doc.get("agent").and_then(str_of) {
        s.agent = Some(t);
    }
    for (rp, importance, summary) in metas {
        let e = s.files.entry(rp).or_default();
        e.importance = importance.or(e.importance.take());
        e.summary = summary.or(e.summary.take());
    }
    for g in doc.get("noise").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
        if !s.noise.iter().any(|x| x == g) {
            s.noise.push(g.into());
        }
    }
    ctx.store.save_session(&mut s)?;
    if doc.get("replace").and_then(Value::as_bool) == Some(true) {
        ctx.store.clear_notes(&s.id)?;
    }

    // Re-importing a corrected document replaces notes with the same file and title instead of
    // duplicating them, so a retry is always safe.
    let existing = ctx.store.notes(&s.id);
    let mut warn = Vec::new();
    let (mut count, mut replaced, mut steps) = (0, 0, 0);
    for input in inputs {
        let file = input.file.as_deref().map(|f| ctx.repo_path(f));
        for old in existing.iter().filter(|o| o.file == file && Some(&o.title) == input.title.as_ref()) {
            ctx.store.delete_note(old)?;
            replaced += 1;
        }
        steps += input.step.is_some() as usize;
        ctx.make_note(&s, input, &mut warn)?;
        count += 1;
    }
    for w in &warn {
        eprintln!("sift: {w}");
    }
    let mut out = format!("Imported into {}: {count} notes ({steps} in the walkthrough), {} file entries", s.id, files.len());
    if replaced > 0 {
        out.push_str(&format!(", replaced {replaced} earlier"));
    }
    out.push_str(if warn.is_empty() { ". All anchors resolved." } else { ". Fix the warnings above and re-import (same titles replace)." });
    println!("{out}");
    Ok(())
}

fn changes(ctx: &Ctx, source: Option<String>, all: bool, json: bool) -> Result<()> {
    let source = match source {
        Some(s) => s,
        None => match &ctx.session {
            Some(id) => format!("session:{id}"),
            None => ctx.store.get_active().map(|a| format!("session:{a}")).unwrap_or_else(|| "working".into()),
        },
    };
    let repo = Repo::open(ctx.root.clone());
    let r = repo.review(&source, false)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&json!({ "source": r.source, "files": r.files }))?);
        return Ok(());
    }
    let (adds, dels): (u32, u32) = r.files.iter().fold((0, 0), |a, f| (a.0 + f.additions, a.1 + f.deletions));
    println!("{}: {} files, +{adds} -{dels}  ({} ms)", r.source.label, r.files.len(), r.took_ms);
    let rank = |i: &str| IMPORTANCE.iter().position(|x| *x == i).unwrap_or(2);
    let mut files = r.files;
    files.sort_by(|a, b| rank(&a.importance).cmp(&rank(&b.importance)).then(a.path.cmp(&b.path)));
    let hidden: Vec<_> = if all { Vec::new() } else { files.iter().filter(|f| f.importance == "noise").cloned().collect() };
    files.retain(|f| all || f.importance != "noise");
    for f in files {
        let imp = if f.importance_source == "default" { String::new() } else { f.importance.clone() };
        let churn = if f.binary { "binary".to_string() } else { format!("+{} -{}", f.additions, f.deletions) };
        let summary = f.summary.map(|s| format!("  — {s}")).unwrap_or_default();
        println!("  {} {:<8} {:>12}  {}{}", f.status, imp, churn, f.path, summary);
    }
    if !hidden.is_empty() {
        let (a, d) = hidden.iter().fold((0, 0), |t, f| (t.0 + f.additions, t.1 + f.deletions));
        println!("  + {} noise files, +{a} -{d} (`sift changes --all` lists them)", hidden.len());
    }
    Ok(())
}

fn feedback(ctx: &Ctx, all: bool, as_json: bool) -> Result<()> {
    let mut items = ctx.store.feedback();
    if let Some(s) = ctx.session.as_deref().and_then(|id| ctx.store.find_session(id)) {
        items.retain(|f| f.session.is_none() || f.session.as_deref() == Some(&s.id));
    }
    if !all {
        items.retain(|f| f.status == "open");
    }
    if as_json {
        println!("{}", serde_json::to_string_pretty(&items)?);
        return Ok(());
    }
    if items.is_empty() {
        println!("{}", if all { "No review comments yet." } else { "No open review comments." });
        return Ok(());
    }
    println!(
        "{} {}review comment{} from the reviewer:\n",
        items.len(),
        if all { "" } else { "open " },
        if items.len() == 1 { "" } else { "s" }
    );
    for f in &items {
        let (mut line, mut end) = (f.line, f.end_line);
        let mut code: Vec<String> = Vec::new();
        if let (Some(file), Some(_)) = (&f.file, f.line) {
            let base = f.session.as_deref().and_then(|s| ctx.store.get_session(s)).map(|s| s.base);
            let lines = if f.side == "old" { base.and_then(|b| ctx.file_lines(Some(&b), file, true)) } else { ctx.file_lines(None, file, false) };
            let refs: Option<Vec<&str>> = lines.as_ref().map(|l| l.iter().map(String::as_str).collect());
            let r = resolve_anchor(refs.as_deref(), f.line, f.end_line, f.anchor.as_deref());
            (line, end) = (r.0, r.1);
            if r.2 {
                code.push("   (the commented line has changed since; showing its last known position)".into());
            }
            if let (Some(ls), Some(l)) = (&lines, line) {
                let last = end.unwrap_or(l);
                let from = l.saturating_sub(2).max(1);
                let to = (last + 2).min(ls.len() as u32);
                let w = to.to_string().len();
                for i in from..=to {
                    let mark = if i >= l && i <= last { '>' } else { ' ' };
                    code.push(format!("   {mark} {i:>w$} | {}", ls[i as usize - 1]));
                }
            }
        }
        let where_ = match &f.file {
            Some(file) => {
                let mut s = file.clone();
                if let Some(l) = line {
                    s.push_str(&format!(":{l}"));
                    if let Some(e) = end {
                        s.push_str(&format!("-{e}"));
                    }
                }
                if f.side == "old" {
                    s.push_str(" (removed code)");
                }
                s
            }
            None => "general".into(),
        };
        println!("[{}] {where_}{}", f.id, if f.status == "resolved" { "  (resolved)" } else { "" });
        for c in &code {
            println!("{c}");
        }
        for l in f.body.lines() {
            println!("   “ {l}");
        }
        for r in &f.replies {
            println!("     ↳ {}: {}", r.author, r.body.replace('\n', "\n       "));
        }
        println!();
    }
    println!("Reply with `sift reply <id> \"<what you did>\" --resolve` once each one is handled.");
    Ok(())
}

fn skill(action: &str, dir: Option<PathBuf>, force: bool) -> Result<()> {
    match action {
        "print" | "show" => {
            print!("{SKILL}");
            Ok(())
        }
        "path" => {
            let d = dir.unwrap_or_else(default_skills_dir).join("sift");
            println!("{}", d.display());
            Ok(())
        }
        "install" => {
            let target = dir.unwrap_or_else(default_skills_dir).join("sift");
            if let Ok(meta) = std::fs::symlink_metadata(&target) {
                if meta.file_type().is_symlink() || (meta.is_dir() && !target.join("SKILL.md").exists()) {
                    if !force {
                        bail!("{} already exists (a link or a folder sift did not write). Re-run with --force to replace it.", target.display());
                    }
                    if meta.file_type().is_symlink() || meta.is_file() {
                        std::fs::remove_file(&target)?;
                    } else {
                        std::fs::remove_dir_all(&target)?;
                    }
                }
            }
            std::fs::create_dir_all(&target)?;
            let file = target.join("SKILL.md");
            let changed = std::fs::read_to_string(&file).map(|s| s != SKILL).unwrap_or(true);
            std::fs::write(&file, SKILL)?;
            println!("{} skill: {}", if changed { "Installed" } else { "Up to date:" }, file.display());
            Ok(())
        }
        other => bail!("unknown skill action \"{other}\". Use install, path or print."),
    }
}

fn default_skills_dir() -> PathBuf {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default();
    home.join(".claude").join("skills")
}
