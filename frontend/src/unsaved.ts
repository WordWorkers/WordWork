/**
 * Backup copy in localStorage of text that could not be saved to disk (e.g. if
 * the data folder is unreachable). Removed as soon as saving succeeds.
 */
const PREFIX = "ww.unsaved:";

export interface Unsaved {
  name: string;
  content: string;
  /** The file's modification time on disk that the text is based on. */
  base: number | null;
  time: number;
}

export function keepLocal(u: Omit<Unsaved, "time">): boolean {
  try {
    localStorage.setItem(PREFIX + u.name, JSON.stringify({ ...u, time: Date.now() }));
    return true;
  } catch {
    return false; // private mode or full
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
    /* ignore */
  }
}

/** Documents that have a backup copy. */
export function localNames(): string[] {
  try {
    return Object.keys(localStorage)
      .filter((k) => k.startsWith(PREFIX))
      .map((k) => k.slice(PREFIX.length));
  } catch {
    return [];
  }
}
