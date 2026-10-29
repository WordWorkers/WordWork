/**
 * Egna anteckningar i texten – för dig själv, aldrig i export.
 *
 * I filen är en anteckning en HTML-kommentar på egen rad:
 *
 *     <!-- Kolla siffran med kommunen -->
 *
 * Kommentarer syns inte när Markdown visas någon annanstans (GitHub, Obsidian
 * m.fl.), och Word Work tar bort dem vid export och kopiering. I Skriv-vyn visas
 * de som gula lappar som går att redigera.
 */
import { Node } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";

/** En kommentar som står ensam på en eller flera rader. */
const NOTE_BLOCK = /^<!--([\s\S]*?)-->[ \t]*(?:\n+|$)/;

export const Note = Node.create({
  name: "note",
  group: "block",
  content: "text*",
  marks: "",
  defining: true,

  parseHTML() {
    return [{ tag: "div[data-note]", preserveWhitespace: "full" }];
  },

  renderHTML() {
    return ["div", { "data-note": "", class: "note", title: "Egen anteckning – följer inte med vid export" }, 0];
  },

  markdownTokenName: "note",

  markdownTokenizer: {
    name: "note",
    level: "block",
    start: (src: string) => src.indexOf("<!--"),
    tokenize(src: string) {
      const m = NOTE_BLOCK.exec(src);
      if (!m) return undefined;
      return { type: "note", raw: m[0], text: m[1].trim() };
    },
  },

  parseMarkdown(token) {
    const text = (token.text as string | undefined) ?? "";
    return { type: "note", content: text ? [{ type: "text", text }] : [] };
  },

  renderMarkdown(node) {
    const text = (node.content ?? [])
      .map((c: { text?: string }) => c.text ?? "")
      .join("")
      .replace(/--+>/g, "– >")
      .trim();
    return `<!-- ${text} -->`;
  },

  addKeyboardShortcuts() {
    return {
      // Enter sist i en anteckning ger ett vanligt stycke efter den.
      Enter: ({ editor }) => {
        const { state } = editor;
        const { $from, empty } = state.selection;
        if ($from.parent.type.name !== "note" || !empty || $from.parentOffset < $from.parent.content.size) return false;
        const pos = $from.after();
        const tr = state.tr.insert(pos, state.schema.nodes.paragraph.create());
        tr.setSelection(TextSelection.create(tr.doc, pos + 1)).scrollIntoView();
        editor.view.dispatch(tr);
        return true;
      },
      // Backsteg i en tom anteckning gör den till ett vanligt stycke.
      Backspace: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if ($from.parent.type.name !== "note" || !empty || $from.parent.content.size > 0) return false;
        return editor.commands.setParagraph();
      },
    };
  },
});

/** Tar bort anteckningar (HTML-kommentarer) ur Markdown, utom i kod. */
export function stripNotes(md: string): string {
  const out: string[] = [];
  let fence = false;
  let inNote = false;
  for (const line of md.split("\n")) {
    if (!inNote && /^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) {
      out.push(line);
      continue;
    }
    const wasInNote = inNote;
    let rest = line;
    let kept = "";
    while (rest) {
      if (inNote) {
        const end = rest.indexOf("-->");
        if (end < 0) {
          rest = "";
          break;
        }
        rest = rest.slice(end + 3);
        inNote = false;
        if (/\s$/.test(kept) && /^\s/.test(rest)) rest = rest.replace(/^[ \t]+/, "");
      } else {
        const start = rest.indexOf("<!--");
        if (start < 0) {
          kept += rest;
          break;
        }
        kept += rest.slice(0, start);
        rest = rest.slice(start + 4);
        inNote = true;
      }
    }
    // En rad som bara bestod av en anteckning försvinner helt.
    if (kept.trim()) out.push(kept.replace(/[ \t]+$/, ""));
    else if (!wasInNote && !line.includes("<!--")) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
