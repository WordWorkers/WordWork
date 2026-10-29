/**
 * Enkla fält i YAML-frontmatter (nyckel: värde på en rad).
 *
 * Bara de fält som metadatapanelen hanterar skrivs om – allt annat i
 * frontmattern (kommentarer, listor, andra nycklar) lämnas exakt som det är.
 * Blockfält (`ai: |` med indragna rader) hanteras som flerradig text; listor
 * och objekt redigeras i Markdown-vyn.
 */

export const META_FIELDS = ["title", "lead", "author", "client", "deadline", "length", "genre", "ai"] as const;
export type MetaKey = (typeof META_FIELDS)[number];

export interface MetaField {
  key: string;
  value: string;
  /** Värdet går inte att redigera som en rad (lista, block e.d.). */
  complex: boolean;
}

const KEY_RE = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*?))?[ \t]*$/;

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  // Kommentar sist på raden (" # …") hör inte till värdet.
  return v.replace(/\s+#.*$/, "");
}

/** Citerar värdet om YAML annars skulle tolka det fel. */
export function quoteYaml(v: string): string {
  if (v === "") return '""';
  const plain =
    !/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(v) &&
    !/:\s|\s#|:$|\n/.test(v) &&
    !/\s$/.test(v) &&
    !/^(?:true|false|yes|no|on|off|null|~)$/i.test(v);
  return plain ? v : JSON.stringify(v);
}

interface Parsed {
  open: string; // "---\n"
  lines: string[]; // raderna mellan avgränsarna
  close: string; // "---\n" eller "...\n" + tomrader
}

function parse(frontmatter: string): Parsed | null {
  const m = /^(﻿?---[ \t]*\r?\n)((?:.*\r?\n)*?)((?:---|\.\.\.)[ \t]*(?:\r?\n|$)[\s\S]*)$/.exec(frontmatter);
  if (!m) return null;
  const body = m[2].replace(/\r?\n$/, "");
  return { open: m[1], lines: body ? body.split(/\r?\n/) : [], close: m[3] };
}

/** Antal rader efter `i` som hör till fältets värde (indragna rader eller listrader). */
function continuation(lines: string[], i: number): number {
  let n = 0;
  while (i + 1 + n < lines.length && (/^[ \t]+\S|^-\s/.test(lines[i + 1 + n]) || (lines[i + 1 + n].trim() === "" && /^[ \t]+\S/.test(lines[i + 2 + n] ?? "")))) n++;
  return n;
}

/** Värdet i ett blockfält (`|` eller `>`): raderna utan indrag. */
function blockValue(indicator: string, lines: string[]): string {
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
  const text = lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join("\n");
  const folded = indicator.startsWith(">") ? text.replace(/([^\n])\n(?=[^\n])/g, "$1 ") : text;
  return folded.replace(/\s+$/, "");
}

/** Fälten på högsta nivån, i den ordning de står. Blockfält (`|`, `>`) läses som flerradig text. */
export function readMeta(frontmatter: string): MetaField[] {
  const p = parse(frontmatter);
  if (!p) return [];
  const out: MetaField[] = [];
  for (let i = 0; i < p.lines.length; i++) {
    const m = KEY_RE.exec(p.lines[i]);
    if (!m) continue;
    const raw = m[2] ?? "";
    const n = continuation(p.lines, i);
    if (/^[|>][+-]?$/.test(raw)) {
      out.push({ key: m[1], value: blockValue(raw, p.lines.slice(i + 1, i + 1 + n)), complex: false });
    } else {
      const complex = (!raw && n > 0) || /^[[{]/.test(raw);
      out.push({ key: m[1], value: complex ? raw : unquote(raw), complex });
    }
    i += n;
  }
  return out;
}

export function metaValue(frontmatter: string, key: string): string {
  const f = readMeta(frontmatter).find((x) => x.key === key);
  return f && !f.complex ? f.value : "";
}

/**
 * Sätter (eller tar bort, om värdet är tomt) ett fält och returnerar den nya
 * frontmattern. Finns ingen frontmatter skapas en. Med `multiline` sparas text
 * med radbrytningar som ett blockfält (`key: |`); annars blir det en rad.
 */
export function writeMeta(frontmatter: string, key: string, value: string, multiline = false): string {
  value = multiline
    ? value.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/^\n+|\s+$/g, "")
    : value.replace(/\s*\n\s*/g, " ").trim();
  const p = parse(frontmatter) ?? { open: "---\n", lines: [], close: "---\n\n" };
  const lines = value.includes("\n")
    ? [`${key}: |`, ...value.split("\n").map((l) => (l ? `  ${l}` : ""))]
    : [`${key}: ${quoteYaml(value)}`];
  const idx = p.lines.findIndex((l) => KEY_RE.exec(l)?.[1] === key);
  if (idx >= 0) {
    const raw = KEY_RE.exec(p.lines[idx])?.[2] ?? "";
    const n = continuation(p.lines, idx);
    // En lista eller ett objekt skrivs inte över – redigeras i Markdown-vyn.
    if ((!raw && n > 0) || /^[[{]/.test(raw)) return frontmatter;
    p.lines.splice(idx, 1 + n, ...(value ? lines : []));
  } else if (value) {
    p.lines.push(...lines);
  }
  if (!p.lines.some((l) => l.trim())) return ""; // tom frontmatter tas bort
  return `${p.open}${p.lines.join("\n")}\n${p.close}`;
}

/* ------------------------------------------------------------------ */
/* Längdmål och deadline                                               */
/* ------------------------------------------------------------------ */

export type LengthUnit = "tecken" | "ord";

export interface LengthTarget {
  amount: number;
  unit: LengthUnit;
}

/** "4500 tecken", "4 500 tkn", "800 ord" → mål. Ett tal utan enhet tolkas som tecken. */
export function parseLength(v: string): LengthTarget | null {
  const m = /^\s*(\d[\d\s ]*)\s*(tecken|tkn|ord|t)?\.?\s*$/i.exec(v);
  if (!m) return null;
  const amount = Number(m[1].replace(/[\s ]/g, ""));
  if (!amount) return null;
  return { amount, unit: m[2]?.toLowerCase() === "ord" ? "ord" : "tecken" };
}

export function formatLength(t: LengthTarget): string {
  return `${t.amount} ${t.unit}`;
}

/** "2026-10-09" (ev. med tid) → datum, annars null. */
export function parseDeadline(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(v.trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 23, m[5] ? +m[5] : 59);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "i dag", "i morgon", "om 3 dagar", "för 2 dagar sedan". */
export function deadlineText(d: Date, now = new Date()): { text: string; level: "late" | "soon" | "ok" } {
  const day = (x: Date) => Math.floor(new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime() / 86_400_000);
  const diff = day(d) - day(now);
  if (diff < 0 || (diff === 0 && d < now)) {
    const n = -diff;
    return { text: n === 0 ? "passerad i dag" : n === 1 ? "i går" : `för ${n} dagar sedan`, level: "late" };
  }
  if (diff === 0) return { text: "i dag", level: "soon" };
  if (diff === 1) return { text: "i morgon", level: "soon" };
  return { text: `om ${diff} dagar`, level: diff <= 3 ? "soon" : "ok" };
}
