/**
 * Direct Tauri commands for the settings that have no route in
 * ipc-routes.ts: the data folder and the AI server. Everything else goes
 * through `api` in api.ts.
 */
import { invokeRoute } from "./api";

/** `invoke` with errors mapped to ApiError (Rust sends `{ status, detail }`). */
export const call = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => invokeRoute<T>({ cmd, args: args ?? {} });

// ---------- data folder ----------

export interface DataDir {
  path: string;
  problem: string | null;
}

export const dataDir = () => call<DataDir>("data_dir_get");
/** Native folder picker; null if cancelled. */
export const chooseDataDir = () => call<DataDir | null>("data_dir_choose");
export const revealDataDir = () => call<void>("data_dir_reveal");

// ---------- AI server settings ----------

export interface AiConfig {
  api: "ollama" | "openai";
  url: string;
  model: string;
  /** A key is stored in the system keyring (the key itself never reaches the UI). */
  has_key: boolean;
  /** WW_AI_* environment variables override the settings (debug builds). */
  from_env: boolean;
  /** The address moved to another server, so the stored key was removed. */
  key_removed?: boolean;
}

export const aiConfig = () => call<AiConfig>("ai_config_get");
/** `key`: undefined = keep the stored key, "" = remove it. */
export const saveAiConfig = (config: { api: string; url: string; model: string; key?: string }) =>
  call<AiConfig>("ai_config_set", { config });
