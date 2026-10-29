# Phase 5 – Mac integration: results

Date: 2026-10-29. Status: **done** (verified on Linux in a real WebView, also
with the frontend embedded as in a release build; please run the checks at
the end on the Mac).

## What was built

| Part | Where |
|---|---|
| **Swedish menu bar**: *Word Work* (Om, Inställningar ⌘,, Göm, Avsluta ⌘Q), *Arkiv* (Nytt ⌘N, Dokument ⌘O, Importera ⇧⌘O, Spara version ⌘S, Versionshistorik, Exportera ⌘E, Kopiera för publicering ⇧⌘C, Spara allt (zip), Papperskorgen, Stäng fönster ⌘W), *Redigera* (Ångra … Markera allt, Sök ⌘F, Sök och ersätt ⌥⌘F, Infoga tecken ⌘., Egen anteckning ⌥⌘M, Kommentera ⌥⌘K, Infoga fotnot ⌥⌘N, Rätta typografin), *Visa* (Skriv/Markdown ⌘/, Metadata, Analys, AI-assistent ⌘J, Helskärm ⌃⌘F), *Fönster*, *Hjälp* (Kortkommandon F1) | `src-tauri/src/shell.rs` |
| Menu → same action as the shortcut/button (`ww://menu` event); the menu's shortcuts are the old ones, so nothing changes for the fingers | `menuAction` in `main.ts` |
| **Save before close/quit**: closing the window, ⌘Q, quitting from the Dock or logging out first saves the text, then closes. If the page doesn't answer within 5 s it closes anyway; unsaved text is also kept locally and offered at next start | `request_close` / `close_confirmed`, `bindAppShell` |
| *Om Word Work* with version and licence | macOS About panel |
| Window size and position remembered | `tauri-plugin-window-state` |
| Starting the app again just brings the open window forward (no second app writing the same files) | `tauri-plugin-single-instance` |
| *Helskärm* uses the real macOS full screen (WKWebView has no page full screen) | `toggle_fullscreen` |
| *Kopiera för publicering* writes HTML + plain text to the clipboard from Rust – the WebView refuses clipboard writes that don't come straight from a click (e.g. from the menu) | `clipboard_write_html`, `publish.ts` |
| Links in AI answers etc. open in the default browser instead of replacing the editor; in the editor a click on a link still just places the cursor. Only http(s) and mailto | `open_url`, click handler |
| No "Word Work har uppdaterats" banner in the app (only relevant for the browser version); the new shortcuts are listed under F1 | `main.ts` |

## Verified

- Menu bar renders with all items and shortcuts; ⌘, opens Inställningar via
  the menu.
- Typed text and pressed **⌘Q 0.2 s later**: the text was on disk, the app
  exited cleanly (code 0). Same when the window manager's close button was
  used (WM_DELETE_WINDOW). Window size/position file written.
- Clipboard after *Kopiera för publicering*: `text/html` and `text/plain`
  both present (read back with `xclip`).
- `open_url` refuses `javascript:` and `file:` URLs.
- **Release mode**: the app built with the frontend embedded (custom
  protocol + the strict Content-Security-Policy from `tauri.conf.json`) ran
  the full smoke test – documents, spelling, export/import, AI streaming and
  stopping – and rendered with the bundled fonts. No CSP errors.
- 93 Rust tests pass, clippy clean.

## Please check on the Mac

1. The menu bar appears at the top of the screen with the Swedish names; try
   a few shortcuts (⌘N, ⌘E, ⌘J, ⌃⌘F).
2. **⌘C / ⌘V / ⌘Z** in the text (these depend on the *Redigera* menu on macOS).
3. Type something and press ⌘Q at once → reopen: the text is there.
4. *Exportera → Kopiera* (or ⇧⌘C) → paste into Mail/Pages: formatted.
5. Quit and start again: same window size and position.
6. A link in an AI answer opens in Safari.
