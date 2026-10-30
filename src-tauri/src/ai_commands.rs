//! Phase 4: the AI assistant. Same JSON as the old `/api/ai/*` routes; the
//! answer streams over a Tauri `Channel` instead of NDJSON, and *Stoppa* calls
//! `ai_cancel`. The API key stays in Rust (Keychain) and never reaches the UI.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::State;
use tokio_util::sync::CancellationToken;
use ww_core::ai::{
    genres, is_external, quick_keys, run_chat, AIEvent, ApiKind, ChatRequest, Genre, ModelInfo, Outcome,
};
use ww_core::{Error, Result};

use crate::state::{ai_from_env, ai_key, AiSettings, AppState};

#[tauri::command(rename_all = "snake_case")]
pub fn ai_genres() -> Vec<Genre> {
    genres()
}

#[tauri::command(rename_all = "snake_case")]
pub async fn ai_status(state: State<'_, AppState>) -> Result<Value> {
    let Some(ai) = state.ai() else {
        return Ok(json!({
            "enabled": false,
            "reason": "AI-stödet är avstängt (ingen AI-server angiven under Inställningar → AI-assistent).",
        }));
    };
    let (available, reason) = ai.availability().await;
    if !available {
        return Ok(json!({ "enabled": false, "configured": true, "reason": reason }));
    }
    Ok(json!({
        "enabled": true,
        "host": ai.host(),
        "external": ai.external(),
        "default_model": ai.default_model(),
        "quick": quick_keys(),
        "api": ai.config.api,
        "think_control": ai.think_control(),
    }))
}

#[derive(Serialize)]
pub struct Models {
    models: Vec<ModelInfo>,
    default_model: String,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn ai_models(state: State<'_, AppState>) -> Result<Models> {
    let ai = state.ai().ok_or_else(|| Error::not_found("AI-stödet är avstängt."))?;
    Ok(Models { models: ai.models().await?, default_model: ai.default_model().to_string() })
}

/// Streams the answer over `on_event`; returns "finished" or "cancelled".
/// Errors before streaming are returned (as HTTP errors were); errors while
/// streaming arrive as an `error` event and are saved in the conversation.
#[tauri::command(rename_all = "snake_case")]
pub async fn ai_chat(
    state: State<'_, AppState>,
    request_id: String,
    req: ChatRequest,
    on_event: Channel<AIEvent>,
) -> Result<&'static str> {
    let ai = state.ai().ok_or_else(|| Error::not_found("AI-stödet är avstängt."))?;
    let token = CancellationToken::new();
    state.ai_running.lock().unwrap().insert(request_id.clone(), token.clone());
    let ctx = state.data();
    let result = run_chat(&ai, &ctx.storage, req, &token, &mut |ev| {
        let _ = on_event.send(ev);
    })
    .await;
    state.ai_running.lock().unwrap().remove(&request_id);
    Ok(match result? {
        Outcome::Finished => "finished",
        Outcome::Cancelled => "cancelled",
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn ai_cancel(state: State<'_, AppState>, request_id: String) -> bool {
    match state.ai_running.lock().unwrap().remove(&request_id) {
        Some(token) => {
            token.cancel();
            true
        }
        None => false,
    }
}

#[derive(Serialize)]
pub struct AiConfigView {
    api: ApiKind,
    url: String,
    model: String,
    /// A key is stored – the key itself is never sent to the UI.
    has_key: bool,
    /// `WW_AI_*` environment variables override these settings (dev).
    from_env: bool,
    /// The address moved to another server, so the stored key was removed.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    key_removed: bool,
}

#[tauri::command(rename_all = "snake_case")]
pub fn ai_config_get(state: State<'_, AppState>) -> AiConfigView {
    let s = state.ai_settings();
    AiConfigView {
        api: s.api,
        url: s.url,
        model: s.model,
        has_key: !ai_key().is_empty(),
        from_env: ai_from_env(),
        key_removed: false,
    }
}

#[derive(Deserialize)]
pub struct AiConfigInput {
    api: ApiKind,
    url: String,
    #[serde(default)]
    model: String,
    /// `None` = keep the stored key, `""` = remove it.
    #[serde(default)]
    key: Option<String>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn ai_config_set(state: State<'_, AppState>, config: AiConfigInput) -> Result<AiConfigView> {
    let url = config.url.trim().to_string();
    if !url.is_empty() && reqwest_url_ok(&url).is_none() {
        return Err(Error::bad_request("Adressen måste börja med http:// eller https://."));
    }
    let (key, key_removed) = key_update(!ai_key().is_empty(), config.key, &state.ai_settings().url, &url)?;
    let settings = AiSettings { api: config.api, url, model: config.model.trim().to_string() };
    state.set_ai(settings, key.as_deref())?;
    Ok(AiConfigView { key_removed, ..ai_config_get(state) })
}

fn reqwest_url_ok(url: &str) -> Option<()> {
    let u = url::Url::parse(url).ok()?;
    (matches!(u.scheme(), "http" | "https") && u.host_str().is_some()).then_some(())
}

/// What to do with the API key when the settings are saved: `(key to store
/// – None = keep, "" = remove –, removed because the server changed)`.
/// A key belongs to the server it was entered for: when the address moves to
/// another server it is removed rather than sent there, and it is never sent
/// unencrypted outside this computer / the local network.
fn key_update(stored: bool, input: Option<String>, old_url: &str, new_url: &str) -> Result<(Option<String>, bool)> {
    let mut key = input.map(|k| k.trim().to_string());
    let removed = key.is_none() && stored && origin(old_url) != origin(new_url);
    if removed {
        key = Some(String::new());
    }
    let will_have_key = key.as_deref().map_or(stored, |k| !k.is_empty());
    if will_have_key && plain_http_external(new_url) {
        return Err(Error::bad_request(
            "En API-nyckel skickas aldrig okrypterat till en server utanför datorn eller nätverket. Använd https://.",
        ));
    }
    Ok((key, removed))
}

/// Scheme, host and port – what decides where the key is sent.
fn origin(url: &str) -> Option<String> {
    url::Url::parse(url.trim()).ok().map(|u| u.origin().ascii_serialization())
}

/// `http://` to a host outside this computer / the local network.
fn plain_http_external(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|u| u.scheme() == "http") && is_external(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_rules() {
        assert_eq!(origin("https://api.openai.com/v1"), origin("https://api.openai.com"));
        assert_ne!(origin("https://api.openai.com"), origin("https://evil.example"));
        assert_ne!(origin("http://localhost:11434"), origin("http://localhost:1234"));
        assert_ne!(origin(""), origin("https://api.openai.com"));
        assert!(plain_http_external("http://api.example.com"));
        assert!(!plain_http_external("https://api.example.com"));
        assert!(!plain_http_external("http://localhost:11434"));
        assert!(!plain_http_external("http://192.168.1.20:11434"));
        assert!(!plain_http_external("http://mac-mini.local:11434"));
    }

    #[test]
    fn key_follows_server() {
        let one = "https://api.one.example";
        // Same server (other path): the stored key is kept.
        assert_eq!(key_update(true, None, one, "https://api.one.example/v1").unwrap(), (None, false));
        // Another server: removed instead of sent there.
        assert_eq!(key_update(true, None, one, "https://api.two.example").unwrap(), (Some(String::new()), true));
        // Another server with a new key: the new key is stored.
        assert_eq!(
            key_update(true, Some(" sk-2 ".into()), one, "https://api.two.example").unwrap(),
            (Some("sk-2".into()), false)
        );
        // No stored key: nothing to remove.
        assert_eq!(key_update(false, None, one, "https://api.two.example").unwrap(), (None, false));
        // Plain http outside the network: refused with a key, fine without.
        assert!(key_update(false, Some("sk".into()), one, "http://api.two.example").is_err());
        assert!(key_update(true, None, "http://api.two.example", "http://api.two.example").is_err());
        assert_eq!(key_update(false, None, one, "http://api.two.example").unwrap(), (None, false));
        assert_eq!(
            key_update(true, Some(String::new()), one, "http://api.two.example").unwrap(),
            (Some(String::new()), false)
        );
        // Plain http on the local network: fine.
        assert!(key_update(false, Some("sk".into()), one, "http://localhost:1234").is_ok());
    }
}
