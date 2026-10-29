//! Phase 4: the AI assistant. Same JSON as the old `/api/ai/*` routes; the
//! answer streams over a Tauri `Channel` instead of NDJSON, and *Stoppa* calls
//! `ai_cancel`. The API key stays in Rust (Keychain) and never reaches the UI.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::State;
use tokio_util::sync::CancellationToken;
use ww_core::ai::{genres, quick_keys, run_chat, AIEvent, ApiKind, ChatRequest, Genre, ModelInfo, Outcome};
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
}

#[tauri::command(rename_all = "snake_case")]
pub fn ai_config_get(state: State<'_, AppState>) -> AiConfigView {
    let s = state.ai_settings();
    AiConfigView { api: s.api, url: s.url, model: s.model, has_key: !ai_key().is_empty(), from_env: ai_from_env() }
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
    let settings = AiSettings { api: config.api, url, model: config.model.trim().to_string() };
    state.set_ai(settings, config.key.as_deref())?;
    Ok(ai_config_get(state))
}

fn reqwest_url_ok(url: &str) -> Option<()> {
    let u = url::Url::parse(url).ok()?;
    (matches!(u.scheme(), "http" | "https") && u.host_str().is_some()).then_some(())
}
