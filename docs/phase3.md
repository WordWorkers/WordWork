# Phase 3 – import, export and backup: results

Date: 2026-10-29. Status: **done** (verified on Linux in a real WebView with the
old backend switched off; please run the checks at the end on the Mac).

## What was built

| Part | Where |
|---|---|
| Full port of `convert.py`: notes (`<!-- -->`) and comments (CriticMarkup) never exported, duplicate title removed, RTF set to A4, print CSS for HTML, same Pandoc arguments, Lua filters and reference documents | `crates/ww-core/src/convert.rs` |
| Import: Pandoc for DOCX/ODT/RTF/HTML; text and Markdown read as UTF-8 (with or without BOM) or Windows-1252; file name cleaned into a document name | `Pandoc::import` |
| **Native Save dialog** for export and *Ladda ner allt (zip)*, with the right file type and the suggested name; remembers the last folder | `src-tauri/src/export_commands.rs` |
| Import from *Dokument → Importera …* and by **dropping files on the window**, sent to Rust as raw bytes | `import_file` command, `dragDropEnabled: false` in `tauri.conf.json` |
| Buttons say *Spara …* / *Spara allt (zip) …* in the app instead of *Ladda ner* | `main.ts` (3 lines) |

The conversion happens before the Save dialog opens, so errors show at once.
Exported files are written atomically and readable like any other file (0644).

## Compatibility

- `test_convert.py` ported: **17 Rust tests**, passing with both Pandoc 3.1 and
  the pinned 3.9.
- **Every export, byte for byte:** all 15 documents in the real data folder
  (current + trash) × every format × every template × with and without page
  breaks before chapters = **270 files**, made by the old Python code and by
  Rust with the same Pandoc 3.9: **270/270 identical** (DOCX/ODT compared per
  zip entry, ignoring Pandoc's own timestamps).
- **Every import:** 60 of those exports (DOCX, ODT, RTF, HTML) plus a
  Windows-1252 text file imported by both: **61/61 identical** Markdown and
  document names.
- In the app: *Exportera → Spara …* opened the Save dialog with
  `Ålgång.docx` and a *Word (.docx)* filter, wrote a valid file and showed
  *Exporterade export-test.docx*; *Spara allt (zip) …* opened in the same folder
  and saved all 112 files of the data folder. Importing a Windows-1252 text file
  named `Gammal: fil?.txt`, an HTML file and an unsupported `.png` gave the same
  results as the old app.

## Tests

71 Rust tests in total (`cargo test --workspace`), clippy clean with
`-D warnings`.

## Please check on the Mac

1. `cargo test --workspace` (runs the export tests against the bundled Pandoc
   if you set `WW_PANDOC=src-tauri/binaries/ww-pandoc-aarch64-apple-darwin`).
2. `cargo tauri dev` without the old backend:
   - *Exportera* (⌘E) → each format → *Spara …* → open the file.
   - *Dokument → Spara allt (zip) …*
   - **Drag a .docx from Finder onto the window** – this is the one thing that
     couldn't be tested on Linux (WKWebView's HTML5 drop).
   - *Dokument → Importera …* with a file.
