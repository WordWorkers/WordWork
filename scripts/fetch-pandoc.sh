#!/usr/bin/env bash
# Downloads the pinned Pandoc release (checksum-verified) and installs it as a
# Tauri sidecar: src-tauri/binaries/ww-pandoc-<target-triple>[.exe]
# ("ww-pandoc", not "pandoc": Linux packages install sidecars to /usr/bin,
# where a system Pandoc may already be.)
#
#   scripts/fetch-pandoc.sh                     # this computer (macOS: both + universal)
#   scripts/fetch-pandoc.sh aarch64-apple-darwin x86_64-pc-windows-msvc …
#
# Supported targets: aarch64-apple-darwin, x86_64-apple-darwin,
# universal-apple-darwin (needs lipo, i.e. macOS), x86_64-pc-windows-msvc,
# x86_64-unknown-linux-gnu, aarch64-unknown-linux-gnu.
# Works with macOS's bash 3.2 and Git Bash on Windows.
set -euo pipefail

VERSION=3.9 # same as pypandoc_binary 1.17 in the old app
BASE="https://github.com/jgm/pandoc/releases/download/$VERSION"

# target → "archive sha256 path-inside-archive"
asset() {
  case "$1" in
  aarch64-apple-darwin)
    echo "pandoc-$VERSION-arm64-macOS.zip 7d56ac6fe6fad0a7407bcd776aa142f61ca41838f286165f79d0584fa57b24d1 pandoc-$VERSION-arm64/bin/pandoc" ;;
  x86_64-apple-darwin)
    echo "pandoc-$VERSION-x86_64-macOS.zip f1dfb5a433976b131818c2e69db70bb46874604367e8923412a5c2fa673f2526 pandoc-$VERSION-x86_64/bin/pandoc" ;;
  x86_64-pc-windows-msvc)
    echo "pandoc-$VERSION-windows-x86_64.zip edccdaa95b5a33b3320187f0e291d58a232e21318a8081750bd31f847e598d18 pandoc-$VERSION/pandoc.exe" ;;
  x86_64-unknown-linux-gnu)
    echo "pandoc-$VERSION-linux-amd64.tar.gz 872a10c7ec29d5278831d855b11bd4ade0df4d5ec9a089a3197bc63a37eb4003 pandoc-$VERSION/bin/pandoc" ;;
  aarch64-unknown-linux-gnu)
    echo "pandoc-$VERSION-linux-arm64.tar.gz e09b97d7313bd417a35bde6c747c458486ec84f696e1cfd0f8c527cd69c89433 pandoc-$VERSION/bin/pandoc" ;;
  *) return 1 ;;
  esac
}

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/src-tauri/binaries"
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch() { # target
  local target="$1" ext="" spec archive sum inner dest
  [[ "$target" == *windows* ]] && ext=".exe"
  dest="$OUT/ww-pandoc-$target$ext"
  if [[ -x "$dest" ]] && "$dest" --version 2>/dev/null | head -1 | grep -q "pandoc $VERSION\$"; then
    echo "$dest is already pandoc $VERSION"
    return
  fi
  spec="$(asset "$target")" || { echo "Unknown target: $target" >&2; exit 1; }
  read -r archive sum inner <<<"$spec"
  echo "Downloading $archive …"
  curl -fsSL --retry 3 -o "$TMP/$archive" "$BASE/$archive"
  if [[ "$(sha256 "$TMP/$archive")" != "$sum" ]]; then
    echo "Checksum mismatch for $archive" >&2
    exit 1
  fi
  case "$archive" in
  *.zip) unzip -q -o "$TMP/$archive" "$inner" -d "$TMP/x-$target" ;;
  *.tar.gz) mkdir -p "$TMP/x-$target" && tar -xzf "$TMP/$archive" -C "$TMP/x-$target" "$inner" ;;
  esac
  cp "$TMP/x-$target/$inner" "$dest"
  chmod 755 "$dest"
  # Remove quarantine so local dev runs on macOS work.
  if command -v xattr >/dev/null; then xattr -d com.apple.quarantine "$dest" 2>/dev/null || true; fi
  echo "Installed $dest"
}

universal() {
  fetch aarch64-apple-darwin
  fetch x86_64-apple-darwin
  lipo -create "$OUT/ww-pandoc-aarch64-apple-darwin" "$OUT/ww-pandoc-x86_64-apple-darwin" \
    -output "$OUT/ww-pandoc-universal-apple-darwin"
  echo "Universal binary: $(du -h "$OUT/ww-pandoc-universal-apple-darwin" | cut -f1)"
}

targets=("$@")
if [[ ${#targets[@]} -eq 0 ]]; then
  case "$(uname -s)" in
  Darwin) targets=(universal-apple-darwin) ;;
  Linux) targets=("$(uname -m | sed 's/arm64/aarch64/')-unknown-linux-gnu") ;;
  MINGW* | MSYS* | CYGWIN*) targets=(x86_64-pc-windows-msvc) ;;
  *) echo "Unknown system – name the target, e.g. $0 x86_64-unknown-linux-gnu" >&2; exit 1 ;;
  esac
fi
for t in "${targets[@]}"; do
  if [[ "$t" == universal-apple-darwin ]]; then universal; else fetch "$t"; fi
done
ls -l "$OUT"
