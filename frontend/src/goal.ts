/**
 * Today's writing goal: how many words have been written today, summed over documents.
 *
 * For each document the word count is saved the first time it is opened that day.
 * Words written = the increase since then (removed words do not count as negative
 * for other documents). Stored in localStorage and reset at midnight.
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
    /* ignore */
  }
  return { date: today(), docs: {} };
}

function save(p: DayProgress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

/** Records the document's current word count and returns today's words written. */
export function trackWords(doc: string, words: number): number {
  const p = load();
  const entry = p.docs[doc];
  if (!entry) p.docs[doc] = { start: words, last: words };
  else entry.last = words;
  save(p);
  return writtenToday(p);
}

/** A document was renamed – move today's count. */
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
