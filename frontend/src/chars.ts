/** Panelen "Infoga tecken". */
import { CHAR_GROUPS, charInfo, codePoint, recentChars, rememberChar, searchChars, type CharInfo } from "./typography";
import { h } from "./ui";

export interface CharPanelDeps {
  panel: HTMLElement;
  insert: (char: string) => void;
  close: () => void;
  fixAll: () => void;
}

/** Synlig form för osynliga tecken. */
function display(c: string): string {
  if (c === " ") return "␣";
  if (c === " ") return "⎵";
  return c;
}

export function renderCharPanel(deps: CharPanelDeps): void {
  const { panel } = deps;
  let active: HTMLButtonElement | null = null;
  const info = h("span", {}, "Välj ett tecken");
  const body = h("div", { class: "chars-body" });

  const setActive = (btn: HTMLButtonElement | null) => {
    active?.classList.remove("sel");
    active = btn;
    if (!btn) return;
    btn.classList.add("sel");
    const c = charInfo(btn.dataset.char!);
    info.replaceChildren(h("b", {}, display(c.char)), ` ${c.name} (${codePoint(c.char)})`);
  };

  const choose = (c: string, close: boolean) => {
    rememberChar(c);
    deps.insert(c);
    if (close) deps.close();
    else render(search.value);
  };

  const key = (c: CharInfo) => {
    const btn = h(
      "button",
      {
        class: "k",
        title: `${c.name} (${codePoint(c.char)})`,
        "aria-label": c.name,
        "data-char": c.char,
        onclick: () => choose(c.char, false),
        onfocus: () => setActive(btn),
        onmouseenter: () => setActive(btn),
      },
      display(c.char),
      c.label ? h("small", {}, c.label) : null,
    ) as HTMLButtonElement;
    return btn;
  };

  const grid = (chars: CharInfo[]) => h("div", { class: "grid", role: "group" }, ...chars.map(key));

  const render = (query: string) => {
    body.replaceChildren();
    if (query.trim()) {
      const hits = searchChars(query);
      body.append(
        hits.length ? grid(hits) : h("p", { class: "meta" }, "Inget tecken matchar. Prova t.ex. ”streck”, ”citat” eller ”grader”."),
      );
    } else {
      const recent = recentChars();
      if (recent.length) body.append(h("div", { class: "grp" }, "Senast använda"), grid(recent.map(charInfo)));
      for (const g of CHAR_GROUPS) body.append(h("div", { class: "grp" }, g.title), grid(g.chars));
    }
    setActive(body.querySelector<HTMLButtonElement>(".k"));
  };

  const search = h("input", {
    type: "search",
    placeholder: "Sök: tankstreck, citat, grader …",
    "aria-label": "Sök tecken",
    oninput: () => render(search.value),
  }) as HTMLInputElement;

  // Tangentbord: piltangenter flyttar, Enter infogar och stänger.
  panel.onkeydown = (e: KeyboardEvent) => {
    const keys = [...body.querySelectorAll<HTMLButtonElement>(".k")];
    if (!keys.length) return;
    if (e.target === search && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return;
    const i = active ? keys.indexOf(active) : -1;
    const cols = 8;
    let next = -1;
    if (e.key === "ArrowRight") next = i + 1;
    else if (e.key === "ArrowLeft") next = i - 1;
    else if (e.key === "ArrowDown") next = i + cols;
    else if (e.key === "ArrowUp") next = i - cols;
    else if (e.key === "Enter" && active) {
      e.preventDefault();
      choose(active.dataset.char!, true);
      return;
    } else return;
    e.preventDefault();
    next = Math.max(0, Math.min(keys.length - 1, next));
    setActive(keys[next]);
    if (document.activeElement !== search) keys[next].focus();
  };

  panel.replaceChildren(
    h("h2", {}, "Infoga tecken"),
    search,
    body,
    h("div", { class: "chars-info" }, info, h("span", {}, "Klicka eller Enter")),
    h(
      "div",
      { class: "chars-footer" },
      h(
        "button",
        { class: "link", onclick: () => deps.fixAll(), title: "Byt raka citattecken, dubbla bindestreck m.m. i hela texten" },
        "Rätta typografin i texten …",
      ),
    ),
  );
  render("");
  search.focus();
}
