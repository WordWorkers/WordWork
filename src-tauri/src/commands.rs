//! Tauri commands. Errors are `ww_core::Error { status, detail }` so the
//! frontend's `ApiError` handling keeps working unchanged.
//!
//! This file: health and the development smoke test. The rest is grouped by
//! phase in `data_commands`, `language_commands`, `export_commands` and
//! `ai_commands`.

use serde::Serialize;
use tauri::State;
use ww_core::Result;

use crate::state::AppState;

#[derive(Serialize)]
pub struct Health {
    status: &'static str,
    version: &'static str,
    problem: Option<String>,
    ai: bool,
    language: bool,
    pandoc: Option<String>,
}

#[tauri::command]
pub async fn health(state: State<'_, AppState>) -> Result<Health> {
    // Checked once: health is polled every minute and Pandoc is a big binary.
    static PANDOC: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    let pandoc = match PANDOC.get() {
        Some(v) => v.clone(),
        None => {
            let p = state.pandoc.clone();
            let v = tauri::async_runtime::spawn_blocking(move || p.version().ok()).await.ok().flatten();
            PANDOC.get_or_init(|| v).clone()
        }
    };
    let problem = ww_core::storage::data_dir_problem(state.data().storage.root());
    Ok(Health {
        status: if problem.is_some() { "error" } else { "ok" },
        version: ww_core::VERSION,
        problem,
        ai: state.ai().is_some(),
        language: matches!(state.language.get(), Some(Ok(_))),
        pandoc,
    })
}

/// Phase 0: prints a smoke-test line from the WebView; `DONE` quits the app.
#[tauri::command]
pub fn spike_report(app: tauri::AppHandle, line: String) {
    // Development only: release builds ignore it (the WebView can't quit the app).
    if !cfg!(debug_assertions) {
        return;
    }
    println!("[spike] {line}");
    if line == "DONE" {
        app.exit(0);
    }
}
