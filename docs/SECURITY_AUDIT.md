# Security audit – Word Work 2.0 (Tauri)

Date: 2026-10-30 · Scope: `src-tauri/`, `crates/ww-core/`, `frontend/src/`,
`resources/filters/`, `.github/workflows/`, `scripts/fetch-pandoc.sh`, dependencies.
Method: code review, reproduction with the bundled Pandoc 3.9, `cargo audit`
(RustSec, 595 crates), `npm audit`.

## Summary

The app has a small attack surface. It has a strict CSP, the WebView only has
`core:default` permissions, and nothing outside the app is loaded. Every path
built from user input is validated, and all HTML is sanitized. The API key
never reaches the UI.

The one real issue: **exported Word/ODT/RTF files can carry any local file**
that the document points to. The fix is one Pandoc flag.

| # | Severity | Finding | Fix effort |
|---|---|---|---|
| 1 | **Medium** | Pandoc export embeds local files and fetches remote URLs (no `--sandbox`) | 1 line |
| 2 | Low–medium | API key follows a changed AI address; may be sent over plain http | Small |
| 3 | Low | Dev overrides (`WW_*` env vars, `spike_report`) active in release builds | Small |
| 4 | Low | No Rust-side navigation guard for the WebView | Small |
| 5 | Low | Dependencies with advisories (dompurify, zip), not exploitable as used | Version bumps |
| 6 | Low | CI: third-party actions pinned by tag, default token permissions | Small |
| 7 | Info | No update mechanism; unsigned binaries; silent fallbacks (Pandoc on PATH, compile-time resource path) | – |

## Status: findings 1–6 fixed (2026-10-30)

| # | Fix | Where | Verified by |
|---|---|---|---|
| 1 | `--sandbox` on every Pandoc import/export | `convert.rs` | `export_never_embeds_local_files` (fails without the flag); smoke-test imports |
| 2 | Key removed when the address moves to another origin (UI says so); key refused for `http://` outside the local network | `ai_commands.rs` (`key_update`), `main.ts` | `key_follows_server`, `key_rules` |
| 3 | `WW_*` variables read through `dev_env()`, `None` in release builds; `spike_report` (now `smoke_report`) is a no-op in release | `state.rs`, `commands.rs` | review |
| 4 | `navigation-guard` plugin: only the app page itself (`tauri://localhost/`, `http(s)://tauri.localhost/`) may load. Web/mail links go to the browser, everything else is blocked, including other paths on the app origin, which would reload the app | `shell.rs`, `lib.rs` | `app_urls`; in the app: relative link and `file://` blocked, smoke test passes |
| 5 | dompurify 3.4.17, zip 9.1; `cargo audit`: 0 vulnerabilities, `npm audit`: 0 | `package.json`, `ww-core/Cargo.toml` | audits |
| 6 | Actions pinned by commit SHA; `permissions: contents: read`; Tauri CLI 2.12.4 is a locked devDependency; new `audit` CI job; Dependabot for actions, cargo and npm | `.github/` | YAML check |

Item 7 is unchanged: no update mechanism, unsigned binaries, silent
fallbacks.

## 1. Export embeds local files (Medium)

`Pandoc::export` runs Pandoc without `--sandbox`. Pandoc's docx, odt and rtf
writers then read every image reference in the Markdown and put it in the
file. This includes absolute paths, `file://` URLs and `http(s)://` URLs, and
any file type, not only images.

Reproduced with `ww-pandoc` 3.9:

```markdown
![](/home/user/.ssh/id_ed25519)
![](file:///etc/passwd)
```

→ `word/media/rId21.txt` and `rId24.so` inside the `.docx` contained the
files verbatim. ODT had the same result (`Pictures/1.txt`). The editor shows
nothing; the warnings go only to Pandoc's stderr.

**How it happens:** the export reads the file on disk, not what the editor
shows. Two ways a document like this gets there:

- A `.md`/`.txt` import is stored raw. Pandoc-based imports strip images in
  `import.lua`.
- A file placed directly in the data folder, for example from a shared or
  synced folder.

The writer exports and sends the `.docx` to a publisher, and the secret goes
with it. Remote URLs also mean that exporting makes network requests
(tracking pixel, IP leak).

**Fix:** add `--sandbox` to every Pandoc call in `convert.rs` (`export` and
`import`). Verified: with `--sandbox` nothing is embedded, while
`--reference-doc` and the Lua filters still work, because files named on the
command line are allowed. Optionally, also drop `Image` in the export
filters, since the editor can't show images anyway.

## 2. AI key handling (Low–medium)

- `ai_config_set` keeps the stored key when the address changes. Changing
  the address to another server sends the key there on the next request.
  **Fix:** clear the key (or require it again) when the host changes.
- An `http://` address to an external host sends the key and the text
  unencrypted. `is_external` already exists. **Fix:** refuse a key with
  `http://` unless the host is local (localhost, private network, `.local`).
- Good: the key is in the Keychain / Credential Manager / Secret Service,
  never sent to the UI, and not logged. reqwest drops `Authorization` on
  cross-host redirects.

## 3. Development hooks in release builds (Low)

- In release builds, `WW_PANDOC` (which program to run), `WW_AI_URL` /
  `WW_AI_API` / `WW_AI_MODEL` / `WW_AI_KEY` and `WW_DATA_DIR` are all read.
  Anyone who can set the user's environment already owns the account, so the
  risk is low. Still, `WW_AI_URL` combined with the stored key is a quiet way
  to send the key elsewhere.
- `spike_report` is registered in release builds (the WebView can print to
  stdout and quit the app).

**Fix:** `#[cfg(debug_assertions)]` on the env overrides and the command.

## 4. WebView navigation (Low)

Links are intercepted in JS: http/https/mailto go to `open_url`, which
allowlists schemes in Rust. A *relative* link (allowed by DOMPurify in
notes/comments) or any other scheme falls through. Clicking it navigates the
main window away from the editor. That is not code execution, because the
CSP and capabilities still apply, but unsaved text can be lost.

**Fix:** add an `on_navigation` handler on the main window in Rust. Allow
only the app's own origin and send everything else to the opener or block it.

## 5. Dependencies (Low)

| Package | Advisory | Exploitable here? | Action |
|---|---|---|---|
| dompurify 3.4.16 | GHSA-cg2g-xh64-v4q7, -mrv2-3pqr-j5jr, -c6gr-qvv4-5v3f | No – needs `SAFE_FOR_TEMPLATES`, `IN_PLACE` + hooks, or XHTML parsing, none used | `npm update dompurify` (3.4.17) |
| zip 2.6.1 | RUSTSEC-2026-0367/0368/0369 | No – only extraction is affected; the app only writes zips | Bump to `zip = "9"` |
| gtk-rs 0.18, zbus/zvariant, proc-macro-error | unmaintained / unsound iterator | Linux only, comes from Tauri/wry | Follow Tauri updates |

Add `cargo audit` and `npm audit --omit=dev` to `ci.yml` so new advisories
show up.

## 6. CI / supply chain (Low)

- Good: Pandoc is pinned and sha256-verified, `npm ci` uses a lockfile,
  `Cargo.lock` is committed, signing secrets are only exposed on the macOS
  step and only when present, and fork PRs get no secrets.
- `dtolnay/rust-toolchain`, `Swatinem/rust-cache` and
  `softprops/action-gh-release` are pinned by tag. These jobs will hold the
  Apple certificate later. **Fix:** pin by commit SHA (Dependabot can keep
  them current).
- Neither workflow sets `permissions:` at the top. **Fix:**
  `permissions: contents: read` globally; the `release` job already asks for
  `contents: write`.
- `npx --yes @tauri-apps/cli@2.12.4` is version-pinned but not covered by
  the lockfile. **Fix:** add the CLI as a devDependency and run it from
  `node_modules`.

## 7. Notes (Info)

- **No updates:** users won't learn about security fixes. Later: the
  `tauri-plugin-updater` with signed update manifests.
- **Unsigned binaries:** already known (Developer ID later). Users can
  check SHA256SUMS, but those come from the same release page.
- **Silent fallbacks:** if the sidecar is missing, `pandoc` from PATH is
  run. If resources are missing, a compile-time path (the CI runner's
  checkout) is tried. In release builds, fail instead.
- **HTML export** keeps raw HTML from the document (e.g. `<script>` in a
  hand-written `.md`). That is the user's own content, but worth knowing
  before publishing an exported page.
- Documents are stored as plain text (by design); new files are 0600 via
  tempfile, exports 0644.

## Checked and fine

- **CSP:** `default-src 'self'`, no remote scripts, connect only to IPC.
  `style-src 'unsafe-inline'` is the only relaxation.
- **Capabilities:** only `core:default`. The dialog, opener and clipboard
  plugins are used from Rust only, and the JS can't call them.
- **HTML sinks:** all `innerHTML` content goes through DOMPurify with tight
  allowlists (AI answers: no attributes at all). `open_url` allows only
  http/https/mailto.
- **Paths:**
  - `validate_name` blocks separators, `..`, a leading dot, control
    characters and Windows-forbidden characters.
  - Version ids and chat ids are strictly validated.
  - Trash restore rejects separators and leading dots, and re-validates the
    names it parses.
  - The backup skips symlinks.
- **Import:** 25 MB limit, extension allowlist, file name sanitized; Pandoc
  reads from stdin with a 60 s timeout. `import.lua` strips images and raw
  HTML.
- **No shell:** Pandoc and the opener are spawned with argument lists, not
  through a shell.
- **AI output:** shown as sanitized Markdown only; it never writes into the
  document.
