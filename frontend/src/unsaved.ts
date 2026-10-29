/**
 * Reservkopia i webbläsaren av text som inte har kunnat sparas på servern
 * (t.ex. medan containern startar om). Tas bort så snart servern har sparat.
 */
const PREFIX = "ww.unsaved:";

export interface Unsaved {
  name: string;
  content: string;
  /** Serverns ändringstid som texten bygger på. */
  base: number | null;
  time: number;
}

export function keepLocal(u: Omit<Unsaved, "time">): boolean {
  try {
    localStorage.setItem(PREFIX + u.name, JSON.stringify({ ...u, time: Date.now() }));
    return true;
  } catch {
    return false; // privat läge eller fullt
  }
}

export function localCopy(name: string): Unsaved | null {
  try {
    const raw = localStorage.getItem(PREFIX + name);
    if (!raw) return null;
    const u = JSON.parse(raw) as Unsaved;
    return typeof u.content === "string" ? u : null;
  } catch {
    return null;
  }
}

export function dropLocal(name: string): void {
  try {
    localStorage.removeItem(PREFIX + name);
  } catch {
    /* ignorera */
  }
}

/** Dokument som har en reservkopia. */
export function localNames(): string[] {
  try {
    return Object.keys(localStorage)
      .filter((k) => k.startsWith(PREFIX))
      .map((k) => k.slice(PREFIX.length));
  } catch {
    return [];
  }
}
