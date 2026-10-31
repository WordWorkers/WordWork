use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio_util::sync::CancellationToken;
use ww_core::ai::{AiClient, AiConfig, ApiKind};
use ww_core::convert::Pandoc;
use ww_core::language::{Dictionaries, PersonalDictionary};
use ww_core::storage::Storage;
use ww_core::userdata::SettingsStore;

/// Everything that lives in the data folder. Swapped as a whole when the user
/// picks another folder.
pub struct DataCtx {
    pub storage: Storage,
    pub settings: SettingsStore,
    /// `.wordwork/ordlista.txt`
    pub personal: PersonalDictionary,
}

impl DataCtx {
    pub fn open(dir: &Path, snapshot_minutes: f64) -> Self {
        let storage = Storage::new(dir, snapshot_minutes);
        let settings = SettingsStore::new(storage.root());
        let personal = PersonalDictionary::new(storage.root().join(".wordwork").join("ordlista.txt"));
        Self { storage, settings, personal }
    }
}

pub struct AppState {
    pub data: RwLock<Arc<DataCtx>>,
    /// Where the chosen data folder is remembered.
    config_path: PathBuf,
    pub snapshot_minutes: f64,
    /// Loaded on a background thread at startup (≈0.2 s); `None` until ready.
    pub language: Arc<OnceLock<Result<Dictionaries, String>>>,
    pub pandoc: Pandoc,
    /// `None` = AI off (no server address).
    pub ai: RwLock<Option<AiClient>>,
    /// Running AI requests by id, so the UI can cancel them ("Stoppa").
    pub ai_running: Mutex<HashMap<String, CancellationToken>>,
    /// Notices documents changed outside the app.
    pub watcher: crate::watch::Watcher,
}

/// `<app config dir>/config.json` – app-level settings that can't live in the
/// data folder (because they say where the data folder is).
#[derive(Default, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    data_dir: Option<PathBuf>,
    /// AI server (Inställningar → AI-assistent). The key is in the system keyring.
    #[serde(default)]
    pub ai: AiSettings,
    /// Folder of the last export/backup, offered first in the Save dialog.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    save_dir: Option<PathBuf>,
}

impl AppState {
    pub fn new(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let resources = resource_dir(app);
        let language = Arc::new(OnceLock::new());
        {
            let language = language.clone();
            let dir = resources.join("sv");
            std::thread::Builder::new().name("language-load".into()).spawn(move || {
                let t = std::time::Instant::now();
                let r = Dictionaries::load(&dir).map_err(|e| e.detail);
                log::info!("language resources loaded in {:.1?} (ok: {})", t.elapsed(), r.is_ok());
                let _ = language.set(r);
            })?;
        }

        let config_path = app.path().app_config_dir()?.join("config.json");
        let snapshot_minutes = dev_env("WW_SNAPSHOT_MINUTES").and_then(|v| v.parse().ok()).unwrap_or(5.0);
        let data_dir = initial_data_dir(app, &config_path);
        log::info!("data folder: {}", data_dir.display());
        let data = RwLock::new(Arc::new(DataCtx::open(&data_dir, snapshot_minutes)));

        let ai = RwLock::new(AiClient::new(ai_config(&read_config_file(&config_path).ai)));
        Ok(Self {
            data,
            config_path,
            snapshot_minutes,
            language,
            pandoc: Pandoc::new(pandoc_path(), resources),
            ai,
            ai_running: Mutex::new(HashMap::new()),
            watcher: Default::default(),
        })
    }

    pub fn data(&self) -> Arc<DataCtx> {
        self.data.read().clone()
    }

    /// Switches to another data folder and remembers it.
    pub fn set_data_dir(&self, dir: &Path) -> ww_core::Result<()> {
        std::fs::create_dir_all(dir)
            .map_err(|e| ww_core::Error::bad_request(format!("Kan inte skapa {}: {e}", dir.display())))?;
        if let Some(problem) = ww_core::storage::data_dir_problem(dir) {
            return Err(ww_core::Error::bad_request(problem));
        }
        self.update_config(|c| c.data_dir = Some(dir.to_path_buf()))?;
        *self.data.write() = Arc::new(DataCtx::open(dir, self.snapshot_minutes));
        Ok(())
    }

    pub fn ai(&self) -> Option<AiClient> {
        self.ai.read().clone()
    }

    pub fn ai_settings(&self) -> AiSettings {
        self.read_config().ai
    }

    /// Saves the AI settings (and key, if given) and switches to the new server.
    pub fn set_ai(&self, settings: AiSettings, key: Option<&str>) -> ww_core::Result<()> {
        if let Some(k) = key {
            set_ai_key(k.trim())?;
        }
        let saved = settings.clone();
        self.update_config(|c| c.ai = saved)?;
        *self.ai.write() = AiClient::new(ai_config(&settings));
        Ok(())
    }

    pub fn read_config(&self) -> AppConfig {
        read_config_file(&self.config_path)
    }

    fn update_config(&self, f: impl FnOnce(&mut AppConfig)) -> ww_core::Result<()> {
        let mut cfg = self.read_config();
        f(&mut cfg);
        ww_core::storage::atomic_write(&self.config_path, &serde_json::to_string_pretty(&cfg).expect("json"))
    }

    /// Where the Save dialog starts: the last folder used, else Documents.
    pub fn save_dir(&self, app: &AppHandle) -> Option<PathBuf> {
        self.read_config().save_dir.filter(|d| d.is_dir()).or_else(|| app.path().document_dir().ok())
    }

    pub fn remember_save_dir(&self, file: &Path) {
        if let Some(dir) = file.parent() {
            let _ = self.update_config(|c| c.save_dir = Some(dir.to_path_buf()));
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AiSettings {
    #[serde(default)]
    pub api: ApiKind,
    /// Empty = AI off.
    #[serde(default = "default_ai_url")]
    pub url: String,
    #[serde(default)]
    pub model: String,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self { api: ApiKind::Ollama, url: default_ai_url(), model: String::new() }
    }
}

fn default_ai_url() -> String {
    "http://localhost:11434".into()
}

/// `WW_*` overrides for development and tests. Release builds ignore them, so
/// nothing in the environment can point the app at another Pandoc, data folder
/// or AI server (with the stored key).
pub fn dev_env(name: &str) -> Option<String> {
    if cfg!(debug_assertions) {
        std::env::var(name).ok()
    } else {
        None
    }
}

const KEYCHAIN_SERVICE: &str = "se.schiren.wordwork";
const KEYCHAIN_ACCOUNT: &str = "ai-api-key";

fn keychain() -> Option<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).ok()
}

/// The API key: `WW_AI_KEY` (debug builds) or the system keyring (macOS
/// Keychain, Windows Credential Manager, Secret Service on Linux).
pub fn ai_key() -> String {
    if let Some(k) = dev_env("WW_AI_KEY") {
        if !k.trim().is_empty() {
            return k.trim().to_string();
        }
    }
    keychain().and_then(|e| e.get_password().ok()).unwrap_or_default()
}

/// Stores (or with `""` removes) the key in the system keyring.
pub fn set_ai_key(key: &str) -> ww_core::Result<()> {
    let entry = keychain().ok_or_else(|| ww_core::Error::internal("Nyckelringen kan inte nås."))?;
    let r = if key.is_empty() {
        match entry.delete_credential() {
            Err(keyring::Error::NoEntry) => Ok(()),
            other => other,
        }
    } else {
        entry.set_password(key)
    };
    r.map_err(|e| ww_core::Error::internal(format!("Kunde inte spara nyckeln i nyckelringen: {e}")))
}

/// Do the `WW_AI_*` variables decide the AI server (dev, tests)?
pub fn ai_from_env() -> bool {
    ["WW_AI_URL", "WW_AI_API", "WW_AI_MODEL"].iter().any(|k| dev_env(k).is_some())
}

/// Settings → client config. `WW_AI_*` variables win (debug builds).
pub fn ai_config(saved: &AiSettings) -> AiConfig {
    let env = dev_env;
    let api = match env("WW_AI_API").map(|v| v.trim().to_lowercase()).as_deref() {
        Some("openai") => ApiKind::Openai,
        Some("ollama") => ApiKind::Ollama,
        _ => saved.api,
    };
    AiConfig {
        api,
        url: env("WW_AI_URL").or_else(|| env("WW_OLLAMA_URL")).unwrap_or_else(|| saved.url.clone()),
        model: env("WW_AI_MODEL").or_else(|| env("WW_OLLAMA_MODEL")).unwrap_or_else(|| saved.model.clone()),
        key: ai_key(),
    }
}

pub fn read_config_file(path: &Path) -> AppConfig {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// `WW_DATA_DIR` (dev, tests) → remembered folder → `~/Documents/Word Work`.
fn initial_data_dir(app: &AppHandle, config_path: &Path) -> PathBuf {
    if let Some(dir) = dev_env("WW_DATA_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    if let Some(dir) = read_config_file(config_path).data_dir {
        return dir;
    }
    app.path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map(|d| d.join("Word Work"))
        .unwrap_or_else(|_| PathBuf::from("Word Work"))
}

/// Bundled resources (`sv/`, `filters/`, `templates/`). Falls back to the repo
/// folder when running from `cargo run` without Tauri's resource copy.
fn resource_dir(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().resource_dir() {
        if dir.join("sv/sv_SE.dic").is_file() {
            return dir;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources")
}

/// The sidecar sits next to the app executable (`Contents/MacOS/ww-pandoc`, `/usr/bin/ww-pandoc`, or
/// `target/<profile>/pandoc` in dev). `WW_PANDOC` overrides; PATH is the last resort.
fn pandoc_path() -> PathBuf {
    if let Some(p) = dev_env("WW_PANDOC") {
        return p.into();
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(PathBuf::from)) {
        let p = dir.join(if cfg!(windows) { "ww-pandoc.exe" } else { "ww-pandoc" });
        if p.is_file() {
            return p;
        }
    }
    "pandoc".into()
}
