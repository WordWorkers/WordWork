# Phase 2 – language tools: results

Date: 2026-10-29. Status: **done** (verified on Linux in a real WebView with the
old backend switched off; please run the checks at the end on the Mac).

## What was built

| Part | Where |
|---|---|
| Spell check with the old rules: same word cleaning (`strip("-'’")`), skip words with digits or > 64 characters, personal dictionary first | `Dictionaries::misspelled` in `crates/ww-core/src/language.rs` |
| Suggestions without the word itself, cached (5 000 words); no time budget needed any more | `Dictionaries::suggestions` |
| Synonyms for the word, its lower-case form and its base forms, with `base_form` flag | `Dictionaries::synonyms` |
| Personal dictionary: words and phrases (≤ 6 words), `#` comments, sorted like Python's `casefold`, reread when the file is edited by hand, "fanzine" also accepts "Fanzine" but not the other way round | `PersonalDictionary` |
| 8 Tauri commands (check, suggest, synonyms, dictionary get/add/replace/rename/remove) | `src-tauri/src/language_commands.rs` |
| Routes for `/spell/*` and `/synonyms` | `frontend/src/ipc-routes.ts` |

The personal dictionary lives in the data folder (`.wordwork/ordlista.txt`)
and follows it when you switch folders. The big dictionaries load once at
start (0.2 s) in the background.

## Compatibility

- `test_language.py` ported (10 Rust tests, incl. hand-edited file, phrases,
  capitalisation rule, invalid entries, sorting).
- **Every word in the real data folder** – current documents, all 77 history
  versions and the trash, 2,664 distinct words – checked by the old backend and
  by Rust:
  - Spelling: 535 of 537 flagged words identical. The two differences: Rust
    accepts `framträder` (correct Swedish; spylls was wrong) and skips `½`.
  - Synonyms: 2,647 of 2,664 identical. 9 differ only in the order of base
    forms; 6 are abbreviations (`A`, `DN`, `IN`, `OR`, `S`, `RAR`) where spylls
    produced dozens of absurd "base forms" (`DN` → `adel`, `agenda` …) and Rust
    gives none or only the real one; 2 where Rust finds more (`framträder` →
    `framträda`, `mot` → also `mota`).
- In the app, with the old backend stopped: misspelled words are underlined,
  right-click shows suggestions and synonyms, adding to and editing the
  personal dictionary works, and the in-app comparison against the old backend
  on the same text was identical (6/6 flagged words).
- Speed: checking all words of a document takes ~8 ms; suggestions for five
  words ~270 ms in a debug build.

## Tests

51 Rust tests in total (`cargo test --workspace`), clippy clean with
`-D warnings`.

## Please check on the Mac

1. `cargo test --workspace`
2. `cargo tauri dev` **without** the old backend running: open a document,
   misspelled words are underlined; right-click → suggestions, *Lägg till i egen
   ordlista*, synonyms; *Inställningar → Egen ordlista …* lists and edits the
   entries.
