#!/usr/bin/env bash
# Writes the licence notices of every third-party component in the app:
#  - resources/licenses/THIRD_PARTY_NOTICES.txt – with all licence texts; shown
#    under "Om Word Work → Visa alla licenstexter" and bundled in the installers
#  - THIRD_PARTY_LICENSES.md – overview (name, version, licence)
#
#   scripts/third-party-notices.sh
#
# Needs cargo-about (cargo install --locked cargo-about --features cli) and the
# frontend's node_modules (npm ci). Run it again when dependencies change;
# the Build workflow does it for every build.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/resources/licenses/THIRD_PARTY_NOTICES.txt"
MD="$ROOT/THIRD_PARTY_LICENSES.md"
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' "$ROOT/Cargo.toml" | head -1)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

about() { # template output
  cargo about generate --locked -m "$ROOT/src-tauri/Cargo.toml" -c "$ROOT/about.toml" "$ROOT/scripts/$1" -o "$2"
}
about about.hbs "$TMP/rust.txt"
about about-md.hbs "$TMP/rust.md"
# Output via stdout, not a path argument: on Windows, Node and Git Bash see /tmp differently.
node "$ROOT/frontend/scripts/notices.mjs" >"$TMP/npm.txt"
node "$ROOT/frontend/scripts/notices.mjs" --json >"$TMP/npm.json"

LINE="=============================================================================="

# ---------------------------------------------------------------- full text
mkdir -p "$(dirname "$OUT")"
{
  cat <<END_OF_HEADER
Word Work $VERSION – tredjepartskomponenter / third-party components
$LINE

Word Work har licensen Apache License 2.0 (se LICENSE).
Copyright 2026 Mikke Schirén.

Appen innehåller komponenter från tredje part med egna licenser. De listas
här med sina licenstexter:

  1. Program och data: Pandoc, stavningsordlistan, synonymerna, typsnitten
  2. Rust-bibliotek (appens kärna och fönster, bland annat Tauri)
  3. JavaScript-bibliotek (editorn, bland annat TipTap)
  4. GPL-2.0, LGPL-3.0 och MPL-2.0 i sin helhet


1. PROGRAM OCH DATA
$LINE

Pandoc 3.9 – GNU General Public License version 2 eller senare
  Copyright (C) 2006-2024 John MacFarlane.
  Följer med som ett separat program (ww-pandoc) för import och export.
  Källkod: https://github.com/jgm/pandoc/tree/3.9
  Licenstext: avsnitt 4 (GPL-2.0).

Den stora svenska ordlistan (sv_SE.aff, sv_SE.dic) – GNU LGPL version 3
  Copyright (C) 2003-19 Göran Andersson.
  Stavningsordlista, separata och oförändrade datafiler.
  Licenstext: avsnitt 4 (LGPL-3.0).

Synlex – Folkets synonymlexikon (th_sv_SE.dat)
  Copyright (c) Viggo Kann KTH 2009, konverterad till OpenOffice.org-format
  av Niklas Johansson. Fri att använda; notisen ska behållas.
  Ändrad för Word Work: omkodad från ISO-8859-1 till UTF-8.

Typsnitten Literata, Source Sans 3 och IBM Plex Mono – SIL Open Font License 1.1
  Licenstexterna finns under respektive @fontsource-paket i avsnitt 3.


2. RUST-BIBLIOTEK
$LINE
Grupperade efter licens: varje licenstext följs av biblioteken som använder den.
END_OF_HEADER
  cat "$TMP/rust.txt"
  printf '\n\n3. JAVASCRIPT-BIBLIOTEK\n%s\n\n' "$LINE"
  cat "$TMP/npm.txt"
  printf '\n\n4. LICENSTEXTER\n%s\n' "$LINE"
  for f in GPL-2.0 LGPL-3.0 MPL-2.0; do
    printf '\n%s\n%s\n%s\n\n' "------------------------------------------------------------------------------" "$f" \
      "------------------------------------------------------------------------------"
    cat "$ROOT/LICENSES/$f.txt"
  done
} >"$OUT"
echo "Wrote $OUT ($(wc -c <"$OUT") bytes)"

# ---------------------------------------------------------------- overview
{
  cat <<END_OF_MD
# Tredjepartskomponenter

Word Work har licensen Apache 2.0 (se [LICENSE](LICENSE)), Copyright 2026 Mikke Schirén.
Här listas komponenterna från tredje part som följer med i appen ($VERSION) och deras licenser.
Alla licenstexter finns i [resources/licenses/THIRD_PARTY_NOTICES.txt](resources/licenses/THIRD_PARTY_NOTICES.txt)
(i appen: *Om Word Work → Visa alla licenstexter*) och i [LICENSES/](LICENSES/).

Skapad med \`scripts/third-party-notices.sh\` – kör om när beroenden ändras.

## Program och data

| Komponent | Version | Licens | Hur den används |
|---|---|---|---|
| [Pandoc](https://pandoc.org) | 3.9 | GPL-2.0-or-later | Separat program (ww-pandoc) för import och export. Källkod: <https://github.com/jgm/pandoc/tree/3.9> |
| Den stora svenska ordlistan (Göran Andersson) | dictionary-sv 4.0.0 | LGPL-3.0 | Stavningsordlista, separata och oförändrade datafiler |
| Synlex – Folkets synonymlexikon (Viggo Kann, KTH) | 2009 | Synlex-licens (fri användning, notisen ska behållas) | Synonymer; omkodad till UTF-8 |
| Literata, Source Sans 3, IBM Plex Mono | | OFL-1.1 | Typsnitt (via @fontsource, se nedan) |

## Rust-bibliotek (appen, alla plattformar)

| Bibliotek | Version | Licens |
|---|---|---|
END_OF_MD
  grep -v -e '^| word-work ' -e '^| ww-core ' "$TMP/rust.md" | grep '^| ' | sort -f -u
  printf '\n## JavaScript-bibliotek (editorn)\n\n| Paket | Version | Licens |\n|---|---|---|\n'
  node -e 'for (const r of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))) console.log(`| ${r.name} | ${r.version} | ${r.license} |`)' \
    "$TMP/npm.json"
} >"$MD"
echo "Wrote $MD"
