//! Opening files from outside the app: "Open with Word Work" in Finder /
//! Explorer, double-click when Word Work is the default for .md, a file
//! dropped on the Dock icon, or a path on the command line.
//!
//! Word Work keeps its texts in the data folder, so:
//!  - a document that is already in the data folder is simply opened;
//!  - any other file is imported as a copy (like *Importera …*) – the original
//!    is never changed. Opening the same file again opens the earlier copy
//!    instead of making another one.
//!
//! The paths are queued here and `ww://open-files` tells the frontend, which
//! takes them with `opened_files` – also at startup, when the event may have
//! come before the page was ready.

use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use ww_core::convert::MAX_IMPORT_BYTES;
use ww_core::{Error, Result};

use crate::state::AppState;

#[derive(Default)]
pub struct OpenQueue(Mutex<Vec<PathBuf>>);

/// Queues files to open and tells the frontend.
pub fn open_paths(app: &AppHandle, paths: Vec<PathBuf>) {
    let paths: Vec<PathBuf> = paths.into_iter().filter(|p| p.is_file()).collect();
    if paths.is_empty() {
        return;
    }
    if let Some(queue) = app.try_state::<OpenQueue>() {
        queue.0.lock().extend(paths);
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    let _ = app.emit_to("main", "ww://open-files", ());
}

/// File arguments of a (second) launch: `args[0]` is the program; relative
/// paths are relative to the directory it was started in. Flags are ignored.
pub fn paths_from_args(args: &[String], cwd: &Path) -> Vec<PathBuf> {
    args.iter().skip(1).filter(|a| !a.starts_with('-')).map(|a| cwd.join(a)).collect()
}

#[derive(Debug, Serialize)]
pub struct Opened {
    /// The document to show.
    name: String,
    /// The file was imported as a copy (it was outside the data folder).
    imported: bool,
}

#[derive(Debug, Serialize)]
pub struct OpenedFiles {
    opened: Vec<Opened>,
    /// One message per file that couldn't be opened.
    errors: Vec<String>,
}

/// The queued files, opened or imported (in order).
#[tauri::command(rename_all = "snake_case")]
pub async fn opened_files(state: State<'_, AppState>, queue: State<'_, OpenQueue>) -> Result<OpenedFiles> {
    let paths: Vec<PathBuf> = std::mem::take(&mut *queue.0.lock());
    let (pandoc, ctx) = (state.pandoc.clone(), state.data());
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = OpenedFiles { opened: Vec::new(), errors: Vec::new() };
        for path in paths {
            let file = path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
            match open_one(&pandoc, &ctx.storage, &path) {
                Ok(o) => out.opened.push(o),
                Err(e) => out.errors.push(format!("”{file}”: {}", e.detail)),
            }
        }
        out
    })
    .await
    .map_err(|e| Error::internal(e.to_string()))
}

fn open_one(pandoc: &ww_core::convert::Pandoc, storage: &ww_core::storage::Storage, path: &Path) -> Result<Opened> {
    let path = dunce::canonicalize(path).map_err(|e| Error::not_found(e.to_string()))?;
    // Already a document in the data folder: open it.
    if path.parent() == Some(storage.root()) {
        if let Some(name) =
            path.file_name().and_then(|f| f.to_str()).and_then(|f| f.strip_suffix(ww_core::storage::EXT))
        {
            if !name.starts_with('.') {
                return Ok(Opened { name: name.to_string(), imported: false });
            }
        }
    }
    let size = std::fs::metadata(&path).map_err(|e| Error::not_found(e.to_string()))?.len();
    if size > MAX_IMPORT_BYTES as u64 {
        return Err(Error::bad_request("Filen är för stor (max 25 MB)."));
    }
    let data = std::fs::read(&path).map_err(|e| Error::internal(e.to_string()))?;
    let file_name = path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
    let (name, markdown) = pandoc.import(&file_name, &data)?;
    // Opened before: the copy with the same text is already there.
    if let Ok(doc) = storage.read(&name) {
        if doc.content == markdown {
            return Ok(Opened { name, imported: false });
        }
    }
    let info = storage.create(Some(&name), &markdown)?;
    Ok(Opened { name: info.name, imported: true })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args() {
        let cwd = Path::new("/home/x");
        let args: Vec<String> = ["word-work", "--flag", "a.md", "/tmp/b.md"].map(String::from).to_vec();
        assert_eq!(paths_from_args(&args, cwd), [PathBuf::from("/home/x/a.md"), PathBuf::from("/tmp/b.md")]);
    }

    #[test]
    fn inside_opens_outside_imports_once() {
        let data = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let storage = ww_core::storage::Storage::new(data.path(), 5.0);
        storage.create(Some("Hamlet"), "Text.\n").unwrap();
        // .md and .txt are read without Pandoc.
        let pandoc = ww_core::convert::Pandoc::new("/nonexistent/pandoc", "/nonexistent");
        let r = open_one(&pandoc, &storage, &data.path().join("Hamlet.md")).unwrap();
        assert_eq!((r.name.as_str(), r.imported), ("Hamlet", false));

        let file = outside.path().join("Krönika.md");
        std::fs::write(&file, "# Krönika\n\nHej.\n").unwrap();
        let r = open_one(&pandoc, &storage, &file).unwrap();
        assert_eq!((r.name.as_str(), r.imported), ("Krönika", true));
        // Again: the same copy, not "Krönika 2".
        let r = open_one(&pandoc, &storage, &file).unwrap();
        assert_eq!((r.name.as_str(), r.imported), ("Krönika", false));
        // Changed outside: a new copy next to the old one.
        std::fs::write(&file, "# Krönika\n\nHej igen.\n").unwrap();
        let r = open_one(&pandoc, &storage, &file).unwrap();
        assert_eq!((r.name.as_str(), r.imported), ("Krönika 2", true));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "# Krönika\n\nHej igen.\n");
        // original untouched
    }
}
