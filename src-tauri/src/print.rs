//! The system print dialog for the document (⌘P, and PDF in the export
//! dialog – "Save as PDF" is part of the print dialog everywhere).
//!
//! Page size and margins are set natively, because WebKit (macOS, Linux)
//! ignores CSS `@page` margins when printing: A4 with 2.5 cm margins, like
//! the Word templates. On Windows the WebView (Chromium) prints with
//! `window.print()` and takes the margins from CSS (see `printDocument` in
//! main.ts).

use tauri::WebviewWindow;
use ww_core::{Error, Result};

/// 2.5 cm, like the Word/OpenDocument templates.
#[cfg(any(target_os = "macos", target_os = "linux"))]
const MARGIN_MM: f64 = 25.0;

pub fn print(window: &WebviewWindow) -> Result<()> {
    let err = |e: tauri::Error| Error::internal(format!("Kunde inte skriva ut: {e}"));
    #[cfg(target_os = "macos")]
    {
        window.with_webview(|wv| macos::print(wv.inner())).map_err(err)
    }
    #[cfg(target_os = "linux")]
    {
        window.with_webview(|wv| linux::print(&wv.inner())).map_err(err)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        window.print().map_err(err)
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use gtk::prelude::*;
    use webkit2gtk::PrintOperationExt;

    pub fn print(webview: &webkit2gtk::WebView) {
        let setup = gtk::PageSetup::new();
        setup.set_paper_size(&gtk::PaperSize::new(Some(gtk::PAPER_NAME_A4)));
        setup.set_top_margin(super::MARGIN_MM, gtk::Unit::Mm);
        setup.set_bottom_margin(super::MARGIN_MM, gtk::Unit::Mm);
        setup.set_left_margin(super::MARGIN_MM, gtk::Unit::Mm);
        setup.set_right_margin(super::MARGIN_MM, gtk::Unit::Mm);
        let op = webkit2gtk::PrintOperation::new(webview);
        op.set_page_setup(&setup);
        let parent = webview.toplevel().and_then(|w| w.downcast::<gtk::Window>().ok());
        op.run_dialog(parent.as_ref());
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2_app_kit::{NSPrintInfo, NSPrintOperation};
    use objc2_foundation::NSSize;
    use objc2_web_kit::WKWebView;

    /// Points per millimetre.
    const PT_PER_MM: f64 = 72.0 / 25.4;

    pub fn print(webview: *mut std::ffi::c_void) {
        // Safety: on macOS the platform webview is a WKWebView, valid on the
        // main thread where `with_webview` runs this.
        let webview: &WKWebView = unsafe { &*(webview as *const WKWebView) };
        let info = NSPrintInfo::sharedPrintInfo();
        let margin = super::MARGIN_MM * PT_PER_MM;
        info.setPaperSize(NSSize::new(210.0 * PT_PER_MM, 297.0 * PT_PER_MM));
        info.setTopMargin(margin);
        info.setBottomMargin(margin);
        info.setLeftMargin(margin);
        info.setRightMargin(margin);
        // Same steps as wry's own print(), with our page setup.
        // Safety: a plain Objective-C call on a valid WKWebView.
        let op: objc2::rc::Retained<NSPrintOperation> = unsafe { webview.printOperationWithPrintInfo(&info) };
        op.setShowsPrintPanel(true);
        op.setCanSpawnSeparateThread(true);
        if let Some(window) = webview.window() {
            // Safety: no delegate or selector, so nothing is called back.
            unsafe {
                op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                    &window,
                    None,
                    None,
                    std::ptr::null_mut(),
                )
            };
        }
    }
}
