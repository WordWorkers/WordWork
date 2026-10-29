/**
 * Högerklicksmeny i Skriv-vyn: rättningsförslag, egen ordlista och synonymer.
 * Ingenting ändras i texten förrän användaren själv väljer ett alternativ.
 */
import type { EditorView } from "@tiptap/pm/view";
import { TextSelection } from "@tiptap/pm/state";
import { api } from "./api";
import { WORD_RE, wordAt, type SpellService, type WordRange } from "./spell";
import { h, toast } from "./ui";
import { commentAt } from "./comments";

interface MenuDeps {
  spell: SpellService;
  replace: (from: number, to: number, text: string) => void;
  openChars: () => void;
  toggleNote: () => void;
  /** Lägg till eller ändra en kommentar på intervallet. */
  comment: (from: number, to: number) => void;
  removeComment: (from: number, to: number) => void;
  /** Ändra fotnoten på positionen, eller (null) infoga en ny vid markören. */
  footnote: (pos: number | null) => void;
  removeFootnote: (pos: number) => void;
}

let current: HTMLElement | null = null;

export function closeMenu(): void {
  current?.remove();
  current = null;
}

document.addEventListener("mousedown", (e) => {
  if (current && !current.contains(e.target as Node)) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
});
window.addEventListener("blur", closeMenu);
window.addEventListener("resize", closeMenu);

/** Behåll versal begynnelsebokstav om originalet hade det. */
function matchCase(original: string, replacement: string): string {
  if (original.length > 1 && original === original.toUpperCase()) return replacement.toUpperCase();
  if (original[0] === original[0].toUpperCase() && original[0] !== original[0].toLowerCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

export function openContextMenu(event: MouseEvent, view: EditorView, deps: MenuDeps): boolean {
  const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!hit) return false;
  // Högerklick på en fotnotssiffra: bara fotnotsval.
  const fnEl = (event.target as Element).closest?.(".ww-footnote");
  if (fnEl) {
    const pos = view.posAtDOM(fnEl, 0);
    if (view.state.doc.nodeAt(pos)?.type.name === "footnote") {
      closeMenu();
      const menu = h("div", { class: "context-menu", role: "menu" });
      current = menu;
      menu.append(
        item("Ändra fotnot …", () => {
          closeMenu();
          deps.footnote(pos);
        }),
        item("Ta bort fotnot", () => {
          closeMenu();
          deps.removeFootnote(pos);
        }),
      );
      document.body.append(menu);
      position(menu, event.clientX, event.clientY);
      return true;
    }
  }
  // En egen markering som klicket ligger i (för "Kommentera …"), innan menyn ändrar den.
  const sel = view.state.selection;
  const selRange =
    !sel.empty && hit.pos >= sel.from && hit.pos <= sel.to && sel.$from.sameParent(sel.$to)
      ? { from: sel.from, to: sel.to }
      : null;
  const range = wordAt(view.state, hit.pos);
  if (!range) {
    // Inget ord under markören: visa bara "Infoga tecken".
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, hit.pos)));
    closeMenu();
    const menu = h("div", { class: "context-menu", role: "menu" });
    current = menu;
    menu.append(
      ...commentItems(deps, view, hit.pos, selRange),
      footnoteItem(deps, view, selRange?.to ?? hit.pos),
      charsItem(deps, view, hit.pos),
      noteItem(deps, view, hit.pos),
    );
    document.body.append(menu);
    position(menu, event.clientX, event.clientY);
    return true;
  }

  const phrase = phraseCandidate(view, hit.pos, range, deps.spell);
  // Markera ordet så det syns vad menyn gäller – men behåll en egen markering
  // som användaren gjort för att lägga till en fras.
  if (!phrase?.fromSelection) {
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, range.from, range.to)),
    );
  }

  closeMenu();
  const menu = h("div", { class: "context-menu", role: "menu" });
  current = menu;

  const choose = (text: string) => {
    deps.replace(range.from, range.to, matchCase(range.word, text));
    closeMenu();
  };

  if (phrase) buildPhrase(menu, phrase.text, deps);
  const misspelled = deps.spell.isMisspelled(range.word);
  if (misspelled) buildSpelling(menu, range, deps, choose);
  buildSynonyms(menu, range, choose);
  menu.append(
    h("hr", {}),
    ...commentItems(deps, view, hit.pos, selRange ?? { from: range.from, to: range.to }),
    footnoteItem(deps, view, selRange?.to ?? range.to),
    charsItem(deps, view, hit.pos),
    noteItem(deps, view, hit.pos),
  );

  document.body.append(menu);
  position(menu, event.clientX, event.clientY);
  return true;
}

const MAX_PHRASE_WORDS = 6;

/**
 * En fras att föreslå för den egna ordlistan:
 *  - den egna markeringen, om klicket är i den och den är 2–6 ord, eller
 *  - en följd av understrukna ord runt det klickade ("open source").
 */
function phraseCandidate(
  view: EditorView,
  pos: number,
  range: WordRange,
  spell: SpellService,
): { text: string; fromSelection: boolean } | null {
  const sel = view.state.selection;
  if (!sel.empty && sel.from <= pos && pos <= sel.to) {
    const text = view.state.doc.textBetween(sel.from, sel.to, " ", " ").split(/\s+/).filter(Boolean).join(" ");
    const n = text.match(WORD_RE)?.length ?? 0;
    WORD_RE.lastIndex = 0;
    if (n >= 2 && n <= MAX_PHRASE_WORDS) return { text, fromSelection: true };
  }
  if (!spell.isMisspelled(range.word)) return null;

  const $pos = view.state.doc.resolve(range.from);
  const block = $pos.parent;
  const start = $pos.start();
  const text = block.textBetween(0, block.content.size, undefined, "\n");
  const words = [...text.matchAll(WORD_RE)].map((m) => ({ word: m[0], from: m.index!, to: m.index! + m[0].length }));
  const i = words.findIndex((w) => w.from === range.from - start);
  if (i < 0) return null;
  const joined = (a: number, b: number) => /^[ \t]+$/.test(text.slice(words[a].to, words[b].from));
  let a = i;
  let b = i;
  while (a > 0 && b - a + 1 < MAX_PHRASE_WORDS && joined(a - 1, a) && spell.isMisspelled(words[a - 1].word)) a--;
  while (b < words.length - 1 && b - a + 1 < MAX_PHRASE_WORDS && joined(b, b + 1) && spell.isMisspelled(words[b + 1].word)) b++;
  if (a === b) return null;
  return { text: words.slice(a, b + 1).map((w) => w.word).join(" "), fromSelection: false };
}

function buildPhrase(menu: HTMLElement, phrase: string, deps: MenuDeps): void {
  menu.append(
    h("div", { class: "menu-heading" }, `Fras: ”${phrase}”`),
    item("Lägg till fras i egen ordlista", async () => {
      closeMenu();
      try {
        await deps.spell.addToDictionary(phrase);
        toast(`”${phrase}” godkänns nu som fras – orden var för sig gör det inte`);
      } catch (e) {
        toast(e instanceof Error ? e.message : "Kunde inte spara i ordlistan");
      }
    }),
    h("hr", {}),
  );
}

/** "Infoga tecken …" – tecknet ska hamna där man högerklickade, inte ersätta ordet. */
function charsItem(deps: MenuDeps, view: EditorView, pos: number): HTMLButtonElement {
  return item("Infoga tecken …", () => {
    closeMenu();
    const p = Math.min(pos, view.state.doc.content.size);
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(p))));
    deps.openChars();
  });
}

/** "Kommentera …", eller "Ändra kommentar …"/"Ta bort kommentar" på en befintlig kommentar. */
function commentItems(
  deps: MenuDeps,
  view: EditorView,
  pos: number,
  target: { from: number; to: number } | null,
): HTMLElement[] {
  const existing = commentAt(view.state, pos);
  if (existing) {
    return [
      item(`Ändra kommentar … (”${existing.text.length > 30 ? existing.text.slice(0, 30) + "…" : existing.text}”)`, () => {
        closeMenu();
        deps.comment(existing.from, existing.to);
      }),
      item("Ta bort kommentar", () => {
        closeMenu();
        deps.removeComment(existing.from, existing.to);
      }),
    ];
  }
  if (!target || target.from === target.to) return [];
  return [
    item("Kommentera …", () => {
      closeMenu();
      deps.comment(target.from, target.to);
    }),
  ];
}

/** "Infoga fotnot …" – efter ordet (eller markeringen) man högerklickade på. */
function footnoteItem(deps: MenuDeps, view: EditorView, pos: number): HTMLElement {
  const $pos = view.state.doc.resolve(Math.min(pos, view.state.doc.content.size));
  if ($pos.parent.type.name === "note" || $pos.parent.type.name === "codeBlock") return h("span", { hidden: true });
  return item("Infoga fotnot …", () => {
    closeMenu();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, $pos.pos)));
    deps.footnote(null);
  });
}

/** Gör stycket till en egen anteckning (eller tillbaka). */
function noteItem(deps: MenuDeps, view: EditorView, pos: number): HTMLButtonElement {
  const $pos = view.state.doc.resolve(Math.min(pos, view.state.doc.content.size));
  const inNote = $pos.parent.type.name === "note";
  return item(inNote ? "Gör till vanligt stycke" : "Gör till egen anteckning", () => {
    closeMenu();
    view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)));
    deps.toggleNote();
  });
}

function item(label: string, onclick: () => void, cls = ""): HTMLButtonElement {
  return h("button", { class: `menu-item ${cls}`, role: "menuitem", onclick }, label);
}

function buildSpelling(
  menu: HTMLElement,
  range: WordRange,
  deps: MenuDeps,
  choose: (t: string) => void,
): void {
  const list = h("div", { class: "menu-group" }, h("div", { class: "menu-note" }, "Söker förslag …"));
  menu.append(
    h("div", { class: "menu-heading" }, `Stavning: ”${range.word}”`),
    list,
    item("Lägg till i egen ordlista", async () => {
      closeMenu();
      try {
        await deps.spell.addToDictionary(range.word);
        toast(`”${range.word}” finns nu i din ordlista`);
      } catch {
        toast("Kunde inte spara i ordlistan");
      }
    }),
    item("Ignorera i den här sessionen", () => {
      deps.spell.ignore(range.word);
      closeMenu();
    }),
    h("hr", {}),
  );
  api
    .suggest(range.word)
    .then(({ suggestions }) => {
      list.replaceChildren(
        ...(suggestions.length
          ? suggestions.map((s) => item(s, () => choose(s), "suggestion"))
          : [h("div", { class: "menu-note" }, "Inga förslag")]),
      );
      reposition(menu);
    })
    .catch(() => list.replaceChildren(h("div", { class: "menu-note" }, "Kunde inte hämta förslag")));
}

function buildSynonyms(menu: HTMLElement, range: WordRange, choose: (t: string) => void): void {
  const box = h("div", { class: "menu-group synonyms" }, h("div", { class: "menu-note" }, "Söker synonymer …"));
  menu.append(h("div", { class: "menu-heading" }, `Synonymer`), box);
  api
    .synonyms(range.word)
    .then(({ groups }) => {
      if (!groups.length) {
        box.replaceChildren(h("div", { class: "menu-note" }, `Inga synonymer för ”${range.word}”`));
        return;
      }
      const nodes: HTMLElement[] = [];
      for (const g of groups) {
        if (g.base_form || groups.length > 1) {
          nodes.push(h("div", { class: "menu-sub" }, g.base_form ? `${g.word} (grundform)` : g.word));
        }
        nodes.push(
          h(
            "div",
            { class: "chips" },
            ...g.synonyms.slice(0, 18).map((s) =>
              h("button", { class: "chip", role: "menuitem", onclick: () => choose(s) }, s),
            ),
          ),
        );
      }
      box.replaceChildren(...nodes);
      reposition(menu);
    })
    .catch(() => box.replaceChildren(h("div", { class: "menu-note" }, "Kunde inte hämta synonymer")));
}

function position(menu: HTMLElement, x: number, y: number): void {
  menu.dataset.x = String(x);
  menu.dataset.y = String(y);
  reposition(menu);
}

function reposition(menu: HTMLElement): void {
  const x = Number(menu.dataset.x);
  const y = Number(menu.dataset.y);
  const r = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - r.width - 8);
  const top = y + r.height > window.innerHeight - 8 ? Math.max(8, y - r.height) : y;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${top}px`;
}
