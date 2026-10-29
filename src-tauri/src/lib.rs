//! Word Work desktop app: Tauri glue around `ww-core`.

mod ai_commands;
mod commands;
mod data_commands;
mod export_commands;
mod language_commands;
mod shell;
mod state;

use std::sync::atomic::Ordering;

use tauri::{Manager, RunEvent, WindowEvent};

pub fn run() {
    let app = tauri::Builder::default()
        // Must be first: a second launch just brings the open window forward.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .menu(shell::build_menu)
        .on_menu_event(|app, event| shell::on_menu(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            // Closing the window: save first (see shell::request_close).
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && !shell::CLOSE_CONFIRMED.load(Ordering::SeqCst) {
                    api.prevent_close();
                    shell::request_close(window.app_handle());
                }
            }
        })
        .setup(|app| {
            let state = state::AppState::new(app.handle())?;
            app.manage(state);
            // Phase 0: `WW_SPIKE=1 cargo tauri dev` runs the smoke test in the real
            // WebView and prints the results to stdout (debug builds only).
            #[cfg(debug_assertions)]
            if std::env::var_os("WW_SPIKE").is_some() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(4));
                    if let Some(w) = handle.get_webview_window("main") {
                        let _ = w.eval("window.wwSpike && window.wwSpike(true)");
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::health,
            language_commands::spell_check,
            language_commands::spell_suggest,
            language_commands::synonyms,
            language_commands::dict_get,
            language_commands::dict_add,
            language_commands::dict_replace,
            language_commands::dict_rename,
            language_commands::dict_remove,
            export_commands::export_formats,
            export_commands::export_save,
            export_commands::backup_save,
            export_commands::import_file,
            ai_commands::ai_genres,
            ai_commands::ai_status,
            ai_commands::ai_models,
            ai_commands::ai_chat,
            ai_commands::ai_cancel,
            ai_commands::ai_config_get,
            ai_commands::ai_config_set,
            commands::spike_report,
            data_commands::doc_list,
            data_commands::doc_create,
            data_commands::doc_get,
            data_commands::doc_save,
            data_commands::doc_rename,
            data_commands::doc_delete,
            data_commands::history_list,
            data_commands::history_snapshot,
            data_commands::history_get,
            data_commands::history_restore,
            data_commands::chat_list,
            data_commands::chat_get,
            data_commands::chat_save,
            data_commands::chat_delete,
            data_commands::trash_list,
            data_commands::trash_restore,
            data_commands::settings_get,
            data_commands::settings_put,
            data_commands::data_dir_get,
            data_commands::data_dir_choose,
            data_commands::data_dir_reveal,
            shell::close_confirmed,
            shell::toggle_fullscreen,
            shell::open_url,
            shell::clipboard_write_html,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Word Work");

    app.run(|app, event| {
        // ⌘Q from the Dock, logging out …: save first, like closing the window.
        // (`code` is set when we exit ourselves, after saving.)
        if let RunEvent::ExitRequested { code: None, api, .. } = event {
            if !shell::CLOSE_CONFIRMED.load(Ordering::SeqCst) && app.get_webview_window("main").is_some() {
                api.prevent_exit();
                shell::request_close(app);
            }
        }
    });
}
