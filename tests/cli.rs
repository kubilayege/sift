//! End-to-end: drive the real binary against a throwaway git repository.

use std::path::{Path, PathBuf};
use std::process::Command;

fn sift() -> &'static str {
    env!("CARGO_BIN_EXE_sift")
}

struct Repo(PathBuf);

impl Drop for Repo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn repo() -> Repo {
    let dir = std::env::temp_dir().join(format!("sift-test-{}-{}", std::process::id(), fastrand_like()));
    std::fs::create_dir_all(&dir).unwrap();
    let r = Repo(dir);
    git(&r.0, &["init", "-q", "-b", "main"]);
    git(&r.0, &["config", "user.email", "t@example.com"]);
    git(&r.0, &["config", "user.name", "T"]);
    write(&r.0, "src/a.ts", "export const a = 1;\nexport const b = 2;\nexport function f() {\n  return a + b;\n}\n");
    write(&r.0, "dirty.txt", "already dirty\n");
    git(&r.0, &["add", "src/a.ts"]);
    git(&r.0, &["commit", "-q", "-m", "init"]);
    r
}

/// Unique per test in this process: parallel tests can read the same clock tick (macOS has µs resolution).
fn fastrand_like() -> String {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{}-{n}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())
}

fn write(root: &Path, p: &str, s: &str) {
    let path = root.join(p);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, s).unwrap();
}

fn git(root: &Path, args: &[&str]) {
    let ok = Command::new("git").args(args).current_dir(root).status().unwrap().success();
    assert!(ok, "git {args:?}");
}

fn run(root: &Path, args: &[&str]) -> String {
    run_stdin(root, args, None)
}

fn run_stdin(root: &Path, args: &[&str], stdin: Option<&str>) -> String {
    use std::io::Write;
    let mut c = Command::new(sift());
    c.args(args).current_dir(root).env_remove("SIFT_SESSION");
    c.stdin(if stdin.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() });
    c.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = c.spawn().unwrap();
    if let Some(s) = stdin {
        child.stdin.take().unwrap().write_all(s.as_bytes()).unwrap();
    }
    let out = child.wait_with_output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout).into_owned() + &String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "sift {args:?} failed:\n{text}");
    text
}

#[test]
fn session_notes_and_feedback() {
    let r = repo();
    let root = &r.0;
    let out = run(root, &["begin", "Add multiply", "--agent", "test", "--json"]);
    let v: serde_json::Value = serde_json::from_str(out.trim()).unwrap();
    let sid = v["id"].as_str().unwrap().to_string();

    // Edits after the baseline: one modified file, one new file. dirty.txt was already dirty.
    write(root, "src/a.ts", "export const a = 1;\nexport const b = 3;\nexport function f() {\n  return a * b;\n}\n");
    write(root, "src/b.ts", "export const c = 4;\n");
    std::fs::remove_file(root.join("dirty.txt")).ok();
    write(root, "dirty.txt", "already dirty\n");

    let changes = run(root, &["changes", "--json"]);
    let c: serde_json::Value = serde_json::from_str(&changes).unwrap();
    let paths: Vec<&str> = c["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
    assert_eq!(paths, ["src/a.ts", "src/b.ts"], "baseline must exclude pre-existing dirt");
    assert_eq!(c["files"][0]["additions"], 2);

    let doc = r#"{
      "summary": "Multiply instead of add.",
      "files": { "src/a.ts": { "importance": "high", "summary": "the change" } },
      "notes": [
        { "file": "src/a.ts:4", "kind": "important", "title": "Now multiplies", "step": 1 },
        { "file": "src/a.ts", "line": 2, "endLine": 3, "kind": "why", "title": "b is 3" },
        { "kind": "todo", "title": "Tests" }
      ]
    }"#;
    let out = run_stdin(root, &["import", "-"], Some(doc));
    assert!(out.contains("3 notes (1 in the walkthrough)"), "{out}");
    let notes = run(root, &["notes", "--json"]);
    let n: serde_json::Value = serde_json::from_str(&notes).unwrap();
    let list = n["notes"].as_array().unwrap();
    assert_eq!(list.len(), 3);
    assert_eq!(list[0]["anchor"], "return a * b;");
    assert_eq!(list[1]["endLine"], 3);
    assert_eq!(n["session"]["files"]["src/a.ts"]["importance"], "high");

    // A comment from the reviewer, as the UI would write it, then the agent's reply.
    std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(root.join(".sift/feedback.jsonl"))
        .and_then(|mut f| {
            use std::io::Write;
            writeln!(
                f,
                r#"{{"op":"add","item":{{"id":"abcde","file":"src/a.ts","line":4,"side":"new","anchor":"return a * b;","body":"Overflow?","status":"open","session":"{sid}","createdAt":"2026-01-01T00:00:00.000Z","replies":[]}}}}"#
            )
        })
        .unwrap();
    let fb = run(root, &["feedback"]);
    assert!(fb.contains("[abcde] src/a.ts:4") && fb.contains("> 4 |   return a * b;"), "{fb}");
    run(root, &["reply", "abc", "Checked, fine.", "--resolve"]);
    assert!(run(root, &["feedback"]).contains("No open review comments"));

    // The comment follows its line when code is inserted above it.
    write(root, "src/a.ts", "// header\n// more\nexport const a = 1;\nexport const b = 3;\nexport function f() {\n  return a * b;\n}\n");
    assert!(run(root, &["feedback", "--all"]).contains("src/a.ts:6"));

    run(root, &["end"]);
    assert!(run(root, &["sessions"]).contains("closed"));
}

#[test]
fn notes_without_a_session_start_one() {
    let r = repo();
    let out = run(&r.0, &["note", "src/a.ts:2", "--kind", "risk", "--title", "Check this"]);
    assert!(out.contains("risk") && out.contains("src/a.ts:2"), "{out}");
    assert!(run(&r.0, &["status"]).contains("Untitled changes"));
}

#[test]
fn deleted_files_anchor_on_the_old_side() {
    let r = repo();
    run(&r.0, &["begin", "Remove a"]);
    std::fs::remove_file(r.0.join("src/a.ts")).unwrap();
    run(&r.0, &["note", "src/a.ts:4", "--title", "Gone"]);
    let n: serde_json::Value = serde_json::from_str(&run(&r.0, &["notes", "--json"])).unwrap();
    assert_eq!(n["notes"][0]["side"], "old");
    assert_eq!(n["notes"][0]["anchor"], "return a + b;");
}

#[test]
fn skill_prints() {
    let out = Command::new(sift()).args(["skill", "print"]).output().unwrap();
    assert!(String::from_utf8_lossy(&out.stdout).starts_with("---\nname: sift"));
}

#[test]
fn import_finds_lines_by_text_and_replaces_on_retry() {
    let r = repo();
    let root = &r.0;
    run(root, &["begin", "Text anchors"]);
    write(root, "src/a.ts", "export const a = 1;\nexport const b = 2;\nexport function f() {\n  return a + b;\n}\nexport const z = 9;\n");
    write(root, "src/x.meta", "guid: 1\n");
    let doc = r#"{
      "files": { "src/a.ts": "high", "src/x.meta": "Unity guid" },
      "notes": [
        { "file": "src/a.ts", "at": "export function f", "to": "}", "kind": "why", "title": "Whole function", "step": 1 },
        { "file": "src/a.ts", "at": "export const", "title": "Ambiguous" },
        { "file": "src/a.ts", "at": "export const", "line": 6, "title": "Near hint" },
        { "file": "src/a.ts", "at": "not in the file", "title": "Missing" }
      ]
    }"#;
    let out = run_stdin(root, &["import", "-"], Some(doc));
    assert!(out.contains("4 notes (1 in the walkthrough)"), "{out}");
    assert!(out.contains("is on lines 1, 2, 6; used 1"), "{out}");
    assert!(out.contains("\"not in the file\" not found"), "{out}");

    let n: serde_json::Value = serde_json::from_str(&run(root, &["notes", "--json"])).unwrap();
    let by_title = |t: &str| n["notes"].as_array().unwrap().iter().find(|x| x["title"] == t).unwrap().clone();
    assert_eq!((by_title("Whole function")["line"].clone(), by_title("Whole function")["endLine"].clone()), (3.into(), 5.into()));
    assert_eq!(by_title("Ambiguous")["line"], 1);
    assert_eq!(by_title("Near hint")["line"], 6);
    assert!(by_title("Missing")["line"].is_null());
    assert_eq!(n["session"]["files"]["src/a.ts"]["importance"], "high");
    assert_eq!(n["session"]["files"]["src/x.meta"]["summary"], "Unity guid");

    // A corrected re-import replaces notes with the same file and title.
    let fix = r#"{ "notes": [ { "file": "src/a.ts", "at": "export const z", "title": "Missing" } ] }"#;
    let out = run_stdin(root, &["import", "-"], Some(fix));
    assert!(out.contains("replaced 1 earlier") && out.contains("All anchors resolved"), "{out}");
    let n: serde_json::Value = serde_json::from_str(&run(root, &["notes", "--json"])).unwrap();
    assert_eq!(n["notes"].as_array().unwrap().len(), 4);

    // `sift note --at` works the same way.
    assert!(run(root, &["note", "src/a.ts", "--at", "return a + b", "--title", "Sum"]).contains("src/a.ts:4"));

    // Noise is counted, not listed, unless --all.
    let ch = run(root, &["changes"]);
    assert!(ch.contains("+ 1 noise files") && !ch.contains("src/x.meta"), "{ch}");
    assert!(run(root, &["changes", "--all"]).contains("src/x.meta"));
}

#[test]
fn invalid_import_writes_nothing() {
    let r = repo();
    run(&r.0, &["begin", "Bad import"]);
    let doc = r#"{ "notes": [ { "title": "fine" }, { "kind": "nope", "title": "bad kind" } ] }"#;
    let out = Command::new(sift()).args(["import", "-"]).current_dir(&r.0).stdin(std::process::Stdio::piped()).spawn().and_then(|mut c| {
        use std::io::Write;
        c.stdin.take().unwrap().write_all(doc.as_bytes())?;
        c.wait_with_output()
    });
    assert!(!out.unwrap().status.success());
    let n: serde_json::Value = serde_json::from_str(&run(&r.0, &["notes", "--json"])).unwrap();
    assert_eq!(n["notes"].as_array().unwrap().len(), 0);
}
