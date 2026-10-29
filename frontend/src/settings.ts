/**
 * Inställningar (utseende m.m.). Typsnitt gäller alltid hela dokumentet (temaval).
 *
 * Inställningarna sparas på servern i datamappen (.wordwork/settings.json), så att de följer
 * med mellan webbläsare och vid ominstallation. En kopia i webbläsaren gör att rätt
 * tema visas direkt vid start, innan servern har svarat.
 */

import { api } from "./api";
import type { QuoteStyle } from "./typography";

export type Theme = "auto" | "light" | "sepia" | "dark";
export type Font = "literata" | "source-sans" | "plex-mono" | "system-serif";

export interface Settings {
  theme: Theme;
  font: Font;
  size: number; // px
  lineHeight: number;
  width: number; // ch
  focusParagraph: boolean;
  typewriter: boolean;
  spellcheck: boolean;
  dailyGoal: number; // ord per dag, 0 = av
  autoTypography: boolean;
  quoteStyle: QuoteStyle;
  aiModel: string; // tom = serverns standardmodell
  aiThink: boolean;
  markLongSentences: boolean;
  longSentenceWords: number;
  defaultGenre: string; // texttyp för nya dokument, tom = ingen
}

export const FONTS: Record<Font, { label: string; stack: string }> = {
  literata: { label: "Literata (serif)", stack: '"Literata Variable", Georgia, serif' },
  "source-sans": {
    label: "Source Sans (sans-serif)",
    stack: '"Source Sans 3 Variable", system-ui, sans-serif',
  },
  "plex-mono": { label: "IBM Plex Mono (skrivmaskin)", stack: '"IBM Plex Mono", ui-monospace, monospace' },
  "system-serif": {
    label: "Systemets serif",
    stack: 'Charter, "Iowan Old Style", "Palatino Linotype", Georgia, serif',
  },
};

export const THEMES: Record<Theme, string> = {
  auto: "Följ systemet",
  light: "Ljust",
  sepia: "Sepia",
  dark: "Mörkt",
};

const DEFAULTS: Settings = {
  theme: "auto",
  font: "literata",
  size: 20,
  lineHeight: 1.7,
  width: 66,
  focusParagraph: false,
  typewriter: false,
  spellcheck: true,
  dailyGoal: 0,
  autoTypography: true,
  quoteStyle: "sv",
  aiModel: "",
  aiThink: true,
  markLongSentences: false,
  longSentenceWords: 30,
  defaultGenre: "",
};

const KEY = "ww.settings";
// Äldre versioner sparade AI-valen separat i webbläsaren.
const LEGACY_AI_MODEL = "ww.aiModel";
const LEGACY_AI_THINK = "ww.aiThink";

/** Behåller bara kända nycklar med rätt typ – en trasig eller gammal fil ska inte förstöra något. */
function sanitize(raw: unknown): Partial<Settings> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === typeof def && (typeof v !== "number" || Number.isFinite(v))) out[key] = v;
  }
  if (typeof out.font === "string" && !(out.font in FONTS)) delete out.font;
  if (typeof out.theme === "string" && !(out.theme in THEMES)) delete out.theme;
  if (typeof out.quoteStyle === "string" && !["sv", "angle", "straight"].includes(out.quoteStyle)) delete out.quoteStyle;
  return out as Partial<Settings>;
}

function local(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // privat läge e.d.
  }
}

function cache(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignorera */
  }
}

/** Snabb start från webbläsarens kopia. Rätt värden hämtas sedan med syncSettings(). */
export function loadSettings(): Settings {
  const s: Settings = { ...DEFAULTS };
  try {
    Object.assign(s, sanitize(JSON.parse(local(KEY) ?? "null")));
  } catch {
    /* ignorera */
  }
  const model = local(LEGACY_AI_MODEL);
  const think = local(LEGACY_AI_THINK);
  if (model && !s.aiModel) s.aiModel = model;
  if (think !== null) s.aiThink = think !== "false";
  return s;
}

/**
 * Hämtar inställningarna från servern och skriver in dem i `s`. Första gången
 * (inget sparat på servern) flyttas webbläsarens inställningar dit i stället.
 * Returnerar true om något ändrades.
 */
export async function syncSettings(s: Settings): Promise<boolean> {
  const r = await api.settings();
  if (!r.saved) {
    await api.saveSettings(s);
    try {
      localStorage.removeItem(LEGACY_AI_MODEL);
      localStorage.removeItem(LEGACY_AI_THINK);
    } catch {
      /* ignorera */
    }
    return false;
  }
  const next: Settings = { ...DEFAULTS, ...sanitize(r.settings) };
  const changed = JSON.stringify(next) !== JSON.stringify(s);
  Object.assign(s, next);
  cache(s);
  return changed;
}

let timer: number | undefined;
let pending: Settings | null = null;

function push(): void {
  window.clearTimeout(timer);
  timer = undefined;
  if (!pending) return;
  const s = pending;
  pending = null;
  api.saveSettings(s).catch(() => {
    pending ??= s; // försök igen vid nästa ändring
  });
}

/** Sparar direkt i webbläsaren och strax efteråt på servern (samlar snabba ändringar). */
export function saveSettings(s: Settings): void {
  cache(s);
  pending = { ...s };
  window.clearTimeout(timer);
  timer = window.setTimeout(push, 400);
}

// Spara det som väntar om fliken stängs.
window.addEventListener("pagehide", () => {
  if (!pending) return;
  try {
    void fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pending),
      keepalive: true,
    });
    pending = null;
  } catch {
    /* ignorera */
  }
});

export function applySettings(s: Settings): void {
  const root = document.documentElement;
  if (s.theme === "auto") root.removeAttribute("data-theme");
  else root.dataset.theme = s.theme;
  root.style.setProperty("--doc-font", FONTS[s.font].stack);
  root.style.setProperty("--doc-size", `${s.size}px`);
  root.style.setProperty("--doc-leading", String(s.lineHeight));
  root.style.setProperty("--doc-width", `${s.width}ch`);
  document.body.classList.toggle("focus-paragraph", s.focusParagraph);
  document.body.classList.toggle("typewriter", s.typewriter);
}
