# Installing Word Work

Word Work is a calm, distraction-free word processor (Swedish interface). It
runs on macOS, Windows and Linux. The installers are on the project's GitHub
**Releases** page.

The apps are **not yet signed by Apple or Microsoft**, so your system will
warn once before the first start. The steps below are the normal way to
confirm that you trust the app. If you'd rather not, build it yourself (last
section) – the result is the same.

## Which file do I need?

| Computer | File |
|---|---|
| Mac with Apple Silicon (M1–M5; *Apple menu → About This Mac* says "Chip Apple …") | `Word-Work_<version>_macOS-AppleSilicon.dmg` |
| Mac with Intel processor ("Processor Intel …") | `Word-Work_<version>_macOS-Intel.dmg` |
| Windows 10/11 (64-bit) | `Word-Work_<version>_Windows-x64-setup.exe` (or the `.msi`) |
| Ubuntu, Debian, Mint … | `word-work_<version>_amd64.deb` |
| Fedora, openSUSE … | `word-work-<version>.x86_64.rpm` |
| Any other Linux | `Word-Work_<version>_x86_64.AppImage` |

### Check the download (optional, recommended)

Each release has a `SHA256SUMS` file. The checksum of your file must match:

```sh
shasum -a 256 Word-Work_*.dmg                                # macOS
sha256sum word-work_*.deb                                    # Linux
Get-FileHash .\Word-Work_*-setup.exe -Algorithm SHA256       # Windows PowerShell
```

## macOS (11 Big Sur or later)

1. Open the `.dmg` and drag **Word Work** to **Applications**.
2. Open Word Work from Applications. macOS says it *could not verify* the app
   – click **Done** (not *Move to Trash*).
3. Open **System Settings → Privacy & Security**, scroll down to the message
   about Word Work and click **Open Anyway**. Confirm with your password or
   Touch ID.
4. Word Work starts. From now on it opens like any other app.

Alternative for the Terminal, instead of steps 2–3:

```sh
xattr -dr com.apple.quarantine "/Applications/Word Work.app"
```

Good to know:

- After an **update** (a new download) the same confirmation is needed once
  more.
- If you store an **API key** for the AI assistant, macOS may ask after an
  update whether Word Work may use it in the keychain – choose **Always
  Allow**.
- If macOS ever says the app is *damaged*, the download was incomplete or
  altered: download it again and check the checksum.

## Windows 10/11

1. Run `Word-Work_<version>_Windows-x64-setup.exe`.
2. Windows SmartScreen says *Windows protected your PC*: click **More info**,
   then **Run anyway**.
3. The installer puts Word Work in your user account (no administrator
   needed) and adds it to the Start menu.

The `.msi` is for installing through company tools (Intune, Group Policy).
Word Work needs Microsoft Edge WebView2, which is part of Windows 10/11; the
installer fetches it if it's missing.

## Linux

Debian/Ubuntu:

```sh
sudo apt install ./word-work_<version>_amd64.deb
```

Fedora/openSUSE:

```sh
sudo dnf install ./word-work-<version>.x86_64.rpm      # or: sudo zypper install …
```

AppImage (no installation):

```sh
chmod +x Word-Work_<version>_x86_64.AppImage
./Word-Work_<version>_x86_64.AppImage
```

The packages pull in WebKitGTK 4.1 and GTK 3 (Ubuntu 22.04 / Debian 12 /
Fedora 36 or later). The API key for the AI assistant is kept in the
desktop's keyring (GNOME Keyring or KWallet).

## After installing

- **Your texts** are stored as plain Markdown files in
  `Documents/Word Work` (change it under *Inställningar → Datamapp*). Back the
  folder up like any other, or use *Arkiv → Spara allt (zip)*.
- Coming from the Docker version? Point *Datamapp* to the old `data` folder –
  nothing is converted.
- **AI assistant** (optional): *Inställningar → AI-assistent* – an Ollama
  server (e.g. `http://localhost:11434`) or an OpenAI-compatible service with
  an API key. The AI only suggests; it never writes in your text.
- Export to Word/OpenDocument/RTF/HTML works without anything else installed
  (Pandoc is included).

## Uninstalling

- **macOS:** move *Word Work* from Applications to the Trash. Settings:
  `~/Library/Application Support/se.schiren.wordwork`.
- **Windows:** *Settings → Apps → Word Work → Uninstall*.
- **Linux:** `sudo apt remove word-work` / `sudo dnf remove word-work`, or
  delete the AppImage.

Your texts in `Documents/Word Work` are never removed.

## Building it yourself

Requirements: Rust (via rustup), Node 22, and on Linux the WebKitGTK
development packages. Then:

```sh
git clone <repository> && cd word-work-rust
(cd frontend && npm ci)
scripts/fetch-pandoc.sh                        # Pandoc for this computer
frontend/node_modules/.bin/tauri build      # installers in target/release/bundle/
```

A self-built app is trusted by your own computer – no warnings.
