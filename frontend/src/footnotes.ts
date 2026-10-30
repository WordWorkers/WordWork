/**
 * Footnotes – Pandoc's Markdown syntax, which become real footnotes on export.
 *
 *     Romanen kom ut 1879.[^1]
 *
 *     [^1]: Albert Bonniers förlag, Stockholm.
 *
 * In the Write view a footnote is a small superscript number (an atom with the
 * footnote text as an attribute). The numbers are set with a CSS counter, so they
 * renumber themselves when footnotes are added, moved or removed.
 *
 * When the file is read, the definitions are removed from the text and put in a
 * table the tokenizer looks up in. When the file is written, the footnotes are
 * numbered 1, 2, 3 … in the order they appear, and the definitions go at the end
 * of the text. Named footnotes ([^kalla]) keep their names. Pandoc's inline
 * footnotes (^[text]) are also read and saved as regular footnotes.
 */
import { Node } from "@tiptap/core";

export interface FootnoteDefs {
  /** id → footnote text (Markdown, paragraphs separated by a blank line). */
  defs: Map<string, string>;
}

/** Footnote definitions the tokenizer looks up while a text is being loaded. */
let parsing: Map<string, string> = new Map();
/** Footnotes collected while the text is being written out (getMarkdown). */
let rendering: { ids: Map<string, string>; defs: { id: string; text: string }[]; next: number } | null = null;

const DEF_START = /^\[\^([^\]\s]+)\]:[ \t]?(.*)$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Extracts the footnote definitions from the Markdown text. Continuation lines are
 * indented (4 spaces or a tab); a blank line followed by an indented line also
 * belongs to the footnote. Code blocks are left untouched.
 */
export function extractFootnotes(md: string): { body: string; defs: Map<string, string> } {
  const lines = md.split("\n");
  const out: string[] = [];
  const defs = new Map<string, string>();
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) fence = !fence;
    const m = fence ? null : DEF_START.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const parts = [m[2]];
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (/^(?: {2,}|\t)\S/.test(next)) {
        parts.push(next.replace(/^(?: {1,4}|\t)/, ""));
        i++;
      } else if (next.trim() === "" && /^(?: {2,}|\t)\S/.test(lines[i + 2] ?? "")) {
        parts.push("");
        i++;
      } else break;
    }
    if (!defs.has(m[1])) defs.set(m[1], parts.join("\n").trim());
    // The blank line after a removed definition is not needed.
    if (out.length && out[out.length - 1].trim() === "" && (lines[i + 1] ?? "").trim() === "") i++;
  }
  return { body: out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, md.endsWith("\n") ? "\n" : ""), defs };
}

/** The footnote text on one line: line breaks within a paragraph become spaces. */
export function cleanFootnote(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Text for a definition: continuation paragraphs are indented four spaces. */
function definition(id: string, text: string): string {
  const [first, ...rest] = cleanFootnote(text).split("\n\n");
  return [`[^${id}]: ${first ?? ""}`, ...rest.map((p) => `\n    ${p}`)].join("\n");
}

/** Index of the "]" closing the "[" at the start of src (balanced brackets), otherwise -1. */
function inlineEnd(src: string): number {
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i;
  }
  return -1;
}

export const Footnote = Node.create({
  name: "footnote",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      id: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-id") ?? "",
        renderHTML: (attrs) => ({ "data-id": attrs.id }),
      },
      text: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-footnote") ?? "",
        renderHTML: (attrs) => ({ "data-footnote": attrs.text, title: attrs.text }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "sup[data-footnote]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["sup", { ...HTMLAttributes, class: "ww-footnote", "aria-label": "Fotnot" }];
  },

  renderText() {
    return ""; // not counted as body text
  },

  markdownTokenName: "footnote",

  markdownTokenizer: {
    name: "footnote",
    level: "inline",
    start: (src: string) => {
      const a = src.indexOf("[^");
      const b = src.indexOf("^[");
      return a < 0 ? b : b < 0 ? a : Math.min(a, b);
    },
    tokenize(src: string) {
      const ref = /^\[\^([^\]\s]+)\]/.exec(src);
      if (ref) {
        if (!parsing.has(ref[1])) return undefined; // no definition: plain text
        return { type: "footnote", raw: ref[0], id: ref[1], text: parsing.get(ref[1]) ?? "" };
      }
      if (src.startsWith("^[")) {
        const end = inlineEnd(src.slice(1));
        if (end < 0) return undefined;
        return { type: "footnote", raw: src.slice(0, end + 2), id: "", text: src.slice(2, end + 1).trim() };
      }
      return undefined;
    },
  },

  parseMarkdown(token) {
    const t = token as { id?: string; text?: string };
    return { type: "footnote", attrs: { id: t.id ?? "", text: t.text ?? "" } };
  },

  renderMarkdown(node) {
    const attrs = (node as { attrs?: { id?: string; text?: string } }).attrs ?? {};
    const text = String(attrs.text ?? "");
    const old = String(attrs.id ?? "");
    if (!rendering) return `^[${cleanFootnote(text).replace(/\n\n/g, " ")}]`; // outside getMarkdown (e.g. copying)
    let id = old && rendering.ids.get(old);
    if (!id) {
      // Numbers are renumbered in order; named footnotes keep their name.
      id = !old || /^\d+$/.test(old) ? String(rendering.next++) : old;
      if (old) rendering.ids.set(old, id);
      rendering.defs.push({ id, text });
    }
    return `[^${id}]`;
  },
});

/**
 * Prepares a text for loading into the Write view: the definitions are removed and
 * put in the table the tokenizer uses. Returns the text without definitions and
 * the definitions no reference points to (they are saved untouched at the end
 * of the text).
 */
export function prepareFootnotes(md: string): { body: string; orphans: { id: string; text: string }[] } {
  const { body, defs } = extractFootnotes(md);
  parsing = defs;
  const used = new Set<string>();
  for (const m of body.matchAll(/\[\^([^\]\s]+)\]/g)) used.add(m[1]);
  const orphans = [...defs].filter(([id]) => !used.has(id)).map(([id, text]) => ({ id, text }));
  return { body, orphans };
}

/** Runs `serialize` and appends the footnote definitions at the end of the text. */
export function withFootnotes(serialize: () => string, orphans: { id: string; text: string }[] = []): string {
  rendering = { ids: new Map(), defs: [], next: 1 };
  let md: string;
  let defs: { id: string; text: string }[];
  try {
    md = serialize();
    defs = rendering.defs;
  } finally {
    rendering = null;
  }
  const taken = new Set(defs.map((d) => d.id));
  const all = [...defs, ...orphans.filter((o) => !taken.has(o.id))];
  if (!all.length) return md;
  return `${md.replace(/\s+$/, "")}\n\n${all.map((d) => definition(d.id, d.text)).join("\n\n")}\n`;
}

/** The footnotes in the Markdown text in the order of their references (for overviews). */
export function listFootnotes(md: string): { id: string; text: string }[] {
  const { body, defs } = extractFootnotes(md);
  const seen = new Set<string>();
  const out: { id: string; text: string }[] = [];
  for (const m of body.matchAll(/\[\^([^\]\s]+)\]|\^\[/g)) {
    if (m[0] === "^[") {
      const end = inlineEnd(body.slice(m.index! + 1));
      if (end >= 0) out.push({ id: "", text: body.slice(m.index! + 2, m.index! + end + 1).trim() });
    } else if (defs.has(m[1]) && !seen.has(m[1])) {
      seen.add(m[1]);
      out.push({ id: m[1], text: defs.get(m[1])! });
    }
  }
  return out;
}

/** Removes footnotes entirely (for counting words and characters in the body text). */
export function stripFootnotes(md: string): string {
  const { body, defs } = extractFootnotes(md);
  let out = body.replace(/\[\^([^\]\s]+)\]/g, (all, id: string) => (defs.has(id) ? "" : all));
  // Inline ^[…]
  let i = out.indexOf("^[");
  while (i >= 0) {
    const end = inlineEnd(out.slice(i + 1));
    if (end < 0) break;
    out = out.slice(0, i) + out.slice(i + end + 2);
    i = out.indexOf("^[", i);
  }
  return out;
}

const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
export const superscript = (n: number): string => String(n).replace(/\d/g, (d) => SUP[Number(d)]);

/**
 * For publishing: references become superscript numbers (<sup>) and the footnotes
 * a numbered list at the end of the text.
 */
export function footnotesForPublishing(md: string): string {
  const { body, defs } = extractFootnotes(md);
  const numbers = new Map<string, number>();
  const notes: string[] = [];
  let out = body.replace(/\[\^([^\]\s]+)\]/g, (all, id: string) => {
    if (!defs.has(id)) return all;
    if (!numbers.has(id)) {
      notes.push(defs.get(id)!);
      numbers.set(id, notes.length);
    }
    return `<sup>${numbers.get(id)}</sup>`;
  });
  let i = out.indexOf("^[");
  while (i >= 0) {
    const end = inlineEnd(out.slice(i + 1));
    if (end < 0) break;
    notes.push(out.slice(i + 2, i + end + 1).trim());
    const sup = `<sup>${notes.length}</sup>`;
    out = out.slice(0, i) + sup + out.slice(i + end + 2);
    i = out.indexOf("^[", i + sup.length);
  }
  if (!notes.length) return out;
  const list = notes.map((n, k) => `${k + 1}. ${cleanFootnote(n).replace(/\n\n/g, " ")}`).join("\n");
  return `${out.replace(/\s+$/, "")}\n\n---\n\n${list}\n`;
}
