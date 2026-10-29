/**
 * Markerar mycket långa meningar i Skriv-vyn (slås på i Analys-panelen).
 *
 * Meningar delas som i LIX-beräkningen (stats.ts), så att markeringarna stämmer
 * med "Längsta meningarna". Vid ändringar räknas bara de ändrade styckena om.
 */
import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { ABBREVIATIONS } from "./stats";

interface Sentence {
  from: number;
  to: number;
  words: number;
}

const WORD = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu;
const BOUNDARY = /(?<=[.!?:…]["”’»)]*)\s+/gu;

/** Meningar i en textsträng, med teckenpositioner. */
export function sentencesIn(text: string): Sentence[] {
  const masked = text.replace(ABBREVIATIONS, (m) => m.replace(/\./g, "\u0000"));
  const out: Sentence[] = [];
  const push = (a: number, b: number) => {
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (b > a) out.push({ from: a, to: b, words: (text.slice(a, b).match(WORD) ?? []).length });
  };
  let start = 0;
  BOUNDARY.lastIndex = 0;
  for (const m of masked.matchAll(BOUNDARY)) {
    push(start, m.index!);
    start = m.index! + m[0].length;
  }
  push(start, text.length);
  return out;
}

interface State {
  limit: number;
  decorations: DecorationSet;
}

const key = new PluginKey<State>("wwLongSentences");

function blockDecos(node: PMNode, pos: number, limit: number): Decoration[] {
  if (node.type.name === "note" || node.type.name === "codeBlock") return [];
  let text = "";
  node.forEach((child) => {
    text += child.isText ? child.text! : "\n".repeat(child.nodeSize);
  });
  return sentencesIn(text)
    .filter((s) => s.words > limit)
    .map((s) =>
      Decoration.inline(pos + 1 + s.from, pos + 1 + s.to, {
        class: "long-sentence",
        title: `Lång mening: ${s.words} ord`,
      }),
    );
}

function build(state: EditorState, limit: number): DecorationSet {
  if (!limit) return DecorationSet.empty;
  const decos: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    decos.push(...blockDecos(node, pos, limit));
    return false;
  });
  return DecorationSet.create(state.doc, decos);
}

function update(tr: Transaction, prev: State): DecorationSet {
  let set = prev.decorations.map(tr.mapping, tr.doc);
  const size = tr.doc.content.size;
  const seen = new Set<number>();
  tr.mapping.maps.forEach((map, i) => {
    const rest = tr.mapping.slice(i + 1);
    map.forEach((_os, _oe, ns, ne) => {
      const from = Math.max(0, Math.min(rest.map(ns, -1), size));
      const to = Math.min(size, Math.max(from + 1, Math.min(rest.map(ne, 1), size)));
      tr.doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isTextblock) return true;
        if (seen.has(pos)) return false;
        seen.add(pos);
        set = set.remove(set.find(pos, pos + node.nodeSize));
        set = set.add(tr.doc, blockDecos(node, pos, prev.limit));
        return false;
      });
    });
  });
  return set;
}

export const LongSentences = Extension.create({
  name: "wwLongSentences",
  addProseMirrorPlugins() {
    return [
      new Plugin<State>({
        key,
        state: {
          init: () => ({ limit: 0, decorations: DecorationSet.empty }),
          apply(tr, prev, _old, state) {
            const limit = tr.getMeta(key) as number | undefined;
            if (limit !== undefined) return { limit, decorations: build(state, limit) };
            if (tr.docChanged && prev.limit) return { ...prev, decorations: update(tr, prev) };
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

export function setLongSentences(view: EditorView, limit: number): void {
  if (key.getState(view.state)?.limit === limit && !limit) return;
  view.dispatch(view.state.tr.setMeta(key, limit));
}
