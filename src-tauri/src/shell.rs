//! Phase 5: the Mac shell around the editor – Swedish menu bar, safe close
//! and quit (the text is always saved first), full screen, external links in
//! the default browser and rich text on the clipboard.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::menu::{AboutMetadata, Menu, MenuItem, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};
use ww_core::{Error, Result};

#[cfg(target_os = "macos")]
const FULLSCREEN_KEY: &str = "Ctrl+Cmd+F";
#[cfg(not(target_os = "macos"))]
const FULLSCREEN_KEY: &str = "F11";

/// Menu item ids are sent to the frontend as-is (`ww://menu`).
const MENU: &[(&str, &str, Option<&str>)] = &[
    // id, label, accelerator
    ("settings", "Inställningar …", Some("CmdOrCtrl+,")),
    ("new", "Nytt dokument", Some("CmdOrCtrl+N")),
    ("documents", "Dokument …", Some("CmdOrCtrl+O")),
    ("import", "Importera …", Some("CmdOrCtrl+Shift+O")),
    ("export", "Exportera …", Some("CmdOrCtrl+E")),
    ("publish", "Kopiera för publicering", Some("CmdOrCtrl+Shift+C")),
    ("save", "Spara version", Some("CmdOrCtrl+S")),
    ("history", "Versionshistorik …", None),
    ("trash", "Papperskorgen …", None),
    ("backup", "Spara allt (zip) …", None),
    ("find", "Sök …", Some("CmdOrCtrl+F")),
    ("replace", "Sök och ersätt …", Some("CmdOrCtrl+Alt+F")),
    ("chars", "Infoga tecken …", Some("CmdOrCtrl+.")),
    ("note", "Egen anteckning", Some("CmdOrCtrl+Alt+M")),
    ("comment", "Kommentera …", Some("CmdOrCtrl+Alt+K")),
    ("footnote", "Infoga fotnot …", Some("CmdOrCtrl+Alt+N")),
    ("typography", "Rätta typografin i texten …", None),
    ("view", "Växla Skriv/Markdown", Some("CmdOrCtrl+/")),
    ("meta", "Metadata", None),
    ("analysis", "Analys", None),
    ("ai", "AI-assistent", Some("CmdOrCtrl+J")),
    ("fullscreen", "Helskärm", Some(FULLSCREEN_KEY)),
    ("shortcuts", "Kortkommandon", Some("F1")),
    ("quit", "Avsluta Word Work", Some("CmdOrCtrl+Q")),
];

fn item<R: Runtime>(app: &AppHandle<R>, id: &str) -> tauri::Result<MenuItem<R>> {
    let (_, label, accel) = MENU.iter().find(|(i, _, _)| *i == id).expect("menu id");
    let mut b = MenuItemBuilder::with_id(id, *label);
    if let Some(a) = accel {
        b = b.accelerator(*a);
    }
    b.build(app)
}

pub fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let sep = || PredefinedMenuItem::separator(app);
    let about = AboutMetadata {
        name: Some("Word Work".into()),
        version: Some(ww_core::VERSION.into()),
        copyright: Some("© 2026 Mikke Schirén – Apache License 2.0".into()),
        comments: Some("En lugn, distraktionsfri ordbehandlare för kulturjournalister och författare.".into()),
        ..Default::default()
    };

    let app_menu: Submenu<R> = SubmenuBuilder::new(app, "Word Work")
        .item(&PredefinedMenuItem::about(app, Some("Om Word Work"), Some(about))?)
        .item(&sep()?)
        .item(&item(app, "settings")?)
        .item(&sep()?)
        .item(&PredefinedMenuItem::services(app, Some("Tjänster"))?)
        .item(&sep()?)
        .item(&PredefinedMenuItem::hide(app, Some("Göm Word Work"))?)
        .item(&PredefinedMenuItem::hide_others(app, Some("Göm övriga"))?)
        .item(&PredefinedMenuItem::show_all(app, Some("Visa alla"))?)
        .item(&sep()?)
        // Our own Quit, so the text is saved before the app exits.
        .item(&item(app, "quit")?)
        .build()?;

    let file = SubmenuBuilder::new(app, "Arkiv")
        .item(&item(app, "new")?)
        .item(&item(app, "documents")?)
        .item(&item(app, "import")?)
        .item(&sep()?)
        .item(&item(app, "save")?)
        .item(&item(app, "history")?)
        .item(&sep()?)
        .item(&item(app, "export")?)
        .item(&item(app, "publish")?)
        .item(&item(app, "backup")?)
        .item(&sep()?)
        .item(&item(app, "trash")?)
        .item(&sep()?)
        .item(&PredefinedMenuItem::close_window(app, Some("Stäng fönster"))?)
        .build()?;

    // The predefined edit items are what make ⌘C/⌘V/⌘Z work in the WebView on macOS.
    let edit = SubmenuBuilder::new(app, "Redigera")
        .item(&PredefinedMenuItem::undo(app, Some("Ångra"))?)
        .item(&PredefinedMenuItem::redo(app, Some("Gör om"))?)
        .item(&sep()?)
        .item(&PredefinedMenuItem::cut(app, Some("Klipp ut"))?)
        .item(&PredefinedMenuItem::copy(app, Some("Kopiera"))?)
        .item(&PredefinedMenuItem::paste(app, Some("Klistra in"))?)
        .item(&PredefinedMenuItem::select_all(app, Some("Markera allt"))?)
        .item(&sep()?)
        .item(&item(app, "find")?)
        .item(&item(app, "replace")?)
        .item(&sep()?)
        .item(&item(app, "chars")?)
        .item(&item(app, "note")?)
        .item(&item(app, "comment")?)
        .item(&item(app, "footnote")?)
        .item(&item(app, "typography")?)
        .build()?;

    let view = SubmenuBuilder::new(app, "Visa")
        .item(&item(app, "view")?)
        .item(&sep()?)
        .item(&item(app, "meta")?)
        .item(&item(app, "analysis")?)
        .item(&item(app, "ai")?)
        .item(&sep()?)
        .item(&item(app, "fullscreen")?)
        .build()?;

    let window = SubmenuBuilder::new(app, "Fönster")
        .item(&PredefinedMenuItem::minimize(app, Some("Minimera"))?)
        .item(&PredefinedMenuItem::maximize(app, Some("Zooma"))?)
        .build()?;

    let help = SubmenuBuilder::new(app, "Hjälp").item(&item(app, "shortcuts")?).build()?;

    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window, &help])
}

/// Menu click → the frontend runs the same action as the keyboard shortcut.
pub fn on_menu<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if id == "quit" {
        request_close(app);
        return;
    }
    if MENU.iter().any(|(i, _, _)| *i == id) {
        let _ = app.emit_to("main", "ww://menu", id);
    }
}

// ---------------------------------------------------------------- close / quit

/// Set once the frontend has saved; then closing/quitting goes through.
pub static CLOSE_CONFIRMED: AtomicBool = AtomicBool::new(false);

/// Asks the frontend to save, then close (`close_confirmed`). If it doesn't
/// answer within 5 s (e.g. the page is broken) the window closes anyway –
/// the frontend also keeps unsaved text in local storage as a last resort.
pub fn request_close<R: Runtime>(app: &AppHandle<R>) {
    let Some(win) = app.get_webview_window("main") else {
        app.exit(0);
        return;
    };
    if win.emit("ww://before-close", ()).is_err() {
        CLOSE_CONFIRMED.store(true, Ordering::SeqCst);
        let _ = win.destroy();
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(5));
        if !CLOSE_CONFIRMED.swap(true, Ordering::SeqCst) {
            log::warn!("frontend did not confirm close in time – closing anyway");
            remember_window(&app);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.destroy();
            }
            app.exit(0);
        }
    });
}

/// The frontend has saved everything: close the window (which ends the app).
#[tauri::command]
pub fn close_confirmed(window: WebviewWindow) {
    CLOSE_CONFIRMED.store(true, Ordering::SeqCst);
    remember_window(window.app_handle());
    let _ = window.destroy();
}

/// Size and position for next start (destroying the window skips the
/// plugin's own save on close).
fn remember_window<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_window_state::{AppHandleExt, StateFlags};
    let _ = app.save_window_state(StateFlags::all());
}

// ---------------------------------------------------------------- small commands

/// The WebView's own full-screen API isn't available in WKWebView – use the window's.
#[tauri::command]
pub fn toggle_fullscreen(window: WebviewWindow) -> Result<bool> {
    let now = window.is_fullscreen().map_err(|e| Error::internal(e.to_string()))?;
    window.set_fullscreen(!now).map_err(|e| Error::internal(e.to_string()))?;
    Ok(!now)
}

/// Links in the text and in AI answers open in the default browser, never in
/// the app window. Only web and mail links.
#[tauri::command(rename_all = "snake_case")]
pub fn open_url(app: AppHandle, url: String) -> Result<()> {
    let ok = url::Url::parse(&url).is_ok_and(|u| matches!(u.scheme(), "http" | "https" | "mailto"));
    if !ok {
        return Err(Error::bad_request("Bara webb- och e-postlänkar kan öppnas."));
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(url, None::<&str>).map_err(|e| Error::internal(e.to_string()))
}

/// "Kopiera för publicering": HTML and plain text on the clipboard. Done in
/// Rust because the WebView only allows it right after a click, not after a
/// menu choice.
#[tauri::command(rename_all = "snake_case")]
pub fn clipboard_write_html(app: AppHandle, html: String, text: String) -> Result<()> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().write_html(html, Some(text)).map_err(|e| Error::internal(e.to_string()))
}

/// Keeps the window on the app. The frontend already sends web links to the
/// browser; this is the backstop in Rust for anything that slips through (a
/// relative link, another scheme): web and mail links open in the browser,
/// everything else is blocked – the editor is never replaced.
pub fn navigation_guard<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|webview, url| {
            if is_app_url(url) {
                return true;
            }
            if matches!(url.scheme(), "http" | "https" | "mailto") {
                use tauri_plugin_opener::OpenerExt;
                let _ = webview.app_handle().opener().open_url(url.as_str(), None::<&str>);
            }
            false
        })
        .build()
}

/// The app's single page: `tauri://localhost/` (macOS, Linux),
/// `http(s)://tauri.localhost/` (Windows), the Vite dev server in debug builds.
/// Other paths on the same origin are not allowed either – the asset server
/// answers them with the app again, which would reload it and lose unsaved text.
fn is_app_url(url: &tauri::Url) -> bool {
    let app_origin = match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => {
            url.host_str() == Some("tauri.localhost")
                || (cfg!(debug_assertions) && url.host_str() == Some("localhost") && url.port() == Some(5173))
        }
        "about" => return url.path() == "blank",
        _ => false,
    };
    app_origin && matches!(url.path(), "" | "/" | "/index.html")
}

#[cfg(test)]
mod tests {
    use super::is_app_url;

    #[test]
    fn app_urls() {
        let ok = |s: &str| is_app_url(&s.parse().unwrap());
        assert!(ok("tauri://localhost/"));
        assert!(ok("tauri://localhost/index.html#x"));
        assert!(ok("tauri://localhost"));
        assert!(!ok("tauri://localhost/relative-page"));
        assert!(ok("http://tauri.localhost/"));
        assert!(ok("about:blank"));
        assert!(!ok("tauri://evil/"));
        assert!(!ok("https://example.com/"));
        assert!(!ok("http://tauri.localhost.example.com/"));
        assert!(!ok("file:///etc/passwd"));
        assert!(!ok("data:text/html,<p>x"));
        assert!(!ok("javascript:alert(1)"));
    }
}
