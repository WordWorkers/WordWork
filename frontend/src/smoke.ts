/** Development smoke test (see `wwSmokeTest`). Imported by main.ts for its side effect. */
import { api, ApiError, invokeRoute } from "./api";
import { ipcRoute } from "./ipc-routes";
import { aiConfig, call, dataDir } from "./ipc";

/**
 * Smoke test of the Rust side through the real WebView. In the app's devtools
 * console: `await wwSmokeTest()`. `WW_SMOKE=1 cargo tauri dev` runs it
 * automatically and prints the results to the terminal. It creates and
 * deletes test documents (they end up in the trash).
 */
export async function wwSmokeTest(report = false): Promise<void> {
  const out = (label: string, value: unknown) => {
    const line = `${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`;
    console.log(line);
    if (report) void call("smoke_report", { line: label === "DONE" ? "DONE" : line });
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
    await checkShell(out);
    await checkAi(out);
    await checkStorage(out);
    await checkLanguage(out);
    await checkConvert(out);
  } catch (e) {
    out("FAILED", String((e as Error)?.message ?? e));
  }
  out("DONE", "");
}

type Out = (label: string, value: unknown) => void;

/** Reads through every GET route, then a write round trip. */
async function checkStorage(out: Out): Promise<void> {
  out("data_dir", await dataDir());
  const docs = await api.list();
  out("documents", docs.map((d) => `${d.name} (${d.words} ord)`));
  const paths = ["/documents", "/trash", "/settings"];
  for (const d of docs) {
    const n = `/documents/${encodeURIComponent(d.name)}`;
    paths.push(n, `${n}/history`, `${n}/chats`);
  }
  let read = 0;
  for (const path of paths) {
    const route = ipcRoute("GET", path);
    if (route) {
      await invokeRoute(route);
      read++;
    }
  }
  out("read routes", read);

  const created = await api.create("Röktest", "# Test\n\nEtt två tre.\n");
  const doc = await api.get(created.name);
  const saved = await api.save(created.name, doc.content + "\nFyra.\n", doc.modified, true);
  let conflict = "none";
  try {
    await api.save(created.name, "x", doc.modified);
  } catch (e) {
    conflict = `${(e as ApiError).status}`;
  }
  const renamed = await api.rename(created.name, "Röktest omdöpt");
  const hist = await api.history(renamed.name);
  await api.saveChat(renamed.name, "t1", "m", [{ role: "user", content: "Hej" }]);
  const chats = await api.chats(renamed.name);
  await api.remove(renamed.name);
  const trash = await api.trash();
  const entry = trash.find((t) => t.kind === "document" && t.name === "Röktest omdöpt");
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

/** Spelling for every word in the documents, synonyms, the personal dictionary. */
async function checkLanguage(out: Out): Promise<void> {
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

  const syn = await api.synonyms("vackra");
  out("synonyms vackra", syn.groups.map((g) => `${g.word}${g.base_form ? " (grundform)" : ""}: ${g.synonyms.slice(0, 3).join(", ")}`));

  const before = (await api.dictionary()).words;
  await api.dictionaryAdd("Röktestord");
  const flagged = (await api.spellCheck(["Röktestord", "röktestord"])).misspelled;
  await api.dictionaryRename("Röktestord", "röktest  fras");
  const renamed = (await api.dictionary()).words.includes("röktest fras");
  await api.dictionaryRemove("röktest fras");
  const after = (await api.dictionary()).words;
  out("personal dictionary", { flagged_after_add: flagged, renamed_to_phrase: renamed, restored: JSON.stringify(before) === JSON.stringify(after) });
}

/** Formats and imports (the Save dialogs need a person). */
async function checkConvert(out: Out): Promise<void> {
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
 * AI: status, models, one answer that is saved in a conversation, and one
 * that is stopped half-way (saved as "Avbrutet"). Skipped without a server
 * (`python3 tools/fake_ollama.py` is enough).
 */
async function checkAi(out: Out): Promise<void> {
  out("ai config", await aiConfig());
  const status = await api.aiStatus();
  out("ai status", status);
  if (!status.enabled) return;
  const models = await api.aiModels();
  out("ai models", models.models.map((m) => m.name));
  const doc = await api.create("Röktest AI", "---\ntitle: Test\ngenre: prosa\n---\n\nEn text om vår tid och samtid.\n");
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

/** Rich clipboard and link safety (menus and closing are tested by hand). */
async function checkShell(out: Out): Promise<void> {
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

(window as unknown as { wwSmokeTest: typeof wwSmokeTest }).wwSmokeTest = wwSmokeTest;
