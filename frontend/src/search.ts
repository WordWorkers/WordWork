/**
 * Sök och ersätt.
 *
 * Skriv-vyn: ett ProseMirror-tillägg markerar alla träffar och den aktuella.
 * Träffar söks inom varje stycke (inte över styckegränser), i den synliga texten
 * – Markdown-tecken som ** eller # påverkar alltså inte sökningen.
 *
 * Markdown-vyn: samma sökning i källtexten.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

export interface SearchQuery {
  text: string;
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface SearchStatus {
  count: number;
  /** Index för aktuell träff (0-baserat), -1 om ingen. */
  current: number;
}

export interface Range {
  from: number;
  to: number;
}

const MAX_MATCHES = 5000;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildRegExp(q: SearchQuery | null): RegExp | null {
  if (!q || !q.text) return null;
  let src = escapeRegExp(q.text);
  if (q.wholeWord) src = `(?<![\\p{L}\\p{N}_])${src}(?![\\p{L}\\p{N}_])`;
  return new RegExp(src, q.caseSensitive ? "gu" : "giu");
}

/** Träffar i en vanlig sträng (Markdown-vyn). */
export function findInText(text: string, re: RegExp | null): Range[] {
  if (!re) return [];
  const out: Range[] = [];
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    if (!m[0]) continue;
    out.push({ from: m.index!, to: m.index! + m[0].length });
    if (out.length >= MAX_MATCHES) break;
  }
  return out;
}

function findInBlock(node: PMNode, pos: number, re: RegExp, out: Range[]): void {
  // Varje tecken i texten motsvarar en position; övriga inline-noder (t.ex.
  // radbrytningar) tar en position och ersätts med ett tecken som aldrig matchar.
  let text = "";
  node.forEach((child) => {
    text += child.isText ? child.text! : "\ufffc";
  });
  for (const r of findInText(text, re)) out.push({ from: pos + 1 + r.from, to: pos + 1 + r.to });
}

/** Träffar i dokumentet, som ProseMirror-positioner. */
function findInDoc(state: EditorState, re: RegExp | null): Range[] {
  if (!re) return [];
  const out: Range[] = [];
  state.doc.descendants((node, pos) => {
    if (out.length >= MAX_MATCHES) return false;
    if (!node.isTextblock) return true;
    findInBlock(node, pos, re, out);
    return false;
  });
  return out.slice(0, MAX_MATCHES);
}

interface Update {
  matches: Range[];
  /** Stycken som sökts om (positioner i det nya dokumentet). */
  blocks: Range[];
  fresh: Range[];
}

/**
 * Efter en ändring: flytta gamla träffar och sök bara om i de stycken som
 * ändrats – annars blir varje tangenttryck långsamt i långa manus.
 */
function updateMatches(tr: Transaction, state: EditorState, re: RegExp, old: Range[]): Update | null {
  if (old.length >= MAX_MATCHES) return null; // gör om allt
  const size = state.doc.content.size;
  const blocks: Range[] = [];
  const fresh: Range[] = [];
  tr.mapping.maps.forEach((map, i) => {
    const rest = tr.mapping.slice(i + 1);
    map.forEach((_os, _oe, ns, ne) => {
      const from = Math.max(0, Math.min(rest.map(ns, -1), size));
      // Även en ren borttagning (from === to) ska söka om stycket den skedde i.
      const to = Math.min(size, Math.max(from + 1, Math.min(rest.map(ne, 1), size)));
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isTextblock) return true;
        if (!blocks.some((b) => b.from === pos)) {
          blocks.push({ from: pos, to: pos + node.nodeSize });
          findInBlock(node, pos, re, fresh);
        }
        return false;
      });
    });
  });
  const kept: Range[] = [];
  for (const m of old) {
    const a = tr.mapping.mapResult(m.from, 1);
    const b = tr.mapping.mapResult(m.to, -1);
    if (a.deleted || b.deleted || b.pos <= a.pos) continue;
    if (blocks.some((bl) => a.pos < bl.to && b.pos > bl.from)) continue;
    kept.push({ from: a.pos, to: b.pos });
  }
  const matches = [...kept, ...fresh].sort((x, y) => x.from - y.from).slice(0, MAX_MATCHES);
  return { matches, blocks, fresh };
}

interface PluginState {
  re: RegExp | null;
  matches: Range[];
  current: number;
  /** Alla träffar (flyttas med vid ändringar i stället för att byggas om). */
  base: DecorationSet;
  /** base + markering av aktuell träff. */
  decorations: DecorationSet;
}

const key = new PluginKey<PluginState>("wwSearch");

type Meta = { re: RegExp | null } | { current: number };

const matchDeco = (m: Range) => Decoration.inline(m.from, m.to, { class: "search-match" });

function withCurrent(state: EditorState, base: DecorationSet, matches: Range[], current: number): DecorationSet {
  const m = matches[current];
  return m ? base.add(state.doc, [Decoration.inline(m.from, m.to, { class: "search-current" })]) : base;
}

function fromScratch(state: EditorState, re: RegExp | null, pos: number): PluginState {
  const matches = findInDoc(state, re);
  const current = nearest(matches, pos);
  const base = matches.length ? DecorationSet.create(state.doc, matches.map(matchDeco)) : DecorationSet.empty;
  return { re, matches, current, base, decorations: withCurrent(state, base, matches, current) };
}

/** Index för första träffen vid eller efter positionen. */
function nearest(matches: Range[], pos: number): number {
  if (!matches.length) return -1;
  const i = matches.findIndex((m) => m.to > pos);
  return i === -1 ? 0 : i;
}

export const SearchHighlight = Extension.create({
  name: "wwSearch",
  addProseMirrorPlugins() {
    return [
      new Plugin<PluginState>({
        key,
        state: {
          init: () => ({ re: null, matches: [], current: -1, base: DecorationSet.empty, decorations: DecorationSet.empty }),
          apply(tr: Transaction, prev: PluginState, _old, state): PluginState {
            const meta = tr.getMeta(key) as Meta | undefined;
            if (meta && "re" in meta) return fromScratch(state, meta.re, state.selection.from);
            if (meta && "current" in meta) {
              return { ...prev, current: meta.current, decorations: withCurrent(state, prev.base, prev.matches, meta.current) };
            }
            if (tr.docChanged && prev.re) {
              const old = prev.matches[prev.current];
              const anchor = old ? tr.mapping.map(old.from) : state.selection.from;
              const up = updateMatches(tr, state, prev.re, prev.matches);
              if (!up) return fromScratch(state, prev.re, anchor);
              let base = prev.base.map(tr.mapping, tr.doc);
              for (const bl of up.blocks) base = base.remove(base.find(bl.from, bl.to));
              if (up.fresh.length) base = base.add(tr.doc, up.fresh.map(matchDeco));
              const current = nearest(up.matches, anchor);
              return { ...prev, matches: up.matches, current, base, decorations: withCurrent(state, base, up.matches, current) };
            }
            return prev;
          },
        },
        props: {
          decorations: (state) => key.getState(state)?.decorations,
        },
      }),
    ];
  },
});

function pmState(view: EditorView): PluginState {
  return key.getState(view.state)!;
}

function status(s: PluginState): SearchStatus {
  return { count: s.matches.length, current: s.matches.length ? s.current : -1 };
}

export function pmSearch(view: EditorView, re: RegExp | null): SearchStatus {
  view.dispatch(view.state.tr.setMeta(key, { re }));
  return status(pmState(view));
}

export function pmStatus(view: EditorView): SearchStatus {
  return status(pmState(view));
}

/** Går till nästa (+1) eller föregående (-1) träff, eller visar aktuell (0), och markerar den. */
export function pmStep(view: EditorView, dir: 1 | 0 | -1): Range | null {
  const s = pmState(view);
  if (!s.matches.length) return null;
  const n = s.matches.length;
  const current = (s.current + dir + n) % n;
  const m = s.matches[current];
  view.dispatch(
    view.state.tr.setMeta(key, { current }).setSelection(TextSelection.create(view.state.doc, m.from, m.to)),
  );
  return m;
}

export function pmCurrent(view: EditorView): Range | null {
  const s = pmState(view);
  return s.matches[s.current] ?? null;
}

/** Ersätter aktuell träff. Returnerar nästa träff (att visa), om någon. */
export function pmReplace(view: EditorView, text: string): Range | null {
  const s = pmState(view);
  const m = s.matches[s.current];
  if (!m) return null;
  view.dispatch(view.state.tr.insertText(text, m.from, m.to));
  const after = pmState(view);
  return after.matches[after.current] ?? null;
}

/** Ersätter alla träffar i ett enda steg (ett Ångra återställer allt). */
export function pmReplaceAll(view: EditorView, text: string): number {
  const { matches } = pmState(view);
  if (!matches.length) return 0;
  const tr = view.state.tr;
  for (let i = matches.length - 1; i >= 0; i--) tr.insertText(text, matches[i].from, matches[i].to);
  view.dispatch(tr);
  return matches.length;
}
