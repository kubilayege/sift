//! The local review server: JSON API, server-sent change events driven by a file watcher, and the
//! web UI embedded in the binary.

use crate::review::Repo;
use crate::store::{ServerInfo, UiState};
use crate::types::Feedback;
use anyhow::Result;
use axum::Router;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, Uri, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use notify::{EventKind, RecursiveMode, Watcher};
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::convert::Infallible;
use std::path::{Component, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tokio::sync::broadcast;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;

#[derive(RustEmbed)]
#[folder = "web/dist/"]
#[allow_missing = true]
struct Assets;

#[derive(Clone)]
struct AppState {
    repo: Arc<Repo>,
    tx: broadcast::Sender<String>,
}

fn error(status: StatusCode, msg: impl ToString) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], axum::Json(json!({ "error": msg.to_string() }))).into_response()
}

fn json_bytes(bytes: Vec<u8>, cache: &'static str) -> Response {
    ([(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, cache)], bytes).into_response()
}

fn ok_json(v: Value) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], axum::Json(v)).into_response()
}

/// Run CPU/IO-bound work off the async threads.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T, Response> {
    match tokio::task::spawn_blocking(f).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(error(StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}"))),
        Err(e) => Err(error(StatusCode::INTERNAL_SERVER_ERROR, e)),
    }
}

fn is_oid(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

// ---- handlers -----------------------------------------------------------------------------

async fn ping(State(st): State<AppState>) -> Response {
    ok_json(json!({ "ok": true, "app": "sift", "root": st.repo.root, "pid": std::process::id(), "version": env!("CARGO_PKG_VERSION") }))
}

async fn events(State(st): State<AppState>) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let hello = Event::default().event("hello").data(json!({ "watching": st.repo.watching.load(Ordering::SeqCst) }).to_string());
    let changes = BroadcastStream::new(st.tx.subscribe()).filter_map(|m| m.ok().map(|d| Ok(Event::default().event("change").data(d))));
    Sse::new(tokio_stream::once(Ok(hello)).chain(changes)).keep_alive(KeepAlive::new().interval(Duration::from_secs(20)))
}

async fn meta(State(st): State<AppState>) -> Response {
    let repo = st.repo.clone();
    match blocking(move || Ok(serde_json::to_vec(&repo.meta())?)).await {
        Ok(b) => json_bytes(b, "no-store"),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
struct ReviewQ {
    source: Option<String>,
    ws: Option<String>,
}

async fn review(State(st): State<AppState>, Query(q): Query<ReviewQ>) -> Response {
    let repo = st.repo.clone();
    let source = q.source.unwrap_or_else(|| "working".into());
    let ws = q.ws.as_deref() == Some("1");
    match blocking(move || Ok(serde_json::to_vec(&repo.review(&source, ws)?)?)).await {
        Ok(b) => json_bytes(b, "no-store"),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
struct DiffQ {
    a: Option<String>,
    b: Option<String>,
    path: String,
    ws: Option<String>,
}

async fn diff(State(st): State<AppState>, Query(q): Query<DiffQ>) -> Response {
    let a = q.a.filter(|s| !s.is_empty());
    let b = q.b.filter(|s| !s.is_empty());
    if a.as_deref().is_some_and(|s| !is_oid(s)) || b.as_deref().is_some_and(|s| !is_oid(s)) || (a.is_none() && b.is_none()) {
        return error(StatusCode::BAD_REQUEST, "Pass blob ids as a and/or b.");
    }
    let repo = st.repo.clone();
    let ws = q.ws.as_deref() == Some("1");
    match blocking(move || Ok(serde_json::to_vec(&repo.file_diff(&q.path, a.as_deref(), b.as_deref(), ws))?)).await {
        // Content-addressed: the same ids always produce the same diff.
        Ok(bytes) => json_bytes(bytes, "public, max-age=31536000, immutable"),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
struct LinesQ {
    blob: Option<String>,
    rev: Option<String>,
    path: String,
    ranges: Option<String>,
}

async fn lines(State(st): State<AppState>, Query(q): Query<LinesQ>) -> Response {
    let (spec, immutable) = match (q.blob.filter(|b| is_oid(b)), q.rev.filter(|r| is_oid(r))) {
        (Some(b), _) => (b, true),
        (None, Some(r)) => (format!("{r}:{}", q.path), true),
        _ => return error(StatusCode::BAD_REQUEST, "Pass blob, or rev and path."),
    };
    let ranges: Vec<(u32, u32)> = q
        .ranges
        .unwrap_or_default()
        .split(',')
        .filter_map(|r| {
            let (a, b) = r.split_once('-').unwrap_or((r, r));
            Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
        })
        .take(200)
        .collect();
    let repo = st.repo.clone();
    let path = q.path.clone();
    match blocking(move || Ok(serde_json::to_vec(&repo.lines(&spec, &path, &ranges))?)).await {
        Ok(b) => json_bytes(b, if immutable { "public, max-age=31536000, immutable" } else { "no-store" }),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewFeedback {
    body: Option<String>,
    file: Option<String>,
    line: Option<u32>,
    end_line: Option<u32>,
    side: Option<String>,
    rev: Option<String>,
    session: Option<String>,
}

async fn add_feedback(State(st): State<AppState>, axum::Json(b): axum::Json<NewFeedback>) -> Response {
    let Some(body) = b.body.filter(|s| !s.trim().is_empty()) else {
        return error(StatusCode::BAD_REQUEST, "Comment text is required.");
    };
    let repo = st.repo.clone();
    let res = blocking(move || {
        let file = b.file.filter(|f| !f.is_empty());
        let line = b.line.filter(|l| *l > 0);
        let anchor = match (&file, line, b.rev.as_deref().filter(|r| is_oid(r))) {
            (Some(f), Some(l), Some(rev)) => repo.cat.read(&format!("{rev}:{f}")).and_then(|d| {
                let text = String::from_utf8_lossy(&d);
                crate::util::split_lines(&text).get(l as usize - 1).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
            }),
            _ => None,
        };
        let item = Feedback {
            end_line: b.end_line.filter(|e| line.is_some_and(|l| *e > l)),
            file,
            line,
            side: if b.side.as_deref() == Some("old") { "old".into() } else { "new".into() },
            anchor,
            body,
            session: b.session.filter(|s| !s.is_empty()),
            ..Default::default()
        };
        Ok(serde_json::to_value(repo.store.add_feedback(item)?)?)
    })
    .await;
    match res {
        Ok(v) => {
            let _ = st.tx.send(json!({ "kinds": ["notes"] }).to_string());
            ok_json(v)
        }
        Err(e) => e,
    }
}

async fn feedback_action(State(st): State<AppState>, method: axum::http::Method, Path(rest): Path<String>, body: axum::body::Bytes) -> Response {
    let mut parts = rest.splitn(2, '/');
    let id = parts.next().unwrap_or_default().to_string();
    let action = parts.next().map(String::from);
    let b: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let repo = st.repo.clone();
    let res = blocking(move || {
        let Some(item) = repo.store.find_feedback(&id) else { return Ok(false) };
        if method == axum::http::Method::DELETE {
            repo.store.delete_feedback(&item.id)?;
        } else {
            match action.as_deref() {
                Some("reply") => repo.store.reply_feedback(&item.id, "user", b["body"].as_str().unwrap_or_default())?,
                Some("status") => {
                    repo.store.set_feedback_status(&item.id, if b["status"] == "resolved" { "resolved" } else { "open" })?
                }
                _ => {
                    if let Some(body) = b["body"].as_str() {
                        repo.store.edit_feedback(&item.id, body)?
                    }
                }
            }
        }
        Ok(true)
    })
    .await;
    match res {
        Ok(true) => {
            let _ = st.tx.send(json!({ "kinds": ["notes"] }).to_string());
            ok_json(json!({ "ok": true }))
        }
        Ok(false) => error(StatusCode::NOT_FOUND, "Comment not found."),
        Err(e) => e,
    }
}

async fn viewed(State(st): State<AppState>, axum::Json(b): axum::Json<Value>) -> Response {
    let repo = st.repo.clone();
    match blocking(move || {
        let mut s: UiState = repo.store.state();
        if let Some(files) = b["files"].as_object() {
            for (path, hash) in files {
                match hash.as_str() {
                    Some(h) if !h.is_empty() => {
                        s.viewed.insert(path.clone(), h.to_string());
                    }
                    _ => {
                        s.viewed.remove(path);
                    }
                }
            }
        }
        repo.store.save_state(&s)?;
        Ok(json!({ "viewed": s.viewed }))
    })
    .await
    {
        Ok(v) => ok_json(v),
        Err(e) => e,
    }
}

async fn ack(State(st): State<AppState>, axum::Json(b): axum::Json<Value>) -> Response {
    let repo = st.repo.clone();
    match blocking(move || {
        let mut s = repo.store.state();
        let mut set: Vec<String> = s.acked.clone();
        let on = b["acked"].as_bool().unwrap_or(false);
        for id in b["ids"].as_array().into_iter().flatten().filter_map(|v| v.as_str()) {
            set.retain(|x| x != id);
            if on {
                set.push(id.to_string());
            }
        }
        s.acked = set;
        repo.store.save_state(&s)?;
        Ok(json!({ "acked": s.acked }))
    })
    .await
    {
        Ok(v) => ok_json(v),
        Err(e) => e,
    }
}

fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "png" => "image/png",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

async fn static_files(uri: Uri) -> Response {
    let p = uri.path().trim_start_matches('/');
    if p.starts_with("api/") {
        return error(StatusCode::NOT_FOUND, "Not found");
    }
    let (path, file) = match Assets::get(p).filter(|_| !p.is_empty()) {
        Some(f) => (p, f),
        None => match Assets::get("index.html") {
            Some(f) => ("index.html", f),
            None => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "This sift binary was built without its UI. Run `npm install && npm run build`, then `cargo build --release`.",
                )
                    .into_response();
            }
        },
    };
    let cache = if path.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-store" };
    Response::builder()
        .header(header::CONTENT_TYPE, mime(path))
        .header(header::CACHE_CONTROL, cache)
        .body(Body::from(file.data.into_owned()))
        .unwrap()
}

// ---- file watching ------------------------------------------------------------------------

/// Directories whose churn never affects the diff.
const IGNORED: &[&str] = &["node_modules", "Library", "Temp", "Logs", "obj", ".vs", ".idea", ".gradle", ".cache", "UserSettings"];

fn classify_path(roots: &[PathBuf], path: &std::path::Path, gi: &ignore::gitignore::Gitignore) -> Option<&'static str> {
    let rel = roots.iter().find_map(|r| path.strip_prefix(r).ok())?;
    let parts: Vec<String> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    let first = parts.first()?.as_str();
    let second = parts.get(1).map(String::as_str).unwrap_or("");
    if first == ".sift" {
        if second == "server.json" || parts.last()?.ends_with(".tmp") {
            return None;
        }
        return Some("notes");
    }
    if first == ".git" {
        return match second {
            "HEAD" | "index" | "refs" | "packed-refs" => Some("git"),
            "logs" if parts.get(2).map(String::as_str) == Some("HEAD") => Some("git"),
            _ => None,
        };
    }
    if parts.iter().any(|p| IGNORED.contains(&p.as_str())) {
        return None;
    }
    if gi.matched_path_or_any_parents(rel, false).is_ignore() {
        return None;
    }
    Some("files")
}

fn start_watcher(repo: Arc<Repo>, tx: broadcast::Sender<String>) -> Option<notify::RecommendedWatcher> {
    let (etx, erx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(etx).ok()?;
    watcher.watch(&repo.root, RecursiveMode::Recursive).ok()?;
    repo.watching.store(true, Ordering::SeqCst);

    let mut b = ignore::gitignore::GitignoreBuilder::new(&repo.root);
    b.add(repo.root.join(".gitignore"));
    b.add(repo.root.join(".git").join("info").join("exclude"));
    let gi = b.build().unwrap_or_else(|_| ignore::gitignore::Gitignore::empty());
    let mut roots = vec![repo.root.clone()];
    if let Ok(c) = repo.root.canonicalize() {
        if c != repo.root {
            roots.push(c);
        }
    }

    std::thread::spawn(move || {
        let mut pending: HashSet<&'static str> = HashSet::new();
        let mut first: Option<Instant> = None;
        let mut deadline: Option<Instant> = None;
        loop {
            let wait = deadline.map(|d| d.saturating_duration_since(Instant::now())).unwrap_or(Duration::from_secs(3600));
            match erx.recv_timeout(wait) {
                Ok(Ok(ev)) => {
                    if matches!(ev.kind, EventKind::Access(_)) {
                        continue;
                    }
                    for p in &ev.paths {
                        let Some(kind) = classify_path(&roots, p, &gi) else { continue };
                        if kind != "notes" {
                            repo.invalidate();
                        }
                        pending.insert(kind);
                        let now = Instant::now();
                        let start = *first.get_or_insert(now);
                        let quiet = if kind == "notes" && !pending.contains("files") { 100 } else { 300 };
                        // Debounce, but never hold updates back for more than a second and a half.
                        deadline = Some((now + Duration::from_millis(quiet)).min(start + Duration::from_millis(1500)));
                    }
                }
                Ok(Err(_)) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if !pending.is_empty() {
                        let kinds: Vec<&str> = pending.drain().collect();
                        let _ = tx.send(json!({ "kinds": kinds }).to_string());
                    }
                    first = None;
                    deadline = None;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });
    Some(watcher)
}

pub fn open_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("cmd").args(["/c", "start", "", url]).spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let r = std::process::Command::new("xdg-open").arg(url).spawn();
    let _ = r;
}

pub fn run(repo: Arc<Repo>, host: String, want_port: u16, open: bool) -> Result<()> {
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    rt.block_on(async move {
        let mut bound = None;
        for p in want_port..want_port.saturating_add(50) {
            if let Ok(l) = tokio::net::TcpListener::bind((host.as_str(), p)).await {
                bound = Some((l, p));
                break;
            }
        }
        let Some((listener, port)) = bound else { anyhow::bail!("no free port near {want_port}") };
        crate::highlight::warm_up();
        let (tx, _) = broadcast::channel::<String>(64);
        let _watcher = start_watcher(repo.clone(), tx.clone());
        repo.store.ensure()?;
        repo.store.save_server_info(Some(&ServerInfo { port, pid: std::process::id() }))?;

        let url = format!("http://127.0.0.1:{port}/");
        println!("Sift is reviewing {}\n  {url}\nPress Ctrl+C to stop.", repo.root.display());
        if open {
            open_browser(&url);
        }

        let state = AppState { repo: repo.clone(), tx };
        let app = Router::new()
            .route("/api/ping", get(ping))
            .route("/api/events", get(events))
            .route("/api/meta", get(meta))
            .route("/api/review", get(review))
            .route("/api/diff", get(diff))
            .route("/api/lines", get(lines))
            .route("/api/feedback", post(add_feedback))
            .route("/api/feedback/{*rest}", post(feedback_action).delete(feedback_action))
            .route("/api/viewed", post(viewed))
            .route("/api/ack", post(ack))
            .fallback(static_files)
            .with_state(state);

        // SSE connections never finish on their own, so exit directly instead of draining them.
        let store = repo.store.clone();
        tokio::spawn(async move {
            let ctrl_c = tokio::signal::ctrl_c();
            #[cfg(unix)]
            {
                let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal");
                tokio::select! { _ = ctrl_c => {}, _ = term.recv() => {} }
            }
            #[cfg(not(unix))]
            let _ = ctrl_c.await;
            if store.server_info().is_some_and(|i| i.pid == std::process::id()) {
                let _ = store.save_server_info(None);
            }
            std::process::exit(0);
        });
        axum::serve(listener, app).await?;
        Ok(())
    })
}
