/**
 * The editor: two views of the same Markdown text.
 *
 *  - "write":    WYSIWYG-like view (TipTap/ProseMirror). Only formatting that
 *                Markdown can express exists in the schema – no fonts, colours,
 *                underline etc. Pasted formatting that is not Markdown is
 *                stripped automatically by the schema.
 *  - "markdown": the source text in a text field.
 *
 * The Markdown string is always the source of truth. It is only rewritten from
 * the WYSIWYG view when the user actually edits there.
 */
import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { TextSelection } from "@tiptap/pm/state";
import { setHighlight, spellExtension, WordHighlight, type SpellService } from "./spell";
import { Note, stripNotes } from "./notes";
import { cleanComment, Comment, commentAt, stripComments, type CommentRange } from "./comments";
import { cleanFootnote, Footnote, prepareFootnotes, stripFootnotes, withFootnotes } from "./footnotes";
import { LongSentences, setLongSentences } from "./longsentences";
import { typographyExtension, type TypographyOptions } from "./typography";
import {
  buildRegExp,
  findInText,
  pmReplace,
  pmReplaceAll,
  pmSearch,
  pmStatus,
  pmStep,
  SearchHighlight,
  type Range,
  type SearchQuery,
  type SearchStatus,
} from "./search";

export type ViewMode = "write" | "markdown";

/** Marks the paragraph containing the cursor (for focus mode with dimming). */
const CurrentBlock = Extension.create({
  name: "currentBlock",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("currentBlock"),
        props: {
          decorations(state) {
            const { $from } = state.selection;
            if ($from.depth < 1) return DecorationSet.empty;
            const start = $from.before(1);
            const node = state.doc.child($from.index(0));
            return DecorationSet.create(state.doc, [
              Decoration.node(start, start + node.nodeSize, { class: "is-current" }),
            ]);
          },
        },
      }),
    ];
  },
});

/**
 * Placeholder text when the document is empty. (TipTap's Placeholder walks the whole
 * document on every keystroke – noticeable in long manuscripts.)
 */
const EmptyPlaceholder = Extension.create({
  name: "emptyPlaceholder",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("emptyPlaceholder"),
        props: {
          decorations(state) {
            const { doc } = state;
            const first = doc.firstChild;
            if (doc.childCount !== 1 || !first || !first.isTextblock || first.content.size > 0) return null;
            return DecorationSet.create(doc, [
              Decoration.node(0, first.nodeSize, {
                class: "is-editor-empty",
                "data-placeholder": "Skriv här …",
              }),
            ]);
          },
        },
      }),
    ];
  },
});

export interface EditorOptions {
  host: HTMLElement;
  spell: SpellService;
  typography: () => TypographyOptions;
  /** The text has changed. Markdown is only serialized when needed (getMarkdown). */
  onChange: () => void;
  onActivity: () => void;
  onSelection?: () => void;
  onContextMenu?: (event: MouseEvent, view: EditorView) => boolean;
  /** Right-click in the Markdown view; `offset` is the character under the pointer. */
  onSourceContextMenu?: (event: MouseEvent, offset: number) => boolean;
  /** Click on commented text (to show the comment). */
  onCommentClick?: (comment: CommentRange, rect: DOMRect) => void;
  /** Click on a footnote number. */
  onFootnoteClick?: (footnote: FootnoteAt, rect: DOMRect) => void;
}

export interface FootnoteAt {
  pos: number;
  /** The footnote's number in the text (1, 2, 3 …). */
  number: number;
  text: string;
}

export class DocEditor {
  private host: HTMLElement;
  private wysiwygEl: HTMLDivElement;
  private sourceEl: HTMLTextAreaElement;
  private editor: Editor | null = null;
  private markdown = "";
  private wysiwygDirty = false;
  private changeTimer: number | undefined;
  mode: ViewMode = "write";
  typewriter = false;
  /** Active search (applies to both views). */
  private searchRe: RegExp | null = null;
  private longSentenceLimit = 0;
  private srcMatches: Range[] = [];
  private srcCurrent = -1;
  /** Footnote definitions without a reference – saved untouched at the end of the text. */
  private orphanFootnotes: { id: string; text: string }[] = [];

  constructor(private opts: EditorOptions) {
    this.host = opts.host;
    this.wysiwygEl = document.createElement("div");
    this.wysiwygEl.className = "wysiwyg";
    this.sourceEl = document.createElement("textarea");
    this.sourceEl.className = "source";
    this.sourceEl.spellcheck = true;
    this.sourceEl.lang = "sv";
    this.sourceEl.placeholder = "Skriv här …";
    this.sourceEl.setAttribute("aria-label", "Markdown-källtext");
    this.host.append(this.wysiwygEl, this.sourceEl);

    this.sourceEl.addEventListener("contextmenu", (event) => {
      // Shift+right-click: the system menu, as in the Write view.
      if (event.shiftKey || !this.opts.onSourceContextMenu) return;
      const offset = sourceOffsetAt(this.sourceEl, event.clientX, event.clientY);
      if (offset !== null && this.opts.onSourceContextMenu(event, offset)) event.preventDefault();
    });
    this.sourceEl.addEventListener("input", () => {
      this.markdown = this.sourceEl.value;
      this.autoGrow();
      this.opts.onActivity();
      this.emitChange();
    });
    window.addEventListener("resize", () => this.autoGrow());
  }

  /** Loads a new document (resets the undo history). */
  load(markdown: string): void {
    this.markdown = markdown;
    this.wysiwygDirty = false;
    this.render();
  }

  getMarkdown(): string {
    if (this.wysiwygDirty && this.editor) {
      // Frontmatter is not shown in the Write view and is put back untouched.
      const editor = this.editor;
      this.markdown =
        splitFrontmatter(this.markdown).frontmatter +
        normalize(withFootnotes(() => editor.getMarkdown(), this.orphanFootnotes));
      this.wysiwygDirty = false;
    }
    return this.markdown;
  }

  setMode(mode: ViewMode): void {
    if (mode === this.mode) return;
    this.getMarkdown(); // include any changes from WYSIWYG
    this.mode = mode;
    this.render();
    this.focus();
  }

  focus(): void {
    if (this.mode === "write") this.editor?.commands.focus();
    else this.sourceEl.focus();
  }

  /** Body text without Markdown syntax (paragraphs separated by a blank line). Private notes are not counted. */
  getPlainText(): string {
    if (this.editor) {
      const blocks: string[] = [];
      this.editor.state.doc.descendants((node) => {
        if (node.type.name === "note") return false;
        if (!node.isTextblock) return true;
        blocks.push(node.textBetween(0, node.content.size, "\n", (leaf) => (leaf.type.name === "hardBreak" ? "\n" : "")));
        return false;
      });
      return blocks.join("\n\n");
    }
    return stripMarkdown(stripComments(stripNotes(stripFootnotes(splitFrontmatter(this.markdown).body))));
  }

  /** Frontmatter (empty string if missing). */
  getFrontmatter(): string {
    return splitFrontmatter(this.getMarkdown()).frontmatter;
  }

  /** Replaces the frontmatter without touching the text (metadata panel). */
  setFrontmatter(frontmatter: string): void {
    const md = this.getMarkdown();
    const { frontmatter: old, body } = splitFrontmatter(md);
    if (old === frontmatter) return;
    this.markdown = frontmatter + body;
    if (this.mode === "markdown") {
      const ta = this.sourceEl;
      const delta = frontmatter.length - old.length;
      const [start, end] = [ta.selectionStart ?? 0, ta.selectionEnd ?? 0];
      ta.value = this.markdown;
      ta.setSelectionRange(Math.max(0, start + delta), Math.max(0, end + delta));
      this.autoGrow();
    }
    this.emitChange();
  }

  // ---------------- comments ----------------
  /**
   * What to comment on: the comment at the cursor, otherwise the selection (within
   * one paragraph). In the Markdown view: the selection in the source text.
   */
  commentTarget(): { from: number; to: number; text: string; quote: string } | null {
    if (this.mode === "write" && this.editor) {
      const { state } = this.editor;
      const { from, to, empty, $from, $to } = state.selection;
      const existing = commentAt(state, from);
      if (existing && (empty || (from >= existing.from && to <= existing.to))) return existing;
      if (empty || !$from.sameParent($to)) return null;
      return { from, to, text: "", quote: state.doc.textBetween(from, to, " ") };
    }
    const ta = this.sourceEl;
    const from = ta.selectionStart ?? 0;
    const to = ta.selectionEnd ?? 0;
    const quote = ta.value.slice(from, to);
    if (from === to || quote.includes("\n\n")) return null;
    return { from, to, text: "", quote };
  }

  /** Adds or changes a comment on the range (from commentTarget). */
  setComment(from: number, to: number, text: string): void {
    const clean = cleanComment(text);
    if (!clean) return;
    if (this.mode === "write" && this.editor) {
      const { state, view } = this.editor;
      const type = state.schema.marks.comment;
      view.dispatch(state.tr.removeMark(from, to, type).addMark(from, to, type.create({ text: clean })));
      view.focus();
      return;
    }
    const ta = this.sourceEl;
    const quote = ta.value.slice(from, to);
    this.replaceSource(from, to, `{==${quote}==}{>>${clean}<<}`);
  }

  /** Existing comment at a position in the Write view. */
  commentAtPos(pos: number): CommentRange | null {
    return this.editor ? commentAt(this.editor.state, pos) : null;
  }

  removeComment(from: number, to: number): void {
    if (!this.editor) return;
    const { state, view } = this.editor;
    view.dispatch(state.tr.removeMark(from, to, state.schema.marks.comment));
    view.focus();
  }

  // ---------------- footnotes ----------------
  /** The footnotes in the Write view, in order. */
  footnotes(): FootnoteAt[] {
    const out: FootnoteAt[] = [];
    this.editor?.state.doc.descendants((node, pos) => {
      if (node.type.name === "footnote") out.push({ pos, number: out.length + 1, text: node.attrs.text as string });
      return node.isBlock; // don't descend into text nodes
    });
    return out;
  }

  footnoteAtPos(pos: number): FootnoteAt | null {
    return this.footnotes().find((f) => f.pos === pos) ?? null;
  }

  /** Can a footnote be inserted at the cursor? */
  canInsertFootnote(): boolean {
    if (this.mode !== "write") return true;
    if (!this.editor) return false;
    const { $from } = this.editor.state.selection;
    return $from.parent.type.name !== "note" && $from.parent.type.name !== "codeBlock" && $from.parent.isTextblock;
  }

  /** Where a new footnote goes (read before the dialog opens, which may move focus). */
  footnoteInsertPoint(): number {
    if (this.mode === "write" && this.editor) return this.editor.state.selection.to;
    return this.sourceEl.selectionEnd ?? this.sourceEl.value.length;
  }

  /** Inserts a footnote at `at` (from footnoteInsertPoint), otherwise after the selection. */
  insertFootnote(text: string, at?: number): void {
    const clean = cleanFootnote(text);
    if (!clean) return;
    if (this.mode === "write" && this.editor) {
      const { state, view } = this.editor;
      const pos = Math.min(at ?? state.selection.to, state.doc.content.size);
      const node = state.schema.nodes.footnote.create({ id: "", text: clean });
      const tr = state.tr.insert(pos, node);
      tr.setSelection(TextSelection.create(tr.doc, pos + node.nodeSize)).scrollIntoView();
      view.dispatch(tr);
      view.focus();
      return;
    }
    // Markdown view: reference at the cursor, definition at the end.
    const ta = this.sourceEl;
    const used = new Set([...ta.value.matchAll(/\[\^(\d+)\]/g)].map((m) => Number(m[1])));
    let n = 1;
    while (used.has(n)) n++;
    at = Math.min(at ?? ta.selectionEnd ?? ta.value.length, ta.value.length);
    const ref = `[^${n}]`;
    const before = ta.value.slice(0, at) + ref + ta.value.slice(at);
    const def = `[^${n}]: ${clean.replace(/\n\n/g, "\n\n    ")}`;
    ta.value = `${before.replace(/\s+$/, "")}\n\n${def}\n`;
    ta.focus();
    ta.setSelectionRange(at + ref.length, at + ref.length);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }

  setFootnoteText(pos: number, text: string): void {
    if (!this.editor) return;
    const clean = cleanFootnote(text);
    const { state, view } = this.editor;
    const node = state.doc.nodeAt(pos);
    if (node?.type.name !== "footnote" || !clean) return;
    view.dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, text: clean }));
    view.focus();
  }

  removeFootnote(pos: number): void {
    if (!this.editor) return;
    const { state, view } = this.editor;
    const node = state.doc.nodeAt(pos);
    if (node?.type.name !== "footnote") return;
    view.dispatch(state.tr.delete(pos, pos + node.nodeSize));
    view.focus();
  }

  /** Turns the current paragraph into a private note (or back). */
  toggleNote(): boolean {
    if (!this.editor) return false;
    const { $from } = this.editor.state.selection;
    const inNote = $from.parent.type.name === "note";
    return inNote
      ? this.editor.chain().focus().setParagraph().run()
      : this.editor.chain().focus().setNode("note").run();
  }

  /** Highlight sentences longer than the limit (0 = off). */
  markLongSentences(limit: number): void {
    this.longSentenceLimit = limit;
    if (this.editor) setLongSentences(this.editor.view, limit);
  }

  /** Selected text in the current view (to fill in the search field). */
  getSelectedForSearch(): string {
    if (this.mode === "write") return this.getSelectionText();
    const ta = this.sourceEl;
    return ta.value.slice(ta.selectionStart ?? 0, ta.selectionEnd ?? 0);
  }

  /** Selected text in the Write view (empty string if nothing is selected). */
  getSelectionText(): string {
    if (!this.editor) return "";
    const { from, to, empty } = this.editor.state.selection;
    return empty ? "" : this.editor.state.doc.textBetween(from, to, "\n\n", " ");
  }

  /** Highlights all occurrences of a word and scrolls to the first. */
  highlight(word: string | null): void {
    if (!this.editor) return;
    const first = setHighlight(this.editor.view, word);
    if (first !== null) this.scrollToPos(first);
  }

  /** Finds a piece of text (e.g. a sentence) and selects it. */
  selectText(text: string): boolean {
    if (!this.editor) return false;
    const needle = text.slice(0, 80);
    const { doc } = this.editor.state;
    let found: { from: number; to: number } | null = null;
    doc.descendants((node, pos) => {
      if (found || !node.isTextblock) return !found;
      const blockText = node.textBetween(0, node.content.size, " ", " ");
      const idx = blockText.indexOf(needle);
      if (idx >= 0) {
        const from = pos + 1 + idx;
        found = { from, to: Math.min(from + text.length, pos + 1 + node.content.size) };
      }
      return false;
    });
    if (!found) return false;
    const { from, to } = found;
    const view = this.editor.view;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
    view.focus();
    this.scrollToPos(from);
    return true;
  }

  /**
   * Scrolls to a position. Off-screen paragraphs only have an estimated height
   * (content-visibility), so we first scroll the element into view and then
   * adjust once it has rendered.
   */
  private scrollToPos(pos: number): void {
    if (!this.editor) return;
    const view = this.editor.view;
    try {
      const { node } = view.domAtPos(pos);
      const el = (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)) ?? null;
      el?.scrollIntoView({ block: "center" });
      let tries = 0;
      const adjust = () => {
        const coords = view.coordsAtPos(pos);
        const delta = coords.top - window.innerHeight * 0.4;
        if (Math.abs(delta) > 4) window.scrollBy({ top: delta });
        if (++tries < 3 && Math.abs(delta) > 4) requestAnimationFrame(adjust);
      };
      requestAnimationFrame(adjust);
    } catch {
      /* the position may be missing just as the editor is rebuilt */
    }
  }

  /** Inserts text at the cursor (in both views). */
  insertText(text: string): void {
    if (this.mode === "write" && this.editor) {
      const view = this.editor.view;
      view.dispatch(view.state.tr.insertText(text).scrollIntoView());
      view.focus();
      return;
    }
    const ta = this.sourceEl;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    ta.focus();
    ta.setRangeText(text, start, end, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** The Markdown view's text field (for its right-click menu). */
  get source(): HTMLTextAreaElement {
    return this.sourceEl;
  }

  /**
   * Replaces text in a range (used by corrections and synonyms). Positions are
   * ProseMirror positions in the Write view and character offsets in the
   * Markdown view.
   */
  replaceRange(from: number, to: number, text: string): void {
    if (this.mode === "markdown") {
      this.replaceSource(from, to, text);
      return;
    }
    if (!this.editor) return;
    const view = this.editor.view;
    view.dispatch(view.state.tr.insertText(text, from, to));
    view.focus();
  }

  private render(): void {
    this.host.dataset.mode = this.mode;
    if (this.mode === "write") {
      this.sourceEl.hidden = true;
      this.wysiwygEl.hidden = false;
      this.mountWysiwyg();
    } else {
      this.editor?.destroy();
      this.editor = null;
      this.wysiwygEl.hidden = true;
      this.sourceEl.hidden = false;
      this.sourceEl.value = this.markdown;
      this.autoGrow();
    }
    if (this.searchRe) this.applySearch();
    if (this.mode === "write" && this.editor && this.longSentenceLimit) setLongSentences(this.editor.view, this.longSentenceLimit);
  }

  // ---------------- search and replace ----------------
  setSearch(q: SearchQuery | null): SearchStatus {
    this.searchRe = buildRegExp(q);
    return this.applySearch();
  }

  private applySearch(): SearchStatus {
    if (this.mode === "write" && this.editor) return pmSearch(this.editor.view, this.searchRe);
    this.srcMatches = findInText(this.sourceEl.value, this.searchRe);
    const pos = this.sourceEl.selectionStart ?? 0;
    const i = this.srcMatches.findIndex((m) => m.to > pos);
    this.srcCurrent = this.srcMatches.length ? (i === -1 ? 0 : i) : -1;
    return this.srcStatus();
  }

  private srcStatus(): SearchStatus {
    return { count: this.srcMatches.length, current: this.srcMatches.length ? this.srcCurrent : -1 };
  }

  /** Number of matches after the text changed. */
  searchStatus(): SearchStatus {
    if (this.mode === "write" && this.editor) return pmStatus(this.editor.view);
    if (!this.searchRe) return { count: 0, current: -1 };
    const before = this.srcMatches[this.srcCurrent]?.from ?? 0;
    this.srcMatches = findInText(this.sourceEl.value, this.searchRe);
    const i = this.srcMatches.findIndex((m) => m.to > before);
    this.srcCurrent = this.srcMatches.length ? (i === -1 ? 0 : i) : -1;
    return this.srcStatus();
  }

  /**
   * Next (+1) or previous (-1) match, or show the current one (0). In the Markdown
   * view the match is selected in the source text (which then gets focus); 0 does nothing there.
   */
  searchStep(dir: 1 | 0 | -1): SearchStatus {
    if (this.mode === "write" && this.editor) {
      const m = pmStep(this.editor.view, dir);
      if (m) this.scrollToPos(m.from);
      return pmStatus(this.editor.view);
    }
    const n = this.srcMatches.length;
    if (!n || dir === 0) return this.srcStatus();
    this.srcCurrent = (this.srcCurrent + dir + n) % n;
    this.selectSource(this.srcMatches[this.srcCurrent]);
    return this.srcStatus();
  }

  replaceCurrent(text: string): SearchStatus {
    if (this.mode === "write" && this.editor) {
      const next = pmReplace(this.editor.view, text);
      if (next) this.scrollToPos(next.from);
      return pmStatus(this.editor.view);
    }
    const m = this.srcMatches[this.srcCurrent];
    if (!m) return this.srcStatus();
    this.replaceSource(m.from, m.to, text);
    this.srcMatches = findInText(this.sourceEl.value, this.searchRe);
    const i = this.srcMatches.findIndex((r) => r.from >= m.from + text.length);
    this.srcCurrent = this.srcMatches.length ? (i === -1 ? 0 : i) : -1;
    if (this.srcCurrent >= 0) this.selectSource(this.srcMatches[this.srcCurrent]);
    return this.srcStatus();
  }

  replaceAll(text: string): number {
    if (this.mode === "write" && this.editor) return pmReplaceAll(this.editor.view, text);
    const n = this.srcMatches.length;
    if (!n || !this.searchRe) return 0;
    this.searchRe.lastIndex = 0;
    const value = this.sourceEl.value.replace(this.searchRe, () => text);
    this.replaceSource(0, this.sourceEl.value.length, value);
    this.applySearch();
    return n;
  }

  /** Replaces in the source text so that the WebView's Undo works. */
  private replaceSource(from: number, to: number, text: string): void {
    const ta = this.sourceEl;
    ta.focus();
    ta.setSelectionRange(from, to);
    if (!document.execCommand("insertText", false, text)) {
      ta.setRangeText(text, from, to, "end");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  private selectSource(m: Range): void {
    const ta = this.sourceEl;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(m.from, m.to);
    // The text field is as tall as the text, so the page must scroll to the match.
    const top = ta.getBoundingClientRect().top + window.scrollY + caretOffset(ta, m.from);
    window.scrollTo({ top: Math.max(0, top - window.innerHeight * 0.4) });
  }

  private mountWysiwyg(): void {
    this.editor?.destroy();
    const { body, orphans } = prepareFootnotes(splitFrontmatter(this.markdown).body);
    this.orphanFootnotes = orphans;
    this.wysiwygEl.replaceChildren();
    this.editor = new Editor({
      element: this.wysiwygEl,
      extensions: [
        StarterKit.configure({
          underline: false, // not in Markdown
          link: { openOnClick: false, autolink: true },
        }),
        Markdown.configure({ indentation: { style: "space", size: 2 } }),
        EmptyPlaceholder,
        CurrentBlock,
        spellExtension(this.opts.spell),
        typographyExtension(this.opts.typography),
        WordHighlight,
        SearchHighlight,
        Note,
        Comment,
        Footnote,
        LongSentences,
      ],
      content: body,
      contentType: "markdown",
      editorProps: {
        // Own spell checking in the Write view; the WebView's is used in the Markdown view.
        // "long" enables rendering optimization for long manuscripts (see .prose.long in CSS).
        attributes: (state) => ({
          class: state.doc.childCount > 300 ? "prose long" : "prose",
          "aria-label": "Text",
          spellcheck: "false",
          lang: "sv",
        }),
        handleClickOn: (_view, _pos, node, nodePos, event) => {
          if (node.type.name !== "footnote" || event.button !== 0 || !this.opts.onFootnoteClick) return false;
          const f = this.footnoteAtPos(nodePos);
          const el = (event.target as Element).closest?.(".ww-footnote");
          if (f && el) this.opts.onFootnoteClick(f, el.getBoundingClientRect());
          return false;
        },
        handleClick: (view, pos, event) => {
          if (!this.opts.onCommentClick || event.button !== 0) return false;
          const c = commentAt(view.state, pos);
          if (!c) return false;
          const target = (event.target as Element).closest?.(".ww-comment");
          if (target) this.opts.onCommentClick(c, target.getBoundingClientRect());
          return false; // the cursor is placed as usual
        },
        handleDOMEvents: {
          contextmenu: (view, event) => {
            if (event.shiftKey || !this.opts.onContextMenu) return false;
            if (this.opts.onContextMenu(event, view)) {
              event.preventDefault();
              return true;
            }
            return false;
          },
        },
      },
      onUpdate: () => {
        this.wysiwygDirty = true;
        this.opts.onActivity();
        this.emitChange();
      },
      onSelectionUpdate: () => {
        this.typewriterScroll();
        this.opts.onSelection?.();
      },
    });
  }

  private emitChange(): void {
    window.clearTimeout(this.changeTimer);
    this.changeTimer = window.setTimeout(() => {
      this.opts.onChange();
    }, 250);
  }

  private typewriterScroll(): void {
    if (!this.typewriter || !this.editor) return;
    const { view } = this.editor;
    try {
      const coords = view.coordsAtPos(view.state.selection.head);
      const target = window.innerHeight * 0.45;
      const delta = coords.top - target;
      if (Math.abs(delta) > 4) window.scrollBy({ top: delta, behavior: "smooth" });
    } catch {
      /* the position may be missing just as the editor is rebuilt */
    }
  }

  private autoGrow(): void {
    const ta = this.sourceEl;
    if (ta.hidden) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }
}

/** A single trailing newline – stable files and diffs. */
function normalize(md: string): string {
  // Empty lines at the end of a quote ("> " without text) are just junk from Enter.
  // Empty paragraphs are written by the serializer as "&nbsp;" – Markdown has no empty
  // paragraphs, so they are removed instead of ending up as junk in the file.
  const cleaned = md.replace(/^(?:&nbsp;|\u00a0)[ \t]*$/gm, "").replace(/\n{3,}/g, "\n\n");
  const trimmed = cleaned.replace(/\s+$/, "").replace(/(?:\n>[ \t]*)+$/, "").replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n` : "";
}

export function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`]/g, "");
}

/**
 * YAML frontmatter at the start of the file (--- … --- or --- … ...), including
 * the blank lines after it. It is not edited in the Write view but preserved exactly.
 * As in Pandoc, the line after the opening --- must not be empty (then it is a horizontal rule).
 */
const FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n(?![ \t]*\r?\n)(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)(?:[ \t]*\r?\n)*/;

export function splitFrontmatter(md: string): { frontmatter: string; body: string } {
  const m = FRONTMATTER_RE.exec(md);
  if (!m) return { frontmatter: "", body: md };
  return { frontmatter: m[0], body: md.slice(m[0].length) };
}

/**
 * The character offset in a text field under a screen point, or null. A text
 * field has no API for this, so an exact, transparent copy is laid over it
 * for a moment and asked with caretRangeFromPoint / caretPositionFromPoint.
 */
function sourceOffsetAt(ta: HTMLTextAreaElement, x: number, y: number): number | null {
  const cs = getComputedStyle(ta);
  const rect = ta.getBoundingClientRect();
  const mirror = document.createElement("div");
  for (const p of ["font", "letterSpacing", "lineHeight", "padding", "border", "boxSizing", "tabSize", "wordSpacing", "textIndent"] as const) {
    mirror.style[p] = cs[p];
  }
  Object.assign(mirror.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top - ta.scrollTop}px`,
    width: `${rect.width}px`,
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    borderColor: "transparent",
    color: "transparent",
    opacity: "0",
    zIndex: "2147483647",
  });
  const text = document.createTextNode(ta.value + "\u200b");
  mirror.append(text);
  document.body.append(mirror);
  try {
    const doc = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    const pos = doc.caretPositionFromPoint?.(x, y);
    if (pos) return pos.offsetNode === text ? Math.min(pos.offset, ta.value.length) : null;
    const range = document.caretRangeFromPoint?.(x, y);
    return range && range.startContainer === text ? Math.min(range.startOffset, ta.value.length) : null;
  } finally {
    mirror.remove();
  }
}

/** Height (px) from the text field's top edge to a character, measured with an invisible copy. */
function caretOffset(ta: HTMLTextAreaElement, index: number): number {
  const cs = getComputedStyle(ta);
  const mirror = document.createElement("div");
  for (const p of ["font", "letterSpacing", "lineHeight", "padding", "border", "boxSizing", "tabSize", "wordSpacing"] as const) {
    mirror.style[p] = cs[p];
  }
  Object.assign(mirror.style, {
    position: "absolute",
    visibility: "hidden",
    top: "0",
    left: "-9999px",
    width: `${ta.clientWidth}px`,
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
  });
  mirror.textContent = ta.value.slice(0, index);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.append(marker);
  document.body.append(mirror);
  const top = marker.offsetTop;
  mirror.remove();
  return top;
}
