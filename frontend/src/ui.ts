/** Small DOM helpers and dialogs. */

type Attrs = Record<string, string | boolean | number | EventListener | undefined>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === "class") {
      el.className = String(v);
    } else if (v === true) {
      el.setAttribute(k, "");
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? "⌘" : "Ctrl";

export function isMod(e: KeyboardEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

function modal(build: (close: (v: unknown) => void) => HTMLElement): Promise<unknown> {
  return new Promise((resolve) => {
    const dlg = h("dialog", { class: "modal" });
    const close = (v: unknown) => {
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    dlg.append(build(close));
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      close(null);
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}

export function prompt(title: string, value = "", okLabel = "OK"): Promise<string | null> {
  return modal((close) => {
    const input = h("input", { type: "text", value, "aria-label": title }) as HTMLInputElement;
    const form = h(
      "form",
      { method: "dialog" },
      h("h2", {}, title),
      input,
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", onclick: () => close(null) }, "Avbryt"),
        h("button", { type: "submit", class: "primary" }, okLabel),
      ),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      close(input.value.trim() || null);
    });
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
    return form;
  }) as Promise<string | null>;
}

/**
 * Like prompt, but with a multi-line text field. Enter saves, Shift+Enter gives
 * a new line (an empty line starts a new paragraph).
 */
export function promptText(title: string, value = "", okLabel = "OK", hint = ""): Promise<string | null> {
  return modal((close) => {
    const input = h("textarea", { rows: 4, "aria-label": title }) as HTMLTextAreaElement;
    input.value = value;
    const form = h(
      "form",
      { method: "dialog", class: "prompt-text" },
      h("h2", {}, title),
      input,
      hint ? h("p", { class: "hint" }, hint) : "",
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", onclick: () => close(null) }, "Avbryt"),
        h("button", { type: "submit", class: "primary" }, okLabel),
      ),
    );
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      close(input.value.trim());
    });
    queueMicrotask(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return form;
  }) as Promise<string | null>;
}

export function confirm(title: string, text: string, okLabel = "OK", danger = false) {
  return modal((close) =>
    h(
      "div",
      {},
      h("h2", {}, title),
      h("p", {}, text),
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", onclick: () => close(false) }, "Avbryt"),
        h(
          "button",
          { type: "button", class: danger ? "danger" : "primary", onclick: () => close(true) },
          okLabel,
        ),
      ),
    ),
  ) as Promise<boolean>;
}

export function showModal(build: (close: () => void) => HTMLElement): Promise<void> {
  return modal((close) => build(() => close(null))) as Promise<void>;
}

let toastTimer: number | undefined;
export function toast(message: string): void {
  let el = document.getElementById("toast");
  if (!el) {
    el = h("div", { id: "toast", role: "status" });
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove("show"), 2600);
}

export function formatDate(d: Date): string {
  const today = new Date();
  const time = d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `I dag ${time}`;
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `I går ${time}`;
  return `${d.toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" })} ${time}`;
}

const WORD = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu;
export function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0;
}
