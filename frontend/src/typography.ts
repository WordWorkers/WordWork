/**
 * Typography: special characters, automatic replacements while typing and
 * "rätta typografin" for existing text.
 *
 * Everything becomes plain Unicode characters – the file stays pure Markdown.
 */
import { Extension, InputRule } from "@tiptap/core";

export type QuoteStyle = "sv" | "angle" | "straight";

export interface TypographyOptions {
  enabled: boolean;
  quotes: QuoteStyle;
}

export const QUOTE_STYLES: Record<QuoteStyle, string> = {
  sv: "”Svenska” och ’inre’",
  angle: "»Vinkel» och ›inre›",
  straight: "Raka \"\" – byt inte",
};

/* ------------------------------------------------------------------ */
/* Characters                                                          */
/* ------------------------------------------------------------------ */

export interface CharInfo {
  char: string;
  name: string;
  /** Short label under the character in the panel (e.g. for invisible characters). */
  label?: string;
  keywords?: string;
}

export const CHAR_GROUPS: { title: string; chars: CharInfo[] }[] = [
  {
    title: "Citattecken och apostrof",
    chars: [
      { char: "”", name: "Svenskt citattecken", label: "sv", keywords: "citat anföring" },
      { char: "’", name: "Apostrof / inre citattecken", label: "sv", keywords: "apostrof enkelt citat" },
      { char: "»", name: "Vinkelcitattecken", keywords: "citat guillemet" },
      { char: "«", name: "Vinkelcitattecken vänster", keywords: "citat guillemet fransk" },
      { char: "›", name: "Enkelt vinkelcitattecken", keywords: "inre citat" },
      { char: "‹", name: "Enkelt vinkelcitattecken vänster", keywords: "inre citat" },
      { char: "„", name: "Nedre citattecken (tyska m.fl.)", keywords: "citat tysk" },
      { char: "“", name: "Engelskt inledande citattecken", keywords: "citat engelsk" },
    ],
  },
  {
    title: "Streck och mellanrum",
    chars: [
      { char: "–", name: "Tankstreck", label: "tank", keywords: "streck talstreck intervall pratminus" },
      { char: "—", name: "Långt tankstreck", label: "lång", keywords: "em dash streck" },
      { char: "‑", name: "Hårt bindestreck (bryts inte)", label: "hårt", keywords: "bindestreck" },
      { char: "−", name: "Minustecken", label: "minus", keywords: "minus matematik" },
      { char: " ", name: "Hårt mellanslag (bryts inte)", label: "hårt", keywords: "mellanslag blanksteg nbsp" },
      { char: " ", name: "Smalt hårt mellanslag (t.ex. 10 000)", label: "smalt", keywords: "mellanslag tusental siffror" },
      { char: "·", name: "Mittpunkt", keywords: "punkt" },
      { char: "•", name: "Punkt (bullet)", keywords: "lista punkt" },
    ],
  },
  {
    title: "Typografi",
    chars: [
      { char: "…", name: "Ellips (tre punkter)", keywords: "punkter uteslutning" },
      { char: "§", name: "Paragraftecken", keywords: "paragraf lag" },
      { char: "¶", name: "Stycketecken", keywords: "stycke" },
      { char: "†", name: "Kors (död)", keywords: "död avliden kors" },
      { char: "‡", name: "Dubbelkors", keywords: "kors fotnot" },
      { char: "©", name: "Copyright", keywords: "upphovsrätt" },
      { char: "®", name: "Registrerat varumärke", keywords: "varumärke" },
      { char: "™", name: "Varumärke", keywords: "trademark" },
    ],
  },
  {
    title: "Tal och mått",
    chars: [
      { char: "°", name: "Grader", keywords: "grad temperatur" },
      { char: "±", name: "Plus/minus", keywords: "ungefär" },
      { char: "×", name: "Gånger", keywords: "multiplikation mått" },
      { char: "÷", name: "Division", keywords: "delat" },
      { char: "½", name: "En halv", keywords: "bråk halv" },
      { char: "¼", name: "En fjärdedel", keywords: "bråk fjärdedel" },
      { char: "¾", name: "Tre fjärdedelar", keywords: "bråk" },
      { char: "‰", name: "Promille", keywords: "procent" },
    ],
  },
  {
    title: "Bokstäver",
    chars: "éèêëàáâüæøçñßœłőčšžćńíóúýåäö".split("").map((c) => ({ char: c, name: `Bokstaven ${c}`, keywords: "accent" })),
  },
];

const ALL_CHARS = CHAR_GROUPS.flatMap((g) => g.chars);

export function charInfo(c: string): CharInfo {
  return ALL_CHARS.find((x) => x.char === c) ?? { char: c, name: "Tecken" };
}

export function codePoint(c: string): string {
  return `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
}

export function searchChars(query: string): CharInfo[] {
  const q = query.trim().toLocaleLowerCase("sv");
  if (!q) return [];
  return ALL_CHARS.filter(
    (c) =>
      c.char === query.trim() ||
      c.name.toLocaleLowerCase("sv").includes(q) ||
      (c.keywords ?? "").includes(q) ||
      codePoint(c.char).toLowerCase().includes(q),
  );
}

const RECENT_KEY = "ww.recentChars";

export function recentChars(): string[] {
  try {
    const r = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(r) ? r.slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function rememberChar(c: string): void {
  try {
    const r = [c, ...recentChars().filter((x) => x !== c)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(r));
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

const DQ: Record<Exclude<QuoteStyle, "straight">, string> = { sv: "”", angle: "»" };
const SQ: Record<Exclude<QuoteStyle, "straight">, string> = { sv: "’", angle: "›" };

/**
 * Single quotation mark. With Swedish quotes, the apostrophe and inner quotes are the
 * same character (’). With angle quotes it becomes › – except after a letter when no
 * inner quote is open, then it is an apostrophe (”Strindberg’s”).
 */
function singleQuote(prev: string, style: Exclude<QuoteStyle, "straight">, before = ""): string {
  if (style === "sv") return "’";
  const open = (before.match(/›/g)?.length ?? 0) % 2 === 1;
  if (/[\p{L}\p{N}]/u.test(prev) && !open) return "’";
  return SQ[style];
}

interface Rule {
  name: string;
  /** Matches the end of the text before the cursor (including the character just typed). */
  find: RegExp;
  replace: (m: RegExpExecArray, style: QuoteStyle, before: string) => string | null;
  quotes?: boolean; // the rule concerns quotation marks (off when the style is "straight")
}

// Whitespace but not line break – TipTap runs the rules even when Enter is pressed ("\n").
const RANGE_SUFFIX = "[ \\t\\u00a0.,;:!?)]";

export const RULES: Rule[] = [
  { name: "dubbelt citat", quotes: true, find: /"$/, replace: (_m, s) => (s === "straight" ? null : DQ[s]) },
  {
    name: "enkelt citat",
    quotes: true,
    find: /(.?)'$/u,
    replace: (m, s, before) => (s === "straight" ? null : m[1] + singleQuote(m[1], s, before)),
  },
  { name: "ellips", find: /\.\.\.$/, replace: () => "…" },
  { name: "långt tankstreck", find: /–-$/, replace: () => "—" },
  // Not at the start of a paragraph: there "---" may be a horizontal rule in Markdown.
  { name: "tankstreck", find: /([^\n-])--$/, replace: (m) => `${m[1]}–` },
  { name: "pratminus", find: /([ \t\u00a0])-[ \u00a0]$/, replace: (m) => `${m[1]}– ` },
  // Dialogue in fiction: "-- " at the start of a paragraph becomes "– ". ("- " becomes a
  // bullet list and "---" a horizontal rule, so they are left alone.)
  { name: "replikstreck", find: /^--[ \u00a0]$/, replace: () => "– " },
  {
    // 12-15, 1998-2001 – but not dates (2026-10-07) or phone numbers (08-123).
    name: "intervall",
    find: new RegExp(`(?<![\\d\\-–.,:/])([1-9]\\d{0,3})-(\\d{1,4})(${RANGE_SUFFIX})$`),
    replace: (m) => `${m[1]}–${m[2]}${m[3]}`,
  },
  {
    name: "bråk",
    find: new RegExp(`(^|[^\\d/])(1/2|1/4|3/4)(${RANGE_SUFFIX})$`),
    replace: (m) => `${m[1]}${({ "1/2": "½", "1/4": "¼", "3/4": "¾" } as Record<string, string>)[m[2]]}${m[3]}`,
  },
];

/** TipTap extension for replacements while typing. Backspace right after undoes. */
export function typographyExtension(options: () => TypographyOptions) {
  return Extension.create({
    name: "wwTypography",
    addInputRules() {
      return RULES.map(
        (rule) =>
          new InputRule({
            find: rule.find,
            handler: ({ state, range, match }) => {
              const opts = options();
              if (!opts.enabled) return null;
              const $from = state.doc.resolve(range.from);
              const before = $from.parent.textBetween(0, $from.parentOffset, undefined, " ");
              const replacement = rule.replace(match as unknown as RegExpExecArray, opts.quotes, before);
              if (replacement === null || replacement === match[0]) return null;
              state.tr.insertText(replacement, range.from, range.to);
            },
            undoable: true,
          }),
      );
    },
  });
}

/* ------------------------------------------------------------------ */
/* Fix typography in existing text                                     */
/* ------------------------------------------------------------------ */

export interface TypographyChange {
  line: number;
  before: string;
  after: string;
}

/** Splits a line into pieces that may be changed and pieces that are protected (code, link targets, URLs). */
function protectedSplit(line: string): { text: string; locked: boolean }[] {
  const re = /(`+)[^`]*?\1|\]\([^)]*\)|<https?:[^>]*>|https?:\/\/\S+/g;
  const parts: { text: string; locked: boolean }[] = [];
  let last = 0;
  for (const m of line.matchAll(re)) {
    if (m.index! > last) parts.push({ text: line.slice(last, m.index), locked: false });
    parts.push({ text: m[0], locked: true });
    last = m.index! + m[0].length;
  }
  if (last < line.length) parts.push({ text: line.slice(last), locked: false });
  return parts;
}

function fixSegment(s: string, style: QuoteStyle): string {
  if (style !== "straight") {
    s = s.replace(/"/g, DQ[style]);
    let out = "";
    for (const ch of s) {
      out += ch === "'" ? singleQuote([...out].pop() ?? "", style, out) : ch;
    }
    s = out;
  }
  return s
    .replace(/\.\.\./g, "…")
    .replace(/(^|[^-])---(?!-)/g, "$1—")
    .replace(/(^|[^-])--(?!-)/g, "$1–")
    .replace(/(\s)-(?=\s)/g, "$1–")
    .replace(new RegExp(`(?<![\\d\\-–.,:/])([1-9]\\d{0,3})-(\\d{1,4})(?=${RANGE_SUFFIX}|$)`, "g"), "$1–$2")
    .replace(new RegExp(`(^|[^\\d/])(1/2|1/4|3/4)(?=${RANGE_SUFFIX}|$)`, "g"), (_m, p: string, f: string) =>
      p + ({ "1/2": "½", "1/4": "¼", "3/4": "¾" } as Record<string, string>)[f],
    );
}

/**
 * Fixes the typography in a Markdown text. Frontmatter, code blocks, inline code,
 * link targets and Markdown syntax (list markers, horizontal rules) are left untouched.
 */
export function fixTypography(md: string, style: QuoteStyle): { text: string; changes: TypographyChange[] } {
  const lines = md.split("\n");
  const changes: TypographyChange[] = [];
  let inFence = false;
  let inFrontmatter = lines[0]?.replace(/^﻿/, "").trim() === "---";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inFrontmatter) {
      if (i > 0 && /^(---|\.\.\.)\s*$/.test(line)) inFrontmatter = false;
      continue;
    }
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^ {4}|\t/.test(line)) continue; // code block
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue; // horizontal rule
    // Keep list markers, quote markers and heading markers at the start of the line.
    const lead = /^(\s*(?:>\s*)*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)?)/.exec(line)![0];
    const rest = line.slice(lead.length);
    const fixed =
      lead +
      protectedSplit(rest)
        .map((p) => (p.locked ? p.text : fixSegment(p.text, style)))
        .join("");
    if (fixed !== line) {
      changes.push({ line: i + 1, before: line, after: fixed });
      lines[i] = fixed;
    }
  }
  return { text: lines.join("\n"), changes };
}
