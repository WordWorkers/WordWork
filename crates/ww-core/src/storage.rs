//! File storage of documents (Markdown) and version history. Ported from
//! `storage.py`; the on-disk format is identical so the Docker version's data
//! folder can be opened as-is.
//!
//! ```text
//! <data>/<name>.md                     current documents
//! <data>/.history/<name>/index.json    version metadata
//! <data>/.history/<name>/<vid>.md      snapshots
//! <data>/.trash/<stamp>-<name>.md      deleted documents (never really deleted)
//! <data>/.chats/<name>/<id>.json       AI conversations about the document
//! <data>/.wordwork/settings.json       settings
//! ```
//!
//! Chats follow their document on rename and go to the trash with it.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use chrono::{DateTime, SecondsFormat, Utc};
use parking_lot::{ReentrantMutex, ReentrantMutexGuard};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::text::{count_words, validate_name};

pub const EXT: &str = ".md";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Version {
    pub id: String,
    /// ISO 8601, UTC
    pub created: String,
    /// "auto" | "manual" | "named" | "restore"
    pub kind: String,
    pub label: String,
    pub words: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DocumentInfo {
    pub id: String,
    pub name: String,
    pub modified: f64,
    pub words: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Document {
    pub id: String,
    pub name: String,
    pub content: String,
    pub modified: f64,
}

// ---------------------------------------------------------------- helpers

pub(crate) fn io_err(path: &Path, e: std::io::Error) -> Error {
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        Error::internal(format!("Rättighetsfel i datamappen: {} ({e})", path.display()))
    } else {
        Error::internal(format!("{}: {e}", path.display()))
    }
}

pub(crate) fn read_text(path: &Path) -> Result<String> {
    fs::read_to_string(path).map_err(|e| io_err(path, e))
}

/// Writes via a temp file in the same folder + fsync + rename, so a crash or a
/// backup taken mid-write never sees a half-written file.
pub fn atomic_write(path: &Path, text: &str) -> Result<()> {
    let dir = path.parent().ok_or_else(|| Error::internal("Ogiltig sökväg."))?;
    fs::create_dir_all(dir).map_err(|e| io_err(dir, e))?;
    let suffix = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let mut tmp =
        tempfile::Builder::new().prefix(".tmp-").suffix(&suffix).tempfile_in(dir).map_err(|e| io_err(dir, e))?;
    tmp.write_all(text.as_bytes()).map_err(|e| io_err(path, e))?;
    tmp.as_file().sync_all().map_err(|e| io_err(path, e))?;
    tmp.persist(path).map_err(|e| io_err(path, e.error))?;
    Ok(())
}

/// Like [`atomic_write`] for binary data (exports, backups).
pub fn write_bytes_atomic(path: &Path, data: &[u8]) -> Result<()> {
    let dir = path.parent().ok_or_else(|| Error::internal("Ogiltig sökväg."))?;
    let mut tmp = tempfile::Builder::new().prefix(".tmp-").tempfile_in(dir).map_err(|e| io_err(dir, e))?;
    tmp.write_all(data).map_err(|e| io_err(path, e))?;
    tmp.as_file().sync_all().map_err(|e| io_err(path, e))?;
    // Temp files are private (0600); an exported file should be like any other.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tmp.as_file().set_permissions(fs::Permissions::from_mode(0o644));
    }
    tmp.persist(path).map_err(|e| io_err(path, e.error))?;
    Ok(())
}

pub(crate) fn mtime(path: &Path) -> Result<f64> {
    let meta = fs::metadata(path).map_err(|e| io_err(path, e))?;
    let t = meta.modified().map_err(|e| io_err(path, e))?;
    Ok(t.duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0))
}

pub(crate) fn now() -> DateTime<Utc> {
    Utc::now()
}

/// Python's `datetime.isoformat()` for an aware UTC time: microseconds unless zero.
pub(crate) fn iso_micros(t: DateTime<Utc>) -> String {
    let s = if t.timestamp_subsec_micros() == 0 {
        t.to_rfc3339_opts(SecondsFormat::Secs, false)
    } else {
        t.to_rfc3339_opts(SecondsFormat::Micros, false)
    };
    s.replace('Z', "+00:00")
}

/// `isoformat(timespec="seconds")`
pub(crate) fn iso_seconds(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Secs, false).replace('Z', "+00:00")
}

/// Trash stamp, `%Y%m%dT%H%M%S`.
pub(crate) fn stamp(t: DateTime<Utc>) -> String {
    t.format("%Y%m%dT%H%M%S").to_string()
}

/// Python `json.dumps(…, ensure_ascii=False, indent=1)`.
pub(crate) fn to_json(value: &impl Serialize) -> String {
    let mut buf = Vec::new();
    let fmt = serde_json::ser::PrettyFormatter::with_indent(b" ");
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, fmt);
    value.serialize(&mut ser).expect("JSON serialisation");
    String::from_utf8(buf).expect("UTF-8")
}

fn is_version_id(vid: &str) -> bool {
    vid.len() == 21 && vid.as_bytes()[8] == b'T' && vid.bytes().enumerate().all(|(i, b)| i == 8 || b.is_ascii_digit())
}

/// Moves `src` to `dst`, falling back to copy + delete across file systems.
pub(crate) fn move_path(src: &Path, dst: &Path) -> Result<()> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| io_err(parent, e))?;
    }
    fs::rename(src, dst).map_err(|e| io_err(src, e))
}

// ---------------------------------------------------------------- storage

pub struct Storage {
    root: PathBuf,
    snapshot_minutes: f64,
    lock: ReentrantMutex<()>,
}

impl Storage {
    pub fn new(root: impl Into<PathBuf>, snapshot_minutes: f64) -> Self {
        let root = root.into();
        // Reported via `data_dir_problem` – the app should start anyway.
        let _ = fs::create_dir_all(&root);
        // dunce: plain `C:\…` paths on Windows instead of `\\?\C:\…` (shown in Inställningar).
        let root = dunce::canonicalize(&root).unwrap_or(root);
        Self { root, snapshot_minutes, lock: ReentrantMutex::new(()) }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn guard(&self) -> ReentrantMutexGuard<'_, ()> {
        self.lock.lock()
    }

    // ---------- paths ----------
    pub(crate) fn doc_path(&self, name: &str) -> Result<PathBuf> {
        Ok(self.root.join(format!("{}{EXT}", validate_name(name)?)))
    }

    pub(crate) fn hist_dir(&self, name: &str) -> Result<PathBuf> {
        Ok(self.root.join(".history").join(validate_name(name)?))
    }

    pub(crate) fn chat_dir(&self, name: &str) -> Result<PathBuf> {
        Ok(self.root.join(".chats").join(validate_name(name)?))
    }

    pub(crate) fn trash_dir(&self) -> PathBuf {
        self.root.join(".trash")
    }

    pub(crate) fn require(&self, name: &str) -> Result<PathBuf> {
        let path = self.doc_path(name)?;
        if !path.is_file() {
            return Err(Error::not_found(format!("Dokumentet ”{name}” finns inte.")));
        }
        Ok(path)
    }

    /// A free trash stamp for `<stamp>-<name><suffix>`: never overwrite an
    /// earlier deletion made in the same second.
    pub(crate) fn free_stamp(&self, name: &str, suffixes: &[&str]) -> String {
        let mut t = now();
        loop {
            let s = stamp(t);
            if suffixes.iter().all(|suf| !self.trash_dir().join(format!("{s}-{name}{suf}")).exists()) {
                return s;
            }
            t += chrono::Duration::seconds(1);
        }
    }

    // ---------- documents ----------
    pub fn list(&self) -> Result<Vec<DocumentInfo>> {
        let mut docs = Vec::new();
        let entries = fs::read_dir(&self.root).map_err(|e| io_err(&self.root, e))?;
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let Some(stem) = file_name.strip_suffix(EXT) else { continue };
            let path = entry.path();
            if file_name.starts_with('.') || !path.is_file() {
                continue;
            }
            let text = read_text(&path)?;
            docs.push(DocumentInfo {
                id: stem.to_string(),
                name: stem.to_string(),
                modified: mtime(&path)?,
                words: count_words(&text),
            });
        }
        docs.sort_by(|a, b| b.modified.total_cmp(&a.modified));
        Ok(docs)
    }

    pub fn read(&self, name: &str) -> Result<Document> {
        let path = self.require(name)?;
        Ok(Document {
            id: name.to_string(),
            name: name.to_string(),
            content: read_text(&path)?,
            modified: mtime(&path)?,
        })
    }

    pub fn unique_name(&self, base: &str) -> Result<String> {
        let base = validate_name(base)?;
        let mut candidate = base.clone();
        let mut n = 2;
        while self.doc_path(&candidate)?.exists() {
            candidate = format!("{base} {n}");
            n += 1;
        }
        Ok(candidate)
    }

    pub fn create(&self, name: Option<&str>, content: &str) -> Result<DocumentInfo> {
        let _g = self.guard();
        let name = self.unique_name(name.filter(|n| !n.trim().is_empty()).unwrap_or("Namnlös"))?;
        let path = self.doc_path(&name)?;
        atomic_write(&path, content)?;
        Ok(DocumentInfo { id: name.clone(), name, modified: mtime(&path)?, words: count_words(content) })
    }

    /// Saves; returns the new mtime. `base_modified` is the mtime the editor
    /// loaded – if the file changed since, it's a conflict (409).
    pub fn save(&self, name: &str, content: &str, base_modified: Option<f64>, snapshot: bool) -> Result<f64> {
        let _g = self.guard();
        let path = self.require(name)?;
        let current = mtime(&path)?;
        if let Some(base) = base_modified {
            if (current - base).abs() > 1e-3 {
                return Err(Error::conflict(
                    "Dokumentet har ändrats någon annanstans (t.ex. i en annan flik). Ladda om innan du sparar.",
                ));
            }
        }
        if read_text(&path)? != content {
            atomic_write(&path, content)?;
        }
        if snapshot {
            self.snapshot(name, "manual", "")?;
        } else {
            self.maybe_auto_snapshot(name, content)?;
        }
        mtime(&path)
    }

    pub fn rename(&self, old: &str, new: &str) -> Result<DocumentInfo> {
        let _g = self.guard();
        let src = self.require(old)?;
        let new = validate_name(new)?;
        if new == old {
            return Ok(DocumentInfo { id: old.to_string(), name: old.to_string(), modified: mtime(&src)?, words: 0 });
        }
        let dst = self.doc_path(&new)?;
        // On macOS (case-insensitive) "essä" → "Essä" finds the same file: allow it.
        let case_only = old.to_lowercase() == new.to_lowercase() && same_file(&src, &dst);
        if dst.exists() && !case_only {
            return Err(Error::conflict(format!("Det finns redan ett dokument som heter ”{new}”.")));
        }
        fs::rename(&src, &dst).map_err(|e| io_err(&src, e))?;
        for (old_dir, new_dir, suffix) in [
            (self.hist_dir(old)?, self.hist_dir(&new)?, ".history"),
            (self.chat_dir(old)?, self.chat_dir(&new)?, ".chats"),
        ] {
            if !old_dir.exists() {
                continue;
            }
            if new_dir.exists() && !case_only {
                // Leftovers under the new name: keep them, in the trash.
                let s = self.free_stamp(&new, &[suffix]);
                move_path(&new_dir, &self.trash_dir().join(format!("{s}-{new}{suffix}")))?;
            }
            move_path(&old_dir, &new_dir)?;
        }
        let text = read_text(&dst)?;
        Ok(DocumentInfo { id: new.clone(), name: new, modified: mtime(&dst)?, words: count_words(&text) })
    }

    /// Moves the document (and its history and chats) to the trash.
    pub fn delete(&self, name: &str) -> Result<()> {
        let _g = self.guard();
        let src = self.require(name)?;
        let name = validate_name(name)?;
        let s = self.free_stamp(&name, &[EXT, ".history", ".chats"]);
        let trash = self.trash_dir();
        move_path(&src, &trash.join(format!("{s}-{name}{EXT}")))?;
        for (dir, suffix) in [(self.hist_dir(&name)?, ".history"), (self.chat_dir(&name)?, ".chats")] {
            if dir.exists() {
                move_path(&dir, &trash.join(format!("{s}-{name}{suffix}")))?;
            }
        }
        Ok(())
    }

    // ---------- history ----------
    fn load_index(&self, name: &str) -> Result<Vec<Version>> {
        let f = self.hist_dir(name)?.join("index.json");
        if !f.exists() {
            return Ok(Vec::new());
        }
        serde_json::from_str(&read_text(&f)?)
            .map_err(|e| Error::internal(format!("Trasig versionslista för ”{name}”: {e}")))
    }

    fn save_index(&self, name: &str, versions: &[Version]) -> Result<()> {
        atomic_write(&self.hist_dir(name)?.join("index.json"), &to_json(&versions))
    }

    /// Newest first.
    pub fn history(&self, name: &str) -> Result<Vec<Version>> {
        self.require(name)?;
        let mut v = self.load_index(name)?;
        v.reverse();
        Ok(v)
    }

    pub fn read_version(&self, name: &str, vid: &str) -> Result<String> {
        self.require(name)?;
        let f = self.hist_dir(name)?.join(format!("{vid}{EXT}"));
        if !is_version_id(vid) || !f.is_file() {
            return Err(Error::not_found("Versionen finns inte."));
        }
        read_text(&f)
    }

    /// Saves a snapshot. Skipped if identical to the latest version (except for
    /// named versions, where the latest version gets the label).
    pub fn snapshot(&self, name: &str, kind: &str, label: &str) -> Result<Option<Version>> {
        let _g = self.guard();
        let path = self.require(name)?;
        let content = read_text(&path)?;
        let mut versions = self.load_index(name)?;
        if let Some(last) = versions.last() {
            if self.read_version(name, &last.id).ok().as_deref() == Some(content.as_str()) {
                if kind == "named" && !label.is_empty() {
                    let last = versions.last_mut().expect("non-empty");
                    last.label = label.to_string();
                    last.kind = "named".into();
                    let v = last.clone();
                    self.save_index(name, &versions)?;
                    return Ok(Some(v));
                }
                return Ok(None);
            }
        }
        let mut t = now();
        let mut vid = t.format("%Y%m%dT%H%M%S%6f").to_string();
        while versions.iter().any(|v| v.id == vid) {
            // Two versions in the same microsecond.
            t += chrono::Duration::microseconds(1);
            vid = t.format("%Y%m%dT%H%M%S%6f").to_string();
        }
        let v = Version {
            id: vid.clone(),
            created: iso_micros(t),
            kind: kind.into(),
            label: label.into(),
            words: count_words(&content),
        };
        atomic_write(&self.hist_dir(name)?.join(format!("{vid}{EXT}")), &content)?;
        versions.push(v.clone());
        self.save_index(name, &versions)?;
        Ok(Some(v))
    }

    fn maybe_auto_snapshot(&self, name: &str, content: &str) -> Result<()> {
        let versions = self.load_index(name)?;
        if let Some(last) = versions.last() {
            if let Ok(created) = DateTime::parse_from_rfc3339(&last.created) {
                let age = (now() - created.with_timezone(&Utc)).num_milliseconds() as f64 / 1000.0;
                if age < self.snapshot_minutes * 60.0 {
                    return Ok(());
                }
            }
        }
        if content.trim().is_empty() && versions.is_empty() {
            return Ok(());
        }
        self.snapshot(name, "auto", "")?;
        Ok(())
    }

    /// Restores a version. The current text is saved first – nothing is lost.
    pub fn restore(&self, name: &str, vid: &str) -> Result<f64> {
        let _g = self.guard();
        let content = self.read_version(name, vid)?;
        self.snapshot(name, "auto", "Före återställning")?;
        let path = self.doc_path(name)?;
        atomic_write(&path, &content)?;
        self.snapshot(name, "restore", "")?;
        mtime(&path)
    }
}

/// Same file on disk (e.g. two spellings on a case-insensitive file system)?
fn same_file(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (fs::metadata(a), fs::metadata(b)) {
            (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        // Windows resolves both spellings to the file's real name on disk.
        match (dunce::canonicalize(a), dunce::canonicalize(b)) {
            (Ok(x), Ok(y)) => x == y,
            _ => false,
        }
    }
}

/// Checks that the data folder is writable (common problem: permissions).
pub fn data_dir_problem(path: &Path) -> Option<String> {
    let probe = path.join(".wordwork").join(".skrivtest");
    let r = fs::create_dir_all(probe.parent().expect("parent"))
        .and_then(|_| fs::write(&probe, "ok"))
        .and_then(|_| fs::remove_file(&probe));
    r.err()
        .map(|e| format!("Kan inte skriva i datamappen {} ({e}). Kontrollera rättigheterna på mappen.", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_formats_match_python() {
        let t = DateTime::parse_from_rfc3339("2026-10-08T19:40:20.752989Z").unwrap().with_timezone(&Utc);
        assert_eq!(iso_micros(t), "2026-10-08T19:40:20.752989+00:00");
        assert_eq!(iso_seconds(t), "2026-10-08T19:40:20+00:00");
        assert_eq!(stamp(t), "20261008T194020");
        assert_eq!(t.format("%Y%m%dT%H%M%S%6f").to_string(), "20261008T194020752989");
        let whole = DateTime::parse_from_rfc3339("2026-10-08T19:40:20Z").unwrap().with_timezone(&Utc);
        assert_eq!(iso_micros(whole), "2026-10-08T19:40:20+00:00");
    }

    #[test]
    fn json_matches_python_indent_1() {
        let v =
            vec![Version { id: "a".into(), created: "c".into(), kind: "auto".into(), label: "Före".into(), words: 3 }];
        assert_eq!(
            to_json(&v),
            "[\n {\n  \"id\": \"a\",\n  \"created\": \"c\",\n  \"kind\": \"auto\",\n  \"label\": \"Före\",\n  \"words\": 3\n }\n]"
        );
        assert_eq!(to_json(&Vec::<Version>::new()), "[]");
    }

    #[test]
    fn version_ids() {
        assert!(is_version_id("20261008T194020752989"));
        assert!(!is_version_id("../../x"));
        assert!(!is_version_id("nope"));
        assert!(!is_version_id("20261008X194020752989"));
    }
}
