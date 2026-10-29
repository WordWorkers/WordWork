# Word Work (Rust) – Project plan

Rewrite of [`word-work`](../word-work) as a **native macOS app**. The old app is a Docker container (Python/FastAPI + Pandoc) serving a TypeScript/TipTap editor to the browser. The new app is a **Tauri 2** desktop app: all backend logic is rewritten in Rust, and the existing editor UI is reused in the system WebView (WKWebView).

**Goal:** feature parity with word-work 1.10.0 (see its README), launched by double-clicking `Word Work.app`. No Docker, no browser tab, no localhost port.

**Non-goals for v1:** Windows/Linux builds (Tauri makes them possible later), a native (non-WebView) editor, new features, changes to the data format.

---

## 1. What exists today (inventory)

| Part | Old implementation | Size |
|---|---|---|
| HTTP API, security middleware | `backend/app/main.py` (FastAPI, ~35 routes) | 478 lines |
| Storage: documents, history, trash, chats, settings, backup zip | `backend/app/storage.py` | 558 |
| Spelling (Hunspell via spylls), personal dictionary, synonyms (MyThes/Synlex), stemming | `backend/app/language.py` | 287 |
| Import/export via Pandoc + Lua filters, note/comment stripping, RTF A4 patch | `backend/app/convert.py`, `resources/filters/*.lua`, `resources/templates/*` | 264 + 130 |
| AI: Ollama native API, OpenAI-compatible API, prompts, genres, `<think>` splitting, NDJSON streaming | `backend/app/ai.py`, `ai_openai.py` | 644 |
| Config via `WW_*` env vars | `backend/app/config.py` | 68 |
| Editor UI (TipTap 3, Markdown, footnotes, comments, notes, typography, search, stats/LIX, AI panel …) | `frontend/src/*.ts`, `style.css` | ~7,500 + 1,900 |
| Tests | `backend/tests/` (pytest) | 68 tests |

Data format (must stay **byte-compatible** so an existing `data/` folder can simply be opened):

```
<data>/<name>.md                        documents (Markdown + optional YAML frontmatter)
<data>/.history/<name>/index.json       version metadata
<data>/.history/<name>/<stamp>.md       snapshots
<data>/.chats/<name>/<id>.json          AI conversations
<data>/.trash/…                         deleted documents, history, chats
<data>/.wordwork/settings.json          settings
<data>/.wordwork/ordlista.txt           personal dictionary
```

---

## 2. Architecture decisions

| Area | Choice | Rationale |
|---|---|---|
| App shell | **Tauri 2** | Rust backend, small binary, native macOS window/menus, reuses the web UI as-is. |
| UI | **Existing TS/TipTap frontend**, copied into `frontend/` | ~7,500 lines of tuned editor logic; rewriting it in a Rust GUI toolkit would be the bulk of the project with no user benefit. |
| UI ↔ core transport | **Tauri commands** (`invoke`) + **`ipc::Channel`** for AI streaming | No open TCP port → no DNS-rebinding/host checks needed. `api.ts` keeps its exact public interface; only its internals change. |
| Type sharing | `tauri-specta` (or `ts-rs`) generates TS types from Rust structs | Keeps `api.ts` interfaces in sync with Rust. |
| Core logic | Separate crate **`ww-core`** with no Tauri dependency | Unit-testable with `cargo test`, reusable (CLI, future server mode). |
| Async / HTTP | `tokio`, `reqwest` (rustls, streaming) | AI calls to Ollama/OpenAI. |
| Spelling | **`spellbook`** (pure-Rust Hunspell, used by Helix) + own `SFX`-rule stemmer for synonyms | ✅ Phase 0: 2,362/2,364 words agree with spylls, suggestions ≤ 0.5 s (was up to 9 s), stemmer matches 255/257. |
| Synonyms | Own MyThes parser (port of `_load_mythes`) | ~30 lines; data file unchanged. |
| Import/export | **Pandoc 3.9 as a Tauri sidecar** (`externalBin`, pinned + checksummed) + existing Lua filters and reference docs, run via `std::process` with `LC_ALL` set | No Rust equivalent to Pandoc for DOCX/ODT/RTF in both directions. Same licensing model as today (separate GPL program, not linked). ✅ Phase 0 on Linux. |
| Regex | `regex` + `fancy-regex` where lookahead is used (frontmatter rule) – or a small hand-written parser | Rust `regex` has no lookaround. |
| Storage | `std::fs`, `tempfile` (atomic write + fsync + rename), `chrono`, `serde_json`, `zip` | Straight port of `storage.py`. |
| Config | Settings UI + `config.json` in app support dir; **API key in macOS Keychain** (`keyring`) | Env vars don't fit a GUI app. `WW_*` env vars still honoured for dev/power users. |
| Data folder | User-chosen; default `~/Documents/Word Work`. First run offers "Open existing Word Work folder…" | Zero-copy migration from the Docker setup. |
| File drop, downloads, clipboard | Tauri drag-drop events, `dialog` + `fs` plugins (Save As…), `clipboard-manager` plugin (`writeHtml`) as fallback | `<a download>` doesn't work in WKWebView; see §5. |
| Packaging | Universal `.app` + `.dmg`, Developer ID signing + notarization, hardened runtime | Required to run on other Macs without Gatekeeper warnings. |
| Minimum macOS | 11 Big Sur (Tauri 2 supports 10.15+) | |

```
┌──────────────── Word Work.app ─────────────────────────────┐
│  WKWebView: existing frontend (TipTap, panels, styles)      │
│        │ invoke("doc_save", …)      ▲ Channel<AIEvent>      │
│  ──────▼────────────────────────────┴─────────────────────  │
│  src-tauri: commands, menus, dialogs, window state          │
│        │                                                    │
│  ww-core: storage · history · chats · trash · settings      │
│           language (spellbook + Synlex) · stats helpers     │
│           convert (→ pandoc sidecar) · ai (Ollama/OpenAI)   │
└──────┬──────────────────────────┬──────────────────────────┘
       │ data folder (Markdown)   │ HTTP → Ollama / OpenAI-compatible
```

### Repository layout

```
word-work-rust/
  Cargo.toml                 workspace
  crates/ww-core/            all logic, no Tauri
    src/{storage,history,chats,trash,settings,text,language,convert,ai}/…
    tests/                   ported pytest suite + parity fixtures
  src-tauri/                 Tauri app (commands.rs, menu.rs, main.rs, tauri.conf.json, capabilities/)
    binaries/ww-pandoc-<target> sidecar
  resources/                 sv/ dictionaries, filters/*.lua, templates/* (copied unchanged)
  frontend/                  copied from word-work/frontend, api.ts adapted
  LICENSES/, THIRD_PARTY_LICENSES.md, NOTICE
```

---

## 3. API mapping (FastAPI route → Tauri command)

All commands return `Result<T, ApiError>` where `ApiError { status, detail }` mirrors today's HTTP errors so the frontend's error handling (`ApiError.status === 409` etc.) keeps working.

| Old route | Command |
|---|---|
| `GET /health` | `health` |
| `GET/POST /documents`, `GET/PUT/DELETE /documents/{n}`, `POST …/rename` | `doc_list`, `doc_create`, `doc_get`, `doc_save` (with `base_modified` conflict check), `doc_delete`, `doc_rename` |
| `…/history`, `…/history/{vid}`, `…/restore` | `history_list`, `history_snapshot`, `history_get`, `history_restore` |
| `…/chats…` | `chat_list`, `chat_get`, `chat_save`, `chat_delete` |
| `GET /trash`, `POST /trash/{e}/restore` | `trash_list`, `trash_restore` |
| `GET/PUT /settings` | `settings_get`, `settings_put` |
| `/spell/check`, `/spell/suggest`, `/spell/dictionary*` | `spell_check`, `spell_suggest`, `dict_get/add/rename/replace/remove` |
| `GET /synonyms` | `synonyms` |
| `GET /export/formats`, `GET …/export` | `export_formats`, `export_doc { path }` – writes to a path chosen in a native Save dialog |
| `POST /import` | `import_files { paths }` – from native Open dialog or drag-drop |
| `GET /backup` | `backup_zip { path }` |
| `GET /ai/genres`, `/ai/status`, `/ai/models` | `ai_genres`, `ai_status`, `ai_models` |
| `POST /ai/chat` (NDJSON stream) | `ai_chat { req, channel: Channel<AIEvent> }` + `ai_cancel { id }` (replaces `AbortSignal`) |
| SPA/static serving, CSP/host middleware | Removed – Tauri serves the bundled assets; CSP set in `tauri.conf.json` |

---

## 4. Phases

Estimates assume one developer working with AI assistance, as the original was built.

### Phase 0 – Spikes and skeleton (≈ 1 week)
**Status: done (2026-10-29), macOS checks pending – see [docs/phase0.md](docs/phase0.md).**
- Cargo workspace, `ww-core`, Tauri 2 app that loads the copied frontend unmodified (dev server via `beforeDevCommand`).
- **Spike A – spelling:** load `sv_SE.aff/.dic` in `spellbook`; compare `check` and `suggest` against spylls on a word list extracted from the sample documents in `data/` (compounds, inflections, names). Check whether stemming for synonyms is possible. Decide `spellbook` vs `hunspell-sys`.
- **Spike B – Pandoc sidecar:** bundle a universal pandoc binary, run an export with the Lua filter and reference doc, confirm it works inside a signed, hardened-runtime build.
- **Spike C – streaming:** `Channel` from a Rust task to the AI panel, with cancellation.
- CI (GitHub Actions, `macos-latest`): `cargo fmt/clippy/test`, `npm run typecheck`, `tauri build` for `universal-apple-darwin`.
- **Exit criterion:** the three spikes are green and the decision table above is confirmed or amended.

### Phase 1 – Core storage (≈ 1–1.5 weeks)
**Status: done (2026-10-29) – see [docs/phase1.md](docs/phase1.md).** Byte-for-byte parity with the Python storage; real data folder opens unchanged.
- Port `storage.py`: name validation/`safe_name`, frontmatter split, word count, atomic write, documents CRUD, rename (moves history + chats), conflict detection (`base_modified`), auto-snapshot interval, history index, restore, trash (move, list, restore with "(återställd)"), chats (size/count limits, summaries), settings store (validation, defaults), backup zip.
- Port `test_api.py` / `test_userdata.py` cases to Rust unit/integration tests.
- **Parity tests:** run old Python `Storage` and new Rust code against the same fixture operations; diff the resulting data folders byte-for-byte.
- Commands + `api.ts` adapter for documents, history, trash, settings.
- **Exit:** the app can open the existing `word-work/data` folder, edit, autosave, show/restore history and trash – with the unchanged UI.

### Phase 2 – Language tools (≈ 1–1.5 weeks)
**Status: done (2026-10-29) – see [docs/phase2.md](docs/phase2.md).** Identical results to the old app on every word in the real data folder, apart from a handful of improvements.
- Background loading of dictionaries at startup (`ready` flag in `health`).
- `check` with lookup cache, digit/length rules, personal dictionary incl. **phrases**; `suggest` with time budget (2 s / 0.35 s settle) and cache – implemented with a worker thread + `crossbeam` channel or `tokio::time::timeout`.
- Personal dictionary file: sorted case-insensitively, reload when the file changes on disk (mtime check or `notify`).
- Synonyms: MyThes parser, lookup for word + lowercase + stems.
- Port `test_language.py`.
- **Exit:** underline, right-click suggestions, add/ignore, phrases and synonyms behave as in the old app.

### Phase 3 – Import/export (≈ 1 week)
**Status: done (2026-10-29) – see [docs/phase3.md](docs/phase3.md).** 270/270 exports and 61/61 imports identical to the old app on the real data folder; native Save dialog.
- Port `strip_notes`, `strip_comments`, `_drop_duplicate_title`, `_rtf_a4`, text normalisation and encoding fallback (UTF-8-sig → CP1252 → Latin-1, via `encoding_rs`).
- Pandoc invocation through the sidecar (`tauri-plugin-shell` or `std::process::Command` on the resolved sidecar path), stdin/stdout, 60 s timeout, 25 MB import cap; same args, Lua filters and templates.
- Native **Save As…** dialog for export and backup (remember last folder); native **Open…** and drag-drop for import (multiple files).
- Port `test_convert.py`; golden-file tests comparing Rust export output with the Python version for docx/odt/rtf/html/md/txt (DOCX/ODT compared after unzipping, ignoring timestamps).
- **Exit:** all six export formats × three templates × chapter breaks, and all import formats, match the old app.

### Phase 4 – AI assistant (≈ 1.5–2 weeks)
**Status: done (2026-10-29) – see [docs/phase4.md](docs/phase4.md).** 312/312 prompts identical to the old app; key in the Keychain; the Python backend is no longer needed.
- Port prompts, `GENRES`, `parse_meta`, `text_guidance`, `build_messages`, `context_size`, `is_external` **verbatim** (Swedish prompt text is product logic – copy, don't paraphrase).
- `OllamaClient` (native `/api/chat`, `num_ctx`, `think` toggle, model list with size/params/thinking capability, model cache) and `OpenAIClient` (`/v1` base handling, `reasoning_content`/`reasoning` fields, `ThinkSplitter` for `<think>` tags, retry without `temperature`, embedding/image/audio model filtering).
- Streaming via `Channel<AIEvent>` with the same event shapes (`start`, `thinking`, `content`, `done`, `error`); cancellation; server-side persistence of question + answer even when cancelled ("Avbrutet").
- Status polling (`ai_status`) every minute and on window focus, as today.
- AI settings in the Settings panel: API type, URL, model, key (stored in Keychain, never sent to the WebView).
- Port `test_ai.py` / `test_ai_openai.py` using a mock HTTP server (`wiremock`).
- **Exit:** quick actions, free questions, thinking, model switching, chat history and "external server" warning work against local Ollama and an OpenAI-compatible server.

### Phase 5 – Mac integration and frontend adaptation (≈ 1 week)
**Status: done (2026-10-29) – see [docs/phase5.md](docs/phase5.md).** Menu bar, save-before-quit, window state, single instance, clipboard, links; verified in release mode with CSP.
- `api.ts`: replace `fetch` with `invoke`; keep exported function names/types so `main.ts` and the rest stay untouched where possible.
- Replace `download()` with Save dialog flow; replace HTML5 file-drop with Tauri drag-drop events (or disable Tauri's handler and read files via `fs`).
- "Kopiera för publicering": verify `navigator.clipboard.write` with `text/html` in WKWebView; fall back to `clipboard-manager` `writeHtml`.
- Remove the "Word Work har uppdaterats" reload banner (no longer applicable) – optionally replace with `tauri-plugin-updater`.
- Unsaved-text protection: hook the window close request (`onCloseRequested`) instead of `beforeunload`; flush autosave on quit.
- Native **Swedish menu bar** (Arkiv, Redigera, Visa, Fönster, Hjälp) mirroring the existing shortcuts; menu items emit events to the frontend. Ensure menu accelerators don't swallow editor shortcuts (⌘S, ⌘F, ⌘⌥K …).
- Data folder chooser on first run and in Settings; "Visa i Finder" for the data folder.
- Window size/position persistence (`tauri-plugin-window-state`), full-screen focus mode, dark mode following the system theme setting.
- Fonts are already bundled via Fontsource – confirm no network loads; tighten CSP.

### Phase 6 – Packaging, licensing, release (≈ 1 week)
**Status: in progress (2026-10-29).** Done: GitHub Actions builds for macOS Apple Silicon and Intel (separate `.dmg`s), Windows (`.exe`/`.msi`) and Linux (`.deb`/`.rpm`/`.AppImage`), draft releases with `SHA256SUMS` on version tags, ad-hoc macOS signing with Developer ID signing ready to switch on via secrets, and [docs/INSTALL.md](docs/INSTALL.md). Left: licence notices in the app, QA checklist, Developer ID (later).
- Universal build (`aarch64` + `x86_64`), app icon from `favicon.svg`, `.dmg`.
- Code signing (Developer ID Application) + notarization in CI; sign the pandoc sidecar too.
- Licences: `cargo-about` for Rust crates, existing `notices.mjs` for npm, Pandoc GPL notice + source link, Hunspell/Synlex/font licences – bundled in `Resources/licenses/` and shown in an "Om Word Work" window.
- README (Swedish, user-facing) rewritten for the Mac app; migration section ("Öppna din gamla datamapp").
- Manual QA checklist covering every bullet in the old README; beta on the author's own writing for a week.
- **Exit:** v2.0.0 `.dmg` installs and runs on a clean Mac (Apple Silicon and Intel).

**Total: ≈ 8–10 weeks.** Phases 2, 3 and 4 are independent of each other once Phase 1 is done and can be parallelised.

---

## 5. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| `spellbook` differs from spylls/Hunspell on Swedish compounds | Wrong underlines | ✅ Retired in Phase 0 (99.9 % agreement); parity test in CI guards regressions |
| Suggestion latency (Hunspell compound suggestions can take seconds) | UI lag on right-click | Keep the time-budget design; run on a blocking thread pool, never on the IPC thread |
| Pandoc sidecar size (310 MB universal, measured in Phase 0) and signing | Large `.app`; notarization failures | Decide universal vs per-arch (open question 6); sign sidecar explicitly; test notarization early |
| WKWebView vs Chrome differences (clipboard HTML, contenteditable quirks, spellcheck attribute, drag-drop) | Editor bugs only on the Mac app | Test editor features in WKWebView in Phase 0; fix in frontend with feature detection |
| Python `re`/`\w` vs Rust `regex` Unicode semantics | Different word counts/LIX | Parity tests on real documents (e.g. "Ålgång.md") |
| Native menu accelerators conflicting with editor shortcuts | Shortcuts stop working | Route all shortcuts through one table; menu items dispatch to frontend handlers |
| Gatekeeper/notarization needs an Apple Developer account | Can't distribute outside own machine | Confirm account availability before Phase 6; unsigned builds are fine for personal use |
| Multiple app instances writing the same data folder | Overwritten edits | `tauri-plugin-single-instance`; `base_modified` conflict check already exists |

---

## 6. Open questions

1. **Distribution:** *Decided: public downloads, ad-hoc signed for now; Developer ID later. Windows and Linux builds too.*
2. **Docker version:** keep maintaining it in parallel, or freeze it at 1.10.0 once the Mac app reaches parity?
3. **Server mode:** worth keeping an optional `ww-server` binary (axum, same `ww-core`) so the browser version can also be served from Rust? Cheap to add later thanks to the crate split.
4. **Default data folder:** `~/Documents/Word Work`, or iCloud Drive (`~/Library/Mobile Documents/…`) for sync between Macs?
5. **Auto-update:** use `tauri-plugin-updater` (needs a release host), or manual downloads?
6. ~~**Universal vs per-architecture download:**~~ *Decided: separate Apple Silicon and Intel downloads.* Pandoc makes a universal `.app` ~310 MB unpacked (~70 MB `.dmg`); separate Apple Silicon/Intel builds are ~190/120 MB. (Phase 0 finding.)
7. **Bundle identifier:** currently `se.schiren.wordwork` – change before the first signed release if another is preferred (changing it later moves the app's settings).

---

## 7. Definition of done

- Every feature listed in the old README works in the Mac app, with the same Swedish UI.
- An existing `data/` folder from the Docker version opens without conversion, and files written by the new app open in the old one.
- All ported tests pass (`cargo test`, `npm run typecheck`), plus parity/golden tests against the Python implementation.
- No network access except to the configured AI server; no listening ports.
- Signed universal `.dmg` (if Q1 = distribute).
