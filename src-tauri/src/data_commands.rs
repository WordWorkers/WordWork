//! Documents, history, chats, trash, settings and the data folder. The
//! frontend reaches each command through its route in `ipc-routes.ts`;
//! arguments are snake_case.

use std::sync::Arc;

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use ww_core::storage::{Document, DocumentInfo, Version};
use ww_core::userdata::{self, ChatSummary, Restored, TrashItem};
use ww_core::{Error, Result};

use crate::state::{AppState, DataCtx};

/// Runs file work off the main thread.
async fn blocking<T: Send + 'static>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&DataCtx) -> Result<T> + Send + 'static,
) -> Result<T> {
    let ctx: Arc<DataCtx> = state.data();
    tauri::async_runtime::spawn_blocking(move || f(&ctx)).await.map_err(|e| Error::internal(e.to_string()))?
}

// ---------------------------------------------------------------- documents

#[tauri::command(rename_all = "snake_case")]
pub async fn doc_list(state: State<'_, AppState>) -> Result<Vec<DocumentInfo>> {
    blocking(&state, |c| c.storage.list()).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn doc_create(
    state: State<'_, AppState>,
    name: Option<String>,
    content: Option<String>,
) -> Result<DocumentInfo> {
    blocking(&state, move |c| c.storage.create(name.as_deref(), content.as_deref().unwrap_or(""))).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn doc_get(state: State<'_, AppState>, name: String) -> Result<Document> {
    blocking(&state, move |c| c.storage.read(&name)).await
}

#[derive(Serialize)]
pub struct Saved {
    modified: f64,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn doc_save(
    state: State<'_, AppState>,
    name: String,
    content: String,
    base_modified: Option<f64>,
    snapshot: Option<bool>,
) -> Result<Saved> {
    blocking(&state, move |c| {
        let modified = c.storage.save(&name, &content, base_modified, snapshot.unwrap_or(false))?;
        Ok(Saved { modified })
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn doc_rename(state: State<'_, AppState>, name: String, new_name: String) -> Result<DocumentInfo> {
    blocking(&state, move |c| c.storage.rename(&name, &new_name)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn doc_delete(state: State<'_, AppState>, name: String) -> Result<()> {
    blocking(&state, move |c| c.storage.delete(&name)).await
}

// ---------------------------------------------------------------- history

#[tauri::command(rename_all = "snake_case")]
pub async fn history_list(state: State<'_, AppState>, name: String) -> Result<Vec<Version>> {
    blocking(&state, move |c| c.storage.history(&name)).await
}

#[derive(Serialize)]
pub struct Snapshot {
    created: bool,
    version: Option<Version>,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn history_snapshot(state: State<'_, AppState>, name: String, label: Option<String>) -> Result<Snapshot> {
    blocking(&state, move |c| {
        let label: String = label.unwrap_or_default().trim().chars().take(200).collect();
        let kind = if label.is_empty() { "manual" } else { "named" };
        let version = c.storage.snapshot(&name, kind, &label)?;
        Ok(Snapshot { created: version.is_some(), version })
    })
    .await
}

#[derive(Serialize)]
pub struct VersionText {
    id: String,
    content: String,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn history_get(state: State<'_, AppState>, name: String, vid: String) -> Result<VersionText> {
    blocking(&state, move |c| Ok(VersionText { content: c.storage.read_version(&name, &vid)?, id: vid })).await
}

#[derive(Serialize)]
pub struct RestoredVersion {
    modified: f64,
    content: String,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn history_restore(state: State<'_, AppState>, name: String, vid: String) -> Result<RestoredVersion> {
    blocking(&state, move |c| {
        let modified = c.storage.restore(&name, &vid)?;
        Ok(RestoredVersion { modified, content: c.storage.read(&name)?.content })
    })
    .await
}

// ---------------------------------------------------------------- chats

#[tauri::command(rename_all = "snake_case")]
pub async fn chat_list(state: State<'_, AppState>, name: String) -> Result<Vec<ChatSummary>> {
    blocking(&state, move |c| userdata::list_chats(&c.storage, &name)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn chat_get(state: State<'_, AppState>, name: String, cid: String) -> Result<Value> {
    blocking(&state, move |c| userdata::read_chat(&c.storage, &name, &cid)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn chat_save(
    state: State<'_, AppState>,
    name: String,
    cid: String,
    model: Option<String>,
    messages: Value,
) -> Result<ChatSummary> {
    blocking(&state, move |c| userdata::save_chat(&c.storage, &name, &cid, &messages, model.as_deref().unwrap_or("")))
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn chat_delete(state: State<'_, AppState>, name: String, cid: String) -> Result<()> {
    blocking(&state, move |c| userdata::delete_chat(&c.storage, &name, &cid)).await
}

// ---------------------------------------------------------------- trash

#[tauri::command(rename_all = "snake_case")]
pub async fn trash_list(state: State<'_, AppState>) -> Result<Vec<TrashItem>> {
    blocking(&state, |c| userdata::list_trash(&c.storage)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn trash_restore(state: State<'_, AppState>, entry: String) -> Result<Restored> {
    blocking(&state, move |c| userdata::restore_trash(&c.storage, &entry)).await
}

// ---------------------------------------------------------------- settings

#[derive(Serialize)]
pub struct SettingsResponse {
    saved: bool,
    settings: Map<String, Value>,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn settings_get(state: State<'_, AppState>) -> Result<SettingsResponse> {
    blocking(&state, |c| {
        let data = c.settings.read();
        Ok(SettingsResponse { saved: data.is_some(), settings: data.unwrap_or_default() })
    })
    .await
}

#[derive(Serialize)]
pub struct SettingsSaved {
    settings: Value,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn settings_put(state: State<'_, AppState>, settings: Value) -> Result<SettingsSaved> {
    blocking(&state, move |c| Ok(SettingsSaved { settings: c.settings.write(&settings)? })).await
}

// ---------------------------------------------------------------- data folder

#[derive(Serialize)]
pub struct DataDir {
    path: String,
    problem: Option<String>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn data_dir_get(state: State<'_, AppState>) -> DataDir {
    let ctx = state.data();
    let root = ctx.storage.root();
    DataDir { path: root.display().to_string(), problem: ww_core::storage::data_dir_problem(root) }
}

/// Native folder picker. Returns the new folder, or `None` if cancelled.
/// The frontend reloads afterwards so every panel reads the new folder.
#[tauri::command(rename_all = "snake_case")]
pub async fn data_dir_choose(app: AppHandle, state: State<'_, AppState>) -> Result<Option<DataDir>> {
    let current = state.data().storage.root().to_path_buf();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_title("Välj datamapp för Word Work").set_directory(current).blocking_pick_folder()
    })
    .await
    .map_err(|e| Error::internal(e.to_string()))?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| Error::bad_request(e.to_string()))?;
    state.set_data_dir(&path)?;
    Ok(Some(data_dir_get(state)))
}

/// Shows the data folder in Finder / Explorer / the file manager.
#[tauri::command(rename_all = "snake_case")]
pub fn data_dir_reveal(state: State<'_, AppState>) -> Result<()> {
    let root = state.data().storage.root().to_path_buf();
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener).arg(&root).spawn().map_err(|e| Error::internal(e.to_string()))?;
    Ok(())
}
