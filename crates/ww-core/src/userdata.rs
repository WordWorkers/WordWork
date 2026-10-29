//! Settings, AI conversations, trash and backup. Ported from `storage.py`;
//! same files and JSON layout.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::LazyLock;

use chrono::{NaiveDateTime, TimeZone, Utc};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::{Error, Result};
use crate::storage::{atomic_write, io_err, iso_seconds, move_path, now, read_text, to_json, Storage};
use crate::text::{count_words, validate_name};

pub const SETTINGS_FILE: &str = ".wordwork/settings.json";
pub const MAX_SETTINGS_BYTES: usize = 64_000;
pub const MAX_CHAT_BYTES: usize = 4_000_000;
pub const MAX_CHAT_MESSAGES: usize = 400;
const MESSAGE_FIELDS: [&str; 5] = ["content", "label", "thinking", "meta", "error"];

fn check_json_size(value: &impl Serialize, limit: usize, what: &str) -> Result<String> {
    let text = to_json(value);
    if text.len() > limit {
        return Err(Error::bad_request(format!("{what} är för stort (max {} kB).", limit / 1000)));
    }
    Ok(text)
}

// ---------------------------------------------------------------- settings

/// Settings as a JSON object. The frontend owns the format; we only store it.
pub struct SettingsStore {
    path: std::path::PathBuf,
    lock: Mutex<()>,
}

impl SettingsStore {
    pub fn new(root: &Path) -> Self {
        Self { path: root.join(SETTINGS_FILE), lock: Mutex::new(()) }
    }

    /// `None` if nothing has been saved yet. A broken file gives `{}` (defaults)
    /// instead of an error.
    pub fn read(&self) -> Option<Map<String, Value>> {
        let text = match fs::read_to_string(&self.path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
            Err(_) => return Some(Map::new()),
            Ok(t) => t,
        };
        match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(m)) => Some(m),
            _ => Some(Map::new()),
        }
    }

    pub fn write(&self, data: &Value) -> Result<Value> {
        if !data.is_object() {
            return Err(Error::new(422, "Inställningarna måste vara ett objekt."));
        }
        let text = check_json_size(data, MAX_SETTINGS_BYTES, "Inställningarna")?;
        let _g = self.lock.lock();
        atomic_write(&self.path, &format!("{text}\n"))?;
        Ok(data.clone())
    }
}

// ---------------------------------------------------------------- chats

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChatSummary {
    pub id: String,
    pub created: String,
    pub updated: String,
    pub model: String,
    pub title: String,
    pub messages: usize,
}

fn valid_chat_id(cid: &str) -> bool {
    (1..=64).contains(&cid.len()) && cid.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Checks that `name` exists and `cid` is a valid chat id (404 / 400).
pub fn check_chat_target(storage: &Storage, name: &str, cid: &str) -> Result<()> {
    storage.require(name)?;
    chat_path(storage, name, cid).map(|_| ())
}

fn chat_path(storage: &Storage, name: &str, cid: &str) -> Result<std::path::PathBuf> {
    if !valid_chat_id(cid) {
        return Err(Error::bad_request("Ogiltigt samtals-id."));
    }
    Ok(storage.chat_dir(name)?.join(format!("{cid}.json")))
}

/// Keeps role + known string fields; drops everything else (e.g. UI state).
fn clean_messages(messages: &Value) -> Result<Vec<Value>> {
    let list = messages.as_array().ok_or_else(|| Error::bad_request("Meddelandena måste vara en lista."))?;
    if list.len() > MAX_CHAT_MESSAGES {
        return Err(Error::bad_request(format!("Samtalet har för många meddelanden (max {MAX_CHAT_MESSAGES}).")));
    }
    list.iter()
        .map(|m| {
            let role = m.get("role").and_then(Value::as_str).filter(|r| *r == "user" || *r == "assistant");
            let Some(role) = role else { return Err(Error::bad_request("Ogiltigt meddelande.")) };
            let mut clean = Map::new();
            clean.insert("role".into(), role.into());
            for key in MESSAGE_FIELDS {
                if let Some(v) = m.get(key).and_then(Value::as_str).filter(|v| !v.is_empty()) {
                    clean.insert(key.into(), v.into());
                }
            }
            Ok(Value::Object(clean))
        })
        .collect()
}

fn chat_title(messages: &[Value]) -> String {
    for m in messages {
        if m.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let raw = m
            .get("label")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .or_else(|| m.get("content").and_then(Value::as_str))
            .unwrap_or("");
        let title = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        if !title.is_empty() {
            return if title.chars().count() <= 80 {
                title
            } else {
                format!("{}…", title.chars().take(79).collect::<String>())
            };
        }
    }
    "Tomt samtal".into()
}

fn chat_summary(chat: &Value) -> Option<ChatSummary> {
    let s = |k: &str| chat.get(k).and_then(Value::as_str).map(String::from);
    let messages = chat.get("messages")?.as_array()?;
    Some(ChatSummary {
        id: s("id")?,
        created: s("created")?,
        updated: s("updated")?,
        model: s("model").unwrap_or_default(),
        title: chat_title(messages),
        messages: messages.len(),
    })
}

/// The document's chats, most recently updated first.
pub fn list_chats(storage: &Storage, name: &str) -> Result<Vec<ChatSummary>> {
    storage.require(name)?;
    let folder = storage.chat_dir(name)?;
    let mut chats = Vec::new();
    if let Ok(entries) = fs::read_dir(&folder) {
        for e in entries.flatten() {
            let p = e.path();
            // Like Python's glob("*.json"): hidden files (e.g. ".tmp-…") don't count.
            if p.extension().and_then(|x| x.to_str()) != Some("json")
                || e.file_name().to_string_lossy().starts_with('.')
            {
                continue;
            }
            // A broken file must not hide the others.
            let chat = fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
            if let Some(summary) = chat.as_ref().and_then(chat_summary) {
                chats.push(summary);
            }
        }
    }
    chats.sort_by(|a, b| b.updated.cmp(&a.updated).then_with(|| a.id.cmp(&b.id)));
    Ok(chats)
}

pub fn read_chat(storage: &Storage, name: &str, cid: &str) -> Result<Value> {
    storage.require(name)?;
    let path = chat_path(storage, name, cid)?;
    if !path.is_file() {
        return Err(Error::not_found("Samtalet finns inte."));
    }
    serde_json::from_str(&read_text(&path)?).map_err(|e| Error::internal(format!("Trasigt samtal: {e}")))
}

/// Creates or replaces a chat. Returns its summary.
pub fn save_chat(storage: &Storage, name: &str, cid: &str, messages: &Value, model: &str) -> Result<ChatSummary> {
    let _g = storage.guard();
    storage.require(name)?;
    let path = chat_path(storage, name, cid)?;
    let now = iso_seconds(now());
    let created = fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("created").and_then(Value::as_str).map(String::from))
        .unwrap_or_else(|| now.clone());
    let mut chat = Map::new();
    chat.insert("id".into(), cid.into());
    chat.insert("created".into(), created.into());
    chat.insert("updated".into(), now.into());
    chat.insert("model".into(), model.chars().take(200).collect::<String>().into());
    chat.insert("messages".into(), Value::Array(clean_messages(messages)?));
    let chat = Value::Object(chat);
    let text = check_json_size(&chat, MAX_CHAT_BYTES, "Samtalet")?;
    atomic_write(&path, &format!("{text}\n"))?;
    Ok(chat_summary(&chat).expect("valid chat"))
}

/// Moves the chat to the trash.
pub fn delete_chat(storage: &Storage, name: &str, cid: &str) -> Result<()> {
    let _g = storage.guard();
    storage.require(name)?;
    let path = chat_path(storage, name, cid)?;
    if !path.exists() {
        return Err(Error::not_found("Samtalet finns inte."));
    }
    let name = validate_name(name)?;
    let suffix = format!(".chat-{cid}.json");
    let s = storage.free_stamp(&name, &[&suffix]);
    move_path(&path, &storage.trash_dir().join(format!("{s}-{name}{suffix}")))
}

/// Appends messages to a chat (creates it if missing). Used by the AI stream
/// so question and answer are saved even if the window closes.
pub fn append_chat(storage: &Storage, name: &str, cid: &str, messages: &[Value], model: &str) -> Result<ChatSummary> {
    let _g = storage.guard();
    storage.require(name)?;
    let path = chat_path(storage, name, cid)?;
    let mut combined: Vec<Value> = fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("messages").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    combined.extend_from_slice(messages);
    let start = combined.len().saturating_sub(MAX_CHAT_MESSAGES);
    save_chat(storage, name, cid, &Value::Array(combined.split_off(start)), model)
}

// ---------------------------------------------------------------- trash

static TRASH_DOC: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^(\d{8}T\d{6})-(.+)\.md$").expect("regex"));
static TRASH_CHAT: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^(\d{8}T\d{6})-(.+)\.chat-([0-9A-Za-z_-]{1,64})\.json$").expect("regex"));

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TrashItem {
    Document { id: String, name: String, deleted: String, words: usize, history: bool, chats: usize },
    Chat { id: String, name: String, deleted: String, title: String, messages: usize },
}

impl TrashItem {
    fn deleted(&self) -> &str {
        match self {
            TrashItem::Document { deleted, .. } | TrashItem::Chat { deleted, .. } => deleted,
        }
    }
}

fn stamp_iso(stamp: &str) -> String {
    NaiveDateTime::parse_from_str(stamp, "%Y%m%dT%H%M%S")
        .map(|t| iso_seconds(Utc.from_utc_datetime(&t)))
        .unwrap_or_default()
}

/// Deleted documents and chats, most recently deleted first.
pub fn list_trash(storage: &Storage) -> Result<Vec<TrashItem>> {
    let trash = storage.trash_dir();
    let mut names: Vec<String> = match fs::read_dir(&trash) {
        Ok(entries) => entries
            .flatten()
            .filter(|e| e.path().is_file()) // history/chat folders belong to a document
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect(),
        Err(_) => Vec::new(),
    };
    names.sort();
    let mut items = Vec::new();
    for file in names {
        let p = trash.join(&file);
        if let Some(m) = TRASH_DOC.captures(&file) {
            let (stamp, name) = (&m[1], &m[2]);
            let chats_dir = trash.join(format!("{stamp}-{name}.chats"));
            let chats = fs::read_dir(&chats_dir)
                .map(|it| {
                    it.flatten()
                        .filter(|e| {
                            e.path().extension().and_then(|x| x.to_str()) == Some("json")
                                && !e.file_name().to_string_lossy().starts_with('.')
                        })
                        .count()
                })
                .unwrap_or(0);
            items.push(TrashItem::Document {
                id: file.clone(),
                name: name.to_string(),
                deleted: stamp_iso(stamp),
                words: fs::read_to_string(&p).map(|t| count_words(&t)).unwrap_or(0),
                history: trash.join(format!("{stamp}-{name}.history")).is_dir(),
                chats,
            });
        } else if let Some(m) = TRASH_CHAT.captures(&file) {
            let chat = fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
            let messages = chat.as_ref().and_then(|c| c.get("messages")).and_then(Value::as_array);
            let (title, count) = match messages {
                Some(list) => (chat_title(list), list.len()),
                None => ("Samtal".to_string(), 0),
            };
            items.push(TrashItem::Chat {
                id: file.clone(),
                name: m[2].to_string(),
                deleted: stamp_iso(&m[1]),
                title,
                messages: count,
            });
        }
    }
    items.sort_by(|a, b| b.deleted().cmp(a.deleted()));
    Ok(items)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Restored {
    pub kind: &'static str,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

/// Restores an entry. A document gets a new name if its name is taken.
pub fn restore_trash(storage: &Storage, entry: &str) -> Result<Restored> {
    if entry.contains(['/', '\\']) || entry.starts_with('.') {
        return Err(Error::bad_request("Ogiltig post."));
    }
    let trash = storage.trash_dir();
    let src = trash.join(entry);
    if !src.is_file() {
        return Err(Error::not_found("Posten finns inte i papperskorgen."));
    }
    let _g = storage.guard();
    if let Some(m) = TRASH_DOC.captures(entry) {
        let (stamp, old) = (&m[1], &m[2]);
        let base = if storage.doc_path(old)?.exists() { format!("{old} (återställd)") } else { old.to_string() };
        let name = storage.unique_name(&base)?;
        move_path(&src, &storage.doc_path(&name)?)?;
        for (suffix, target) in [(".history", storage.hist_dir(&name)?), (".chats", storage.chat_dir(&name)?)] {
            let companion = trash.join(format!("{stamp}-{old}{suffix}"));
            if companion.is_dir() && !target.exists() {
                move_path(&companion, &target)?;
            }
        }
        return Ok(Restored { kind: "document", name, id: None });
    }
    if let Some(m) = TRASH_CHAT.captures(entry) {
        let (name, cid) = (m[2].to_string(), m[3].to_string());
        if !storage.doc_path(&name)?.is_file() {
            return Err(Error::bad_request(format!("Dokumentet ”{name}” finns inte. Återställ dokumentet först.")));
        }
        let mut target = chat_path(storage, &name, &cid)?;
        let mut n = 2;
        while target.exists() {
            let short: String = cid.chars().take(60).collect();
            target = chat_path(storage, &name, &format!("{short}-{n}"))?;
            n += 1;
        }
        move_path(&src, &target)?;
        let id = target.file_stem().map(|s| s.to_string_lossy().into_owned());
        return Ok(Restored { kind: "chat", name, id });
    }
    Err(Error::bad_request("Okänd post i papperskorgen."))
}

// ---------------------------------------------------------------- backup

/// The whole data folder as a zip (documents, history, chats, trash, settings).
pub fn backup_zip(storage: &Storage, out: &mut (impl Write + std::io::Seek)) -> Result<usize> {
    let _g = storage.guard();
    let root = storage.root();
    let mut files = Vec::new();
    collect_files(root, &mut files)?;
    files.sort();
    let mut zip = zip::ZipWriter::new(out);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let zerr = |e: zip::result::ZipError| Error::internal(format!("Zip: {e}"));
    for p in &files {
        let rel = p.strip_prefix(root).expect("under root");
        let rel = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
        zip.start_file(rel, opts).map_err(zerr)?;
        let data = fs::read(p).map_err(|e| io_err(p, e))?;
        zip.write_all(&data).map_err(|e| io_err(p, e))?;
    }
    zip.finish().map_err(zerr)?;
    Ok(files.len())
}

fn collect_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) -> Result<()> {
    for e in fs::read_dir(dir).map_err(|e| io_err(dir, e))?.flatten() {
        let p = e.path();
        let ft = e.file_type().map_err(|e| io_err(&p, e))?;
        if ft.is_dir() {
            collect_files(&p, out)?;
        } else if ft.is_file() && !e.file_name().to_string_lossy().starts_with(".tmp-") {
            out.push(p);
        }
    }
    Ok(())
}

/// Suggested file name for a backup made today.
pub fn backup_file_name() -> String {
    format!("word-work-{}.zip", chrono::Local::now().format("%Y-%m-%d"))
}
