/**
 * Kommentarer på markerad text – för dig själv, aldrig i export.
 *
 * Sparas i Markdown-texten med CriticMarkup:
 *
 *     Hon sa att {==hon aldrig varit där==}{>>Sa hon verkligen så?<<} och gick.
 *
 * I Skriv-vyn är det ett märke (mark) på den markerade texten, med kommentaren
 * som attribut. Kommentarer tas bort vid export och kopiering (stripComments),
 * och kommentarstexten räknas inte i ord eller tecken.
 */
import { Mark, mergeAttributes } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";

const COMMENT_INLINE = /^\{==([\s\S]+?)==\}\{>>([\s\S]*?)<<\}/;

/** Kommentarstexten får inte innehålla CriticMarkups slutmarkering eller radbrytningar. */
export function cleanComment(text: string): string {
  return text.replace(/\s+/g, " ").replace(/<<\}/g, "<< }").replace(/==\}/g, "== }").trim();
}

export const Comment = Mark.create({
  name: "comment",
  inclusive: false, // text som skrivs direkt efter hör inte till kommentaren
  excludes: "comment", // kommentarer överlappar inte

  addAttributes() {
    return {
      text: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-comment") ?? "",
        renderHTML: (attrs) => ({ "data-comment": attrs.text, title: attrs.text }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-comment]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "ww-comment" }), 0];
  },

  markdownTokenName: "comment",

  markdownTokenizer: {
    name: "comment",
    level: "inline",
    start: (src: string) => src.indexOf("{=="),
    tokenize(src, _tokens, lexer) {
      const m = COMMENT_INLINE.exec(src);
      if (!m) return undefined;
      return { type: "comment", raw: m[0], text: m[1], comment: m[2].trim(), tokens: lexer.inlineTokens(m[1]) };
    },
  },

  parseMarkdown(token, helpers) {
    return helpers.applyMark("comment", helpers.parseInline(token.tokens || []), {
      text: (token as { comment?: string }).comment ?? "",
    });
  },

  renderMarkdown(node, helpers) {
    const text = cleanComment(String((node as { attrs?: { text?: string } }).attrs?.text ?? ""));
    return `{==${helpers.renderChildren(node)}==}{>>${text}<<}`;
  },
});

export interface CommentRange {
  from: number;
  to: number;
  text: string;
  /** Den kommenterade texten. */
  quote: string;
}

/** Kommentaren vid en position (hela det sammanhängande märket), om någon. */
export function commentAt(state: EditorState, pos: number): CommentRange | null {
  const $pos = state.doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;
  const type = state.schema.marks.comment;
  const start = $pos.start();
  // Sammanhängande bitar med samma kommentar i stycket.
  const runs: { from: number; to: number; text: string }[] = [];
  let offset = 0;
  parent.forEach((child) => {
    const mark = type.isInSet(child.marks);
    const from = start + offset;
    const to = from + child.nodeSize;
    const last = runs[runs.length - 1];
    if (mark && last && last.text === mark.attrs.text && last.to === from) last.to = to;
    else if (mark) runs.push({ from, to, text: mark.attrs.text as string });
    offset += child.nodeSize;
  });
  const run = runs.find((r) => pos >= r.from && pos < r.to) ?? runs.find((r) => pos === r.to);
  if (!run) return null;
  return { ...run, quote: state.doc.textBetween(run.from, run.to, " ") };
}

/** Alla kommentarer i Markdown-texten (för översikten). */
export function listComments(markdown: string): { quote: string; text: string }[] {
  const out: { quote: string; text: string }[] = [];
  for (const m of markdown.matchAll(/\{==([\s\S]+?)==\}\{>>([\s\S]*?)<<\}/g)) {
    out.push({ quote: m[1].replace(/[*_`]/g, "").replace(/\s+/g, " ").trim(), text: m[2].trim() });
  }
  return out;
}

/**
 * Tar bort kommentarer ur Markdown: {==text==}{>>kommentar<<} blir text, och
 * fristående {>>kommentar<<} försvinner. Kodblock lämnas orörda.
 */
export function stripComments(md: string): string {
  return md
    .split(/(^(?:```|~~~)[\s\S]*?^(?:```|~~~)[ \t]*$)/m)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/\{==([\s\S]+?)==\}\{>>[\s\S]*?<<\}/g, "$1")
            .replace(/[ \t]?\{>>[\s\S]*?<<\}/g, "")
            .replace(/\{==([\s\S]+?)==\}/g, "$1"),
    )
    .join("");
}
