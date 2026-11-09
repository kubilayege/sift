//! Data model shared by the CLI, the store and the HTTP API. Field names match the JSON the web UI
//! reads and the files earlier versions wrote, so existing `.sift` directories keep working.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const NOTE_KINDS: [&str; 7] = ["important", "why", "risk", "question", "verify", "todo", "info"];
pub const IMPORTANCE: [&str; 5] = ["critical", "high", "normal", "low", "noise"];

fn side_new() -> String {
    "new".into()
}

/// An agent's annotation, anchored to a line range, a whole file, or the session.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub session: String,
    pub kind: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    #[serde(default = "side_new")]
    pub side: String,
    /// Trimmed text of the anchor line when written; used to follow the line if it moves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<String>,
    /// Position in the guided walkthrough (1-based).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<i64>,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct FileMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub importance: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// Commit holding the working-tree snapshot taken when the session began.
    pub base: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_head: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default = "open")]
    pub status: String,
    #[serde(default)]
    pub files: BTreeMap<String, FileMeta>,
    #[serde(default)]
    pub noise: Vec<String>,
}

fn open() -> String {
    "open".into()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub author: String,
    pub body: String,
    #[serde(default)]
    pub created_at: String,
}

/// A comment the human left in the UI, for the agent to pick up.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Feedback {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    #[serde(default = "side_new")]
    pub side: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<String>,
    pub body: String,
    #[serde(default = "open")]
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub replies: Vec<Reply>,
}

/// Anything with a file/line anchor that the server re-resolves against the code being shown.
pub trait Anchored {
    fn file(&self) -> Option<&str>;
    fn side(&self) -> &str;
    fn anchor(&self) -> Option<&str>;
    fn range(&self) -> (Option<u32>, Option<u32>);
    fn set_range(&mut self, line: Option<u32>, end: Option<u32>);
}

macro_rules! anchored {
    ($t:ty) => {
        impl Anchored for $t {
            fn file(&self) -> Option<&str> {
                self.file.as_deref()
            }
            fn side(&self) -> &str {
                &self.side
            }
            fn anchor(&self) -> Option<&str> {
                self.anchor.as_deref()
            }
            fn range(&self) -> (Option<u32>, Option<u32>) {
                (self.line, self.end_line)
            }
            fn set_range(&mut self, line: Option<u32>, end: Option<u32>) {
                self.line = line;
                self.end_line = end;
            }
        }
    };
}
anchored!(Note);
anchored!(Feedback);

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Resolved<T> {
    #[serde(flatten)]
    pub item: T,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stale: Option<bool>,
    pub in_diff: bool,
}

/// One changed file in a review. Hunks are fetched separately (`/api/diff`) so huge changes stay cheap.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: String,
    pub binary: bool,
    pub additions: u32,
    pub deletions: u32,
    /// Lines the unified diff renders (context included) and the number of hunks: lets the UI
    /// reserve the right height before the file is loaded.
    pub rows: u32,
    pub hunks: u32,
    pub old_lines: u32,
    pub new_lines: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_blob: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_blob: Option<String>,
    /// "Viewed" marks are tied to this so they reset when the file changes again.
    pub hash: String,
    pub importance: String,
    pub importance_source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Too large to diff in the browser by default.
    pub large: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SourceOption {
    pub id: String,
    pub kind: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub repo: String,
    pub root: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub sources: Vec<SourceOption>,
    pub default_source: String,
    pub sessions: Vec<Session>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub source: SourceOption,
    pub base_rev: String,
    pub head_rev: String,
    pub files: Vec<FileEntry>,
    pub notes: Vec<Resolved<Note>>,
    pub feedback: Vec<Resolved<Feedback>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<Session>,
    pub viewed: BTreeMap<String, String>,
    pub acked: Vec<String>,
    pub generated_at: String,
    pub ignore_whitespace: bool,
    pub took_ms: u64,
}
