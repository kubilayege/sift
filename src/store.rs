//! Everything lives in `<repo>/.sift` (git-ignored by its own .gitignore):
//!   sessions/<id>.json         session meta (title, summary, file importance, noise globs)
//!   sessions/<id>.notes.jsonl  append-only note events, safe for several agents writing at once
//!   feedback.jsonl             append-only events for the human's comments and agent replies
//!   state.json                 UI state (viewed files, read notes)
//!   active                     id of the session agents write to by default
//!   server.json                port + pid of the running UI

use crate::types::{Feedback, Note, Reply, Session};
use crate::util::{now, short_id, write_atomic};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Store {
    pub dir: PathBuf,
}

#[derive(Serialize, Deserialize, Default, Debug)]
pub struct UiState {
    #[serde(default)]
    pub viewed: BTreeMap<String, String>,
    #[serde(default)]
    pub acked: Vec<String>,
}

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
pub struct ServerInfo {
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub pid: u32,
}

fn read_jsonl(path: &Path) -> Vec<Value> {
    let Ok(text) = fs::read_to_string(path) else { return Vec::new() };
    text.lines().filter(|l| !l.trim().is_empty()).filter_map(|l| serde_json::from_str(l).ok()).collect()
}

/// Shallow-merge `patch` (a JSON object) into `target`.
fn merge<T: Serialize + for<'de> Deserialize<'de>>(target: &T, patch: &Value) -> Option<T> {
    let mut v = serde_json::to_value(target).ok()?;
    if let (Some(obj), Some(p)) = (v.as_object_mut(), patch.as_object()) {
        for (k, val) in p {
            if val.is_null() {
                obj.remove(k);
            } else {
                obj.insert(k.clone(), val.clone());
            }
        }
    }
    serde_json::from_value(v).ok()
}

impl Store {
    pub fn new(root: &Path) -> Store {
        Store { dir: root.join(".sift") }
    }

    pub fn ensure(&self) -> Result<()> {
        fs::create_dir_all(self.dir.join("sessions"))?;
        let gi = self.dir.join(".gitignore");
        if !gi.exists() {
            fs::write(gi, "# Sift review data is local to this machine.\n*\n")?;
        }
        Ok(())
    }

    fn append(&self, path: &Path, ev: &Value) -> Result<()> {
        self.ensure()?;
        let mut line = serde_json::to_string(ev)?;
        line.push('\n');
        // One write() per event: appends of a single small buffer do not interleave.
        OpenOptions::new().create(true).append(true).open(path)?.write_all(line.as_bytes())?;
        Ok(())
    }

    // ---- sessions ------------------------------------------------------------------------

    fn session_path(&self, id: &str) -> PathBuf {
        self.dir.join("sessions").join(format!("{id}.json"))
    }

    fn notes_path(&self, id: &str) -> PathBuf {
        self.dir.join("sessions").join(format!("{id}.notes.jsonl"))
    }

    pub fn list_sessions(&self) -> Vec<Session> {
        let Ok(rd) = fs::read_dir(self.dir.join("sessions")) else { return Vec::new() };
        let mut out: Vec<Session> = rd
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
            .filter_map(|e| serde_json::from_slice(&fs::read(e.path()).ok()?).ok())
            .collect();
        out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        out
    }

    pub fn get_session(&self, id: &str) -> Option<Session> {
        if id.is_empty() || id.contains(['/', '\\', '.']) {
            return None;
        }
        serde_json::from_slice(&fs::read(self.session_path(id)).ok()?).ok()
    }

    /// Accepts a full id or a unique prefix.
    pub fn find_session(&self, id: &str) -> Option<Session> {
        if let Some(s) = self.get_session(id) {
            return Some(s);
        }
        let mut m: Vec<Session> = self.list_sessions().into_iter().filter(|s| s.id.starts_with(id)).collect();
        if m.len() == 1 { m.pop() } else { None }
    }

    pub fn save_session(&self, s: &mut Session) -> Result<()> {
        self.ensure()?;
        s.updated_at = now();
        let mut data = serde_json::to_vec_pretty(s)?;
        data.push(b'\n');
        write_atomic(&self.session_path(&s.id), &data)
    }

    pub fn new_session_id(&self) -> String {
        loop {
            let id = short_id(6);
            if !self.session_path(&id).exists() {
                return id;
            }
        }
    }

    pub fn get_active(&self) -> Option<String> {
        let s = fs::read_to_string(self.dir.join("active")).ok()?;
        let s = s.trim();
        if s.is_empty() { None } else { Some(s.to_string()) }
    }

    pub fn set_active(&self, id: Option<&str>) -> Result<()> {
        self.ensure()?;
        write_atomic(&self.dir.join("active"), id.map(|i| format!("{i}\n")).unwrap_or_default().as_bytes())
    }

    // ---- notes ---------------------------------------------------------------------------

    pub fn notes(&self, session: &str) -> Vec<Note> {
        let mut order: Vec<String> = Vec::new();
        let mut map: HashMap<String, Note> = HashMap::new();
        for ev in read_jsonl(&self.notes_path(session)) {
            match ev["op"].as_str() {
                Some("add") => {
                    if let Ok(n) = serde_json::from_value::<Note>(ev["note"].clone()) {
                        if !map.contains_key(&n.id) {
                            order.push(n.id.clone());
                        }
                        map.insert(n.id.clone(), n);
                    }
                }
                Some("update") => {
                    let id = ev["id"].as_str().unwrap_or_default();
                    if let Some(n) = map.get(id).and_then(|n| merge(n, &ev["patch"])) {
                        map.insert(id.to_string(), n);
                    }
                }
                Some("delete") => {
                    map.remove(ev["id"].as_str().unwrap_or_default());
                }
                _ => {}
            }
        }
        order.into_iter().filter_map(|id| map.remove(&id)).collect()
    }

    pub fn all_notes(&self) -> Vec<Note> {
        self.list_sessions().iter().flat_map(|s| self.notes(&s.id)).collect()
    }

    pub fn add_note(&self, mut note: Note) -> Result<Note> {
        note.id = short_id(5);
        note.created_at = now();
        self.append(&self.notes_path(&note.session), &json!({ "op": "add", "note": note }))?;
        Ok(note)
    }

    pub fn find_note(&self, id: &str) -> Option<Note> {
        let all = self.all_notes();
        if let Some(n) = all.iter().find(|n| n.id == id) {
            return Some(n.clone());
        }
        let m: Vec<&Note> = all.iter().filter(|n| n.id.starts_with(id)).collect();
        if m.len() == 1 { Some(m[0].clone()) } else { None }
    }

    pub fn update_note(&self, note: &Note, patch: Value) -> Result<()> {
        self.append(&self.notes_path(&note.session), &json!({ "op": "update", "id": note.id, "patch": patch }))
    }

    pub fn delete_note(&self, note: &Note) -> Result<()> {
        self.append(&self.notes_path(&note.session), &json!({ "op": "delete", "id": note.id }))
    }

    pub fn clear_notes(&self, session: &str) -> Result<()> {
        for n in self.notes(session) {
            self.delete_note(&n)?;
        }
        Ok(())
    }

    // ---- feedback ------------------------------------------------------------------------

    fn feedback_path(&self) -> PathBuf {
        self.dir.join("feedback.jsonl")
    }

    pub fn feedback(&self) -> Vec<Feedback> {
        let mut map: HashMap<String, Feedback> = HashMap::new();
        for ev in read_jsonl(&self.feedback_path()) {
            let id = ev["id"].as_str().unwrap_or_default();
            match ev["op"].as_str() {
                Some("add") => {
                    if let Ok(f) = serde_json::from_value::<Feedback>(ev["item"].clone()) {
                        map.insert(f.id.clone(), f);
                    }
                }
                Some("reply") => {
                    if let (Some(f), Ok(r)) = (map.get_mut(id), serde_json::from_value::<Reply>(ev["reply"].clone())) {
                        f.replies.push(r);
                    }
                }
                Some("status") => {
                    if let Some(f) = map.get_mut(id) {
                        f.status = ev["status"].as_str().unwrap_or("open").to_string();
                    }
                }
                Some("edit") => {
                    if let Some(f) = map.get_mut(id) {
                        f.body = ev["body"].as_str().unwrap_or_default().to_string();
                    }
                }
                Some("delete") => {
                    map.remove(id);
                }
                _ => {}
            }
        }
        let mut v: Vec<Feedback> = map.into_values().collect();
        v.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        v
    }

    pub fn find_feedback(&self, id: &str) -> Option<Feedback> {
        let all = self.feedback();
        if let Some(f) = all.iter().find(|f| f.id == id) {
            return Some(f.clone());
        }
        let m: Vec<&Feedback> = all.iter().filter(|f| f.id.starts_with(id)).collect();
        if m.len() == 1 { Some(m[0].clone()) } else { None }
    }

    pub fn add_feedback(&self, mut item: Feedback) -> Result<Feedback> {
        item.id = short_id(5);
        item.created_at = now();
        item.replies = Vec::new();
        item.status = "open".into();
        self.append(&self.feedback_path(), &json!({ "op": "add", "item": item }))?;
        Ok(item)
    }

    pub fn reply_feedback(&self, id: &str, author: &str, body: &str) -> Result<()> {
        let reply = Reply { author: author.into(), body: body.into(), created_at: now() };
        self.append(&self.feedback_path(), &json!({ "op": "reply", "id": id, "reply": reply }))
    }

    pub fn set_feedback_status(&self, id: &str, status: &str) -> Result<()> {
        self.append(&self.feedback_path(), &json!({ "op": "status", "id": id, "status": status }))
    }

    pub fn edit_feedback(&self, id: &str, body: &str) -> Result<()> {
        self.append(&self.feedback_path(), &json!({ "op": "edit", "id": id, "body": body }))
    }

    pub fn delete_feedback(&self, id: &str) -> Result<()> {
        self.append(&self.feedback_path(), &json!({ "op": "delete", "id": id }))
    }

    // ---- UI state ------------------------------------------------------------------------

    pub fn state(&self) -> UiState {
        fs::read(self.dir.join("state.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save_state(&self, s: &UiState) -> Result<()> {
        self.ensure()?;
        write_atomic(&self.dir.join("state.json"), &serde_json::to_vec_pretty(s)?)
    }

    pub fn server_info(&self) -> Option<ServerInfo> {
        let i: ServerInfo = serde_json::from_slice(&fs::read(self.dir.join("server.json")).ok()?).ok()?;
        if i.port == 0 { None } else { Some(i) }
    }

    pub fn save_server_info(&self, info: Option<&ServerInfo>) -> Result<()> {
        self.ensure()?;
        let data = match info {
            Some(i) => serde_json::to_vec(i)?,
            None => b"{}".to_vec(),
        };
        write_atomic(&self.dir.join("server.json"), &data)
    }
}
