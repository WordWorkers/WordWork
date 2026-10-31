//! Notices documents that change outside the app – edited in another program,
//! synced by iCloud/Dropbox, added or removed in Finder – and tells the
//! frontend (`ww://files-changed` with the document names). The frontend
//! refreshes the document list and, if the open document changed, reloads it
//! or asks what to do (see `onFilesChanged` in main.ts).
//!
//! Only the documents themselves (`<data>/*.md`) are watched. The app's own
//! saves are reported too; the frontend recognises them because the file then
//! has exactly the text it saved.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

/// Collects quick bursts (a save is a temp file plus a rename) into one event.
const DEBOUNCE: Duration = Duration::from_millis(400);

#[derive(Default)]
pub struct Watcher(Mutex<Option<Debouncer<RecommendedWatcher>>>);

impl Watcher {
    /// Watches `dir` (the data folder), replacing any earlier watch. Failing to
    /// watch (e.g. a network drive) only means changes are noticed on save.
    pub fn start(&self, app: &AppHandle, dir: &Path) {
        let mut slot = self.0.lock();
        *slot = None;
        let root = dunce::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        let app = app.clone();
        let watched = root.clone();
        let debouncer = new_debouncer(DEBOUNCE, move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            let names: BTreeSet<String> = events.iter().filter_map(|e| doc_name(&watched, &e.path)).collect();
            if !names.is_empty() {
                let _ = app.emit_to("main", "ww://files-changed", names);
            }
        });
        match debouncer {
            Ok(mut d) => match d.watcher().watch(&root, RecursiveMode::NonRecursive) {
                Ok(()) => *slot = Some(d),
                Err(e) => log::warn!("can't watch {}: {e}", root.display()),
            },
            Err(e) => log::warn!("can't watch {}: {e}", root.display()),
        }
    }
}

/// The document name for a changed path: `<root>/<name>.md`, not hidden
/// (temp files start with a dot), not in a subfolder.
fn doc_name(root: &Path, path: &Path) -> Option<String> {
    let file = path.file_name()?.to_str()?;
    let name = file.strip_suffix(ww_core::storage::EXT)?;
    if name.is_empty() || file.starts_with('.') {
        return None;
    }
    let parent: PathBuf = path.parent()?.to_path_buf();
    let same = parent == root || dunce::canonicalize(&parent).is_ok_and(|p| p == root);
    same.then(|| name.to_string())
}

#[cfg(test)]
mod tests {
    use super::doc_name;
    use std::path::Path;

    #[test]
    fn only_documents_in_the_folder() {
        let root = Path::new("/data");
        assert_eq!(doc_name(root, Path::new("/data/Hamlet.md")), Some("Hamlet".into()));
        assert_eq!(doc_name(root, Path::new("/data/.tmp-abc.md")), None);
        assert_eq!(doc_name(root, Path::new("/data/.history/Hamlet/1.md")), None);
        assert_eq!(doc_name(root, Path::new("/data/bild.png")), None);
        assert_eq!(doc_name(root, Path::new("/annat/Hamlet.md")), None);
    }
}
