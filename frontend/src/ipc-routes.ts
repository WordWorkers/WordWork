/**
 * Maps the old HTTP API (`/api/…`) to Tauri commands.
 *
 * `api.ts` asks this table first when running inside the Mac app; routes
 * without an entry still use `fetch`, which in `cargo tauri dev` reaches the old
 * Python backend through the Vite proxy. Each porting phase adds its routes
 * here – nothing else in the frontend has to change.
 */

export interface IpcRoute {
  cmd: string;
  args: Record<string, unknown>;
  /** Sent as the raw request body (file import) instead of JSON args. */
  raw?: Blob;
  headers?: Record<string, string>;
}

type Body = Record<string, unknown> | undefined;
type Handler = (params: string[], body: Body, query: URLSearchParams) => IpcRoute;

const routes: [string, RegExp, Handler][] = [];

function route(method: string, pattern: string, handler: Handler): void {
  // ":x" matches one encoded path segment.
  const re = new RegExp(`^${pattern.replace(/:[a-z]+/g, "([^/]+)")}$`);
  routes.push([method, re, handler]);
}

const r = (cmd: string, args: Record<string, unknown> = {}): IpcRoute => ({ cmd, args });

// ---------- Phase 1: documents, history, chats, trash, settings ----------
route("GET", "/health", () => r("health"));
route("GET", "/documents", () => r("doc_list"));
route("POST", "/documents", (_, b) => r("doc_create", { name: b?.name ?? null, content: b?.content ?? "" }));
route("GET", "/documents/:name", ([name]) => r("doc_get", { name }));
route("PUT", "/documents/:name", ([name], b) =>
  r("doc_save", { name, content: b?.content, base_modified: b?.base_modified ?? null, snapshot: !!b?.snapshot }),
);
route("POST", "/documents/:name/rename", ([name], b) => r("doc_rename", { name, new_name: b?.name }));
route("DELETE", "/documents/:name", ([name]) => r("doc_delete", { name }));
route("GET", "/documents/:name/history", ([name]) => r("history_list", { name }));
route("POST", "/documents/:name/history", ([name], b) => r("history_snapshot", { name, label: b?.label ?? "" }));
route("GET", "/documents/:name/history/:vid", ([name, vid]) => r("history_get", { name, vid }));
route("POST", "/documents/:name/history/:vid/restore", ([name, vid]) => r("history_restore", { name, vid }));
route("GET", "/documents/:name/chats", ([name]) => r("chat_list", { name }));
route("GET", "/documents/:name/chats/:cid", ([name, cid]) => r("chat_get", { name, cid }));
route("PUT", "/documents/:name/chats/:cid", ([name, cid], b) =>
  r("chat_save", { name, cid, model: b?.model ?? "", messages: b?.messages ?? [] }),
);
route("DELETE", "/documents/:name/chats/:cid", ([name, cid]) => r("chat_delete", { name, cid }));
route("GET", "/trash", () => r("trash_list"));
route("POST", "/trash/:entry/restore", ([entry]) => r("trash_restore", { entry }));
route("GET", "/settings", () => r("settings_get"));
route("PUT", "/settings", (_, b) => r("settings_put", { settings: b ?? {} }));

// ---------- Phase 2: spelling, personal dictionary, synonyms ----------
route("POST", "/spell/check", (_, b) => r("spell_check", { words: b?.words ?? [] }));
route("GET", "/spell/suggest", (_, __, q) =>
  r("spell_suggest", { word: q.get("word") ?? "", limit: Number(q.get("limit") ?? 6) }),
);
route("GET", "/spell/dictionary", () => r("dict_get"));
route("POST", "/spell/dictionary", (_, b) => r("dict_add", { word: b?.word ?? "" }));
route("PUT", "/spell/dictionary", (_, b) => r("dict_replace", { words: b?.words ?? [] }));
route("PUT", "/spell/dictionary/:word", ([word], b) => r("dict_rename", { word, new_word: b?.word ?? "" }));
route("DELETE", "/spell/dictionary/:word", ([word]) => r("dict_remove", { word }));
route("GET", "/synonyms", (_, __, q) => r("synonyms", { word: q.get("word") ?? "" }));

// ---------- Phase 3: export, import, backup ----------
route("GET", "/export/formats", () => r("export_formats"));
route("POST", "/import", (_, b, q) => ({
  cmd: "import_file",
  args: {},
  raw: b as unknown as Blob,
  // Headers are ASCII only – the name is URI-encoded and decoded in Rust.
  headers: { "x-filename": encodeURIComponent(q.get("filename") ?? "") },
}));

// ---------- Phase 4: AI assistant (the chat itself streams in api.aiChat) ----------
route("GET", "/ai/genres", () => r("ai_genres"));
route("GET", "/ai/status", () => r("ai_status"));
route("GET", "/ai/models", () => r("ai_models"));

/**
 * Downloads in the browser version (`<a download>`) become a native Save
 * dialog in the app. The command returns the saved file, or null if cancelled.
 */
const downloads: [RegExp, (params: string[], query: URLSearchParams) => IpcRoute][] = [
  [
    /^\/documents\/([^/]+)\/export$/,
    ([name], q) =>
      r("export_save", {
        name,
        format: q.get("format") ?? "docx",
        template: q.get("template") ?? "standard",
        chapters: Number(q.get("chapters") ?? 0),
      }),
  ],
  [/^\/backup$/, () => r("backup_save")],
];

/** The Save-dialog command for a download URL (`/api/…`), or null. */
export function downloadRoute(url: string): IpcRoute | null {
  const [p, q = ""] = url.replace(/^\/api/, "").split("?");
  for (const [re, handler] of downloads) {
    const m = re.exec(p);
    if (m) return handler(m.slice(1).map(decodeURIComponent), new URLSearchParams(q));
  }
  return null;
}

/** The Tauri command for an API call, or null if it isn't ported yet. */
export function ipcRoute(method: string, path: string, body?: unknown): IpcRoute | null {
  const [p, q = ""] = path.split("?");
  for (const [m, re, handler] of routes) {
    if (m !== method) continue;
    const match = re.exec(p);
    if (match) {
      const params = match.slice(1).map(decodeURIComponent);
      return handler(params, body as Body, new URLSearchParams(q));
    }
  }
  return null;
}
