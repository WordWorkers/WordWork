# Tredjepartskomponenter

Word Work har licensen Apache 2.0 (se [LICENSE](LICENSE)), Copyright 2026 Mikke Schirén.
Här listas de komponenter från tredje part som följer med i appen eller Docker-imagen, och deras licenser.
Fullständiga licenstexter finns i [LICENSES/](LICENSES/). I imagen skapas förteckningen på nytt vid
bygget utifrån de paket som faktiskt installeras: `/app/licenses/THIRD_PARTY_NOTICES.txt`.

Skapad med `python backend/tools/notices.py --markdown …` – kör om när beroenden ändras.

## Program och data

| Komponent | Version | Licens | Hur den används |
|---|---|---|---|
| [Pandoc](https://pandoc.org) | 3.9 | GPL-2.0-or-later | Separat program för import och export; följer med i imagen via pypandoc_binary. Källkod: <https://github.com/jgm/pandoc/tree/3.9> |
| Den stora svenska ordlistan (Göran Andersson) | dictionary-sv 4.0.0 | LGPL-3.0 | Stavningsordlista, separata och oförändrade datafiler |
| Synlex – Folkets synonymlexikon (Viggo Kann, KTH) | 2009 | Synlex-licens (fri användning, notisen ska behållas) | Synonymer; omkodad till UTF-8 |

## Python-paket (backend)

| Paket | Version | Licens |
|---|---|---|
| annotated-doc | 0.0.5 | MIT |
| annotated-types | 0.8.0 | MIT |
| anyio | 4.15.1 | MIT |
| certifi | 2026.7.22 | MPL-2.0 |
| click | 8.5.0 | BSD-3-Clause |
| fastapi | 0.142.2 | MIT |
| h11 | 0.16.0 | MIT |
| httpcore | 1.0.9 | BSD-3-Clause |
| httpx | 0.28.1 | BSD |
| idna | 3.20 | BSD-3-Clause |
| opentelemetry-api | 1.45.1 | Apache-2.0 |
| pydantic | 2.13.5 | MIT |
| pydantic_core | 2.46.5 | MIT |
| pypandoc_binary | 1.17 | MIT |
| spylls | 0.1.7 | MPL-2.0 |
| starlette | 1.7.0 | BSD-3-Clause |
| typing-inspection | 0.4.4 | MIT |
| typing_extensions | 4.16.0 | PSF-2.0 |
| uvicorn | 0.54.0 | BSD-3-Clause |

## npm-paket (webbappen)

| Paket | Version | Licens |
|---|---|---|
| @fontsource-variable/literata | 5.3.0 | OFL-1.1 |
| @fontsource-variable/source-sans-3 | 5.3.0 | OFL-1.1 |
| @fontsource/ibm-plex-mono | 5.3.0 | OFL-1.1 |
| @tiptap/core | 3.31.4 | MIT |
| @tiptap/extension-blockquote | 3.31.4 | MIT |
| @tiptap/extension-bold | 3.31.4 | MIT |
| @tiptap/extension-bullet-list | 3.31.4 | MIT |
| @tiptap/extension-code | 3.31.4 | MIT |
| @tiptap/extension-code-block | 3.31.4 | MIT |
| @tiptap/extension-document | 3.31.4 | MIT |
| @tiptap/extension-dropcursor | 3.31.4 | MIT |
| @tiptap/extension-gapcursor | 3.31.4 | MIT |
| @tiptap/extension-hard-break | 3.31.4 | MIT |
| @tiptap/extension-heading | 3.31.4 | MIT |
| @tiptap/extension-horizontal-rule | 3.31.4 | MIT |
| @tiptap/extension-italic | 3.31.4 | MIT |
| @tiptap/extension-link | 3.31.4 | MIT |
| @tiptap/extension-list | 3.31.4 | MIT |
| @tiptap/extension-list-item | 3.31.4 | MIT |
| @tiptap/extension-list-keymap | 3.31.4 | MIT |
| @tiptap/extension-ordered-list | 3.31.4 | MIT |
| @tiptap/extension-paragraph | 3.31.4 | MIT |
| @tiptap/extension-strike | 3.31.4 | MIT |
| @tiptap/extension-text | 3.31.4 | MIT |
| @tiptap/extension-underline | 3.31.4 | MIT |
| @tiptap/extensions | 3.31.4 | MIT |
| @tiptap/markdown | 3.31.4 | MIT |
| @tiptap/pm | 3.31.4 | MIT |
| @tiptap/starter-kit | 3.31.4 | MIT |
| diff | 9.0.0 | BSD-3-Clause |
| dompurify | 3.4.16 | (MPL-2.0 OR Apache-2.0) |
| linkifyjs | 4.3.3 | MIT |
| marked | 17.0.6 | MIT |
| orderedmap | 2.1.1 | MIT |
| prosemirror-changeset | 2.4.4 | MIT |
| prosemirror-commands | 1.7.2 | MIT |
| prosemirror-dropcursor | 1.8.4 | MIT |
| prosemirror-gapcursor | 1.4.1 | MIT |
| prosemirror-history | 1.5.1 | MIT |
| prosemirror-inputrules | 1.5.1 | MIT |
| prosemirror-keymap | 1.2.3 | MIT |
| prosemirror-model | 1.25.12 | MIT |
| prosemirror-schema-list | 1.5.1 | MIT |
| prosemirror-state | 1.4.4 | MIT |
| prosemirror-tables | 1.8.5 | MIT |
| prosemirror-transform | 1.12.2 | MIT |
| prosemirror-view | 1.42.6 | MIT |
| rope-sequence | 1.3.4 | MIT |
| w3c-keyname | 2.2.8 | MIT |

## Grundimage

Docker-imagen bygger på Chainguards Wolfi-baserade images (`cgr.dev/chainguard/python`).
Operativsystempaketen i dem, bland annat Python, har egna licenser. De framgår av imagens SBOM
(se *Skanning och SBOM* i README).
