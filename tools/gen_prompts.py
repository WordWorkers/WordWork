"""Generates crates/ww-core/src/ai/prompts.rs from the old app's ai.py, so the
Swedish prompts stay word-for-word identical.

    python3 tools/gen_prompts.py ../word-work/backend
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else str(ROOT.parent / "word-work/backend"))
from app import ai  # noqa: E402


def raw(s: str) -> str:
    n = 1
    while '"' + "#" * n in s:
        n += 1
    h = "#" * n
    return f'r{h}"{s}"{h}'


out = [
    "//! Prompts and text types for the AI assistant.",
    "//!",
    "//! GENERATED from the old `backend/app/ai.py` by `tools/gen_prompts.py` – the",
    "//! Swedish wording is product logic and must stay identical. Do not edit by hand.",
    "",
    f"pub const SYSTEM_PROMPT: &str = {raw(ai.SYSTEM_PROMPT)};\n",
    "/// Quick actions: (key, question).",
    "pub const QUICK_PROMPTS: &[(&str, &str)] = &[",
    *[f'    ("{k}", {raw(v)}),' for k, v in ai.QUICK_PROMPTS.items()],
    "];\n",
    "/// Text types (frontmatter `genre`): (key, label, instruction).",
    "pub const GENRES: &[(&str, &str, &str)] = &[",
    *[f'    ("{k}", {raw(label)}, {raw(text)}),' for k, (label, text) in ai.GENRES.items()],
    "];",
]
(ROOT / "crates/ww-core/src/ai/prompts.rs").write_text("\n".join(out) + "\n", encoding="utf-8")
print("wrote prompts.rs")
