# Phase 1 – core storage: results

Date: 2026-10-29. Status: **done** (verified on Linux in a real WebView;
please run the checks at the end on the Mac).

## What was built

| Part | Where |
|---|---|
| Name rules, frontmatter, word count | `crates/ww-core/src/text.rs` |
| Documents, rename (moves history + chats), delete to trash, conflict check, auto/manual/named snapshots, restore | `crates/ww-core/src/storage.rs` |
| AI chats (save, list, read, delete, append), trash list/restore, settings store, backup zip | `crates/ww-core/src/userdata.rs` |
| 21 Tauri commands, one per old HTTP route | `src-tauri/src/data_commands.rs` |
| Data folder: remembered in `~/Library/Application Support/se.schiren.wordwork/config.json`, default `~/Documents/Word Work`, native folder picker, "Visa i Finder" | `src-tauri/src/state.rs`, *Inställningar → Datamapp* |
| Frontend routing: ported routes → Rust, the rest → `fetch` (old backend in dev) | `frontend/src/ipc-routes.ts`, 20 lines in `api.ts` |

The rest of the frontend is unchanged. `package.json` is now `2.0.0-dev` so the
"Word Work har uppdaterats" banner doesn't fire against the Rust version.

## Compatibility with the Docker version

- **Byte-for-byte file parity.** `tools/storage_parity.py` runs a 20-step
  scenario (Swedish names, frontmatter, snapshots, named labels, restore,
  chats with extra fields, append, rename, settings with nested values,
  delete, restore with name clash) through the *old Python code*; the Rust test
  `storage_parity` runs the same steps and compares all 12 files written plus
  every API result. Only timestamps/version ids are normalised.
- **Real data.** A copy of `word-work/data` (2 documents, 77 history versions,
  17 trash entries, AI chats) opened in the app; every read endpoint
  (documents, each document, history, chats, trash, settings) returned the same
  JSON from Rust as from the old backend on an identical copy: **9/9 equal**.
  The word count stored by Python for all 77 versions matches the Rust count.
- The editor loads and works with the Python backend switched off.

## Findings and changes

- **Word count:** Python's `\w` counts `½` and `²` as word characters; Rust's
  doesn't. Found on real data (3 trash entries off by 1–4 words). The Rust
  pattern now uses `[\p{L}\p{N}_]`, matching Python exactly.
- **Two deletes in the same second** of documents with the same name: Python
  silently overwrote the first one in the trash. Rust picks the next free
  second instead – nothing is lost.
- **Case-only rename** (`essä` → `Essä`): Python refused it on macOS
  ("already exists", same file on a case-insensitive disk). Rust allows it.
- **Rename onto leftover history/chats** under the new name: Python would nest
  the folders; Rust moves the leftovers to the trash first.
- File work runs on a blocking thread pool, never on the UI thread.
- Removed with the HTTP server: host-header check (DNS rebinding), security
  headers and SPA caching – there is no open port any more.

## Tests

41 Rust tests (`cargo test --workspace`): 22 ported from `test_api.py` /
`test_userdata.py` plus new ones for the cases above, the parity test, and the
Phase 0 tests. Clippy is clean with `-D warnings`.

## Not in this phase (by plan)

Backup as a download needs a Save dialog → done with export in Phase 3 (the
core `backup_zip` is ready and tested). Spelling with the personal dictionary
→ Phase 2. AI chat persistence while streaming → Phase 4 (`append_chat` is
ready).

## Please check on the Mac

1. `cargo test --workspace`
2. `cargo tauri dev` → *Inställningar → Datamapp → Byt mapp …* → pick
   `~/dev/lab/word-work/data` (or a copy of it). Your documents, history,
   trash and AI chats should all appear.
3. Rename a document only by case (e.g. `ålgång`), then back.
4. *Visa i Finder* opens the folder.
