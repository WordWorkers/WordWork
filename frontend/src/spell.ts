/**
 * Stavningskontroll i Skriv-vyn.
 *
 * Unika ord i dokumentet skickas till servern i omgångar; svaren cachas i
 * webbläsaren. Felstavade ord markeras med ProseMirror-dekorationer, så själva
 * texten (Markdown) påverkas aldrig.
 */
import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { api } from "./api";

export const WORD_RE = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu;
const BATCH = 2000;

export interface WordRange {
  word: string;
  from: number;
  to: number;
}

/** Går igenom textnoder och anropar `fn` för varje ord (utom i kod). */
export function forEachWord(doc: PMNode, fn: (w: WordRange) => void): void {
  doc.descendants((node, pos, parent) => {
    if (node.type.name === "codeBlock") return false;
    if (!node.isText || !node.text) return true;
    if (parent?.type.name === "codeBlock") return false;
    if (node.marks.some((m) => m.type.name === "code")) return false;
    for (const m of node.text.matchAll(WORD_RE)) {
      fn({ word: m[0], from: pos + m.index!, to: pos + m.index! + m[0].length });
    }
    return false;
  });
}

/** Ordet vid en viss position i dokumentet. */
export function wordAt(state: EditorState, pos: number): WordRange | null {
  const $pos = state.doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;
  const start = $pos.start();
  const text = parent.textBetween(0, parent.content.size, "\0", "\0");
  const offset = pos - start;
  for (const m of text.matchAll(WORD_RE)) {
    const a = m.index!;
    const b = a + m[0].length;
    if (offset >= a && offset <= b) return { word: m[0], from: start + a, to: start + b };
  }
  return null;
}

/** Intervall i dokumentet som täcks av en godkänd fras ur den egna ordlistan. */
export interface PhraseRange {
  from: number;
  to: number;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Regex för en fras: orden i följd med blanksteg emellan, hela ord.
 * Efter sista ordet får ett bindestreck följa ("open source-licensen").
 * Gemener i listan godkänner även versal begynnelsebokstav, som för enskilda ord.
 */
export function phraseRegex(phrase: string): RegExp {
  const words = phrase.split(" ");
  const lower = phrase === phrase.toLowerCase();
  const parts = words.map((w, i) => {
    const e = escapeRe(w);
    if (lower && i === 0) {
      const first = escapeRe(w[0]);
      return `[${first}${escapeRe(w[0].toUpperCase())}]${escapeRe(w.slice(1))}`;
    }
    return e;
  });
  return new RegExp(`(?<![\\p{L}\\p{N}'’-])${parts.join("\\s+")}(?![\\p{L}\\p{N}]|['’]\\p{L})`, "gu");
}

/** Hittar alla förekomster av fraserna i varje textblock. */
export function findPhrases(doc: PMNode, phrases: RegExp[]): PhraseRange[] {
  if (!phrases.length) return [];
  const out: PhraseRange[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.name === "codeBlock") return false;
    const text = node.textBetween(0, node.content.size, undefined, "\n");
    for (const re of phrases) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        out.push({ from: pos + 1 + m.index!, to: pos + 1 + m.index! + m[0].length });
      }
    }
    return false;
  });
  return out.sort((a, b) => a.from - b.from);
}

export class SpellService {
  enabled = true;
  /** Fraser ur den egna ordlistan, t.ex. "open source". */
  phrases: RegExp[] = [];
  private known = new Map<string, boolean>(); // ord → korrekt?
  private ignored = new Set<string>();
  private queue = new Set<string>();
  private inFlight = false;
  private timer: number | undefined;
  private listeners = new Set<() => void>();

  onUpdate(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Ritar om understrykningar (t.ex. när kontrollen slås av/på). */
  changed(): void {
    for (const fn of this.listeners) fn();
  }

  isMisspelled(word: string): boolean {
    if (/\d/.test(word) || word.length < 2) return false;
    return this.known.get(word) === false && !this.ignored.has(word);
  }

  /** Köar ord som inte kontrollerats ännu. */
  request(words: Iterable<string>): void {
    for (const w of words) {
      if (!this.known.has(w) && !/\d/.test(w) && w.length > 1) this.queue.add(w);
    }
    if (this.queue.size) {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.flush(), 150);
    }
  }

  private async flush(): Promise<void> {
    if (this.inFlight || !this.queue.size) return;
    this.inFlight = true;
    const batch = [...this.queue].slice(0, BATCH);
    try {
      const { misspelled } = await api.spellCheck(batch);
      const bad = new Set(misspelled);
      for (const w of batch) {
        this.known.set(w, !bad.has(w));
        this.queue.delete(w);
      }
      this.changed();
    } catch {
      // Servern laddar kanske fortfarande ordlistan – försök igen om en stund.
      window.setTimeout(() => void this.flush(), 3000);
      return;
    } finally {
      this.inFlight = false;
    }
    if (this.queue.size) void this.flush();
  }

  ignore(word: string): void {
    this.ignored.add(word);
    this.changed();
  }

  /** Efter större ändringar i ordlistan: kontrollera alla ord på nytt. */
  reload(entries: string[]): void {
    this.setDictionary(entries);
    this.known.clear();
    this.changed();
  }

  /** Läser in fraserna ur den egna ordlistan (enskilda ord kontrolleras på servern). */
  setDictionary(entries: string[]): void {
    this.phrases = entries.filter((e) => e.includes(" ")).map(phraseRegex);
  }

  async loadDictionary(): Promise<void> {
    try {
      this.setDictionary((await api.dictionary()).words);
      this.changed();
    } catch {
      /* servern startar kanske fortfarande */
    }
  }

  async addToDictionary(word: string): Promise<void> {
    const { words } = await api.dictionaryAdd(word);
    this.setDictionary(words);
    if (word.includes(" ")) {
      this.changed();
      return;
    }
    this.known.set(word, true);
    // Ordlistan godkänner även versal begynnelsebokstav för gemena ord.
    if (word === word.toLowerCase()) {
      const cap = word[0].toUpperCase() + word.slice(1);
      if (this.known.has(cap)) this.known.set(cap, true);
    }
    this.changed();
  }

  /** Efter att ett ord tagits bort ur ordlistan måste det kontrolleras igen. */
  forget(word: string, remaining?: string[]): void {
    if (remaining) this.setDictionary(remaining);
    if (word.includes(" ")) {
      this.changed();
      return;
    }
    this.known.delete(word);
    this.known.delete(word[0].toUpperCase() + word.slice(1));
    this.changed();
  }
}

const spellKey = new PluginKey<DecorationSet>("spellcheck");

export function spellExtension(service: SpellService) {
  return Extension.create({
    name: "spellcheck",
    addProseMirrorPlugins() {
      let timer: number | undefined;
      let unsubscribe: (() => void) | null = null;

      const compute = (doc: PMNode): DecorationSet => {
        if (!service.enabled) return DecorationSet.empty;
        const decos: Decoration[] = [];
        const unknown: string[] = [];
        const check = (word: string, from: number, to: number) => {
          if (service.isMisspelled(word)) {
            decos.push(Decoration.inline(from, to, { class: "misspelled" }));
          } else {
            unknown.push(word);
          }
        };
        const phrases = findPhrases(doc, service.phrases);
        let pi = 0;
        forEachWord(doc, ({ word, from, to }) => {
          while (pi < phrases.length && phrases[pi].to <= from) pi++;
          const p = phrases[pi];
          if (p && p.from <= from && from < p.to) {
            // Ordet ingår i en godkänd fras. Fortsätter det med bindestreck efter
            // frasen ("source-licensen") kontrolleras resten som ett svenskt ord.
            if (to <= p.to) return;
            const rest = word.slice(p.to - from);
            const m = /^[-'’]+/.exec(rest);
            const lead = m ? m[0].length : 0;
            if (rest.length > lead) check(rest.slice(lead), p.to + lead, to);
            return;
          }
          check(word, from, to);
        });
        service.request(unknown);
        return DecorationSet.create(doc, decos);
      };

      const refresh = (view: EditorView) => {
        if (view.isDestroyed) return;
        view.dispatch(view.state.tr.setMeta(spellKey, compute(view.state.doc)));
      };

      return [
        new Plugin<DecorationSet>({
          key: spellKey,
          state: {
            init: (_, state) => compute(state.doc),
            apply(tr, old) {
              const fresh = tr.getMeta(spellKey) as DecorationSet | undefined;
              if (fresh) return fresh;
              return old.map(tr.mapping, tr.doc);
            },
          },
          props: {
            decorations(state) {
              return spellKey.getState(state);
            },
          },
          view(view) {
            unsubscribe = service.onUpdate(() => refresh(view));
            return {
              update(v, prev) {
                if (v.state.doc === prev.doc) return;
                window.clearTimeout(timer);
                timer = window.setTimeout(() => refresh(v), 400);
              },
              destroy() {
                window.clearTimeout(timer);
                unsubscribe?.();
              },
            };
          },
        }),
      ];
    },
  });
}

/* ---------- markering av ord (ordfrekvens) ---------- */

const highlightKey = new PluginKey<{ word: string | null; decos: DecorationSet }>("highlight");

function highlightDecos(doc: PMNode, word: string | null): DecorationSet {
  if (!word) return DecorationSet.empty;
  const target = word.toLocaleLowerCase("sv");
  const decos: Decoration[] = [];
  forEachWord(doc, (w) => {
    if (w.word.toLocaleLowerCase("sv") === target) {
      decos.push(Decoration.inline(w.from, w.to, { class: "word-highlight" }));
    }
  });
  return DecorationSet.create(doc, decos);
}

export const WordHighlight = Extension.create({
  name: "wordHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: highlightKey,
        state: {
          init: () => ({ word: null as string | null, decos: DecorationSet.empty }),
          apply(tr, value) {
            const meta = tr.getMeta(highlightKey) as { word: string | null } | undefined;
            if (meta) return { word: meta.word, decos: highlightDecos(tr.doc, meta.word) };
            if (!tr.docChanged || !value.word) return value;
            return { word: value.word, decos: highlightDecos(tr.doc, value.word) };
          },
        },
        props: {
          decorations: (state) => highlightKey.getState(state)?.decos,
        },
      }),
    ];
  },
});

export function setHighlight(view: EditorView, word: string | null): number | null {
  view.dispatch(view.state.tr.setMeta(highlightKey, { word }));
  if (!word) return null;
  let first: number | null = null;
  const target = word.toLocaleLowerCase("sv");
  forEachWord(view.state.doc, (w) => {
    if (first === null && w.word.toLocaleLowerCase("sv") === target) first = w.from;
  });
  return first;
}
