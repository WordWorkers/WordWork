/**
 * Dagens skrivmål: hur många ord som skrivits i dag, summerat över dokument.
 *
 * För varje dokument sparas ordantalet första gången det öppnas under dagen.
 * Skrivna ord = ökningen sedan dess (borttagna ord räknas inte som negativa
 * för andra dokument). Sparas lokalt i webbläsaren och nollställs vid midnatt.
 */

const KEY = "ww.goalProgress";

interface DayProgress {
  date: string;
  docs: Record<string, { start: number; last: number }>;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function load(): DayProgress {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as DayProgress;
      if (p.date === today() && p.docs) return p;
    }
  } catch {
    /* ignorera */
  }
  return { date: today(), docs: {} };
}

function save(p: DayProgress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* ignorera */
  }
}

/** Registrerar dokumentets aktuella ordantal och returnerar dagens skrivna ord. */
export function trackWords(doc: string, words: number): number {
  const p = load();
  const entry = p.docs[doc];
  if (!entry) p.docs[doc] = { start: words, last: words };
  else entry.last = words;
  save(p);
  return writtenToday(p);
}

/** Ett dokument har bytt namn – flytta dagens räkning. */
export function renameTracked(oldName: string, newName: string): void {
  const p = load();
  if (p.docs[oldName]) {
    p.docs[newName] = p.docs[oldName];
    delete p.docs[oldName];
    save(p);
  }
}

function writtenToday(p: DayProgress): number {
  return Object.values(p.docs).reduce((sum, d) => sum + Math.max(0, d.last - d.start), 0);
}
