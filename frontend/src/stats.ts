/**
 * Text statistics and readability.
 *
 * LIX (readability index, C-H Björnsson 1968):
 *   LIX = words/sentences + (long words × 100)/words, where long words have more than 6 letters.
 * OVIX (word variation index):
 *   OVIX = log(words) / log(2 − log(unique words)/log(words))
 */
import { WORD_RE } from "./spell";

export interface TextStats {
  words: number;
  uniqueWords: number;
  chars: number;
  charsNoSpaces: number;
  sentences: number;
  paragraphs: number;
  longWords: number;
  lix: number | null;
  ovix: number | null;
  avgSentenceLength: number;
  avgWordLength: number;
  readingMinutes: number;
  longestSentences: { text: string; words: number }[];
  frequency: { word: string; count: number }[];
}

export interface LixLevel {
  max: number;
  label: string;
  example: string;
}

/** Interpretation scale according to lix.se. */
export const LIX_SCALE: LixLevel[] = [
  { max: 25, label: "Mycket lätt", example: "Barnböcker" },
  { max: 30, label: "Lätt", example: "Enkla texter, ungdomsböcker" },
  { max: 40, label: "Medelsvår", example: "Normal tidningstext, skönlitteratur" },
  { max: 50, label: "Svår", example: "Sakprosa, populärvetenskap" },
  { max: 60, label: "Mycket svår", example: "Facktexter" },
  { max: Infinity, label: "Extremt svår", example: "Byråkratsvenska, forskning" },
];

export function lixLevel(lix: number): LixLevel {
  return LIX_SCALE.find((l) => lix < l.max) ?? LIX_SCALE[LIX_SCALE.length - 1];
}

/** Common Swedish function words hidden in the word frequency list by default. */
export const STOPWORDS = new Set(
  `och i att det som en på är av för med till den har de inte om ett han men var jag sig
  från vi så kan man när år säger hon under också efter eller nu sin där vid mot ska skulle
  kommer ut får finns vara hade alla andra mycket än här då sedan över bara in blir upp även
  vad få två vill ha många hur mer går sitt du mellan blev bli genom vår vilket utan något
  dem dig mig oss er ni honom henne hans hennes deras dess denna detta dessa vars vilken
  vilka sina sitt min mitt mina din ditt dina sådan sådant sådana själv jo ja nej ju väl
  redan aldrig alltid inget ingen inga någon några allt hela samma varit vart skall kunde
  ville måste bör borde låt man en ett åt utom hos innan medan eftersom fast om än både
  varken samt dock bl.a t.ex`.split(/\s+/),
);

// Abbreviations whose periods must not count as sentence ends.
export const ABBREVIATIONS =
  /\b(?:t\.ex|bl\.a|s\.k|d\.v\.s|dvs|m\.m|m\.fl|o\.s\.v|osv|t\.o\.m|f\.d|p\.g\.a|e\.d|e\.dyl|resp|ca|kl|nr|s|jfr|fr\.o\.m|t\.v|a\.k\.a|f\.ö|i\.o\.m|o\.d)\./giu;

/** Splits text into sentences. Paragraphs without final punctuation (e.g. headings) count as separate sentences. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    const masked = para.replace(ABBREVIATIONS, (m) => m.replace(/\./g, "\u0000"));
    for (const raw of masked.split(/(?<=[.!?:…]["”’»)]*)\s+/u)) {
      const s = raw.replace(/\u0000/g, ".").replace(/\s+/g, " ").trim();
      if (s && WORD_RE.test(s)) out.push(s);
      WORD_RE.lastIndex = 0;
    }
  }
  return out;
}

function words(text: string): string[] {
  // Words starting with a letter need no regex check (most of them).
  return (text.match(WORD_RE) ?? []).filter((w) => {
    const c = w.charCodeAt(0);
    return c > 57 || c < 48 ? true : /\p{L}/u.test(w);
  });
}

/** Letters in the word (hyphens and apostrophes are not counted). */
function letterCount(w: string): number {
  if (w.indexOf("-") < 0 && w.indexOf("'") < 0 && w.indexOf("’") < 0) return w.length;
  return w.replace(/[-'’]/g, "").length;
}

const collator = new Intl.Collator("sv");

export interface QuickStats {
  words: number;
  chars: number;
  lix: number | null;
}

/**
 * Quick statistics for the status bar – no word frequency or sentence list.
 * Counts the same way as analyze(), so LIX is identical.
 */
export function quickStats(text: string): QuickStats {
  const ws = words(text);
  const n = ws.length;
  let long = 0;
  for (const w of ws) if (w.length > 6 && letterCount(w) > 6) long++;
  const sentenceCount = Math.max(countSentences(text), n ? 1 : 0);
  return {
    words: n,
    chars: text.replace(/\n/g, "").length,
    lix: n && sentenceCount ? n / sentenceCount + (long * 100) / n : null,
  };
}

/** Number of sentences by the same rules as splitSentences(), without building the list. */
export function countSentences(text: string): number {
  let count = 0;
  for (const para of text.split(/\n\s*\n/)) {
    const masked = para.replace(ABBREVIATIONS, (m) => m.replace(/\./g, "\u0000"));
    for (const raw of masked.split(/(?<=[.!?:…]["”’»)]*)\s+/u)) {
      if (/[\p{L}\p{N}]/u.test(raw)) count++;
    }
  }
  return count;
}

export function analyze(text: string, opts: { includeStopwords?: boolean; top?: number } = {}): TextStats {
  const ws = words(text);
  const n = ws.length;
  const lower = ws.map((w) => w.toLowerCase());
  const unique = new Set(lower);
  const sentences = splitSentences(text);
  const sentenceCount = Math.max(sentences.length, n ? 1 : 0);
  let longWords = 0;
  let letters = 0;
  for (const w of ws) {
    const l = letterCount(w);
    letters += l;
    if (l > 6) longWords++;
  }

  const lix = n && sentenceCount ? n / sentenceCount + (longWords * 100) / n : null;
  let ovix: number | null = null;
  if (n > 1 && unique.size < n) {
    ovix = Math.log(n) / Math.log(2 - Math.log(unique.size) / Math.log(n));
  }

  const top = opts.top ?? 40;
  let frequency: { word: string; count: number }[] = [];
  if (top > 0) {
    const counts = new Map<string, number>();
    for (const w of lower) {
      if (!opts.includeStopwords && STOPWORDS.has(w)) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    frequency = [...counts.entries()]
      .map(([word, count]) => ({ word, count }))
      .sort((a, b) => b.count - a.count || collator.compare(a.word, b.word))
      .slice(0, top);
  }

  const longestSentences = sentences
    .map((s) => ({ text: s, words: (s.match(WORD_RE) ?? []).length }))
    .sort((a, b) => b.words - a.words)
    .slice(0, 5)
    .filter((s) => s.words > 0);

  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim()).length;

  return {
    words: n,
    uniqueWords: unique.size,
    chars: text.replace(/\n/g, "").length,
    charsNoSpaces: text.replace(/\s/g, "").length,
    sentences: sentences.length,
    paragraphs,
    longWords,
    lix,
    ovix,
    avgSentenceLength: sentenceCount ? n / sentenceCount : 0,
    avgWordLength: n ? letters / n : 0,
    readingMinutes: n / 200, // about 200 words/minute for Swedish prose
    longestSentences,
    frequency,
  };
}


/* ------------------------------------------------------------------ */
/* Quotes                                                              */
/* ------------------------------------------------------------------ */

export interface Quote {
  text: string;
  kind: "citat" | "replik";
}

// Opening and closing quotation marks. Swedish ”…” and »…» use the same character on both sides.
const QUOTE_PATTERNS = [/”([^”\n]+)”/g, /“([^”“\n]+)”/g, /„([^“”„\n]+)[“”]/g, /»([^»«\n]+)[»«]/g, /"([^"\n]+)"/g];

/**
 * Quotes in the text: quoted text within quotation marks (at least three words – single
 * words in quotation marks are usually emphasis, not quotes) and dialogue (paragraphs
 * starting with a dialogue dash). In the order they appear in the text.
 */
export function findQuotes(text: string): Quote[] {
  const found: { index: number; q: Quote }[] = [];
  const seen = new Set<string>();
  const add = (index: number, t: string, kind: Quote["kind"]) => {
    const clean = t.replace(/\s+/g, " ").trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    found.push({ index, q: { text: clean, kind } });
  };
  for (const re of QUOTE_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if ((m[1].match(WORD_RE) ?? []).length >= 3) add(m.index!, m[1], "citat");
    }
  }
  let offset = 0;
  for (const para of text.split(/\n/)) {
    if (/^\s*[–—]\s/.test(para) && (para.match(WORD_RE) ?? []).length >= 2) add(offset, para.trim(), "replik");
    offset += para.length + 1;
  }
  return found.sort((a, b) => a.index - b.index).map((f) => f.q);
}

/* ------------------------------------------------------------------ */
/* Nominalizations (nominal style)                                     */
/* ------------------------------------------------------------------ */

/**
 * Nouns formed from verbs and adjectives with typical endings (genomförande-
 * type words are left out since -ande is also a participle). The pattern is
 * deliberately narrow: better fewer matches than wrong ones.
 */
const NOMINAL_RE =
  /^\p{L}{3,}(?:ning(?:en|ar|arna|ens|ars|arnas)?|het(?:en|er|erna|ens|ers|ernas)?|else(?:n|r|rna|ns|rs)?|tion(?:en|er|erna|ens|ers)?|itet(?:en|er|erna)?|andet|endet|andena|endena)$/u;

export interface NominalStats {
  count: number;
  per100: number;
  top: { word: string; count: number }[];
}

export function nominalStyle(text: string): NominalStats {
  const ws = words(text);
  const counts = new Map<string, number>();
  let count = 0;
  for (const w of ws) {
    const l = w.toLowerCase();
    if (l.length < 7 || !NOMINAL_RE.test(l)) continue;
    count++;
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .map(([word, c]) => ({ word, count: c }))
    .sort((a, b) => b.count - a.count || collator.compare(a.word, b.word))
    .slice(0, 12);
  return { count, per100: ws.length ? (count * 100) / ws.length : 0, top };
}

export function nominalLevel(per100: number): string {
  if (per100 < 2) return "Lätt – verbal stil";
  if (per100 < 4) return "Normal";
  if (per100 < 6) return "Ganska tung";
  return "Tung nominalstil";
}
