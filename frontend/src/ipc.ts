/**
 * App-only helpers (data folder, AI server settings) and the development
 * smoke test `wwSpike()`. The normal API calls go through `api` in api.ts,
 * which routes them to Rust via ipc-routes.ts.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { api, ApiError } from "./api";
import { ipcRoute } from "./ipc-routes";

export { isTauri };

/** `invoke` with errors mapped to ApiError (Rust sends `{ status, detail }`). */
export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    if (e && typeof e === "object" && "detail" in e) {
      const err = e as { status?: number; detail: string };
      throw new ApiError(err.status ?? 500, err.detail);
    }
    throw new ApiError(500, String(e));
  }
}

/**
 * Phase 0 smoke test. In the app's devtools console: `await wwSpike()`.
 * `WW_SPIKE=1 cargo tauri dev` runs it automatically and prints to the terminal.
 */
export async function wwSpike(report = false): Promise<void> {
  const out = (label: string, value: unknown) => {
    const line = `${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`;
    console.log(line);
    if (report) void call("spike_report", { line: label === "DONE" ? "DONE" : line });
  };
  try {
    out("health", await call("health"));
    out("spell_check", await call("spell_check", { words: ["kulturjournalisterna", "fellstavat", "Ålgång", "tyvär"] }));
    out("spell_suggest", await call("spell_suggest", { word: "kulturjornalist" }));
    out("synonyms", await call("synonyms", { word: "husen" }));
    try {
      await call("synonyms_missing_command");
    } catch (e) {
      out("error mapping", `${(e as ApiError).status} ${(e as ApiError).message}`);
    }
    await phase5(out);
    await phase4(out);
    await phase1(out);
    await phase2(out);
    await phase3(out);
  } catch (e) {
    out("FAILED", String((e as Error)?.message ?? e));
  }
  out("DONE", "");
}

/**
 * Phase 1 check. Reads the same data through Rust (IPC) and, if the old
 * backend runs behind the Vite proxy on a copy of the same folder, through
 * Python – and compares. Then a write round trip through `api` (Rust only).
 */
/** JSON with sorted keys, so key order doesn't count as a difference. */
function canon(v: unknown): string {
  return JSON.stringify(v, (_, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([p], [q]) => p.localeCompare(q)))
      : x,
  );
}

async function phase1(out: (label: string, value: unknown) => void): Promise<void> {
  const viaPython = async (path: string): Promise<unknown> => {
    const res = await fetch(`/api${path}`);
    return res.ok ? res.json() : `HTTP ${res.status}`;
  };
  out("data_dir", await dataDir());
  const docs = await api.list();
  out("documents", docs.map((d) => `${d.name} (${d.words} ord)`));
  // Old backend reachable (behind the Vite proxy)? Otherwise skip the comparison.
  const probe = await viaPython("/documents").catch(() => null);
  const python = typeof probe === "string" ? null : probe;
  const paths = ["/documents", "/trash", "/settings"];
  for (const d of docs) {
    const n = `/documents/${encodeURIComponent(d.name)}`;
    paths.push(n, `${n}/history`, `${n}/chats`);
  }
  let same = 0;
  const diffs: string[] = [];
  for (const path of paths) {
    const route = ipcRoute("GET", path);
    if (!route) continue;
    const mine = await call(route.cmd, route.args);
    if (python === null) continue;
    const theirs = await viaPython(path);
    const a = canon(mine);
    const b = canon(theirs);
    if (a === b) same++;
    else diffs.push(`${path} | rust: ${a.slice(0, 600)} | python: ${b.slice(0, 600)}`);
  }
  out("parity with python", python === null ? "skipped (no backend)" : { same, differ: diffs.length });
  for (const d of diffs) out("DIFF", d);

  // Write round trip through the normal api object (routes → Rust).
  const created = await api.create("Fas 1-test", "# Test\n\nEtt två tre.\n");
  const doc = await api.get(created.name);
  const saved = await api.save(created.name, doc.content + "\nFyra.\n", doc.modified, true);
  let conflict = "none";
  try {
    await api.save(created.name, "x", doc.modified);
  } catch (e) {
    conflict = `${(e as ApiError).status}`;
  }
  const renamed = await api.rename(created.name, "Fas 1-test omdöpt");
  const hist = await api.history(renamed.name);
  await api.saveChat(renamed.name, "t1", "m", [{ role: "user", content: "Hej" }]);
  const chats = await api.chats(renamed.name);
  await api.remove(renamed.name);
  const trash = await api.trash();
  const entry = trash.find((t) => t.kind === "document" && t.name === "Fas 1-test omdöpt");
  const restored = entry ? await api.restoreTrash(entry.id) : null;
  if (restored) await api.remove(restored.name);
  out("round trip", {
    created: created.name,
    savedNewer: saved.modified >= doc.modified,
    conflict,
    renamed: renamed.name,
    versions: hist.length,
    chats: chats.length,
    trashEntry: entry?.kind,
    restored: restored?.name,
  });
}

/**
 * Phase 2 check: spelling and synonyms for every word in the documents,
 * through `api` (Rust) and – if it runs – the old backend; then a personal
 * dictionary round trip.
 */
async function phase2(out: (label: string, value: unknown) => void): Promise<void> {
  const words = new Set<string>();
  for (const d of await api.list()) {
    const { content } = await api.get(d.name);
    for (const w of content.match(/[\p{L}\p{N}_]+(?:[-'’][\p{L}\p{N}_]+)*/gu) ?? []) words.add(w);
  }
  const list = [...words];
  const t0 = performance.now();
  const { misspelled } = await api.spellCheck(list);
  const checkMs = Math.round(performance.now() - t0);
  const sample = misspelled.slice(0, 5);
  const t1 = performance.now();
  const suggestions = await Promise.all(sample.map((w) => api.suggest(w)));
  out("spelling", {
    words: list.length,
    misspelled: misspelled.length,
    check_ms: checkMs,
    suggest_ms: Math.round(performance.now() - t1),
    examples: suggestions.map((s) => `${s.word} → ${s.suggestions.slice(0, 3).join(", ")}`),
  });

  const res = await fetch("/api/spell/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ words: list }),
  }).catch(() => null);
  if (res?.ok) {
    const py = new Set(((await res.json()) as { misspelled: string[] }).misspelled);
    const rs = new Set(misspelled);
    out("spelling vs python", {
      same: [...rs].filter((w) => py.has(w)).length,
      only_rust: [...rs].filter((w) => !py.has(w)),
      only_python: [...py].filter((w) => !rs.has(w)),
    });
  } else out("spelling vs python", "skipped (no backend)");

  const syn = await api.synonyms("vackra");
  out("synonyms vackra", syn.groups.map((g) => `${g.word}${g.base_form ? " (grundform)" : ""}: ${g.synonyms.slice(0, 3).join(", ")}`));

  const before = (await api.dictionary()).words;
  await api.dictionaryAdd("Fasvåtestord");
  const flagged = (await api.spellCheck(["Fasvåtestord", "fasvåtestord"])).misspelled;
  await api.dictionaryRename("Fasvåtestord", "fasvå  testfras");
  const renamed = (await api.dictionary()).words.includes("fasvå testfras");
  await api.dictionaryRemove("fasvå testfras");
  const after = (await api.dictionary()).words;
  out("personal dictionary", { flagged_after_add: flagged, renamed_to_phrase: renamed, restored: canon(before) === canon(after) });
}

/** Phase 3 check: formats and imports through `api` (Save dialogs need a person). */
async function phase3(out: (label: string, value: unknown) => void): Promise<void> {
  const opts = await api.exportOptions();
  out("export formats", opts.formats.map((f) => f.key));
  const cp1252 = new Uint8Array([0xc5, 0x73, 0x61, 0x20, 0x70, 0xe5, 0x20, 0xf6, 0x6e, 0x0d, 0x0a]); // "Åsa på ön\r\n"
  const files = [
    new File([cp1252], "Gammal: fil?.txt"),
    new File(["<h2>Rubrik</h2><p>Hej <u>under</u> x<sup>2</sup></p>"], "webb.html"),
    new File(["x"], "bild.png"),
  ];
  const results: string[] = [];
  for (const f of files) {
    try {
      const doc = await api.importFile(f);
      const { content } = await api.get(doc.name);
      results.push(`${f.name} → ”${doc.name}”: ${JSON.stringify(content)}`);
      await api.remove(doc.name);
    } catch (e) {
      results.push(`${f.name} → ${(e as ApiError).status} ${(e as ApiError).message}`);
    }
  }
  out("import", results);
}

/**
 * Phase 4 check: status, models, one answer that is saved in a conversation,
 * and one that is stopped half-way (saved as "Avbrutet").
 */
async function phase4(out: (label: string, value: unknown) => void): Promise<void> {
  out("ai config", await aiConfig());
  const status = await api.aiStatus();
  out("ai status", status);
  if (!status.enabled) return;
  const models = await api.aiModels();
  out("ai models", models.models.map((m) => m.name));
  const doc = await api.create("Fas 4-test", "---\ntitle: Test\ngenre: prosa\n---\n\nEn text om vår tid och samtid.\n");
  const ask = async (stopAfterMs: number | null) => {
    const ctrl = new AbortController();
    const kinds: Record<string, number> = {};
    if (stopAfterMs !== null) setTimeout(() => ctrl.abort(), stopAfterMs);
    let outcome = "ok";
    try {
      await api.aiChat(
        { model: "", think: true, prompt: "", quick: "repetition", document: (await api.get(doc.name)).content,
          selection: "", history: [], document_name: doc.name, chat_id: "t1", label: "Hitta upprepningar" },
        (e) => (kinds[e.type] = (kinds[e.type] ?? 0) + 1),
        ctrl.signal,
      );
    } catch (e) {
      outcome = (e as Error).name;
    }
    return { outcome, events: kinds };
  };
  out("ai answer", await ask(null));
  out("ai stopped", await ask(400));
  await new Promise((r) => setTimeout(r, 300)); // let Rust save the stopped answer
  const chat = await api.chat(doc.name, "t1");
  out("ai saved", chat.messages.map((m) => `${m.role}: ${m.label ?? ""}${m.meta ? ` [${m.meta}]` : ""} ${(m.content ?? "").slice(0, 40)}`));
  await api.remove(doc.name);
}

/** Phase 5 check: rich clipboard and link safety (menus/close are tested by hand). */
async function phase5(out: (label: string, value: unknown) => void): Promise<void> {
  await call("clipboard_write_html", { html: "<p><strong>Fet</strong> och <em>kursiv</em></p>", text: "Fet och kursiv" });
  out("clipboard", "written – read it within 3 s");
  await new Promise((r) => setTimeout(r, 3000));
  for (const url of ["javascript:alert(1)", "file:///etc/passwd"]) {
    try {
      await call("open_url", { url });
      out("open_url", `${url} NOT rejected`);
    } catch (e) {
      out("open_url", `${url} → ${(e as ApiError).status} ${(e as ApiError).message}`);
    }
  }
}

if (isTauri()) (window as unknown as { wwSpike: typeof wwSpike }).wwSpike = wwSpike;

// ---------- data folder (Phase 1) ----------

export interface DataDir {
  path: string;
  problem: string | null;
}

export const dataDir = () => call<DataDir>("data_dir_get");
/** Native folder picker; null if cancelled. */
export const chooseDataDir = () => call<DataDir | null>("data_dir_choose");
export const revealDataDir = () => call<void>("data_dir_reveal");

// ---------- AI server settings (Phase 4) ----------

export interface AiConfig {
  api: "ollama" | "openai";
  url: string;
  model: string;
  /** A key is stored in the Keychain (the key itself never reaches the UI). */
  has_key: boolean;
  /** WW_AI_* environment variables override the settings (development). */
  from_env: boolean;
}

export const aiConfig = () => call<AiConfig>("ai_config_get");
/** `key`: undefined = keep the stored key, "" = remove it. */
export const saveAiConfig = (config: { api: string; url: string; model: string; key?: string }) =>
  call<AiConfig>("ai_config_set", { config });
