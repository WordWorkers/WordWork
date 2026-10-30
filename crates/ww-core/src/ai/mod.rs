//! AI assistant: Ollama and OpenAI-compatible servers.
//!
//! Ground rule: the AI never writes in the document. This module has no access
//! to the text except what the caller passes in, and its answers are shown in
//! a separate panel. (The session saves the conversation, never the document.)

mod messages;
mod ollama;
mod openai;
pub mod prompts;
mod session;

use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

pub use messages::{
    build_messages, context_size, genres, is_external, parse_meta, quick_keys, quick_prompt, text_guidance, Genre,
    Message, MAX_DOCUMENT_CHARS,
};
pub use openai::{api_base, ThinkSplitter};
pub use session::{run_chat, ChatRequest};

use crate::error::{Error, Result};

/// Same shapes as `AIEvent` in `frontend/src/api.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum AIEvent {
    Start { question: String },
    Thinking { text: String },
    Content { text: String },
    Done { model: String, tokens: u64, seconds: f64, tokens_per_second: Option<f64> },
    Error { message: String },
}

/// How a stream ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Finished,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ModelInfo {
    pub name: String,
    pub size_gb: f64,
    pub parameters: String,
    pub thinking: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ApiKind {
    /// Ollama's own API: context window and "think" can be controlled.
    #[default]
    Ollama,
    /// OpenAI-compatible API (OpenAI, OpenRouter, vLLM, LM Studio, llama.cpp …).
    Openai,
}

/// Where the AI server is. The key is only ever kept here, never sent to the UI.
#[derive(Debug, Clone, Default)]
pub struct AiConfig {
    pub api: ApiKind,
    /// Empty = AI off.
    pub url: String,
    /// Empty = first chat model the server lists.
    pub model: String,
    pub key: String,
}

#[derive(Default)]
struct Cache {
    models: Option<(Vec<ModelInfo>, Instant)>,
    availability: Option<((bool, String), Instant)>,
}

/// One AI server. Cheap to clone (shared HTTP client and cache).
#[derive(Clone)]
pub struct AiClient {
    pub config: AiConfig,
    http: reqwest::Client,
    cache: Arc<Mutex<Cache>>,
}

/// Short, readable name for a transport error (Python showed the class name).
pub(crate) fn describe(e: &reqwest::Error) -> &'static str {
    if e.is_timeout() {
        "tidsgränsen nåddes"
    } else if e.is_connect() {
        "ingen anslutning"
    } else if e.is_decode() || e.is_body() {
        "ogiltigt svar"
    } else {
        "nätverksfel"
    }
}

impl AiClient {
    /// `None` if no URL is configured (AI off).
    pub fn new(mut config: AiConfig) -> Option<Self> {
        config.url = config.url.trim().trim_end_matches('/').to_string();
        if config.url.is_empty() {
            return None;
        }
        let http = reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).build().expect("reqwest client");
        Some(Self { config, http, cache: Arc::new(Mutex::new(Cache::default())) })
    }

    pub fn default_model(&self) -> &str {
        &self.config.model
    }

    /// Host name without port, for "the text is sent to …".
    pub fn host(&self) -> String {
        reqwest::Url::parse(&self.config.url)
            .ok()
            .and_then(|u| u.host_str().map(|h| h.trim_start_matches('[').trim_end_matches(']').to_string()))
            .unwrap_or_default()
    }

    pub fn external(&self) -> bool {
        is_external(&self.config.url)
    }

    /// Can "Tänk efter först" be switched? (Only with Ollama.)
    pub fn think_control(&self) -> bool {
        self.config.api == ApiKind::Ollama
    }

    /// Is the server reachable and does it have a chat model? Cached for a short
    /// while, so the app works as usual (without AI) when the server is down.
    pub async fn availability(&self) -> (bool, String) {
        if let Some(((ok, reason), at)) = self.cache.lock().availability.clone() {
            let ttl = Duration::from_secs(if ok { 30 } else { 15 });
            if at.elapsed() < ttl {
                return (ok, reason);
            }
        }
        let result = match self.config.api {
            ApiKind::Ollama => ollama::availability(self).await,
            ApiKind::Openai => openai::availability(self).await,
        };
        self.cache.lock().availability = Some((result.clone(), Instant::now()));
        result
    }

    /// Chat models on the server (embedding, OCR, audio … filtered out). Cached 60 s.
    pub async fn models(&self) -> Result<Vec<ModelInfo>> {
        if let Some((models, at)) = self.cache.lock().models.clone() {
            if !models.is_empty() && at.elapsed() < Duration::from_secs(60) {
                return Ok(models);
            }
        }
        let models = match self.config.api {
            ApiKind::Ollama => ollama::models(self).await?,
            ApiKind::Openai => openai::models(self, Duration::from_secs(30)).await?,
        };
        self.cache.lock().models = Some((models.clone(), Instant::now()));
        Ok(models)
    }

    /// Streams the answer to `emit`. Returns `Cancelled` if `cancel` fired first.
    pub async fn chat(
        &self,
        model: &str,
        messages: &[Message],
        think: bool,
        num_ctx: usize,
        cancel: &CancellationToken,
        emit: &mut (dyn FnMut(AIEvent) + Send),
    ) -> Result<Outcome> {
        let model = if model.is_empty() { self.config.model.as_str() } else { model };
        match self.config.api {
            ApiKind::Ollama => ollama::chat(self, model, messages, think, num_ctx, cancel, emit).await,
            ApiKind::Openai => openai::chat(self, model, messages, cancel, emit).await,
        }
    }
}

/// Python's `round(x, 1)` for the statistics shown after an answer.
pub(crate) fn round1(x: f64) -> f64 {
    (x * 10.0).round_ties_even() / 10.0
}

pub(crate) fn bad_gateway(msg: impl Into<String>) -> Error {
    Error::bad_gateway(msg)
}
