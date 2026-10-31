# Word Work – for developers

The app is a Tauri 2 desktop app: all logic in Rust (`crates/ww-core`), the
TipTap editor (from the Docker version, word-work 1.10.0) in the system
WebView. The port is described in [PLAN.md](../PLAN.md) and the phase reports
in this folder. User documentation: [README](../README.md),
[INSTALL.md](INSTALL.md).

## Development (macOS)

Requirements: Node 22, Xcode command line tools (`xcode-select --install`) and
Rust **via rustup** (≥ 1.90). Homebrew's `rust` package or an old standalone
install will not work: it can't add the Intel/Apple Silicon targets and is too
old for Tauri.

```sh
# Once: remove other Rust installs, then install rustup
which -a cargo rustc               # anything not in ~/.cargo/bin must go
brew uninstall rust 2>/dev/null    # if it came from Homebrew
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"          # or open a new terminal
```

In the repo (`rust-toolchain.toml` makes rustup fetch the right toolchain and
both macOS targets automatically):

```sh
cargo install tauri-cli --version "^2" --locked
(cd frontend && npm ci)
scripts/fetch-pandoc.sh          # pinned Pandoc 3.9 sidecar → src-tauri/binaries/

cargo test --workspace           # core tests
cargo tauri dev                  # app window with hot reload
cargo tauri build                # installers for this computer
```

### Data folder

The app keeps the texts in `~/Documents/Word Work` by default. To use the
folder from the Docker version, open *Inställningar → Datamapp → Byt mapp …*
and pick it (e.g. `~/dev/lab/word-work/data`) – the format is the same, nothing
is converted. `WW_DATA_DIR=/path cargo tauri dev` overrides it for one run.

### AI assistant

Set the server under *Inställningar → AI-assistent* (Ollama or an
OpenAI-compatible service, address, default model, API key). The key is kept
in the macOS Keychain. For development the old variables still work and win
over the settings: `WW_AI_API`, `WW_AI_URL`, `WW_AI_MODEL`, `WW_AI_KEY`.
All `WW_*` variables (also `WW_DATA_DIR`, `WW_PANDOC`) work in debug builds
only; a release build ignores them.
The stored key is removed when the address moves to another server, and a key
is never accepted for plain `http://` to a host outside the local network.
`python3 tools/fake_ollama.py` starts a fake server (both APIs, key `hemlig`)
for testing without a model.

### Smoke test

Open the devtools in the app window (right-click → Inspect) and run
`await wwSmokeTest()`, or start with `WW_SMOKE=1 cargo tauri dev` to print the
results in the terminal (`frontend/src/smoke.ts`). It creates and deletes test
documents, so use a test data folder (`WW_DATA_DIR`).

## Building for all platforms (GitHub Actions)

- `.github/workflows/ci.yml` – formatting, clippy, all tests (with the bundled
  Pandoc 3.9) and the frontend typecheck, on every push.
- `.github/workflows/build.yml` – installers on every push, as workflow
  artifacts:

  | Job | Runner | Output |
  |---|---|---|
  | macOS (Apple Silicon) | `macos-15` | `Word-Work_<v>_macOS-AppleSilicon.dmg` |
  | macOS (Intel) | `macos-15`, cross-compiled | `Word-Work_<v>_macOS-Intel.dmg` |
  | Windows | `windows-latest` | `…_Windows-x64-setup.exe`, `…_Windows-x64.msi` |
  | Linux | `ubuntu-22.04` | `.deb`, `.rpm`, `.AppImage` |

  Each job downloads its own Pandoc (`scripts/fetch-pandoc.sh <target>`,
  pinned and checksum-verified) and bundles it.

**Version:** set in `Cargo.toml` (`[workspace.package] version`, used by the
installers and *Om Word Work*) and `frontend/package.json` (shown in
*Inställningar*); keep them equal, plain numbers only (the `.msi` refuses
`-beta` etc.).

**Releasing:** bump `version` in `Cargo.toml` and `frontend/package.json`,
then `git tag v2.0.0 && git push --tags`. The workflow creates a *draft*
GitHub release with all installers and `SHA256SUMS`; check it and publish.

**Signing:** macOS builds are ad-hoc signed (users confirm once, see
INSTALL.md). With a Developer ID, add the repository secrets
`APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific password)
and `APPLE_TEAM_ID` – the same workflow then signs and notarizes. Windows
builds are unsigned (SmartScreen asks once).

## Layout

```
crates/ww-core/   storage, language, convert (Pandoc), ai – no Tauri, `cargo test`
src-tauri/        Tauri app: commands, state, config, icons, Pandoc sidecar
frontend/         editor UI (from word-work 1.10.0)
resources/        Swedish dictionaries, Lua filters, export templates, licence notices
scripts/          fetch-pandoc.sh, third-party-notices.sh
tools/            spylls reference generator, fake Ollama server
docs/             phase reports
```

## Licence

Apache License 2.0, © 2026 Mikke Schirén. Third-party components: see
[THIRD_PARTY_LICENSES.md](../THIRD_PARTY_LICENSES.md) and [LICENSES/](../LICENSES/).
Pandoc (GPL-2.0-or-later) is shipped as a separate program, not linked.

The app shows every bundled component with its licence text under *Om Word
Work → Visa alla licenstexter*. That text and the overview in
THIRD_PARTY_LICENSES.md are generated – run this after changing dependencies
(the Build workflow also does it for every build):

```sh
cargo install --locked cargo-about --features cli   # once
scripts/third-party-notices.sh                      # needs frontend/node_modules
```

`about.toml` lists the licences that are accepted for Rust crates; a crate
with any other licence makes the script fail.
