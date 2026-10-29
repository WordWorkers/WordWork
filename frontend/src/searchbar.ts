/** Sökfältet (⌘F) med ersätt (⌘⌥F). */
import type { DocEditor } from "./editor";
import type { SearchStatus } from "./search";
import { h, isMac, isMod, modKey, toast } from "./ui";

export class SearchBar {
  readonly el = h("div", { class: "searchbar", role: "search", hidden: true });
  private find = h("input", {
    type: "search",
    placeholder: "Sök",
    "aria-label": "Sök i texten",
    spellcheck: "false",
  }) as HTMLInputElement;
  private replace = h("input", {
    type: "text",
    placeholder: "Ersätt med",
    "aria-label": "Ersätt med",
    spellcheck: "false",
  }) as HTMLInputElement;
  private count = h("span", { class: "count", "aria-live": "polite" });
  private caseBtn = h("button", { class: "toggle", "aria-pressed": "false", title: "Skilj på stora och små bokstäver" }, "Aa");
  private wordBtn = h("button", { class: "toggle", "aria-pressed": "false", title: "Bara hela ord" }, "Hela ord");
  private replaceBtn = h("button", { title: "Ersätt den markerade träffen och gå till nästa (Enter)" }, "Ersätt");
  private replaceAllBtn = h("button", { title: `Ersätt alla träffar (${modKey}+Enter)` }, "Ersätt alla");
  private timer: number | undefined;
  private status: SearchStatus = { count: 0, current: -1 };

  constructor(
    private editor: DocEditor,
    private afterClose: () => void,
  ) {
    const toggle = (btn: HTMLElement) => () => {
      btn.setAttribute("aria-pressed", String(btn.getAttribute("aria-pressed") !== "true"));
      this.run(true);
    };
    this.caseBtn.addEventListener("click", toggle(this.caseBtn));
    this.wordBtn.addEventListener("click", toggle(this.wordBtn));
    this.find.addEventListener("input", () => {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.run(true), 120);
    });
    this.find.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.flushInput();
        this.step(e.shiftKey ? -1 : 1);
      }
    });
    this.replace.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.flushInput();
        if (isMod(e)) this.doReplaceAll();
        else this.doReplace();
      }
    });
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
    this.replaceBtn.addEventListener("click", () => this.doReplace());
    this.replaceAllBtn.addEventListener("click", () => this.doReplaceAll());

    const prev = h("button", { class: "icon", title: "Föregående träff (Shift+Enter)", "aria-label": "Föregående träff", onclick: () => this.step(-1) }, "↑");
    const next = h("button", { class: "icon", title: "Nästa träff (Enter)", "aria-label": "Nästa träff", onclick: () => this.step(1) }, "↓");
    const close = h("button", { class: "icon", title: "Stäng (Esc)", "aria-label": "Stäng sökningen", onclick: () => this.close() }, "×");
    this.el.append(
      h("div", { class: "row" }, this.find, this.count, prev, next, this.caseBtn, this.wordBtn, close),
      h("div", { class: "row" }, this.replace, this.replaceBtn, this.replaceAllBtn),
    );
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  /** Öppnar sökfältet. Markerad text (en rad) fylls i. */
  open(focusReplace = false): void {
    const sel = this.editor.getSelectedForSearch();
    if (sel && !sel.includes("\n") && sel.length <= 120) this.find.value = sel;
    this.el.hidden = false;
    this.run(true);
    const target = focusReplace && this.find.value ? this.replace : this.find;
    target.focus();
    target.select();
  }

  close(): void {
    if (!this.isOpen) return;
    window.clearTimeout(this.timer);
    this.el.hidden = true;
    this.editor.setSearch(null);
    this.afterClose();
  }

  /** Anropas när texten eller vyn har ändrats. */
  refresh(): void {
    if (!this.isOpen) return;
    this.status = this.editor.searchStatus();
    this.render();
  }

  /** Ny sökning (vyn kan ha bytts). */
  rerun(): void {
    if (this.isOpen) this.run(false);
  }

  /** Nästa/föregående träff även när fokus står i texten (⌘G / ⇧⌘G). */
  step(dir: 1 | -1): void {
    if (!this.find.value) {
      this.find.focus();
      return;
    }
    this.status = this.editor.searchStep(dir);
    this.render();
  }

  private flushInput(): void {
    if (this.timer !== undefined) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
      this.run(true);
    }
  }

  private run(reveal: boolean): void {
    this.timer = undefined;
    this.status = this.editor.setSearch({
      text: this.find.value,
      caseSensitive: this.caseBtn.getAttribute("aria-pressed") === "true",
      wholeWord: this.wordBtn.getAttribute("aria-pressed") === "true",
    });
    // Visa första träffen medan man skriver (bara i Skriv-vyn – i Markdown-vyn
    // skulle källtexten ta fokus från sökfältet).
    if (reveal && this.status.count && this.editor.mode === "write") this.status = this.editor.searchStep(0);
    this.render();
  }

  private doReplace(): void {
    if (!this.status.count) return;
    this.status = this.editor.replaceCurrent(this.replace.value);
    this.render();
    if (this.editor.mode === "write") this.replace.focus();
  }

  private doReplaceAll(): void {
    if (!this.status.count) return;
    const n = this.editor.replaceAll(this.replace.value);
    this.status = this.editor.searchStatus();
    this.render();
    if (this.editor.mode === "write") this.find.focus(); // knapparna blir inaktiva
    toast(`Ersatte ${n.toLocaleString("sv-SE")} ${n === 1 ? "träff" : "träffar"} – ${isMac ? "⌘" : "Ctrl+"}Z ångrar`);
  }

  private render(): void {
    const { count, current } = this.status;
    const capped = count >= 5000 ? "5 000+" : count.toLocaleString("sv-SE");
    this.count.textContent = !this.find.value ? "" : count ? `${current + 1} av ${capped}` : "Inga träffar";
    this.find.classList.toggle("no-match", !!this.find.value && !count);
    this.replaceBtn.toggleAttribute("disabled", !count);
    this.replaceAllBtn.toggleAttribute("disabled", !count);
  }
}
