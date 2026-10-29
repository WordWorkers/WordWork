import "@fontsource-variable/literata";
import "@fontsource-variable/literata/wght-italic.css";
import "@fontsource-variable/source-sans-3";
import "@fontsource-variable/source-sans-3/wght-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/400-italic.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./style.css";

import { diffWords } from "diff";
import { api, ApiError, invokeRoute, type Version } from "./api";
import { AIPanel } from "./ai";
import { renderCharPanel } from "./chars";
import { closeMenu, openContextMenu } from "./contextmenu";
import { diffChars } from "diff";
import { fixTypography, QUOTE_STYLES, type QuoteStyle } from "./typography";
import { DocEditor, type FootnoteAt, type ViewMode } from "./editor";
import { renameTracked, trackWords } from "./goal";
import { SpellService } from "./spell";
import { analyze, findQuotes, LIX_SCALE, lixLevel, nominalLevel, nominalStyle, quickStats, type TextStats } from "./stats";
import {
  applySettings,
  FONTS,
  loadSettings,
  saveSettings,
  syncSettings,
  THEMES,
  type Font,
  type Settings,
  type Theme,
} from "./settings";
import { confirm, formatDate, h, isMod, modKey, prompt, promptText, showModal, toast } from "./ui";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { SearchBar } from "./searchbar";
import { iconButton, type IconName } from "./icons";
import {
  deadlineText,
  formatLength,
  META_FIELDS,
  metaValue,
  parseDeadline,
  parseLength,
  readMeta,
  writeMeta,
  type LengthUnit,
} from "./frontmatter";
import { splitFrontmatter } from "./editor";
import { copyRich, publishContent } from "./publish";
import { listComments } from "./comments";
import { dropLocal, keepLocal, localCopy, type Unsaved } from "./unsaved";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { aiConfig, chooseDataDir, dataDir, isTauri, revealDataDir, saveAiConfig } from "./ipc";
import { downloadRoute } from "./ipc-routes"; // also registers wwSpike() in the app

const AUTOSAVE_MS = 1500;
const RETRY_MS = 5000;
const PUBLISH_TITLE_KEY = "ww.publishTitle";
const LAST_DOC_KEY = "ww.lastDoc";
const VIEW_KEY = "ww.view";

const KIND_LABEL: Record<Version["kind"], string> = {
  auto: "Automatisk",
  manual: "Sparad",
  named: "Namngiven",
  restore: "Återställd",
};

type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";

class App {
  private settings: Settings = loadSettings();
  private editor: DocEditor;
  private current: { name: string; modified: number } | null = null;
  private lastSaved = "";
  private saveState: SaveState = "saved";
  private saveTimer: number | undefined;
  private savePromise: Promise<void> | null = null;
  private retryTimer: number | undefined;
  private saveErrorShown = false;
  private searchBar: SearchBar;

  // DOM
  private titleBtn = h("button", { class: "doc-title", title: "Byt namn" });
  private viewBtns: Record<ViewMode, HTMLButtonElement>;
  private statusWords = h("span");
  private statusChars = h("span");
  private statusLix = h("button", { class: "status-lix", title: "Läsbarhet – öppna analys" });
  private statusGoal = h("span", { class: "status-goal", hidden: true });
  private statusSave = h("span", { class: "save-state" });
  private docsDrawer = h("aside", { class: "drawer left", "aria-label": "Dokument" });
  private historyDrawer = h("aside", { class: "drawer right", "aria-label": "Versionshistorik" });
  private analysisDrawer = h("aside", { class: "drawer right wide", "aria-label": "Textanalys" });
  private aiDrawer = h("aside", { class: "drawer right wide ai", "aria-label": "AI-assistent" });
  private aiButton = iconButton(
    "ai",
    "AI-assistent",
    { hidden: true, title: `AI-assistent (${modKey}+J) – Det ser ut som att du skriver en text. Vill du ha hjälp?` },
  );
  private metaDrawer = h("aside", { class: "drawer right", "aria-label": "Metadata" });
  private statusLength = h("span", { class: "status-goal status-length", hidden: true });
  private statusDeadline = h("span", { class: "status-deadline", hidden: true });
  /** Frontmatter för aktuellt dokument (uppdateras vid öppning, i metadatapanelen och i Markdown-vyn). */
  private frontmatter = "";
  /** Texttyper från servern (för metadata och inställningar). */
  private genres: { key: string; label: string }[] = [];
  private charsPanel = h("div", {
    class: "popover chars",
    id: "panel-chars",
    role: "dialog",
    "aria-label": "Infoga tecken",
  });
  private charsButton = iconButton(
    "chars",
    "Infoga tecken",
    { "aria-controls": "panel-chars", "aria-expanded": "false" },
    `${modKey}+.`,
  );
  private settingsButton = iconButton("settings", "Inställningar", {
    "aria-controls": "panel-settings",
    "aria-expanded": "false",
  });
  private ai: AIPanel;
  private spell = new SpellService();
  private highlighted: string | null = null;
  private includeStopwords = false;
  private analysisTimer: number | undefined;
  private settingsPanel = h("div", { class: "popover", role: "dialog", "aria-label": "Inställningar" });
  private banner = h("div", { class: "banner", role: "alert", hidden: true });
  /** Visas när servern kör en nyare version än den som laddats i fliken. */
  private updateNotice = h("div", { class: "banner update", role: "status", hidden: true });

  constructor(root: HTMLElement) {
    applySettings(this.settings);

    this.spell.enabled = this.settings.spellcheck;
    const host = h("div", { class: "editor-host" });
    this.editor = new DocEditor({
      host,
      spell: this.spell,
      typography: () => ({ enabled: this.settings.autoTypography, quotes: this.settings.quoteStyle }),
      onChange: () => this.onChange(),
      onActivity: () => {
        document.body.classList.add("typing");
        closeMenu();
        this.closeCommentBubble();
      },
      onCommentClick: (c, rect) => this.showCommentBubble(c, rect),
      onFootnoteClick: (f, rect) => this.showFootnoteBubble(f, rect),
      onSelection: () => {
        this.scheduleAnalysis();
        if (this.aiDrawer.classList.contains("open")) this.ai.updateScope();
      },
      onContextMenu: (event, view) =>
        openContextMenu(event, view, {
          spell: this.spell,
          replace: (from, to, text) => this.editor.replaceRange(from, to, text),
          openChars: () => this.toggleChars(true),
          toggleNote: () => this.toggleNote(),
          comment: (from, to) => void this.editComment(from, to),
          removeComment: (from, to) => this.editor.removeComment(from, to),
          footnote: (pos) => void this.editFootnote(pos),
          removeFootnote: (pos) => this.editor.removeFootnote(pos),
        }),
    });
    this.editor.typewriter = this.settings.typewriter;
    this.applyLongSentences();
    this.searchBar = new SearchBar(this.editor, () => this.editor.focus());
    this.ai = new AIPanel({
      drawer: this.aiDrawer,
      closeButton: () => this.closeButton(),
      documentName: () => this.current?.name ?? null,
      documentText: () => this.editor.getMarkdown(),
      plainText: () => this.editor.getPlainText(),
      selectionText: () => this.editor.getSelectionText(),
      showInText: (phrase) => {
        if (this.editor.mode !== "write") this.setView("write", false);
        return this.editor.selectText(phrase);
      },
      flush: () => this.flush(),
      prefs: () => this.settings,
      textInfo: () => {
        const genre = metaValue(this.frontmatter, "genre");
        return { genre: genre ? this.genreLabel(genre) : "", instructions: !!metaValue(this.frontmatter, "ai").trim() };
      },
      openMeta: () => this.toggleDrawer(this.metaDrawer),
      savePrefs: (patch) => {
        Object.assign(this.settings, patch);
        saveSettings(this.settings);
      },
    });
    this.aiButton.addEventListener("click", () => this.toggleDrawer(this.aiDrawer));
    this.aiDrawer.id = "panel-ai";
    this.aiButton.setAttribute("aria-controls", "panel-ai");
    this.aiButton.setAttribute("aria-expanded", "false");
    this.settingsPanel.id = "panel-settings";
    this.settingsButton.addEventListener("click", (e) => this.toggleSettings(e));
    this.charsButton.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleChars();
    });

    const viewBtn = (mode: ViewMode, iconName: IconName, label: string) =>
      iconButton(
        iconName,
        label,
        { class: "seg icon-btn", "aria-pressed": "false", onclick: () => this.setView(mode) },
        `${modKey}+/ växlar`,
      );
    this.viewBtns = {
      write: viewBtn("write", "write", "Skriv"),
      markdown: viewBtn("markdown", "markdown", "Markdown"),
    };

    const topbar = h(
      "header",
      { class: "chrome topbar" },
      h(
        "div",
        { class: "group" },
        this.panelButton(this.docsDrawer, "dokument", "documents", "Dokument", `${modKey}+O`),
        iconButton("newDoc", "Nytt dokument", { onclick: () => this.newDocument() }),
        iconButton("export", "Exportera eller kopiera för publicering", { onclick: () => this.showExport() }, `${modKey}+E`),
        iconButton("search", "Sök och ersätt", { onclick: () => this.searchBar.open() }, `${modKey}+F`),
      ),
      this.titleBtn,
      h(
        "div",
        { class: "group" },
        h("div", { class: "segmented", role: "group", "aria-label": "Vy" }, ...Object.values(this.viewBtns)),
        this.panelButton(this.metaDrawer, "metadata", "metadata", "Metadata: rubrik, byline, deadline och längdmål"),
        this.panelButton(this.analysisDrawer, "analys", "analysis", "Analys: LIX, statistik, citat och ordfrekvens"),
        this.aiButton,
        this.panelButton(this.historyDrawer, "historik", "history", "Versionshistorik"),
        this.charsButton,
        this.settingsButton,
        iconButton("fullscreen", "Helskärm", { onclick: () => this.toggleFullscreen() }),
      ),
    );
    this.titleBtn.addEventListener("click", () => this.renameCurrent());
    this.statusLix.addEventListener("click", () => this.toggleDrawer(this.analysisDrawer));

    const statusbar = h(
      "footer",
      { class: "chrome statusbar" },
      this.statusWords,
      this.statusChars,
      this.statusLix,
      this.statusLength,
      this.statusDeadline,
      this.statusGoal,
      this.statusSave,
    );

    root.append(
      topbar,
      this.banner,
      this.updateNotice,
      this.searchBar.el,
      h("main", { class: "page" }, host, this.footnoteList),
      statusbar,
      this.docsDrawer,
      this.historyDrawer,
      this.analysisDrawer,
      this.aiDrawer,
      this.metaDrawer,
      this.settingsPanel,
      this.charsPanel,
    );

    this.bindGlobalEvents();
    if (isTauri()) this.bindAppShell();
    this.bindDropImport();
    this.setView((localStorage.getItem(VIEW_KEY) as ViewMode) || "write", false);
  }

  // ---------------- uppstart ----------------
  async start(): Promise<void> {
    await this.loadServerSettings();
    if (!this.genres.length) this.genres = await api.genres().catch(() => []);
    void api
      .health()
      .then((h) => {
        if (h.problem) this.showProblem(h.problem);
      })
      .catch(() => undefined);
    // The Mac app can't run an outdated page – no update banner there.
    if (!isTauri()) this.watchVersion();
    void this.spell.loadDictionary();
    void this.ai.init().then((enabled) => {
      this.aiButton.hidden = !enabled;
      this.ai.monitor((available) => {
        this.aiButton.hidden = !available;
        if (!available) {
          if (this.aiDrawer.classList.contains("open")) this.closeDrawers();
          toast("AI-servern kan inte nås – AI-stödet är av tills den svarar igen");
        } else {
          toast("AI-stödet är tillgängligt igen");
        }
      });
    });
    const docs = await api.list();
    let name = localStorage.getItem(LAST_DOC_KEY);
    if (!name || !docs.some((d) => d.name === name)) name = docs[0]?.name ?? null;
    if (!name) name = (await api.create(undefined, this.newDocContent())).name;
    await this.open(name);
  }

  /** Inställningarna sparas på servern; webbläsarens kopia användes bara för snabb start. */
  private async loadServerSettings(): Promise<void> {
    try {
      if (!(await syncSettings(this.settings))) return;
    } catch {
      return; // servern svarar inte – fortsätt med webbläsarens kopia
    }
    const s = this.settings;
    applySettings(s);
    this.editor.typewriter = s.typewriter;
    this.applyLongSentences();
    if (this.spell.enabled !== s.spellcheck) {
      this.spell.enabled = s.spellcheck;
      this.spell.changed();
    }
    if (this.settingsPanel.classList.contains("open")) this.renderSettings();
  }

  // ---------------- dokument ----------------
  async open(name: string): Promise<void> {
    await this.flush();
    const doc = await api.get(name);
    if (this.current?.name !== doc.name) this.ai?.reset();
    this.current = { name: doc.name, modified: doc.modified };
    this.lastSaved = doc.content;
    this.frontmatter = splitFrontmatter(doc.content).frontmatter;
    this.editor.load(doc.content);
    this.setSaveState("saved");
    this.updateTitle();
    this.updateStats(doc.content);
    this.hideBanner();
    this.searchBar.refresh();
    const local = localCopy(doc.name);
    if (local) {
      if (local.content === doc.content) dropLocal(doc.name);
      else this.showRecover(local);
    }
    try {
      localStorage.setItem(LAST_DOC_KEY, doc.name);
    } catch {
      /* ignorera */
    }
    this.editor.focus();
  }

  private async newDocument(): Promise<void> {
    const name = await prompt("Nytt dokument", "", "Skapa");
    if (name === null) return;
    try {
      const doc = await api.create(name, this.newDocContent());
      await this.open(doc.name);
      this.closeDrawers();
    } catch (e) {
      toast(errorText(e));
    }
  }

  /** Innehåll i ett nytt dokument: texttypen från Inställningar, om en är vald. */
  private newDocContent(): string {
    const g = this.settings.defaultGenre;
    return g && this.genres.some((x) => x.key === g) ? writeMeta("", "genre", g) : "";
  }

  private genreLabel(key: string): string {
    return this.genres.find((g) => g.key === key.trim().toLowerCase())?.label ?? key;
  }

  private async renameCurrent(): Promise<void> {
    if (!this.current) return;
    const name = await prompt("Byt namn", this.current.name, "Byt namn");
    if (!name || name === this.current.name) return;
    await this.flush();
    try {
      const doc = await api.rename(this.current.name, name);
      renameTracked(this.current.name, doc.name);
      this.ai.renamed(this.current.name, doc.name);
      this.current = { name: doc.name, modified: doc.modified };
      localStorage.setItem(LAST_DOC_KEY, doc.name);
      this.updateTitle();
      if (this.docsDrawer.classList.contains("open")) this.renderDocs();
    } catch (e) {
      toast(errorText(e));
    }
  }

  private async deleteDocument(name: string): Promise<void> {
    const ok = await confirm(
      "Ta bort dokument",
      `”${name}” flyttas till papperskorgen i datamappen (.trash) och kan återskapas därifrån.`,
      "Ta bort",
      true,
    );
    if (!ok) return;
    if (this.current?.name === name) await this.flush();
    await api.remove(name);
    if (this.current?.name === name) {
      this.current = null;
      await this.start();
    }
    this.renderDocs();
  }

  // ---------------- sparning ----------------
  private onChange(): void {
    // Markdown serialiseras inte här (dyrt i långa manus) – först vid sparning.
    this.updateStats();
    this.searchBar.refresh();
    if (!this.current || this.saveState === "conflict") return;
    if (this.saveState === "error") {
      // Servern svarar inte: håll reservkopian aktuell och vänta på nästa försök.
      keepLocal({ name: this.current.name, content: this.editor.getMarkdown(), base: this.current.modified });
      return;
    }
    this.setSaveState("dirty");
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.save(), AUTOSAVE_MS);
  }

  private async save(snapshot = false, force = false): Promise<void> {
    if (!this.current) return;
    if (this.savePromise) await this.savePromise;
    window.clearTimeout(this.saveTimer);
    const content = this.editor.getMarkdown();
    if (content === this.lastSaved && !snapshot) {
      if (this.saveState !== "conflict") this.setSaveState("saved");
      return;
    }
    const cur = this.current;
    this.setSaveState("saving");
    this.savePromise = (async () => {
      try {
        const r = await api.save(cur.name, content, force ? null : cur.modified, snapshot);
        cur.modified = r.modified;
        this.lastSaved = content;
        dropLocal(cur.name);
        window.clearTimeout(this.retryTimer);
        if (this.saveErrorShown) toast("Sparat igen – servern svarar");
        this.saveErrorShown = false;
        this.setSaveState(this.editor.getMarkdown() === content ? "saved" : "dirty");
        if (snapshot) toast("Sparat – en version har lagts i historiken");
        if (this.historyDrawer.classList.contains("open")) void this.renderHistory();
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          this.setSaveState("conflict");
          this.showConflict();
        } else {
          // Behåll texten i webbläsaren och försök igen tills servern svarar.
          const kept = keepLocal({ name: cur.name, content: this.editor.getMarkdown(), base: cur.modified });
          this.setSaveState("error");
          const retryable = !(e instanceof ApiError) || e.status >= 500;
          if (!this.saveErrorShown) {
            toast(
              `Kunde inte spara: ${errorText(e)}.` +
                (kept ? " Texten finns kvar i webbläsaren." : "") +
                (retryable ? " Försöker igen." : ""),
            );
            this.saveErrorShown = true;
          }
          window.clearTimeout(this.retryTimer);
          if (retryable) this.retryTimer = window.setTimeout(() => void this.retrySave(), RETRY_MS);
        }
      } finally {
        this.savePromise = null;
      }
    })();
    await this.savePromise;
  }

  private async retrySave(): Promise<void> {
    if (this.saveState !== "error" || !this.current) return;
    // Ändringstiden kan vara inaktuell om sparningen lyckades men svaret gick förlorat.
    await this.save(false, false);
  }

  /** Text som inte hann sparas (t.ex. för att containern startades om) erbjuds tillbaka. */
  private showRecover(local: Unsaved): void {
    const name = local.name;
    this.banner.replaceChildren(
      h("span", {}, `Det finns text i ”${name}” från ${formatDate(new Date(local.time)).toLowerCase()} som inte hann sparas.`),
      h(
        "button",
        {
          onclick: () => {
            dropLocal(name);
            this.hideBanner();
          },
        },
        "Släng den",
      ),
      h(
        "button",
        {
          class: "primary",
          onclick: async () => {
            this.hideBanner();
            if (this.current?.name !== name) return;
            try {
              await api.snapshot(name, "Före återställning av osparad text");
            } catch {
              /* ingen ändring att spara – gör inget */
            }
            this.editor.load(local.content);
            this.updateStats();
            this.setSaveState("dirty");
            await this.save(false, true);
            if (this.saveState === "saved") toast("Den osparade texten är återställd – den tidigare finns i historiken");
          },
        },
        "Återställ den",
      ),
    );
    this.banner.hidden = false;
  }

  /** Spara direkt om något är osparat (inför byte av dokument m.m.). */
  private async flush(): Promise<void> {
    if (!this.current) return;
    if (this.saveState === "dirty" || this.saveState === "saving") await this.save();
  }

  private setSaveState(state: SaveState): void {
    this.saveState = state;
    const text: Record<SaveState, string> = {
      saved: "Sparat",
      dirty: "Osparade ändringar",
      saving: "Sparar …",
      error: "Inte sparat – försöker igen",
      conflict: "Konflikt",
    };
    this.statusSave.textContent = text[state];
    this.statusSave.dataset.state = state;
    this.statusSave.title =
      state === "error" ? "Servern svarar inte. Texten finns kvar i webbläsaren och sparas när servern är tillbaka." : "";
  }

  private showConflict(): void {
    this.banner.replaceChildren(
      h("span", {}, "Dokumentet har ändrats någon annanstans, t.ex. i en annan flik."),
      h(
        "button",
        {
          onclick: async () => {
            if (this.current) await this.open(this.current.name);
          },
        },
        "Ladda om (mina senaste ändringar kastas)",
      ),
      h(
        "button",
        {
          class: "primary",
          onclick: async () => {
            this.hideBanner();
            this.setSaveState("dirty");
            await this.save(true, true);
          },
        },
        "Behåll min version",
      ),
    );
    this.banner.hidden = false;
  }

  /**
   * En flik som var öppen när containern byggdes om kör fortfarande den gamla
   * koden. Kontrollera versionen när fönstret får fokus och varje minut.
   */
  private versionWatched = false;
  private watchVersion(): void {
    if (this.versionWatched) return;
    this.versionWatched = true;
    let last = 0;
    const check = async () => {
      if (Date.now() - last < 10_000) return;
      last = Date.now();
      try {
        const { version } = await api.health();
        if (version && version !== __APP_VERSION__) this.showUpdate(version);
      } catch {
        /* servern startar om – försök igen senare */
      }
    };
    window.setInterval(() => void check(), 60_000);
    window.addEventListener("focus", () => void check());
  }

  private showUpdate(version: string): void {
    if (!this.updateNotice.hidden) return;
    this.updateNotice.replaceChildren(
      h("span", {}, `Word Work har uppdaterats till ${version}. Ladda om sidan för att använda den nya versionen.`),
      h(
        "button",
        {
          class: "primary",
          onclick: async () => {
            await this.flush();
            location.reload();
          },
        },
        "Ladda om",
      ),
    );
    this.updateNotice.hidden = false;
  }

  /** Allvarligt problem (t.ex. datamappen går inte att skriva i) – visas tills det åtgärdats. */
  private showProblem(message: string): void {
    this.banner.replaceChildren(h("span", {}, message));
    this.banner.hidden = false;
  }

  private hideBanner(): void {
    this.banner.hidden = true;
  }

  // ---------------- vy & statistik ----------------
  private setView(mode: ViewMode, focus = true): void {
    this.editor.setMode(mode);
    this.frontmatter = this.editor.getFrontmatter();
    if (this.metaDrawer.classList.contains("open")) this.renderMeta();
    this.searchBar.rerun();
    this.renderFootnoteList();
    for (const [m, btn] of Object.entries(this.viewBtns)) {
      btn.setAttribute("aria-pressed", String(m === mode));
    }
    try {
      localStorage.setItem(VIEW_KEY, mode);
    } catch {
      /* ignorera */
    }
    if (focus) this.editor.focus();
  }

  private updateTitle(): void {
    const name = this.current?.name ?? "";
    this.titleBtn.textContent = name;
    document.title = name ? `${name} – Word Work` : "Word Work";
  }

  private updateStats(_md?: string): void {
    const stats = quickStats(this.editor.getPlainText());
    this.statusWords.textContent = `${stats.words.toLocaleString("sv-SE")} ord`;
    this.statusChars.textContent = `${stats.chars.toLocaleString("sv-SE")} tecken`;
    this.statusLix.textContent = stats.lix === null ? "LIX –" : `LIX ${Math.round(stats.lix)}`;
    this.statusLix.title =
      stats.lix === null ? "Läsbarhet" : `Läsbarhet: ${lixLevel(stats.lix).label.toLowerCase()} – öppna analys`;
    this.updateGoal(stats.words);
    if (this.editor.mode === "markdown") this.frontmatter = splitFrontmatter(this.editor.getMarkdown()).frontmatter;
    this.updateTargets(stats.words, stats.chars);
    this.scheduleAnalysis();
    this.renderFootnoteList();
  }

  /** Längdmål och deadline från frontmattern, i statusraden. */
  private updateTargets(words: number, chars: number): void {
    const target = parseLength(metaValue(this.frontmatter, "length"));
    this.statusLength.hidden = !target;
    if (target) {
      const have = target.unit === "ord" ? words : chars;
      const pct = Math.round((have / target.amount) * 100);
      this.statusLength.replaceChildren(
        h("span", { class: "goal-bar", "aria-hidden": "true" }, h("i", { style: `width:${Math.min(100, pct)}%` })),
        `${have.toLocaleString("sv-SE")} / ${target.amount.toLocaleString("sv-SE")} ${target.unit}`,
      );
      this.statusLength.classList.toggle("done", pct >= 95 && pct <= 105);
      this.statusLength.classList.toggle("over", pct > 105);
      this.statusLength.title =
        pct > 105
          ? `${(have - target.amount).toLocaleString("sv-SE")} ${target.unit} för långt (längdmål i Metadata)`
          : `${pct} % av längdmålet (Metadata)`;
    }
    const deadline = parseDeadline(metaValue(this.frontmatter, "deadline"));
    this.statusDeadline.hidden = !deadline;
    if (deadline) {
      const d = deadlineText(deadline);
      this.statusDeadline.textContent = `Deadline ${d.text}`;
      this.statusDeadline.dataset.level = d.level;
      this.statusDeadline.title = deadline.toLocaleString("sv-SE", { dateStyle: "full", timeStyle: "short" });
    }
  }

  // ---------------- metadata ----------------
  private metaTimer: number | undefined;

  private setMeta(key: string, value: string, multiline = false): void {
    const next = writeMeta(this.frontmatter, key, value, multiline);
    if (next === this.frontmatter) return;
    this.frontmatter = next;
    this.editor.setFrontmatter(next);
    this.updateStats();
  }

  private renderMeta(): void {
    const fm = this.frontmatter;
    const fields = readMeta(fm);
    const field = (key: string) => fields.find((f) => f.key === key);
    const multi = (key: string) => key === "ai";
    const queue = (key: string, value: () => string) => {
      window.clearTimeout(this.metaTimer);
      this.metaTimer = window.setTimeout(() => this.setMeta(key, value(), multi(key)), 350);
    };
    const flushMeta = (key: string, value: () => string) => {
      window.clearTimeout(this.metaTimer);
      this.setMeta(key, value(), multi(key));
    };

    // Texttyp
    const genreNow = metaValue(fm, "genre").trim().toLowerCase();
    const genreSel = h("select", { "aria-label": "Texttyp" }) as HTMLSelectElement;
    genreSel.append(h("option", { value: "", selected: !genreNow }, "– Ingen –"));
    for (const g of this.genres) genreSel.append(h("option", { value: g.key, selected: g.key === genreNow }, g.label));
    if (genreNow && !this.genres.some((g) => g.key === genreNow)) {
      genreSel.append(h("option", { value: genreNow, selected: true }, `${genreNow} (okänd)`));
    }
    genreSel.addEventListener("change", () => flushMeta("genre", () => genreSel.value));
    const textField = (key: string, label: string, hint: string, multiline = false, keepLines = false) => {
      const f = field(key);
      const input = h(multiline ? "textarea" : "input", {
        ...(multiline ? { rows: 3 } : { type: "text" }),
        value: f && !f.complex ? f.value : "",
        disabled: !!f?.complex,
        spellcheck: "true",
        lang: "sv",
      }) as HTMLInputElement;
      if (multiline) (input as unknown as HTMLTextAreaElement).value = f && !f.complex ? f.value : "";
      input.addEventListener("input", () => queue(key, () => input.value));
      input.addEventListener("change", () => flushMeta(key, () => input.value));
      if (keepLines) (input as unknown as HTMLTextAreaElement).rows = 5;
      return h(
        "label",
        { class: "field meta-field" },
        h("span", {}, label),
        input,
        h("small", { class: "meta" }, f?.complex ? "Flera värden – redigera i Markdown-vyn." : hint),
      );
    };

    // Deadline
    const dl = h("input", { type: "date", value: (metaValue(fm, "deadline").match(/^\d{4}-\d{2}-\d{2}/) ?? [""])[0] }) as HTMLInputElement;
    const dlInfo = h("small", { class: "meta" });
    const showDl = () => {
      const d = parseDeadline(dl.value);
      dlInfo.textContent = d ? `Deadline ${deadlineText(d).text}.` : "Visas i statusraden när den närmar sig.";
    };
    showDl();
    dl.addEventListener("change", () => {
      flushMeta("deadline", () => dl.value);
      showDl();
    });

    // Längdmål
    const target = parseLength(metaValue(fm, "length"));
    const amount = h("input", { type: "number", min: "0", step: "100", value: target ? String(target.amount) : "", "aria-label": "Längdmål" }) as HTMLInputElement;
    const unit = h("select", { "aria-label": "Enhet" }) as HTMLSelectElement;
    for (const [v, l] of [["tecken", "tecken inkl. blanksteg"], ["ord", "ord"]] as const) {
      unit.append(h("option", { value: v, selected: (target?.unit ?? "tecken") === v }, l));
    }
    const lengthValue = () => {
      const n = Math.round(Number(amount.value));
      return n > 0 ? formatLength({ amount: n, unit: unit.value as LengthUnit }) : "";
    };
    amount.addEventListener("input", () => queue("length", lengthValue));
    amount.addEventListener("change", () => flushMeta("length", lengthValue));
    unit.addEventListener("change", () => flushMeta("length", lengthValue));

    const others = fields.filter((f) => !(META_FIELDS as readonly string[]).includes(f.key));
    this.metaDrawer.replaceChildren(
      h("div", { class: "drawer-head" }, this.closeButton(), h("h2", {}, "Metadata")),
      h(
        "p",
        { class: "meta" },
        "Sparas som frontmatter först i filen. Syns inte i Skriv-vyn och räknas inte i ord eller tecken.",
      ),
      h(
        "div",
        { class: "meta-form" },
        textField("title", "Rubrik", "Blir dokumenttitel vid export till Word, OpenDocument och HTML."),
        textField("lead", "Ingress", "För planering och AI-assistenten – följer inte med som text.", true),
        textField("author", "Byline", "Författare i dokumentegenskaperna vid export."),
        textField("client", "Beställare", "Till exempel redaktion eller publikation."),
        h(
          "label",
          { class: "field meta-field" },
          h("span", {}, "Texttyp"),
          genreSel,
          h("small", { class: "meta" }, "AI-assistenten anpassar sina råd efter texttypen – prosa granskas inte som en nyhetsartikel."),
        ),
        textField(
          "ai",
          "Instruktioner till AI",
          "Till exempel: ”Romanen utspelar sig på 1890-talet – ålderdomliga ord är avsiktliga.” AI:n följer dem, men skriver aldrig om din text.",
          true,
          true,
        ),
        h("label", { class: "field meta-field" }, h("span", {}, "Deadline"), dl, dlInfo),
        h(
          "div",
          { class: "field meta-field" },
          h("span", {}, "Längdmål"),
          h("div", { class: "row" }, amount, unit),
          h("small", { class: "meta" }, "Visas som en mätare i statusraden."),
        ),
      ),
      others.length
        ? h(
            "section",
            { class: "meta-others" },
            h("h3", {}, "Övriga fält"),
            h(
              "dl",
              {},
              ...others.flatMap((f) => [h("dt", {}, f.key), h("dd", {}, f.complex ? "(flera värden)" : f.value || "–")]),
            ),
            h("p", { class: "meta" }, `Redigeras i Markdown-vyn (${modKey}+/).`),
          )
        : "",
    );
  }

  private updateGoal(words: number): void {
    const goal = this.settings.dailyGoal;
    if (!this.current) return;
    const written = trackWords(this.current.name, words);
    this.statusGoal.hidden = !goal;
    if (!goal) return;
    const pct = Math.min(100, Math.round((written / goal) * 100));
    const done = written >= goal;
    this.statusGoal.replaceChildren(
      h("span", { class: "goal-bar", "aria-hidden": "true" }, h("i", { style: `width:${pct}%` })),
      done
        ? `Dagens mål nått: ${written.toLocaleString("sv-SE")} ord`
        : `${written.toLocaleString("sv-SE")} / ${goal.toLocaleString("sv-SE")} ord i dag`,
    );
    this.statusGoal.classList.toggle("done", done);
    this.statusGoal.title = "Skrivna ord i dag, i alla dokument. Målet ställs in under Inställningar.";
  }

  private showShortcuts(): void {
    this.closeDrawers();
    const rows: [string, string][] = [
      [`${modKey}+S`, "Spara och skapa en version i historiken"],
      [`${modKey}+/`, "Växla mellan Skriv och Markdown"],
      [`${modKey}+O`, "Dokumentlistan"],
      [`${modKey}+E`, "Exportera"],
      [`${modKey}+Shift+C`, "Kopiera texten för publicering (HTML och ren text)"],
      [`${modKey}+F / ${modKey}+Alt+F`, "Sök / sök och ersätt"],
      [`${modKey}+Alt+M`, "Gör stycket till en egen anteckning (följer inte med vid export)"],
      [`${modKey}+Alt+K`, "Kommentera markerad text (följer inte med vid export)"],
      [`${modKey}+Alt+N`, "Infoga fotnot (blir en riktig fotnot vid export)"],
      [`Enter / Shift+Enter, ${modKey}+G`, "Nästa / föregående träff"],
      [`${modKey}+J`, "AI-assistent"],
      [`${modKey}+.`, "Infoga tecken (citattecken, tankstreck m.m.)"],
      ['" \' -- ... 12-15', "Blir ” ’ – … 12–15 automatiskt (Backsteg ångrar)"],
      [`${modKey}+B / ${modKey}+I`, "Fetstil / kursiv (Skriv-vyn)"],
      [`${modKey}+Z / ${modKey}+Shift+Z`, "Ångra / gör om"],
      ["# + mellanslag", "Rubrik (## för underrubrik)"],
      ["> + mellanslag", "Citat"],
      ["- + mellanslag", "Punktlista (1. för numrerad)"],
      ["Högerklick", "Stavningsförslag, egen ordlista och synonymer"],
      ["Shift+högerklick", "Webbläsarens vanliga meny"],
      ["F1", "Den här listan"],
      ["Esc", "Stäng paneler och dialoger"],
      // Mac app only: from the menu bar.
      ...(isTauri()
        ? ([
            [`${modKey}+N`, "Nytt dokument"],
            [`${modKey}+Shift+O`, "Importera"],
            [`${modKey}+,`, "Inställningar"],
            [modKey === "⌘" ? "⌃⌘F" : "F11", "Helskärm"],
            [`${modKey}+Q`, "Avsluta (texten sparas först)"],
          ] as [string, string][])
        : []),
    ];
    void showModal((close) =>
      h(
        "div",
        { class: "shortcuts" },
        h("h2", {}, "Kortkommandon"),
        h(
          "table",
          {},
          h(
            "tbody",
            {},
            ...rows.map(([k, v]) => h("tr", {}, h("td", {}, h("kbd", {}, k)), h("td", {}, v))),
          ),
        ),
        h("div", { class: "actions" }, h("button", { class: "primary", onclick: close }, "Stäng")),
      ),
    );
  }

  // ---------------- lådor & paneler ----------------
  /** Knapp som öppnar/stänger en låda, med aria-expanded/aria-controls. */
  private panelButton(drawer: HTMLElement, key: string, iconName: IconName, label: string, shortcut = ""): HTMLButtonElement {
    drawer.id ||= `panel-${key}`;
    return iconButton(
      iconName,
      label,
      { onclick: () => this.toggleDrawer(drawer), "aria-controls": drawer.id, "aria-expanded": "false" },
      shortcut,
    );
  }

  /** Håller aria-expanded i synk med vilka paneler som är öppna. */
  private syncExpanded(): void {
    for (const btn of document.querySelectorAll<HTMLElement>("[aria-controls]")) {
      const panel = document.getElementById(btn.getAttribute("aria-controls") ?? "");
      if (panel) btn.setAttribute("aria-expanded", String(panel.classList.contains("open")));
    }
  }

  private toggleDrawer(drawer: HTMLElement): void {
    const open = !drawer.classList.contains("open");
    this.closeDrawers();
    if (open) {
      drawer.classList.add("open");
      document.body.dataset.drawer = drawer.classList.contains("left") ? "left" : "right";
      let ready: Promise<void> | void;
      if (drawer === this.docsDrawer) ready = this.renderDocs();
      else if (drawer === this.analysisDrawer) ready = this.renderAnalysis();
      else if (drawer === this.aiDrawer) ready = this.ai.render().then(() => this.ai.focusInput());
      else if (drawer === this.metaDrawer) ready = this.renderMeta();
      else ready = this.renderHistory();
      // Flytta fokus in i panelen så att den går att använda med tangentbordet.
      if (drawer !== this.aiDrawer) {
        void Promise.resolve(ready).then(() => {
          const target =
            drawer.querySelector<HTMLElement>(".list li.active .item, .list .item, .freq button") ??
            drawer.querySelector<HTMLElement>("button, input, select, textarea");
          target?.focus({ preventScroll: true });
        });
      }
    } else {
      this.editor.focus();
    }
    this.syncExpanded();
  }

  private closeDrawers(): void {
    delete document.body.dataset.drawer;
    this.docsDrawer.classList.remove("open");
    this.historyDrawer.classList.remove("open");
    this.aiDrawer.classList.remove("open");
    this.metaDrawer.classList.remove("open");
    this.settingsPanel.classList.remove("open");
    this.charsPanel.classList.remove("open");
    if (this.analysisDrawer.classList.contains("open")) {
      this.analysisDrawer.classList.remove("open");
      this.setHighlight(null);
    }
    this.syncExpanded();
  }

  private async renderDocs(): Promise<void> {
    await this.flush();
    const docs = await api.list();
    const list = h("ul", { class: "list" });
    for (const d of docs) {
      const active = d.name === this.current?.name;
      list.append(
        h(
          "li",
          { class: active ? "active" : "" },
          h(
            "button",
            {
              class: "item",
              onclick: async () => {
                await this.open(d.name);
                this.closeDrawers();
              },
            },
            h("span", { class: "name" }, d.name),
            h(
              "span",
              { class: "meta" },
              `${d.words.toLocaleString("sv-SE")} ord · ${formatDate(new Date(d.modified * 1000))}`,
            ),
          ),
          h(
            "button",
            {
              class: "icon",
              title: `Ta bort ”${d.name}”`,
              "aria-label": `Ta bort ${d.name}`,
              onclick: () => this.deleteDocument(d.name),
            },
            "×",
          ),
        ),
      );
    }
    this.docsDrawer.replaceChildren(
      h(
        "div",
        { class: "drawer-head" },
        this.closeButton(),
        h("h2", {}, "Dokument"),
        h("button", { onclick: () => this.chooseImport(), title: "Importera DOCX, ODT, RTF, HTML, Markdown eller text" }, "Importera …"),
        h("button", { onclick: () => this.newDocument() }, "Nytt"),
      ),
      list,
      h("p", { class: "meta hint-drop" }, "Du kan också släppa filer var som helst i fönstret för att importera dem."),
      h(
        "div",
        { class: "drawer-foot" },
        h("button", { class: "link", onclick: () => this.showTrash() }, "Papperskorgen …"),
        h(
          "button",
          {
            class: "link",
            title: "Alla dokument, versioner, AI-samtal, papperskorgen och inställningar i en zip-fil",
            onclick: async () => {
              await this.flush();
              await this.download("/api/backup", isTauri() ? "Sparade" : "Laddade ner");
            },
          },
          isTauri() ? "Spara allt (zip) …" : "Ladda ner allt (zip)",
        ),
      ),
    );
  }

  private async renderHistory(): Promise<void> {
    if (!this.current) return;
    const name = this.current.name;
    await this.flush();
    const versions = await api.history(name);
    const list = h("ul", { class: "list" });
    if (!versions.length) {
      list.append(
        h("li", { class: "empty" }, `Inga versioner ännu. Tryck ${modKey}+S för att spara en.`),
      );
    }
    for (const v of versions) {
      list.append(
        h(
          "li",
          {},
          h(
            "button",
            { class: "item", onclick: () => this.previewVersion(name, v) },
            h("span", { class: "name" }, v.label || formatDate(new Date(v.created))),
            h(
              "span",
              { class: "meta" },
              `${v.label ? formatDate(new Date(v.created)) + " · " : ""}${KIND_LABEL[v.kind]} · ${v.words.toLocaleString("sv-SE")} ord`,
            ),
          ),
        ),
      );
    }
    this.historyDrawer.replaceChildren(
      h(
        "div",
        { class: "drawer-head" },
        this.closeButton(),
        h("h2", {}, "Historik"),
        h(
          "button",
          {
            onclick: async () => {
              const label = await prompt("Spara namngiven version", "", "Spara");
              if (label === null) return;
              await this.save();
              await api.snapshot(name, label);
              toast(`Versionen ”${label}” är sparad`);
              void this.renderHistory();
            },
          },
          "Spara version …",
        ),
      ),
      list,
    );
  }

  private async previewVersion(name: string, v: Version): Promise<void> {
    const { content } = await api.version(name, v.id);
    const current = this.editor.getMarkdown();
    let showDiff = false;
    const body = h("div", { class: "preview" });
    const render = () => {
      body.replaceChildren();
      if (!showDiff) {
        body.textContent = content;
        return;
      }
      // Grön = finns i nuvarande text men inte i versionen; röd = finns bara i versionen.
      for (const part of diffWords(content, current)) {
        const tag = part.added ? "ins" : part.removed ? "del" : "span";
        body.append(h(tag, {}, part.value));
      }
    };
    render();
    await showModal((close) => {
      const diffBtn = h(
        "button",
        {
          onclick: () => {
            showDiff = !showDiff;
            diffBtn.textContent = showDiff ? "Visa versionen" : "Jämför med nuvarande";
            render();
          },
        },
        "Jämför med nuvarande",
      );
      return h(
        "div",
        { class: "version-modal" },
        h("h2", {}, v.label || formatDate(new Date(v.created))),
        h(
          "p",
          { class: "meta" },
          `${formatDate(new Date(v.created))} · ${KIND_LABEL[v.kind]} · ${v.words.toLocaleString("sv-SE")} ord`,
        ),
        body,
        h(
          "div",
          { class: "actions" },
          diffBtn,
          h("span", { class: "spacer" }),
          h("button", { onclick: close }, "Stäng"),
          h(
            "button",
            {
              class: "primary",
              onclick: async () => {
                await this.save();
                const r = await api.restore(name, v.id);
                if (this.current?.name === name) {
                  this.current.modified = r.modified;
                  this.lastSaved = r.content;
                  this.editor.load(r.content);
                  this.updateStats(r.content);
                  this.setSaveState("saved");
                }
                close();
                toast("Versionen är återställd. Den tidigare texten finns kvar i historiken.");
                void this.renderHistory();
              },
            },
            "Återställ den här versionen",
          ),
        ),
      );
    });
  }

  // ---------------- analys ----------------
  private scheduleAnalysis(): void {
    if (!this.analysisDrawer.classList.contains("open")) return;
    window.clearTimeout(this.analysisTimer);
    this.analysisTimer = window.setTimeout(() => this.renderAnalysis(), 300);
  }

  private setHighlight(word: string | null): void {
    this.highlighted = word;
    if (word && this.editor.mode !== "write") this.setView("write", false);
    this.editor.highlight(word);
  }

  private renderAnalysis(): void {
    // En markering räknas först när den är minst några ord (inte bara ett markerat ord).
    const sel = this.editor.getSelectionText();
    const selection = (sel.match(/\S+/g)?.length ?? 0) >= 3 ? sel : "";
    const text = selection || this.editor.getPlainText();
    const st: TextStats = analyze(text, { includeStopwords: this.includeStopwords, top: 40 });
    const nf = (n: number, d = 0) =>
      n.toLocaleString("sv-SE", { minimumFractionDigits: d, maximumFractionDigits: d });

    const row = (label: string, value: string, hint = "") =>
      h("div", { class: "stat", title: hint }, h("span", {}, label), h("strong", {}, value));

    // LIX-mätare
    let lixBlock: HTMLElement;
    if (st.lix === null) {
      lixBlock = h("p", { class: "meta" }, "Skriv några meningar så räknas LIX ut.");
    } else {
      const level = lixLevel(st.lix);
      const pct = Math.min(100, Math.max(0, ((st.lix - 15) / (70 - 15)) * 100));
      lixBlock = h(
        "div",
        { class: "lix" },
        h(
          "div",
          { class: "lix-head" },
          h("span", { class: "lix-value" }, nf(st.lix)),
          h("span", {}, h("strong", {}, level.label), h("br", {}), h("span", { class: "meta" }, level.example)),
        ),
        h(
          "div",
          { class: "lix-scale", role: "img", "aria-label": `LIX ${nf(st.lix)} – ${level.label}` },
          ...LIX_SCALE.map((l) => h("span", { class: l === level ? "on" : "" })),
          h("i", { style: `left:${pct}%` }),
        ),
        h(
          "div",
          { class: "lix-labels" },
          ...["25", "30", "40", "50", "60"].map((t) => h("span", {}, t)),
        ),
      );
    }

    const freqList = h("ol", { class: "freq" });
    const maxCount = st.frequency[0]?.count ?? 1;
    for (const f of st.frequency) {
      const active = this.highlighted === f.word;
      freqList.append(
        h(
          "li",
          {},
          h(
            "button",
            {
              class: active ? "active" : "",
              title: active ? "Ta bort markering" : "Markera i texten",
              onclick: () => {
                this.setHighlight(active ? null : f.word);
                this.renderAnalysis();
              },
            },
            h("span", { class: "bar", style: `width:${(f.count / maxCount) * 100}%` }),
            h("span", { class: "w" }, f.word),
            h("span", { class: "c" }, String(f.count)),
          ),
        ),
      );
    }

    const sentenceList = h("ol", { class: "sentences" });
    for (const s of st.longestSentences) {
      sentenceList.append(
        h(
          "li",
          {},
          h(
            "button",
            {
              title: "Visa i texten",
              onclick: () => {
                if (this.editor.mode !== "write") this.setView("write", false);
                this.editor.selectText(s.text);
              },
            },
            h("span", { class: "c" }, `${s.words} ord`),
            h("span", { class: "t" }, s.text.length > 140 ? `${s.text.slice(0, 140)} …` : s.text),
          ),
        ),
      );
    }

    // Nominalstil
    const nominal = nominalStyle(text);
    const nominalList = h("ol", { class: "freq nominal" });
    const maxNom = nominal.top[0]?.count ?? 1;
    for (const f of nominal.top) {
      const active = this.highlighted === f.word;
      nominalList.append(
        h(
          "li",
          {},
          h(
            "button",
            {
              class: active ? "active" : "",
              title: active ? "Ta bort markering" : "Markera i texten",
              onclick: () => {
                this.setHighlight(active ? null : f.word);
                this.renderAnalysis();
              },
            },
            h("span", { class: "bar", style: `width:${(f.count / maxNom) * 100}%` }),
            h("span", { class: "w" }, f.word),
            h("span", { class: "c" }, String(f.count)),
          ),
        ),
      );
    }

    // Långa meningar i texten
    const longInput = h("input", {
      type: "number",
      min: "10",
      max: "80",
      value: String(this.settings.longSentenceWords),
      "aria-label": "Antal ord",
      class: "tiny",
      onchange: (e: Event) => {
        const n = Math.min(80, Math.max(10, Math.round(Number((e.target as HTMLInputElement).value)) || 30));
        this.settings.longSentenceWords = n;
        saveSettings(this.settings);
        this.applyLongSentences();
      },
    });
    const longToggle = h(
      "label",
      { class: "check small" },
      h("input", {
        type: "checkbox",
        checked: this.settings.markLongSentences,
        onchange: (e: Event) => {
          this.settings.markLongSentences = (e.target as HTMLInputElement).checked;
          saveSettings(this.settings);
          this.applyLongSentences();
          if (this.settings.markLongSentences && this.editor.mode !== "write") toast("Markeringen syns i Skriv-vyn");
        },
      }),
      h("span", {}, "Markera meningar längre än "),
      longInput,
      h("span", {}, " ord i texten"),
    );

    // Kommentarer (alltid hela texten)
    const comments = listComments(this.editor.getMarkdown());
    const commentList = h("ol", { class: "quotes comments" });
    for (const c of comments) {
      commentList.append(
        h(
          "li",
          {},
          h(
            "button",
            {
              title: "Visa i texten",
              onclick: () => {
                if (this.editor.mode !== "write") this.setView("write", false);
                if (!this.editor.selectText(c.quote)) toast("Hittade inte stället i texten");
              },
            },
            h("span", { class: "c" }, `”${c.quote.length > 60 ? c.quote.slice(0, 60) + " …" : c.quote}”`),
            h("span", { class: "t" }, c.text),
          ),
        ),
      );
    }

    // Citat
    const quotes = findQuotes(text);
    const quoteList = h("ol", { class: "quotes" });
    for (const q of quotes) {
      quoteList.append(
        h(
          "li",
          {},
          h(
            "button",
            {
              title: "Visa i texten",
              onclick: () => {
                if (this.editor.mode !== "write") this.setView("write", false);
                if (!this.editor.selectText(q.text)) toast("Hittade inte citatet i texten");
              },
            },
            h("span", { class: "c" }, q.kind === "replik" ? "Replik" : "Citat"),
            h("span", { class: "t" }, q.text.length > 160 ? `${q.text.slice(0, 160)} …` : q.text),
          ),
        ),
      );
    }
    const copyQuotes = h(
      "button",
      {
        class: "link",
        title: "Kopiera alla citat som en numrerad lista, för avstämning mot källor",
        onclick: async () => {
          const list = quotes.map((q, i) => `${i + 1}. ${q.text}`).join("\n");
          try {
            await navigator.clipboard.writeText(`${list}\n`);
            toast(`Kopierade ${quotes.length} citat`);
          } catch (e) {
            toast(`Kunde inte kopiera: ${errorText(e)}`);
          }
        },
      },
      "Kopiera listan",
    );

    const stopToggle = h(
      "label",
      { class: "check small" },
      h("input", {
        type: "checkbox",
        checked: this.includeStopwords,
        onchange: (e: Event) => {
          this.includeStopwords = (e.target as HTMLInputElement).checked;
          this.renderAnalysis();
        },
      }),
      h("span", {}, "Visa småord"),
    );

    const scrollTop = this.analysisDrawer.scrollTop;
    this.analysisDrawer.replaceChildren(
      h(
        "div",
        { class: "drawer-head" },
        this.closeButton(),
        h("h2", {}, "Analys"),
        h("span", { class: "meta scope" }, selection ? "Markerad text" : "Hela texten"),
      ),
      h("section", {}, h("h3", {}, "Läsbarhet (LIX)"), lixBlock),
      h(
        "section",
        { class: "grid" },
        row("Ord", nf(st.words)),
        row("Unika ord", nf(st.uniqueWords)),
        row("Meningar", nf(st.sentences)),
        row("Stycken", nf(st.paragraphs)),
        row("Tecken", nf(st.chars)),
        row("Utan blanksteg", nf(st.charsNoSpaces)),
        row("Ord per mening", nf(st.avgSentenceLength, 1)),
        row("Bokstäver per ord", nf(st.avgWordLength, 1)),
        row("Långa ord", st.words ? `${nf((st.longWords / st.words) * 100)} %` : "–", "Ord med fler än sex bokstäver"),
        row(
          "OVIX",
          st.ovix === null ? "–" : nf(st.ovix, 0),
          "Ordvariationsindex – högre värde betyder mer varierat ordförråd",
        ),
        row("Lästid", st.readingMinutes < 1 ? "< 1 min" : `${nf(Math.round(st.readingMinutes))} min`),
      ),
      h(
        "section",
        {},
        h("div", { class: "section-head" }, h("h3", {}, "Vanligaste orden"), stopToggle),
        st.frequency.length ? freqList : h("p", { class: "meta" }, "Inga ord ännu."),
        h("p", { class: "meta" }, "Klicka på ett ord för att markera alla förekomster i texten."),
      ),
      h(
        "section",
        {},
        h("h3", {}, "Längsta meningarna"),
        st.longestSentences.length ? sentenceList : h("p", { class: "meta" }, "Inga meningar ännu."),
        longToggle,
      ),
      h(
        "section",
        {},
        h("h3", {}, "Nominalstil"),
        st.words
          ? h(
              "p",
              { class: "nominal-sum", title: "Substantiv bildade av verb och adjektiv, t.ex. utredning, möjlighet, händelse, information" },
              h("strong", {}, nf(nominal.per100, 1)),
              ` substantiveringar per 100 ord – ${nominalLevel(nominal.per100).toLowerCase()}`,
            )
          : h("p", { class: "meta" }, "Inga ord ännu."),
        nominal.top.length ? nominalList : "",
        h(
          "p",
          { class: "meta" },
          "Ord på -ning, -het, -else, -tion och -itet. Många sådana gör texten tung – skriv om med verb: ”genomförde en utredning” → ”utredde”. Siffran är en grov uppskattning, inte en nominalkvot (den kräver ordklassanalys).",
        ),
      ),
      h(
        "section",
        {},
        h("h3", {}, `Kommentarer${comments.length ? ` (${comments.length})` : ""}`),
        comments.length
          ? commentList
          : h("p", { class: "meta" }, `Inga kommentarer. Markera ord och tryck ${modKey}+Alt+K, eller högerklicka och välj Kommentera …`),
      ),
      h(
        "section",
        {},
        h(
          "div",
          { class: "section-head" },
          h("h3", {}, `Citat och repliker${quotes.length ? ` (${quotes.length})` : ""}`),
          quotes.length ? copyQuotes : "",
        ),
        quotes.length
          ? quoteList
          : h("p", { class: "meta" }, "Inga citat ännu. Citat inom citattecken (minst tre ord) och stycken som börjar med pratminus listas här."),
      ),
    );
    this.analysisDrawer.scrollTop = scrollTop;
  }

  // ---------------- kommentarer ----------------
  private commentBubble: HTMLElement | null = null;

  /** Lägg till eller ändra en kommentar – på intervallet, eller på markeringen/kommentaren vid markören. */
  private async editComment(from?: number, to?: number): Promise<void> {
    this.closeCommentBubble();
    let target: { from: number; to: number; text: string; quote: string } | null;
    if (from !== undefined && to !== undefined) {
      const existing = this.editor.commentAtPos(from);
      target =
        existing && existing.from === from && existing.to === to
          ? existing
          : { from, to, text: "", quote: this.editor.getSelectionText() };
    } else {
      target = this.editor.commentTarget();
    }
    if (!target) {
      toast("Markera ett eller flera ord (i samma stycke) som du vill kommentera");
      return;
    }
    const quote = target.quote.length > 60 ? `${target.quote.slice(0, 60)} …` : target.quote;
    const text = await prompt(quote ? `Kommentar till ”${quote}”` : "Kommentar", target.text, target.text ? "Spara" : "Lägg till");
    if (text === null) return;
    if (!text.trim()) {
      if (target.text) this.editor.removeComment(target.from, target.to);
      return;
    }
    this.editor.setComment(target.from, target.to, text);
  }

  private showCommentBubble(c: { from: number; to: number; text: string }, rect: DOMRect): void {
    this.closeCommentBubble();
    const bubble = h(
      "div",
      { class: "comment-bubble", role: "dialog", "aria-label": "Kommentar" },
      h("p", {}, c.text || "(tom kommentar)"),
      h(
        "div",
        { class: "actions" },
        h("button", { class: "link", onclick: () => void this.editComment(c.from, c.to) }, "Ändra"),
        h(
          "button",
          {
            class: "link",
            onclick: () => {
              this.editor.removeComment(c.from, c.to);
              this.closeCommentBubble();
            },
          },
          "Ta bort",
        ),
      ),
    );
    document.body.append(bubble);
    const left = Math.min(Math.max(8, rect.left + window.scrollX), window.scrollX + window.innerWidth - bubble.offsetWidth - 8);
    bubble.style.left = `${left}px`;
    bubble.style.top = `${rect.bottom + window.scrollY + 6}px`;
    this.commentBubble = bubble;
  }

  private closeCommentBubble(): void {
    this.commentBubble?.remove();
    this.commentBubble = null;
  }

  // ---------------- fotnoter ----------------
  private footnoteList = h("section", { class: "footnote-list", "aria-label": "Fotnoter", hidden: true });
  private footnoteKey = "";

  /** Ny fotnot vid markören (pos = null) eller ändra fotnoten på positionen. */
  private async editFootnote(pos: number | null): Promise<void> {
    this.closeCommentBubble();
    const existing = pos === null ? null : this.editor.footnoteAtPos(pos);
    if (pos === null && !this.editor.canInsertFootnote()) {
      toast("Fotnoter kan inte läggas i egna anteckningar eller kodblock");
      return;
    }
    const at = this.editor.footnoteInsertPoint();
    let text = await promptText(
      existing ? `Fotnot ${existing.number}` : "Ny fotnot",
      existing?.text ?? "",
      existing ? "Spara" : "Infoga",
      "Enter sparar, Shift+Enter ger ny rad. *Kursiv* för verktitlar fungerar.",
    );
    if (text === null) return;
    // Samma typografi som i texten: ”citat”, tankstreck och ellips.
    if (text && this.settings.autoTypography) text = fixTypography(text, this.settings.quoteStyle).text;
    if (existing) {
      if (text) this.editor.setFootnoteText(existing.pos, text);
      else this.editor.removeFootnote(existing.pos);
    } else if (text) {
      this.editor.insertFootnote(text, at);
    }
  }

  private showFootnoteBubble(f: FootnoteAt, rect: DOMRect): void {
    this.closeCommentBubble();
    const text = h("p", {});
    text.innerHTML = inlineMarkdown(f.text);
    const bubble = h(
      "div",
      { class: "comment-bubble footnote-bubble", role: "dialog", "aria-label": `Fotnot ${f.number}` },
      h("div", { class: "bubble-title" }, `Fotnot ${f.number}`),
      text,
      h(
        "div",
        { class: "actions" },
        h("button", { class: "link", onclick: () => void this.editFootnote(f.pos) }, "Ändra"),
        h(
          "button",
          {
            class: "link",
            onclick: () => {
              this.editor.removeFootnote(f.pos);
              this.closeCommentBubble();
            },
          },
          "Ta bort",
        ),
      ),
    );
    document.body.append(bubble);
    const left = Math.min(Math.max(8, rect.left + window.scrollX - 12), window.scrollX + window.innerWidth - bubble.offsetWidth - 8);
    bubble.style.left = `${left}px`;
    bubble.style.top = `${rect.bottom + window.scrollY + 6}px`;
    this.commentBubble = bubble;
  }

  /** Fotnoterna under texten i Skriv-vyn, som på en boksida. Klick visar fotnoten i texten. */
  private renderFootnoteList(): void {
    const notes = this.editor.mode === "write" ? this.editor.footnotes() : [];
    const key = JSON.stringify(notes.map((n) => n.text));
    if (key === this.footnoteKey) return;
    this.footnoteKey = key;
    this.footnoteList.hidden = notes.length === 0;
    const items = notes.map((n, i) => {
      const li = h("li", { tabindex: "0", title: "Visa i texten" });
      li.innerHTML = inlineMarkdown(n.text);
      const open = () => {
        const f = this.editor.footnotes()[i];
        if (!f) return;
        const el = document.querySelectorAll(".prose .ww-footnote")[i];
        el?.scrollIntoView({ block: "center" });
        if (el) this.showFootnoteBubble(f, el.getBoundingClientRect());
      };
      li.addEventListener("click", open);
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter") open();
      });
      return li;
    });
    this.footnoteList.replaceChildren(h("h2", {}, "Fotnoter"), h("ol", {}, ...items));
  }

  /** Egen anteckning: gör om stycket i Skriv-vyn, infoga en kommentar i Markdown-vyn. */
  private toggleNote(): void {
    if (this.editor.mode === "write") this.editor.toggleNote();
    else this.editor.insertText("<!-- anteckning -->");
  }

  private applyLongSentences(): void {
    const s = this.settings;
    this.editor.markLongSentences(s.markLongSentences ? Math.max(10, s.longSentenceWords) : 0);
  }

  private closeButton(): HTMLElement {
    return h(
      "button",
      {
        class: "icon close",
        title: "Stäng (Esc)",
        "aria-label": "Stäng",
        onclick: () => {
          this.closeDrawers();
          this.editor.focus();
        },
      },
      "×",
    );
  }

  private async showDictionary(): Promise<void> {
    this.closeDrawers();
    let words = (await api.dictionary()).words;
    let filter = "";
    let textMode = false;

    const apply = (ws: string[]) => {
      words = ws;
      this.spell.reload(ws);
    };

    await showModal((close) => {
      const body = h("div", { class: "dict-body" });
      const count = h("span", { class: "meta" });
      const modeBtn = h("button", { class: "link" });

      const renderList = () => {
        const q = filter.toLocaleLowerCase("sv");
        const shown = q ? words.filter((w) => w.toLocaleLowerCase("sv").includes(q)) : words;
        count.textContent = `${words.length} ${words.length === 1 ? "post" : "poster"}`;
        const list = h("ul", { class: "list dict" });
        if (!shown.length) {
          list.append(
            h(
              "li",
              { class: "empty" },
              words.length
                ? "Inget matchar sökningen."
                : "Ordlistan är tom. Högerklicka på ett understruket ord – eller markera flera ord – för att lägga till.",
            ),
          );
        }
        for (const w of shown) {
          const li = h("li", {});
          const label = h(
            "button",
            { class: "item editable", title: "Klicka för att redigera" },
            h("span", {}, w),
            w.includes(" ") ? h("span", { class: "tag" }, "fras") : null,
          );
          const startEdit = () => {
            const input = h("input", { type: "text", value: w, "aria-label": `Redigera ${w}` }) as HTMLInputElement;
            let done = false;
            const save = async () => {
              if (done) return;
              done = true;
              const next = input.value.trim().split(/\s+/).join(" ");
              if (!next || next === w) return renderList();
              try {
                apply((await api.dictionaryRename(w, next)).words);
                renderList();
              } catch (e) {
                done = false;
                toast(errorText(e));
                input.focus();
              }
            };
            input.addEventListener("keydown", (e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void save();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                done = true;
                renderList();
              }
            });
            input.addEventListener("blur", () => void save());
            li.replaceChildren(input);
            input.focus();
            input.select();
          };
          label.addEventListener("click", startEdit);
          li.append(
            label,
            h(
              "button",
              {
                class: "icon",
                title: `Ta bort ”${w}”`,
                "aria-label": `Ta bort ${w}`,
                onclick: async () => {
                  apply((await api.dictionaryRemove(w)).words);
                  renderList();
                },
              },
              "×",
            ),
          );
          list.append(li);
        }

        const search = h("input", {
          type: "search",
          placeholder: "Sök i ordlistan",
          "aria-label": "Sök i ordlistan",
          value: filter,
          oninput: (e: Event) => {
            filter = (e.target as HTMLInputElement).value;
            const pos = (e.target as HTMLInputElement).selectionStart;
            renderList();
            const again = body.querySelector<HTMLInputElement>("input[type=search]");
            again?.focus();
            if (pos !== null) again?.setSelectionRange(pos, pos);
          },
        }) as HTMLInputElement;

        const addInput = h("input", {
          type: "text",
          placeholder: "Nytt ord eller fras, t.ex. open source",
          "aria-label": "Nytt ord eller fras",
        }) as HTMLInputElement;
        const form = h("form", { class: "dict-add" }, addInput, h("button", { type: "submit" }, "Lägg till"));
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const entry = addInput.value.trim().split(/\s+/).join(" ");
          if (!entry) return;
          try {
            apply((await api.dictionaryAdd(entry)).words);
            filter = "";
            renderList();
            body.querySelector<HTMLInputElement>(".dict-add input")?.focus();
          } catch (err) {
            toast(errorText(err));
          }
        });

        body.replaceChildren(form, words.length > 8 ? search : "", list);
        modeBtn.textContent = "Redigera som text …";
      };

      const renderText = () => {
        const ta = h("textarea", {
          class: "dict-text",
          rows: 14,
          spellcheck: "false",
          "aria-label": "Egen ordlista, en post per rad",
        }) as HTMLTextAreaElement;
        ta.value = words.join("\n");
        const saveBtn = h(
          "button",
          {
            class: "primary",
            onclick: async () => {
              try {
                apply((await api.dictionaryReplace(ta.value.split("\n"))).words);
                textMode = false;
                render();
                toast("Ordlistan är sparad");
              } catch (e) {
                toast(errorText(e));
              }
            },
          },
          "Spara listan",
        );
        body.replaceChildren(
          h("p", { class: "meta" }, "En post per rad. Ett ord eller en fras på högst sex ord. Tomma rader ignoreras."),
          ta,
          h("div", { class: "actions" }, h("button", { onclick: () => ((textMode = false), render()) }, "Avbryt"), saveBtn),
        );
        modeBtn.textContent = "Visa som lista";
        ta.focus();
      };

      const render = () => (textMode ? renderText() : renderList());
      modeBtn.addEventListener("click", () => {
        textMode = !textMode;
        render();
      });
      render();

      return h(
        "div",
        { class: "dict-modal" },
        h("div", { class: "dict-head" }, h("h2", {}, "Egen ordlista"), count),
        h(
          "p",
          { class: "meta" },
          "Ord här godkänns av stavningskontrollen. En fras (t.ex. ”open source”) godkänns bara när orden står tillsammans. Klicka på en post för att ändra den. Listan sparas i datamappen (.wordwork/ordlista.txt) och kan också redigeras där.",
        ),
        body,
        h("div", { class: "actions" }, modeBtn, h("span", { class: "spacer" }), h("button", { class: "primary", onclick: close }, "Klar")),
      );
    });
  }

  // ---------------- import & export ----------------
  private async showExport(): Promise<void> {
    if (!this.current) return;
    this.closeDrawers();
    await this.flush();
    const name = this.current.name;
    let opts;
    try {
      opts = await api.exportOptions();
    } catch (e) {
      toast(errorText(e));
      return;
    }
    const remembered = (key: string, fallback: string) => {
      try {
        return localStorage.getItem(key) ?? fallback;
      } catch {
        return fallback;
      }
    };
    let format = remembered("ww.exportFormat", "docx");
    let template = remembered("ww.exportTemplate", "standard");
    let chapters = remembered("ww.exportChapters", "0");
    if (!opts.formats.some((f) => f.key === format)) format = opts.formats[0].key;

    await showModal((close) => {
      const tplSelect = h("select", {
        "aria-label": "Mall",
        onchange: (e: Event) => (template = (e.target as HTMLSelectElement).value),
      });
      for (const t of opts.templates) {
        tplSelect.append(h("option", { value: t.key, selected: t.key === template }, t.label));
      }
      const tplRow = h("label", { class: "field wide" }, h("span", {}, "Mall"), tplSelect);
      const chapSelect = h("select", {
        "aria-label": "Ny sida före kapitel",
        onchange: (e: Event) => (chapters = (e.target as HTMLSelectElement).value),
      }) as HTMLSelectElement;
      for (const [v, l] of [
        ["0", "Nej"],
        ["1", "Vid rubriknivå 1 (#)"],
        ["2", "Vid rubriknivå 2 (##)"],
      ]) {
        chapSelect.append(h("option", { value: v, selected: v === chapters }, l));
      }
      const chapRow = h(
        "label",
        { class: "field wide", title: "Varje kapitelrubrik börjar på en ny sida. Gäller Word, OpenDocument, RTF och utskrift av HTML." },
        h("span", {}, "Ny sida före kapitel"),
        chapSelect,
      );
      const updateTpl = () => {
        const f = opts.formats.find((x) => x.key === format);
        tplSelect.disabled = !f?.templates;
        tplRow.classList.toggle("disabled", !f?.templates);
        chapSelect.disabled = !f?.pages;
        chapRow.classList.toggle("disabled", !f?.pages);
      };
      const radios = h(
        "div",
        { class: "radio-list", role: "radiogroup", "aria-label": "Format" },
        ...opts.formats.map((f) =>
          h(
            "label",
            {},
            h("input", {
              type: "radio",
              name: "export-format",
              value: f.key,
              checked: f.key === format,
              onchange: () => {
                format = f.key;
                updateTpl();
              },
            }),
            h("span", {}, f.label),
          ),
        ),
      );
      updateTpl();
      return h(
        "div",
        { class: "export-modal" },
        h("h2", {}, `Exportera ”${name}”`),
        radios,
        tplRow,
        chapRow,
        h("p", { class: "meta" }, "Mallen gäller Word och OpenDocument. Titel och författare i frontmatter (title, author) följer med som dokumentegenskaper."),
        h(
          "div",
          { class: "publish-copy" },
          h("h3", {}, "Kopiera för publicering"),
          h(
            "p",
            { class: "meta" },
            `Lägger texten i urklipp med rubriker, fet och kursiv stil, citat och listor – klar att klistra in i WordPress eller ett annat publiceringssystem. Kortkommando: ${modKey}+Shift+C.`,
          ),
          h(
            "div",
            { class: "row" },
            h(
              "label",
              { class: "check small" },
              h("input", {
                type: "checkbox",
                checked: this.publishWithTitle(),
                onchange: (e: Event) => {
                  try {
                    localStorage.setItem(PUBLISH_TITLE_KEY, String((e.target as HTMLInputElement).checked));
                  } catch {
                    /* ignorera */
                  }
                },
              }),
              h("span", {}, "Ta med huvudrubriken"),
            ),
            h(
              "button",
              {
                onclick: async () => {
                  if (await this.copyForPublishing()) close();
                },
              },
              "Kopiera",
            ),
          ),
        ),
        h(
          "div",
          { class: "actions" },
          h("button", { onclick: close }, "Avbryt"),
          h(
            "button",
            {
              class: "primary",
              onclick: () => {
                try {
                  localStorage.setItem("ww.exportFormat", format);
                  localStorage.setItem("ww.exportTemplate", template);
                  localStorage.setItem("ww.exportChapters", chapters);
                } catch {
                  /* ignorera */
                }
                const tpl = opts.formats.find((x) => x.key === format)?.templates ? template : "standard";
                const pages = opts.formats.find((x) => x.key === format)?.pages;
                void this.download(api.exportUrl(name, format, tpl, pages ? Number(chapters) : 0));
                close();
              },
            },
            isTauri() ? "Spara …" : "Ladda ner",
          ),
        ),
      );
    });
  }

  private publishWithTitle(): boolean {
    try {
      return localStorage.getItem(PUBLISH_TITLE_KEY) !== "false";
    } catch {
      return true;
    }
  }

  /** Kopierar texten som HTML och ren text för ett publiceringssystem. */
  private async copyForPublishing(withTitle = this.publishWithTitle()): Promise<boolean> {
    if (!this.current) return false;
    const { html, text } = publishContent(this.editor.getMarkdown(), withTitle);
    if (!text.trim()) {
      toast("Det finns ingen text att kopiera");
      return false;
    }
    try {
      await copyRich(html, text);
      toast(withTitle ? "Texten är kopierad – klistra in i publiceringssystemet" : "Texten är kopierad utan huvudrubrik");
      return true;
    } catch (e) {
      toast(`Kunde inte kopiera: ${errorText(e)}`);
      return false;
    }
  }

  // ---------------- papperskorgen ----------------
  private async showTrash(): Promise<void> {
    await showModal((close) => {
      const list = h("ul", { class: "list trash-list" }, h("li", { class: "empty" }, "Hämtar …"));
      const load = async () => {
        let items;
        try {
          items = await api.trash();
        } catch (e) {
          list.replaceChildren(h("li", { class: "empty" }, errorText(e)));
          return;
        }
        if (!items.length) {
          list.replaceChildren(h("li", { class: "empty" }, "Papperskorgen är tom."));
          return;
        }
        list.replaceChildren(
          ...items.map((it) => {
            const when = formatDate(new Date(it.deleted)).toLowerCase();
            const title =
              it.kind === "document" ? it.name : `AI-samtal: ${it.title ?? "Samtal"}`;
            const extra =
              it.kind === "document"
                ? [
                    `${(it.words ?? 0).toLocaleString("sv-SE")} ord`,
                    it.history ? "med historik" : "",
                    it.chats ? `${it.chats} AI-samtal` : "",
                  ]
                : [`om ”${it.name}”`, `${it.messages ?? 0} meddelanden`];
            return h(
              "li",
              {},
              h(
                "div",
                { class: "item static" },
                h("span", { class: "name" }, title),
                h("span", { class: "meta" }, [...extra.filter(Boolean), `borttaget ${when}`].join(" · ")),
              ),
              h(
                "button",
                {
                  onclick: async () => {
                    try {
                      const r = await api.restoreTrash(it.id);
                      this.ai.forget(r.name);
                      if (r.kind === "document") {
                        toast(r.name === it.name ? `Återställde ”${r.name}”` : `Återställde som ”${r.name}” (namnet var upptaget)`);
                      } else {
                        toast(`Återställde AI-samtalet om ”${r.name}”`);
                      }
                      if (this.docsDrawer.classList.contains("open")) void this.renderDocs();
                      await load();
                    } catch (e) {
                      toast(errorText(e));
                    }
                  },
                },
                "Återställ",
              ),
            );
          }),
        );
      };
      void load();
      return h(
        "div",
        { class: "trash-modal" },
        h("h2", {}, "Papperskorgen"),
        h(
          "p",
          { class: "meta" },
          "Borttagna dokument (med historik och AI-samtal) och borttagna AI-samtal. Inget raderas på riktigt – filerna finns i datamappen under .trash.",
        ),
        list,
        h("div", { class: "actions" }, h("button", { class: "primary", onclick: close }, "Stäng")),
      );
    });
  }

  private async download(url: string, done = "Exporterade"): Promise<void> {
    // Mac app: native Save dialog instead of a browser download.
    const saveRoute = isTauri() ? downloadRoute(url) : null;
    if (saveRoute) {
      try {
        const saved = await invokeRoute<{ file: string } | null>(saveRoute);
        if (saved) toast(`${done} ${saved.file}`);
      } catch (e) {
        toast(`Kunde inte spara: ${errorText(e)}`);
      }
      return;
    }
    // Hämta först, så att fel kan visas i stället för en trasig nedladdning.
    try {
      const res = await fetch(url);
      if (!res.ok) {
        let msg = res.statusText;
        try {
          msg = (await res.json()).detail ?? msg;
        } catch {
          /* inget JSON */
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const cd = res.headers.get("content-disposition") ?? "";
      const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      const plain = /filename="([^"]+)"/i.exec(cd);
      const filename = m ? decodeURIComponent(m[1]) : (plain?.[1] ?? "dokument");
      const a = h("a", { href: URL.createObjectURL(blob), download: filename });
      document.body.append(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      toast(`${done} ${filename}`);
    } catch (e) {
      toast(`Kunde inte ladda ner: ${errorText(e)}`);
    }
  }

  private chooseImport(): void {
    const input = h("input", {
      type: "file",
      multiple: true,
      accept: ".docx,.odt,.rtf,.html,.htm,.md,.markdown,.txt",
    }) as HTMLInputElement;
    input.addEventListener("change", () => void this.importFiles([...(input.files ?? [])]));
    input.click();
  }

  private async importFiles(files: File[]): Promise<void> {
    let last: string | null = null;
    for (const file of files) {
      try {
        toast(`Importerar ${file.name} …`);
        const doc = await api.importFile(file);
        last = doc.name;
      } catch (e) {
        toast(`${file.name}: ${errorText(e)}`);
      }
    }
    if (last) {
      await this.open(last);
      this.closeDrawers();
      toast(files.length > 1 ? `${files.length} filer importerade` : `Importerade ”${last}”`);
    }
  }

  private bindDropImport(): void {
    const overlay = h("div", { class: "drop-overlay", hidden: true }, h("div", {}, "Släpp för att importera"));
    document.body.append(overlay);
    let depth = 0;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
    window.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      depth++;
      overlay.hidden = false;
    });
    window.addEventListener("dragleave", (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) overlay.hidden = true;
    });
    window.addEventListener("dragover", (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      overlay.hidden = true;
      void this.importFiles([...(e.dataTransfer?.files ?? [])]);
    });
  }

  private toggleChars(forceOpen = false): void {
    const open = forceOpen || !this.charsPanel.classList.contains("open");
    this.closeDrawers();
    if (!open) {
      this.editor.focus();
      return;
    }
    this.charsPanel.classList.add("open");
    renderCharPanel({
      panel: this.charsPanel,
      insert: (c) => this.editor.insertText(c),
      close: () => {
        this.charsPanel.classList.remove("open");
        this.syncExpanded();
        this.editor.focus();
      },
      fixAll: () => void this.showTypographyFix(),
    });
    this.syncExpanded();
  }

  /** Rättar typografin i hela texten – med förhandsvisning och en version i historiken först. */
  private async showTypographyFix(): Promise<void> {
    if (!this.current) return;
    this.closeDrawers();
    await this.flush();
    const name = this.current.name;
    const original = this.editor.getMarkdown();
    const { text, changes } = fixTypography(original, this.settings.quoteStyle);
    if (!changes.length) {
      toast("Typografin ser redan bra ut – inget att rätta");
      return;
    }
    const shown = changes.slice(0, 200);
    const list = h("ol", { class: "typo-changes" });
    for (const c of shown) {
      const row = h("div", { class: "typo-diff" });
      for (const part of diffChars(c.before, c.after)) {
        row.append(h(part.added ? "ins" : part.removed ? "del" : "span", {}, part.value));
      }
      list.append(h("li", {}, h("span", { class: "meta" }, `Rad ${c.line}`), row));
    }
    await showModal((close) =>
      h(
        "div",
        { class: "typo-modal" },
        h("h2", {}, "Rätta typografin i texten"),
        h(
          "p",
          { class: "meta" },
          `${changes.length} ${changes.length === 1 ? "rad ändras" : "rader ändras"}: raka citattecken, dubbla bindestreck, tre punkter och intervall som 12-15. ` +
            "Kod, länkadresser och frontmatter lämnas orörda. Den nuvarande texten sparas först som en version i historiken.",
        ),
        list,
        changes.length > shown.length
          ? h("p", { class: "meta" }, `… och ${changes.length - shown.length} rader till.`)
          : null,
        h(
          "div",
          { class: "actions" },
          h("button", { onclick: close }, "Avbryt"),
          h(
            "button",
            {
              class: "primary",
              onclick: async () => {
                try {
                  await api.snapshot(name, "Före typografirättning");
                } catch {
                  /* versionen är en extra säkerhet – fortsätt ändå */
                }
                if (this.current?.name !== name) return close();
                this.editor.load(text);
                this.onChange();
                await this.save(true);
                close();
                toast(`Typografin är rättad på ${changes.length} rader – den tidigare texten finns i historiken`);
              },
            },
            "Rätta",
          ),
        ),
      ),
    );
  }

  private toggleSettings(e?: Event): void {
    e?.stopPropagation();
    const open = !this.settingsPanel.classList.contains("open");
    this.closeDrawers();
    if (!open) return;
    this.renderSettings();
    this.settingsPanel.classList.add("open");
    this.syncExpanded();
    this.settingsPanel.querySelector<HTMLElement>("select, input, button")?.focus({ preventScroll: true });
  }

  private renderSettings(): void {
    const s = this.settings;
    const update = (patch: Partial<Settings>) => {
      Object.assign(s, patch);
      applySettings(s);
      saveSettings(s);
      this.editor.typewriter = s.typewriter;
      if (this.spell.enabled !== s.spellcheck) {
        this.spell.enabled = s.spellcheck;
        this.spell.changed();
      }
    };
    const select = <T extends string>(
      label: string,
      value: T,
      options: Record<T, string>,
      onchange: (v: T) => void,
    ) => {
      const sel = h("select", {
        onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value as T),
      });
      for (const [k, text] of Object.entries(options) as [T, string][]) {
        sel.append(h("option", { value: k, selected: k === value }, text));
      }
      return h("label", {}, h("span", {}, label), sel);
    };
    const range = (
      label: string,
      value: number,
      min: number,
      max: number,
      step: number,
      fmt: (v: number) => string,
      onchange: (v: number) => void,
    ) => {
      const out = h("output", {}, fmt(value));
      const input = h("input", {
        type: "range",
        min,
        max,
        step,
        value,
        oninput: (e: Event) => {
          const v = Number((e.target as HTMLInputElement).value);
          out.textContent = fmt(v);
          onchange(v);
        },
      });
      return h("label", {}, h("span", {}, label), input, out);
    };
    const check = (label: string, value: boolean, onchange: (v: boolean) => void) =>
      h(
        "label",
        { class: "check" },
        h("input", {
          type: "checkbox",
          checked: value,
          onchange: (e: Event) => onchange((e.target as HTMLInputElement).checked),
        }),
        h("span", {}, label),
      );

    const fontLabels = Object.fromEntries(
      Object.entries(FONTS).map(([k, v]) => [k, v.label]),
    ) as Record<Font, string>;

    this.settingsPanel.replaceChildren(
      h("h2", {}, "Inställningar"),
      h("p", { class: "hint" }, "Typsnittet gäller hela texten. Själva dokumentet är alltid ren Markdown."),
      select<Theme>("Tema", s.theme, THEMES, (v) => update({ theme: v })),
      select<Font>("Typsnitt", s.font, fontLabels, (v) => update({ font: v })),
      range("Storlek", s.size, 14, 30, 1, (v) => `${v} px`, (v) => update({ size: v })),
      range("Radavstånd", s.lineHeight, 1.3, 2.2, 0.05, (v) => v.toFixed(2), (v) => update({ lineHeight: v })),
      range("Textbredd", s.width, 40, 100, 2, (v) => `${v} tecken`, (v) => update({ width: v })),
      check("Dimma andra stycken än det jag skriver i", s.focusParagraph, (v) => update({ focusParagraph: v })),
      check("Skrivmaskinsläge (aktuell rad i mitten)", s.typewriter, (v) => update({ typewriter: v })),
      check("Stavningskontroll", s.spellcheck, (v) => update({ spellcheck: v })),
      h("h3", { class: "popover-sub" }, "Typografi medan du skriver"),
      check("Byt automatiskt till typografiska tecken", s.autoTypography, (v) => update({ autoTypography: v })),
      select<QuoteStyle>("Citattecken", s.quoteStyle, QUOTE_STYLES, (v) => update({ quoteStyle: v })),
      h("p", { class: "hint" }, "\" → ”   ' → ’   -- → –   --- → —   ... → …   12-15 → 12–15. Backsteg direkt efter ångrar."),
      select<string>(
        "Texttyp för nya dokument",
        s.defaultGenre,
        Object.fromEntries([["", "– Ingen –"], ...this.genres.map((g) => [g.key, g.label])]) as Record<string, string>,
        (v) => update({ defaultGenre: v }),
      ),
      range(
        "Dagens mål",
        s.dailyGoal,
        0,
        5000,
        100,
        (v) => (v ? `${v.toLocaleString("sv-SE")} ord` : "Av"),
        (v) => {
          update({ dailyGoal: v });
          this.updateStats();
        },
      ),
      h(
        "div",
        { class: "links" },
        h("button", { class: "link", onclick: () => this.showDictionary() }, "Egen ordlista …"),
        h("button", { class: "link", onclick: () => this.showShortcuts() }, "Kortkommandon …"),
      ),
      ...(isTauri() ? [this.aiSection(), this.dataDirSection()] : []),
      h("p", { class: "hint version" }, `Word Work ${__APP_VERSION__}`),
    );
  }

  /**
   * Mac app: which AI server to use. Replaces WW_AI_API / WW_AI_URL /
   * WW_AI_MODEL / WW_AI_KEY from the Docker version. The key goes to the
   * Keychain and is never shown again.
   */
  private aiSection(): HTMLElement {
    const api = h(
      "select",
      {},
      h("option", { value: "ollama" }, "Ollama"),
      h("option", { value: "openai" }, "OpenAI-kompatibel"),
    ) as HTMLSelectElement;
    const url = h("input", { type: "url", class: "text", placeholder: "http://localhost:11434", spellcheck: false }) as HTMLInputElement;
    const model = h("input", { type: "text", class: "text", placeholder: "Första i listan", spellcheck: false }) as HTMLInputElement;
    const key = h("input", { type: "password", class: "text", autocomplete: "off" }) as HTMLInputElement;
    const note = h("p", { class: "hint" });
    let hasKey = false;
    const show = (c: { api: string; url: string; model: string; has_key: boolean; from_env: boolean }) => {
      api.value = c.api;
      url.value = c.url;
      model.value = c.model;
      key.value = "";
      hasKey = c.has_key;
      key.placeholder = c.has_key ? "Sparad – lämna tomt för att behålla" : "Behövs bara för vissa tjänster";
      removeKey.hidden = !c.has_key;
      note.textContent = c.from_env
        ? "Miljövariablerna WW_AI_* gäller just nu i stället för inställningarna här."
        : "Tom adress stänger av AI-stödet. Nyckeln sparas i nyckelringen och visas aldrig.";
    };
    const save = async (newKey?: string) => {
      try {
        const c = await saveAiConfig({ api: api.value, url: url.value, model: model.value, key: newKey });
        show(c);
        toast("AI-inställningarna sparades – AI-stödet startar om");
        await this.flush();
        window.setTimeout(() => location.reload(), 600);
      } catch (e) {
        toast(errorText(e));
      }
    };
    const removeKey = h(
      "button",
      { class: "link", hidden: true, onclick: () => void save("") },
      "Ta bort nyckeln",
    );
    void aiConfig().then(show, (e) => (note.textContent = errorText(e)));
    const row = (label: string, el: HTMLElement) => h("label", { class: "wide-input" }, h("span", {}, label), el);
    return h(
      "div",
      { class: "ai-settings" },
      h("h3", { class: "popover-sub" }, "AI-assistent"),
      row("Server", api),
      row("Adress", url),
      row("Modell", model),
      row("API-nyckel", key),
      note,
      h(
        "div",
        { class: "links" },
        h("button", { class: "link", onclick: () => void save(key.value || (hasKey ? undefined : "")) }, "Spara"),
        removeKey,
      ),
    );
  }

  /** Mac app: where the texts are stored, with "Byt mapp …" and "Visa i Finder". */
  private dataDirSection(): HTMLElement {
    const path = h("p", { class: "hint data-dir-path" }, "…");
    const show = (d: { path: string; problem: string | null }) => {
      path.textContent = d.problem ?? d.path;
      path.title = d.path;
      path.classList.toggle("error", !!d.problem);
    };
    void dataDir().then(show, (e) => (path.textContent = errorText(e)));
    return h(
      "div",
      { class: "data-dir" },
      h("h3", { class: "popover-sub" }, "Datamapp"),
      path,
      h(
        "div",
        { class: "links" },
        h(
          "button",
          {
            class: "link",
            onclick: async () => {
              try {
                await this.flush(); // the open text belongs to the current folder
                const d = await chooseDataDir();
                if (!d) return;
                show(d);
                localStorage.removeItem(LAST_DOC_KEY);
                location.reload();
              } catch (e) {
                toast(errorText(e));
              }
            },
          },
          "Byt mapp …",
        ),
        h("button", { class: "link", onclick: () => void revealDataDir().catch((e) => toast(errorText(e))) }, "Visa i Finder"),
      ),
    );
  }

  private toggleFullscreen(): void {
    if (isTauri()) {
      void invoke("toggle_fullscreen").catch((e) => toast(errorText(e)));
      return;
    }
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => toast("Helskärm stöds inte här"));
  }

  // ---------------- Mac-appen ----------------

  /**
   * The native menu bar, closing/quitting safely, and links. Menu items with
   * a shortcut take the key before the page sees it, so every shortcut that
   * is in the menu is handled here.
   */
  private bindAppShell(): void {
    void listen<string>("ww://menu", (e) => this.menuAction(e.payload));

    // Closing the window or quitting: save first. Rust closes anyway after
    // 5 s, and unsaved text is also kept locally (offered at next start).
    void listen("ww://before-close", async () => {
      try {
        if (this.current && ["dirty", "saving", "error"].includes(this.saveState)) {
          keepLocal({ name: this.current.name, content: this.editor.getMarkdown(), base: this.current.modified });
        }
        await Promise.race([this.flush(), new Promise((r) => window.setTimeout(r, 3000))]);
      } finally {
        void invoke("close_confirmed");
      }
    });

    // Links (in the text, AI answers, help) open in the browser – never in the
    // app window, which would replace the editor.
    document.addEventListener(
      "click",
      (e) => {
        const a = (e.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
        if (!a || a.hasAttribute("download") || !/^(https?|mailto):/i.test(a.href)) return;
        // In the editor a click places the cursor (as before) – don't open the link.
        if (a.closest('[contenteditable="true"]')) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        void invoke("open_url", { url: a.href }).catch((err) => toast(errorText(err)));
      },
      true,
    );
    window.open = (url?: string | URL) => {
      if (url) void invoke("open_url", { url: String(url) }).catch((err) => toast(errorText(err)));
      return null;
    };
  }

  /** Same actions as the keyboard shortcuts and toolbar buttons. */
  private menuAction(id: string): void {
    const actions: Record<string, () => unknown> = {
      settings: () => this.toggleSettings(),
      new: () => this.newDocument(),
      documents: () => this.toggleDrawer(this.docsDrawer),
      import: () => this.chooseImport(),
      export: () => this.showExport(),
      publish: () => this.copyForPublishing(),
      save: () => this.save(true),
      history: () => this.toggleDrawer(this.historyDrawer),
      trash: () => this.showTrash(),
      backup: () => this.download("/api/backup", "Sparade"),
      find: () => this.searchBar.open(false),
      replace: () => this.searchBar.open(true),
      chars: () => this.toggleChars(),
      note: () => this.toggleNote(),
      comment: () => this.editComment(),
      footnote: () => this.editFootnote(null),
      typography: () => this.showTypographyFix(),
      view: () => this.setView(this.editor.mode === "write" ? "markdown" : "write"),
      meta: () => this.toggleDrawer(this.metaDrawer),
      analysis: () => this.toggleDrawer(this.analysisDrawer),
      ai: () => (this.aiButton.hidden ? toast(this.ai.reason || "AI-stödet är inte tillgängligt") : this.toggleDrawer(this.aiDrawer)),
      fullscreen: () => this.toggleFullscreen(),
      shortcuts: () => this.showShortcuts(),
    };
    const run = actions[id];
    if (!run) return;
    Promise.resolve()
      .then(run)
      .catch((e) => toast(errorText(e)));
  }

  // ---------------- globala händelser ----------------
  private bindGlobalEvents(): void {
    document.addEventListener("keydown", (e) => {
      if (isMod(e) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void this.save(true);
      } else if (isMod(e) && e.key === "/") {
        e.preventDefault();
        this.setView(this.editor.mode === "write" ? "markdown" : "write");
      } else if (isMod(e) && e.key.toLowerCase() === "j" && !this.aiButton.hidden) {
        e.preventDefault();
        this.toggleDrawer(this.aiDrawer);
      } else if (isMod(e) && e.key === ".") {
        e.preventDefault();
        this.toggleChars();
      } else if (e.key === "F1") {
        e.preventDefault();
        this.showShortcuts();
      } else if (isMod(e) && e.key.toLowerCase() === "e") {
        e.preventDefault();
        void this.showExport();
      } else if (isMod(e) && e.code === "KeyF") {
        e.preventDefault();
        this.searchBar.open(e.altKey);
      } else if ((isMod(e) && e.code === "KeyG") || e.key === "F3") {
        if (this.searchBar.isOpen) {
          e.preventDefault();
          this.searchBar.step(e.shiftKey ? -1 : 1);
        }
      } else if (isMod(e) && e.altKey && e.code === "KeyK") {
        e.preventDefault();
        void this.editComment();
      } else if (isMod(e) && e.altKey && e.code === "KeyN") {
        e.preventDefault();
        void this.editFootnote(null);
      } else if (isMod(e) && e.altKey && e.code === "KeyM") {
        e.preventDefault();
        this.toggleNote();
      } else if (isMod(e) && e.shiftKey && e.code === "KeyC") {
        e.preventDefault();
        void this.copyForPublishing();
      } else if (isMod(e) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        this.toggleDrawer(this.docsDrawer);
      } else if (e.key === "Escape" && !document.querySelector("dialog[open]")) {
        if (this.searchBar.isOpen && !document.querySelector(".drawer.open, .popover.open")) {
          this.searchBar.close();
        } else if (document.querySelector(".drawer.open, .popover.open")) {
          this.closeDrawers();
          this.editor.focus();
        }
      }
    });

    // Gränssnittet tonas ut när man skriver och tillbaka när musen rör sig.
    let lastX = 0;
    let lastY = 0;
    document.addEventListener("mousemove", (e) => {
      if (Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY) > 8) {
        document.body.classList.remove("typing");
      }
      lastX = e.clientX;
      lastY = e.clientY;
    });

    document.addEventListener("mousedown", (e) => {
      if (this.commentBubble && !this.commentBubble.contains(e.target as Node)) {
        const onComment = (e.target as Element).closest?.(".ww-comment, .ww-footnote, .footnote-list li");
        if (!onComment) this.closeCommentBubble();
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.commentBubble) this.closeCommentBubble();
    });

    document.addEventListener("click", (e) => {
      const t = e.target as Node;
      if (
        this.settingsPanel.classList.contains("open") &&
        !this.settingsPanel.contains(t) &&
        !this.settingsButton.contains(t)
      ) {
        this.settingsPanel.classList.remove("open");
        this.syncExpanded();
      }
      if (
        this.charsPanel.classList.contains("open") &&
        t.isConnected && // ett klickat tecken kan redan ha ritats om
        !this.charsPanel.contains(t) &&
        !this.charsButton.contains(t) &&
        !(t as Element).closest?.(".context-menu, .prose, .source")
      ) {
        this.charsPanel.classList.remove("open");
        this.syncExpanded();
      }
      // Klick i texten stänger öppna lådor.
      if ((t as Element).closest?.(".page") && document.querySelector(".drawer.open")) {
        this.closeDrawers();
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void this.flush();
    });
    window.addEventListener("online", () => void this.retrySave());
    window.addEventListener("focus", () => void this.retrySave());
    window.addEventListener("beforeunload", (e) => {
      if (this.current && ["dirty", "saving", "error"].includes(this.saveState)) {
        // Hinner sparningen inte klart finns texten kvar i webbläsaren.
        keepLocal({ name: this.current.name, content: this.editor.getMarkdown(), base: this.current.modified });
      }
      if (this.saveState === "dirty" || this.saveState === "saving" || this.saveState === "error") {
        void this.flush();
        e.preventDefault();
      }
    });
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const app = new App(document.getElementById("app")!);
app.start().catch((e) => {
  document.getElementById("app")!.replaceChildren(
    h("p", { class: "fatal" }, `Kunde inte starta Word Work: ${errorText(e)}`),
  );
});

/** Fotnotstext (Markdown) som säker HTML: kursiv, fet, länkar, kod. */
function inlineMarkdown(md: string): string {
  const html = md
    .split(/\n\n+/)
    .map((p) => marked.parseInline(p, { async: false }) as string)
    .join("<br><br>");
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: ["em", "strong", "a", "code", "br", "del"], ALLOWED_ATTR: ["href"] });
}
