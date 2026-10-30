//! Export, import and backup. Exports and backups ask where to save with the
//! native Save dialog (which remembers the folder). Imports arrive as raw
//! bytes from the file picker or a drop on the window.

use std::path::PathBuf;

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use ww_core::convert::{export_file_name, export_format, export_options, ExportOptions};
use ww_core::storage::DocumentInfo;
use ww_core::userdata::{backup_file_name, backup_zip};
use ww_core::{Error, Result};

use crate::state::AppState;

#[tauri::command(rename_all = "snake_case")]
pub fn export_formats() -> ExportOptions {
    export_options()
}

#[derive(Serialize)]
pub struct SavedFile {
    /// File name only – for the "Exporterade …" toast.
    file: String,
    path: String,
}

/// Native Save dialog; `None` if cancelled.
async fn ask_save_path(
    app: &AppHandle,
    state: &State<'_, AppState>,
    title: &str,
    file_name: String,
    filter: (&str, &str),
) -> Result<Option<PathBuf>> {
    let mut dialog = app.dialog().file().set_title(title).set_file_name(file_name);
    if let Some(dir) = state.save_dir(app) {
        dialog = dialog.set_directory(dir);
    }
    let (label, ext) = (filter.0.to_string(), filter.1.to_string());
    dialog = dialog.add_filter(label, &[ext.as_str()]);
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(|e| Error::internal(e.to_string()))?;
    match picked {
        None => Ok(None),
        Some(p) => Ok(Some(p.into_path().map_err(|e| Error::bad_request(e.to_string()))?)),
    }
}

fn write_file(state: &State<'_, AppState>, path: PathBuf, data: &[u8]) -> Result<SavedFile> {
    ww_core::storage::write_bytes_atomic(&path, data)?;
    state.remember_save_dir(&path);
    let file = path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(SavedFile { file, path: path.display().to_string() })
}

/// Converts first (so errors show before any dialog), then asks where to save.
#[tauri::command(rename_all = "snake_case")]
pub async fn export_save(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    format: String,
    template: Option<String>,
    chapters: Option<u8>,
) -> Result<Option<SavedFile>> {
    let fmt = export_format(&format)?;
    let (pandoc, ctx) = (state.pandoc.clone(), state.data());
    let doc_name = name.clone();
    let data = tauri::async_runtime::spawn_blocking(move || {
        let doc = ctx.storage.read(&doc_name)?;
        let template = template.unwrap_or_else(|| "standard".into());
        pandoc.export(&doc_name, &doc.content, fmt.key, &template, chapters.unwrap_or(0)).map(|(d, _)| d)
    })
    .await
    .map_err(|e| Error::internal(e.to_string()))??;
    let Some(path) =
        ask_save_path(&app, &state, "Exportera", export_file_name(&name, fmt), (fmt.label, fmt.ext)).await?
    else {
        return Ok(None);
    };
    write_file(&state, path, &data).map(Some)
}

/// The whole data folder as a zip.
#[tauri::command(rename_all = "snake_case")]
pub async fn backup_save(app: AppHandle, state: State<'_, AppState>) -> Result<Option<SavedFile>> {
    let ctx = state.data();
    let data = tauri::async_runtime::spawn_blocking(move || {
        let mut buf = std::io::Cursor::new(Vec::new());
        backup_zip(&ctx.storage, &mut buf)?;
        Ok::<_, Error>(buf.into_inner())
    })
    .await
    .map_err(|e| Error::internal(e.to_string()))??;
    let Some(path) = ask_save_path(&app, &state, "Ladda ner allt", backup_file_name(), ("Zip-arkiv", "zip")).await?
    else {
        return Ok(None);
    };
    write_file(&state, path, &data).map(Some)
}

/// Raw file bytes in the body, the file name (URI-encoded) in `x-filename`.
#[tauri::command(rename_all = "snake_case")]
pub async fn import_file(state: State<'_, AppState>, request: Request<'_>) -> Result<DocumentInfo> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err(Error::bad_request("Ingen fil."));
    };
    let filename = request
        .headers()
        .get("x-filename")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| Error::bad_request("Filnamn saknas."))?;
    let data = data.clone();
    let (pandoc, ctx) = (state.pandoc.clone(), state.data());
    tauri::async_runtime::spawn_blocking(move || {
        let (name, markdown) = pandoc.import(&filename, &data)?;
        ctx.storage.create(Some(&name), &markdown)
    })
    .await
    .map_err(|e| Error::internal(e.to_string()))?
}

/// `decodeURIComponent` for the header value (headers are ASCII only).
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    #[test]
    fn percent_decode() {
        assert_eq!(super::percent_decode("%C3%85lg%C3%A5ng%3A%20test.docx"), "Ålgång: test.docx");
        assert_eq!(super::percent_decode("plain.md"), "plain.md");
        assert_eq!(super::percent_decode("50%"), "50%");
    }
}
