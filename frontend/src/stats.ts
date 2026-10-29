/**
 * Textstatistik och läsbarhet.
 *
 * LIX (läsbarhetsindex, C-H Björnsson 1968):
 *   LIX = ord/meningar + (långa ord × 100)/ord, där långa ord har fler än 6 bokstäver.
 * OVIX (ordvariationsindex):
 *   OVIX = log(ord) / log(2 − log(unika ord)/log(ord))
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

/** Tolkningsskala enligt lix.se. */
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

/** Vanliga svenska funktionsord som döljs i ordfrekvenslistan som standard. */
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

// Förkortningar vars punkter inte ska räknas som meningsslut.
export const ABBREVIATIONS =
  /\b(?:t\.ex|bl\.a|s\.k|d\.v\.s|dvs|m\.m|m\.fl|o\.s\.v|osv|t\.o\.m|f\.d|p\.g\.a|e\.d|e\.dyl|resp|ca|kl|nr|s|jfr|fr\.o\.m|t\.v|a\.k\.a|f\.ö|i\.o\.m|o\.d)\./giu;

/** Delar upp text i meningar. Stycken utan avslutande skiljetecken (t.ex. rubriker) räknas som egna meningar. */
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
  // Ord som börjar med en bokstav behöver ingen regex-kontroll (de flesta).
  return (text.match(WORD_RE) ?? []).filter((w) => {
    const c = w.charCodeAt(0);
    return c > 57 || c < 48 ? true : /\p{L}/u.test(w);
  });
}

/** Bokstäver i ordet (bindestreck och apostrofer räknas inte). */
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
 * Snabb statistik för statusraden – ingen ordfrekvens eller meningslista.
 * Räknar på samma sätt som analyze(), så LIX blir identiskt.
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

/** Antal meningar enligt samma regler som splitSentences(), utan att bygga listan. */
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
    readingMinutes: n / 200, // ca 200 ord/minut för svensk löptext
    longestSentences,
    frequency,
  };
}


/* ------------------------------------------------------------------ */
/* Citat                                                               */
/* ------------------------------------------------------------------ */

export interface Quote {
  text: string;
  kind: "citat" | "replik";
}

// Citattecken som öppnar och stänger. Svenska ”…” och »…» använder samma tecken på båda sidor.
const QUOTE_PATTERNS = [/”([^”\n]+)”/g, /“([^”“\n]+)”/g, /„([^“”„\n]+)[“”]/g, /»([^»«\n]+)[»«]/g, /"([^"\n]+)"/g];

/**
 * Citat i texten: citerat inom citattecken (minst tre ord – enstaka ord inom
 * citattecken är oftast markeringar, inte citat) och repliker (stycken som börjar
 * med pratminus). I den ordning de står i texten.
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
/* Substantiveringar (nominalstil)                                     */
/* ------------------------------------------------------------------ */

/**
 * Substantiv bildade av verb och adjektiv med typiska ändelser (genomförande-
 * typer utelämnas eftersom -ande också är particip). Mönstret är avsiktligt
 * snävt: hellre färre träffar än felaktiga.
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
