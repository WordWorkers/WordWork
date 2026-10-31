import { Channel, invoke } from "@tauri-apps/api/core";
import { ipcRoute, type IpcRoute } from "./ipc-routes";

export interface DocumentInfo {
  id: string;
  name: string;
  modified: number;
  words: number;
}

export interface DocumentData {
  id: string;
  name: string;
  content: string;
  modified: number;
}

export interface Version {
  id: string;
  created: string;
  kind: "auto" | "manual" | "named" | "restore";
  label: string;
  words: number;
}

export interface SynonymGroup {
  word: string;
  base_form: boolean;
  synonyms: string[];
}

export interface ExportOptions {
  formats: { key: string; label: string; templates: boolean; pages?: boolean }[];
  templates: { key: string; label: string }[];
}

export interface AIStatus {
  enabled: boolean;
  configured?: boolean;
  reason?: string;
  host?: string;
  external?: boolean;
  default_model?: string;
  quick?: string[];
  api?: "ollama" | "openai";
  /** Can "Tänk efter först" be controlled? (Only with Ollama.) */
  think_control?: boolean;
}

export interface AIModel {
  name: string;
  size_gb: number;
  parameters: string;
  thinking: boolean;
}

export type AIEvent =
  | { type: "start"; question: string }
  | { type: "thinking" | "content"; text: string }
  | { type: "done"; model: string; tokens: number; seconds: number; tokens_per_second: number | null }
  | { type: "error"; message: string };

export interface AIChatRequest {
  model: string;
  think: boolean;
  prompt?: string;
  quick?: string;
  document: string;
  selection: string;
  history: { role: "user" | "assistant"; content: string }[];
  /** Rust saves question and answer in this conversation. */
  document_name?: string;
  chat_id?: string;
  label?: string;
}

export interface StoredMessage {
  role: "user" | "assistant";
  content?: string;
  label?: string;
  thinking?: string;
  meta?: string;
  error?: string;
}

export interface ChatSummary {
  id: string;
  created: string;
  updated: string;
  model: string;
  title: string;
  messages: number;
}

export interface Chat {
  id: string;
  created: string;
  updated: string;
  model: string;
  messages: StoredMessage[];
}

export interface TrashItem {
  id: string;
  kind: "document" | "chat";
  name: string;
  deleted: string;
  words?: number;
  history?: boolean;
  chats?: number;
  title?: string;
  messages?: number;
}

/** One document in the results of a search across all documents. */
export interface SearchHit {
  name: string;
  modified: number;
  /** The document's name matches. */
  name_match: boolean;
  /** Matches in the text. */
  count: number;
  /** The first few matches with some text around them. */
  snippets: { before: string; text: string; after: string }[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The answer streams over a Tauri Channel. Aborting behaves like an
 * aborted fetch (rejects with AbortError) and stops the request in Rust, which
 * saves the partial answer as "Avbrutet".
 */
async function aiChatStream(body: AIChatRequest, onEvent: (e: AIEvent) => void, signal: AbortSignal): Promise<void> {
  const requestId = crypto.randomUUID();
  const channel = new Channel<AIEvent>();
  let aborted = false;
  channel.onmessage = (e) => {
    if (!aborted) onEvent(e);
  };
  const abortError = () => new DOMException("Avbrutet", "AbortError");
  if (signal.aborted) throw abortError();
  const stopped = new Promise<never>((_, reject) =>
    signal.addEventListener(
      "abort",
      () => {
        aborted = true;
        void invoke("ai_cancel", { request_id: requestId }).catch(() => undefined);
        reject(abortError());
      },
      { once: true },
    ),
  );
  await Promise.race([
    invokeRoute<string>({ cmd: "ai_chat", args: { request_id: requestId, req: body, on_event: channel } }),
    stopped,
  ]);
}

/** Tauri command; Rust errors arrive as `{ status, detail }`. */
export async function invokeRoute<T>(route: IpcRoute): Promise<T> {
  try {
    if (route.raw) {
      const bytes = new Uint8Array(await route.raw.arrayBuffer());
      return (await invoke<T>(route.cmd, bytes, { headers: route.headers ?? {} })) ?? (undefined as T);
    }
    return (await invoke<T>(route.cmd, route.args)) ?? (undefined as T);
  } catch (e) {
    if (e && typeof e === "object" && "detail" in e) {
      const err = e as { status?: number; detail: string };
      throw new ApiError(err.status ?? 500, err.detail);
    }
    throw new ApiError(500, String(e));
  }
}

/** An API call: the route table in ipc-routes.ts picks the Tauri command. */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const route = ipcRoute(method, path, body);
  if (!route) throw new ApiError(404, `Okänt anrop: ${method} ${path}`);
  return invokeRoute<T>(route);
}

const doc = (name: string) => `/documents/${encodeURIComponent(name)}`;

export interface Health {
  status: "ok" | "error";
  version: string;
  problem: string | null;
  ai: boolean;
  language: boolean;
}

export const api = {
  health: () => request<Health>("GET", "/health"),
  list: () => request<DocumentInfo[]>("GET", "/documents"),
  search: (query: string, caseSensitive = false, wholeWord = false) =>
    request<SearchHit[]>(
      "GET",
      `/search?q=${encodeURIComponent(query)}&case=${caseSensitive ? 1 : 0}&word=${wholeWord ? 1 : 0}`,
    ),
  create: (name?: string, content = "") =>
    request<DocumentInfo>("POST", "/documents", { name, content }),
  get: (name: string) => request<DocumentData>("GET", doc(name)),
  save: (name: string, content: string, baseModified: number | null, snapshot = false) =>
    request<{ modified: number }>("PUT", doc(name), {
      content,
      base_modified: baseModified,
      snapshot,
    }),
  rename: (name: string, newName: string) =>
    request<DocumentInfo>("POST", `${doc(name)}/rename`, { name: newName }),
  remove: (name: string) => request<void>("DELETE", doc(name)),
  history: (name: string) => request<Version[]>("GET", `${doc(name)}/history`),
  settings: () => request<{ saved: boolean; settings: Record<string, unknown> }>("GET", "/settings"),
  saveSettings: (settings: object) => request<{ settings: Record<string, unknown> }>("PUT", "/settings", settings),
  trash: () => request<TrashItem[]>("GET", "/trash"),
  genres: () => request<{ key: string; label: string }[]>("GET", "/ai/genres"),
  restoreTrash: (id: string) =>
    request<{ kind: "document" | "chat"; name: string; id?: string }>("POST", `/trash/${encodeURIComponent(id)}/restore`),
  chats: (name: string) => request<ChatSummary[]>("GET", `${doc(name)}/chats`),
  chat: (name: string, id: string) => request<Chat>("GET", `${doc(name)}/chats/${encodeURIComponent(id)}`),
  saveChat: (name: string, id: string, model: string, messages: StoredMessage[]) =>
    request<ChatSummary>("PUT", `${doc(name)}/chats/${encodeURIComponent(id)}`, { model, messages }),
  removeChat: (name: string, id: string) => request<void>("DELETE", `${doc(name)}/chats/${encodeURIComponent(id)}`),
  version: (name: string, vid: string) =>
    request<{ id: string; content: string }>("GET", `${doc(name)}/history/${vid}`),
  snapshot: (name: string, label = "") =>
    request<{ created: boolean; version: Version | null }>("POST", `${doc(name)}/history`, {
      label,
    }),
  restore: (name: string, vid: string) =>
    request<{ modified: number; content: string }>(
      "POST",
      `${doc(name)}/history/${vid}/restore`,
    ),
  spellCheck: (words: string[]) =>
    request<{ misspelled: string[] }>("POST", "/spell/check", { words }),
  suggest: (word: string, limit = 6) =>
    request<{ word: string; suggestions: string[] }>(
      "GET",
      `/spell/suggest?word=${encodeURIComponent(word)}&limit=${limit}`,
    ),
  dictionary: () => request<{ words: string[] }>("GET", "/spell/dictionary"),
  dictionaryAdd: (word: string) =>
    request<{ words: string[] }>("POST", "/spell/dictionary", { word }),
  dictionaryRename: (word: string, newWord: string) =>
    request<{ words: string[] }>("PUT", `/spell/dictionary/${encodeURIComponent(word)}`, { word: newWord }),
  dictionaryReplace: (words: string[]) => request<{ words: string[] }>("PUT", "/spell/dictionary", { words }),
  dictionaryRemove: (word: string) =>
    request<{ words: string[] }>("DELETE", `/spell/dictionary/${encodeURIComponent(word)}`),
  synonyms: (word: string) =>
    request<{ word: string; groups: SynonymGroup[] }>(
      "GET",
      `/synonyms?word=${encodeURIComponent(word)}`,
    ),
  exportOptions: () => request<ExportOptions>("GET", "/export/formats"),
  exportUrl: (name: string, format: string, template: string, chapters = 0) =>
    `/api${doc(name)}/export?format=${encodeURIComponent(format)}&template=${encodeURIComponent(template)}` +
    (chapters ? `&chapters=${chapters}` : ""),
  importFile: (file: File) =>
    request<DocumentInfo>("POST", `/import?filename=${encodeURIComponent(file.name)}`, file),
  aiStatus: () => request<AIStatus>("GET", "/ai/status"),
  aiModels: () => request<{ models: AIModel[]; default_model: string }>("GET", "/ai/models"),
  /** Streams the AI answer as events; `signal` stops it. */
  aiChat: (body: AIChatRequest, onEvent: (e: AIEvent) => void, signal: AbortSignal): Promise<void> =>
    aiChatStream(body, onEvent, signal),
};
