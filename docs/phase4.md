# Phase 4 – AI assistant: results

Date: 2026-10-29. Status: **done** (verified on Linux in a real WebView against
fake Ollama and OpenAI servers; please run the checks at the end on the Mac
with your real server).

With this phase **the app no longer needs the old Python backend for
anything.**

## What was built

| Part | Where |
|---|---|
| System prompt, quick actions and text types – **generated** word for word from the old `ai.py` | `crates/ww-core/src/ai/prompts.rs`, `tools/gen_prompts.py` |
| Frontmatter parsing (`genre`, `ai: |` blocks, folded `>` blocks, quotes, `# comments`), metadata block, selection, history (max 20), length limits, context-window steps, "external server" check | `ai/messages.rs` |
| Ollama client: availability (cached 30 s/15 s), model list via `/api/tags` + `/api/show` (embedding/OCR filtered, thinking capability), streaming `/api/chat` with `think` and `num_ctx` | `ai/ollama.rs` |
| OpenAI-compatible client: `/v1` added when missing, Bearer key, model list (embedding/audio/image filtered, fallback to the configured model), SSE streaming, `reasoning_content`/`reasoning`, `<think>` tags split even across chunks, retry without `temperature`, readable 401/403/404/429 messages | `ai/openai.rs` |
| Chat session: validates, streams, and saves question + answer in the document's conversation – also on *Stoppa* ("Avbrutet", partial answer kept) and on errors | `ai/session.rs` |
| 7 Tauri commands; the answer streams over a Tauri `Channel`, *Stoppa* cancels in Rust | `src-tauri/src/ai_commands.rs`, `api.aiChat` |
| **Settings → AI-assistent**: server type, address, default model, API key. The key is stored in the **macOS Keychain** and never sent to the UI; empty address turns AI off. `WW_AI_*` variables still override (development). | `state.rs`, `main.ts` |

## Compatibility

- `test_ai.py` and `test_ai_openai.py` ported: **19 Rust tests** (wiremock
  fakes for both APIs, plus cancellation over a slow socket).
- **Prompt parity:** 312 cases – every document in the real data folder (51
  incl. history and trash) × free question / each quick action, with and
  without selection and history, plus edge cases (folded blocks, quoted
  values, comments, empty frontmatter, overlong instructions, empty question)
  – built by the old Python code and by Rust: **312/312 identical** messages,
  context sizes and error texts.
- In the app (fake servers): the AI panel lists models, *Hitta upprepningar*
  streams the answer with "Visa resonemang", the meta line shows
  `fake-model:7b · 2 s · 48 tokens/s`, a stopped answer is saved as
  *Avbrutet*, and the old conversations from the data folder are listed.
  Switching to *OpenAI-kompatibel* with a key in *Inställningar* stored the key
  in the keyring, listed `fake-gpt` (which needs the key) and split the
  `<think>` reasoning correctly.

## Small changes compared with the old app

- Error texts that pointed to `WW_AI_KEY`/`WW_AI_URL` now point to
  *Inställningar → AI-assistent*.
- Transport errors are described in Swedish ("ingen anslutning",
  "tidsgränsen nåddes") instead of Python class names.
- The *Inställningar* panel now scrolls when it is taller than the window
  (it was cut off once the AI and data-folder sections were added).

## Tests

93 Rust tests in total (`cargo test --workspace`), clippy clean with
`-D warnings`.

## Please check on the Mac

1. `cargo tauri dev` **without** the old backend.
2. *Inställningar → AI-assistent*: enter your server (e.g. your Ollama at
   `https://ollama.dglive.net` or `http://localhost:11434`), press *Spara*.
3. ⌘J → pick a model → a quick action; try *Stoppa* half-way; reopen the
   panel – both answers are in the conversation.
4. For an OpenAI-compatible service: choose it, add the key, *Spara*, and
   check *Nyckelringsåtkomst* (Keychain Access) for `se.schiren.wordwork`.
