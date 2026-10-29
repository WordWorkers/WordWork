# Phase 0 – spikes and skeleton: results

Date: 2026-10-29. Status: **done on Linux**; the macOS-only checks at the end
need to be run on a Mac (locally or in CI).

## What was built

| Part | Where |
|---|---|
| Cargo workspace: `ww-core` (no Tauri) + `src-tauri` (app) | `Cargo.toml`, `crates/ww-core`, `src-tauri` |
| Old frontend copied unchanged, plus `src/ipc.ts` (Tauri transport) and one import line in `main.ts` | `frontend/` |
| Dictionaries, Lua filters, export templates copied unchanged | `resources/` |
| Tauri config: bundle id, CSP, resources, Pandoc sidecar, macOS 11+, hardened runtime | `src-tauri/tauri.conf.json` |
| App icons generated from `favicon.svg` | `src-tauri/icons/` |
| Pinned, checksum-verified Pandoc sidecar download | `scripts/fetch-pandoc.sh` |
| CI: Linux (fmt, clippy, tests, typecheck) + macOS universal build | `.github/workflows/ci.yml` |
| Phase 0 commands: `health`, `spell_check`, `spell_suggest`, `synonyms`, `spike_export`, `ai_chat`, `ai_cancel` | `src-tauri/src/commands.rs` |
| Tests: 12 (unit + integration) | `crates/ww-core/{src,tests}` |

## Spike A – Swedish spelling: **spellbook confirmed**

`spellbook` 0.4 (pure Rust, from the Helix editor) with the unchanged
`sv_SE.aff/.dic`, compared with spylls (the old engine) on 2,364 words from the
old README, PROJEKTPLAN and sample documents:

| | spylls (old) | spellbook (new) |
|---|---|---|
| Load time | ~5 s (background thread) | **0.2 s** |
| Check 2,364 words | 2.8 s | **0.04 s** |
| Check agreement | – | **2,362 / 2,364** |
| Suggestions, slowest word | 9.1 s (`kulturjornalist`) | **0.5 s** |
| Same first suggestion | – | 20 / 27; mean overlap 88 % |

- The two differences: spellbook accepts `assistant` and rejects `JS-alternativ`
  (spylls accepts `JS` via an odd abbreviation rule). Both acceptable; recorded
  in `tests/spelling_parity.rs`.
- Suggestions are fast enough that the old 2 s / 0.35 s time-budget machinery
  can be dropped (keep the cache). Ranking differs a little, e.g. for `Ålgång`
  spellbook offers `Älgång` first – arguably better.
- **Stemming:** spellbook has no stem API. A ~100-line suffix stripper reading
  the `SFX` rules of the same `.aff` file (`language::Stemmer`) finds the
  spylls base form for **255 of 257** words (the misses are `NATO` → `Nato` and
  the single letter `O`). Good enough for synonyms, which are best effort.
- Fallback (`hunspell-sys`, C) is **not needed**.

## Spike B – Pandoc sidecar: **works; two findings**

- The old app's `pypandoc_binary 1.17` bundles **Pandoc 3.9**. The sidecar is
  pinned to the official 3.9 macOS releases with SHA-256 checks.
- Export to DOCX/ODT/RTF/HTML/TXT with the existing reference documents and
  `chapters.lua`, and DOCX import through `import.lua` (frontmatter, headings,
  footnotes) pass against both Pandoc 3.1.3 and 3.9 (`tests/pandoc.rs`).
- **Finding 1 – locale.** Pandoc decodes its arguments using the locale. Apps
  started from Finder have no `LANG`, so `-M pagetitle=Ålgång` came out as
  `��lg��ng`. Fixed: the runner sets `LC_ALL` (`en_US.UTF-8` on macOS).
- **Finding 2 – size.** The macOS binaries are 190 MB (arm64) and 120 MB
  (x86_64); a universal binary is ~310 MB inside the `.app` (zipped ~70 MB).
  Options: accept it, or ship separate Apple Silicon / Intel downloads
  (~190/120 MB). **Decision needed before Phase 6** (see open questions).
- Pandoc is run with `std::process` (no shell plugin needed), with stdin/stdout
  on separate threads and a 60 s kill timeout.

## Spike C – AI streaming over a Tauri Channel: **confirmed end to end**

- `ww-core::ai::OllamaClient::chat` streams Ollama's NDJSON and emits the same
  `AIEvent` JSON as the old backend (`{"type":"content","text":…}` etc.), with
  cancellation through a `CancellationToken`.
- Core tests use a fake Ollama over raw TCP: normal stream with thinking/done
  statistics, cancel mid-stream (< 600 ms), server error, unreachable server.
- **End to end in a real WebView** (WebKitGTK under Xvfb, `WW_SPIKE=1`):
  `health`, spelling, suggestions and synonyms over `invoke`; AI stream over
  `ipc::Channel` – first content after 157 ms, 45 content events, aborted
  after 1.5 s via `AbortSignal` → `ai_cancel`, and the fake server saw the
  connection close. Error objects `{status, detail}` map to `ApiError`.

## Decisions confirmed or changed

| Plan said | Now |
|---|---|
| spellbook, fallback hunspell-sys | **spellbook** + own suffix stemmer |
| Suggestion time budget | Not needed (0.5 s worst case); keep cache only |
| Pandoc sidecar | **Pandoc 3.9 pinned**; run with `LC_ALL` set |
| `tauri-plugin-shell` for the sidecar | Not needed – plain `std::process` |
| Dev workflow | `cargo tauri dev` loads Vite; Vite still proxies `/api` to the old Python backend, so the full UI works while commands are ported |

## Still to verify on a Mac

These cannot be run from Linux. Either run them locally or push to GitHub and
let the `macos` CI job do the build:

1. `scripts/fetch-pandoc.sh` → three binaries in `src-tauri/binaries/`.
2. `WW_PANDOC=src-tauri/binaries/ww-pandoc-aarch64-apple-darwin cargo test -p ww-core`
3. `cargo tauri dev` – the app window shows the editor (WKWebView). In the
   devtools console (right-click → Inspect): `await wwSpike()`.
4. With Ollama running: `WW_SPIKE=1 cargo tauri dev` prints the smoke test.
5. `cargo tauri build --target universal-apple-darwin` → open the `.app` from
   Finder. The window and editor should load; document calls still go to
   `/api` and fail in a release build until Phase 1 ports them.
6. With a Developer ID: signed + notarized build, including the Pandoc sidecar
   under hardened runtime.

## How to reproduce

```sh
cargo test --workspace                                   # 12 tests
cargo run --release -p ww-core --example spell_spike -- \
    resources/sv crates/ww-core/tests/fixtures/spylls_reference.json
python3 tools/fake_ollama.py &                           # fake AI server on :11434
WW_SPIKE=1 cargo tauri dev                               # smoke test in the app
```
