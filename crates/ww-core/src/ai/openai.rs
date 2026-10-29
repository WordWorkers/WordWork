//! OpenAI-compatible API (`/v1/models`, `/v1/chat/completions`): OpenAI,
//! OpenRouter, vLLM, LM Studio, llama.cpp server, Ollama's `/v1` …
//!
//! Differences from Ollama mode: the context window is decided by the server,
//! "Tänk efter först" can't be switched (reasoning the server sends –
//! `reasoning_content`/`reasoning` or `<think>` tags – is shown), and the model
//! list only has names.

use std::sync::LazyLock;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::{bad_gateway, describe, round1, AIEvent, AiClient, Message, ModelInfo, Outcome};
use crate::error::Result;

/// Models that are not chat models, by name.
static NOT_CHAT: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)embed|ocr|whisper|tts|transcribe|dall-e|image|moderation|rerank|audio|realtime|davinci|babbage|sora|speech",
    )
    .expect("regex")
});

/// Base URL of the API. "/v1" is added if the path has no version part.
pub fn api_base(url: &str) -> String {
    static VERSION: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"/v\d+(?:beta\d*)?(?:/|$)").expect("regex"));
    let url = url.trim_end_matches('/');
    let path = reqwest::Url::parse(url).map(|u| u.path().to_string()).unwrap_or_default();
    if VERSION.is_match(&path) {
        url.to_string()
    } else {
        format!("{url}/v1")
    }
}

fn request(c: &AiClient, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
    let r = c.http.request(method, format!("{}{path}", api_base(&c.config.url)));
    if c.config.key.is_empty() {
        r
    } else {
        r.bearer_auth(&c.config.key)
    }
}

fn error_text(status: u16, body: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let mut msg = body.to_string();
    if let Some(v) = parsed {
        let err = v.get("error").cloned().unwrap_or(v);
        let m = match &err {
            Value::Object(o) => o.get("message").cloned().unwrap_or(Value::Null),
            other => other.clone(),
        };
        msg = match m {
            Value::String(s) if !s.is_empty() => s,
            Value::Null => msg,
            other => other.to_string(),
        };
    }
    let body: String = msg.trim().chars().take(300).collect();
    match status {
        401 => {
            format!("API-nyckeln godkändes inte (401). Kontrollera nyckeln under Inställningar → AI-assistent. {body}")
                .trim()
                .to_string()
        }
        403 => format!("Servern nekade åtkomst (403): {body}"),
        404 => format!("Hittades inte (404) – stämmer adressen och modellnamnet? {body}").trim().to_string(),
        429 => format!("För många förfrågningar eller slut på kvot (429): {body}"),
        _ => format!("AI-servern svarade med fel ({status}): {body}"),
    }
}

pub(super) async fn availability(c: &AiClient) -> (bool, String) {
    match models(c, Duration::from_secs(3)).await {
        Ok(m) if !m.is_empty() => (true, String::new()),
        Ok(_) => (false, "AI-servern har ingen chattmodell.".into()),
        Err(e) => (false, e.detail),
    }
}

pub(super) async fn models(c: &AiClient, timeout: Duration) -> Result<Vec<ModelInfo>> {
    let base = api_base(&c.config.url);
    let res = request(c, reqwest::Method::GET, "/models")
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| bad_gateway(format!("AI-servern på {base} kan inte nås ({}).", describe(&e))))?;
    let status = res.status().as_u16();
    let default = c.config.model.clone();
    if matches!(status, 404 | 405 | 501) && !default.is_empty() {
        // The server doesn't list models – use the configured one.
        return Ok(vec![ModelInfo { name: default, size_gb: 0.0, parameters: String::new(), thinking: false }]);
    }
    let text = res.text().await.unwrap_or_default();
    if status != 200 {
        return Err(bad_gateway(error_text(status, &text)));
    }
    let data: Value = serde_json::from_str(&text)
        .map_err(|_| bad_gateway(format!("AI-servern på {base} svarade inte med en modellista.")))?;
    let mut names: Vec<String> = data
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| m.get("id").and_then(Value::as_str))
        .filter(|n| !n.is_empty())
        .map(String::from)
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup();
    Ok(names
        .into_iter()
        .filter(|n| !NOT_CHAT.is_match(n))
        .map(|name| ModelInfo { name, size_gb: 0.0, parameters: String::new(), thinking: false })
        .collect())
}

pub(super) async fn chat(
    c: &AiClient,
    model: &str,
    messages: &[Message],
    cancel: &CancellationToken,
    emit: &mut (dyn FnMut(AIEvent) + Send),
) -> Result<Outcome> {
    static RETRYABLE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)temperature|stream_options|unsupported|not supported|unrecognized|unknown")
            .expect("regex")
    });
    let base = api_base(&c.config.url);
    let unreachable = |e: reqwest::Error| bad_gateway(format!("AI-servern på {base} kan inte nås ({}).", describe(&e)));
    let mut payload = json!({
        "model": model,
        "messages": messages,
        "stream": true,
        "temperature": 0.4,
        "stream_options": { "include_usage": true },
    });
    let started = Instant::now();
    let mut first_token: Option<Instant> = None;
    let mut tokens: u64 = 0;
    let mut used_model = model.to_string();
    let mut splitter = ThinkSplitter::default();

    let mut res = None;
    for attempt in 0..2 {
        let send = request(c, reqwest::Method::POST, "/chat/completions").json(&payload).send();
        let r = tokio::select! {
            _ = cancel.cancelled() => return Ok(Outcome::Cancelled),
            r = send => r.map_err(unreachable)?,
        };
        let status = r.status().as_u16();
        if status == 200 {
            res = Some(r);
            break;
        }
        let body = r.text().await.unwrap_or_default();
        // Some models/servers don't accept temperature or stream_options.
        if attempt == 0 && matches!(status, 400 | 422) && RETRYABLE.is_match(&body) {
            let obj = payload.as_object_mut().expect("object");
            obj.remove("temperature");
            obj.remove("stream_options");
            continue;
        }
        return Err(bad_gateway(error_text(status, &body)));
    }
    let Some(res) = res else { return Err(bad_gateway("AI-servern svarade inte.")) };

    let mut stream = res.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    'read: loop {
        let next = tokio::select! {
            _ = cancel.cancelled() => return Ok(Outcome::Cancelled),
            n = tokio::time::timeout(Duration::from_secs(300), stream.next()) => {
                n.map_err(|_| bad_gateway(format!("AI-servern på {base} slutade svara.")))?
            }
        };
        let Some(chunk) = next else { break };
        buf.extend_from_slice(&chunk.map_err(unreachable)?);
        while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            let raw: Vec<u8> = buf.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&raw);
            let line = line.trim();
            let Some(data) = line.strip_prefix("data:") else { continue };
            let data = data.trim();
            if data == "[DONE]" {
                break 'read;
            }
            let Ok(chunk) = serde_json::from_str::<Value>(data) else { continue };
            if let Some(err) = chunk.get("error").filter(|e| !e.is_null()) {
                let msg = err.get("message").cloned().unwrap_or_else(|| err.clone());
                let msg = msg.as_str().map(String::from).unwrap_or_else(|| msg.to_string());
                return Err(bad_gateway(format!("AI-servern: {msg}")));
            }
            if let Some(m) = chunk.get("model").and_then(Value::as_str).filter(|m| !m.is_empty()) {
                used_model = m.to_string();
            }
            if let Some(t) = chunk.pointer("/usage/completion_tokens").and_then(Value::as_u64).filter(|t| *t > 0) {
                tokens = t;
            }
            for choice in chunk.get("choices").and_then(Value::as_array).into_iter().flatten() {
                let delta = &choice["delta"];
                let reasoning = delta
                    .get("reasoning_content")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .or_else(|| delta.get("reasoning").and_then(Value::as_str));
                if let Some(r) = reasoning.filter(|s| !s.is_empty()) {
                    first_token.get_or_insert_with(Instant::now);
                    emit(AIEvent::Thinking { text: r.to_string() });
                }
                if let Some(text) = delta.get("content").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    first_token.get_or_insert_with(Instant::now);
                    for ev in splitter.feed(text) {
                        emit(ev);
                    }
                }
            }
        }
    }
    for ev in splitter.flush() {
        emit(ev);
    }
    let now = Instant::now();
    let gen = first_token.map_or(0.0, |t| (now - t).as_secs_f64());
    emit(AIEvent::Done {
        model: used_model,
        tokens,
        seconds: round1((now - started).as_secs_f64()),
        tokens_per_second: (tokens > 0 && gen > 0.05).then(|| round1(tokens as f64 / gen)),
    });
    Ok(Outcome::Finished)
}

/// Splits streamed text into reasoning (`<think>…</think>` at the start of
/// the answer) and answer. Tags may arrive split over several chunks, so a
/// short rest is kept until it's clear whether it starts a tag.
#[derive(Default)]
pub struct ThinkSplitter {
    mode: Mode,
    buf: String,
}

#[derive(Default, PartialEq)]
enum Mode {
    #[default]
    Start,
    Think,
    Content,
}

const OPEN: &str = "<think>";
const CLOSE: &str = "</think>";

impl ThinkSplitter {
    pub fn feed(&mut self, text: &str) -> Vec<AIEvent> {
        self.buf.push_str(text);
        let mut out = Vec::new();
        loop {
            match self.mode {
                Mode::Start => {
                    let s = self.buf.trim_start().to_string();
                    if s.is_empty() || (s.len() < OPEN.len() && OPEN.starts_with(s.as_str())) {
                        break; // wait for more text
                    }
                    if let Some(rest) = s.strip_prefix(OPEN) {
                        self.buf = rest.to_string();
                        self.mode = Mode::Think;
                    } else {
                        self.mode = Mode::Content;
                    }
                }
                Mode::Think => {
                    if let Some(i) = self.buf.find(CLOSE) {
                        if i > 0 {
                            out.push(AIEvent::Thinking { text: self.buf[..i].to_string() });
                        }
                        self.buf = self.buf[i + CLOSE.len()..].trim_start_matches('\n').to_string();
                        self.mode = Mode::Content;
                        continue;
                    }
                    // Keep a possible start of "</think>" for the next chunk.
                    let keep = (1..CLOSE.len()).rev().find(|&n| self.buf.ends_with(&CLOSE[..n])).unwrap_or(0);
                    let cut = self.buf.len() - keep;
                    let emit: String = self.buf[..cut].to_string();
                    self.buf = self.buf[cut..].to_string();
                    if !emit.is_empty() {
                        out.push(AIEvent::Thinking { text: emit });
                    }
                    break;
                }
                Mode::Content => {
                    if !self.buf.is_empty() {
                        out.push(AIEvent::Content { text: std::mem::take(&mut self.buf) });
                    }
                    break;
                }
            }
        }
        out
    }

    pub fn flush(&mut self) -> Vec<AIEvent> {
        let rest = std::mem::take(&mut self.buf);
        if rest.trim().is_empty() {
            return Vec::new();
        }
        vec![if self.mode == Mode::Think { AIEvent::Thinking { text: rest } } else { AIEvent::Content { text: rest } }]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(evs: &[AIEvent]) -> (String, String) {
        let (mut t, mut c) = (String::new(), String::new());
        for e in evs {
            match e {
                AIEvent::Thinking { text } => t.push_str(text),
                AIEvent::Content { text } => c.push_str(text),
                _ => {}
            }
        }
        (t, c)
    }

    #[test]
    fn think_tags_split_over_chunks() {
        let mut s = ThinkSplitter::default();
        let mut evs = Vec::new();
        for part in ["<thi", "nk>Hmm", ".</th", "ink>\n\nSvaret", " här."] {
            evs.extend(s.feed(part));
        }
        evs.extend(s.flush());
        assert_eq!(texts(&evs), ("Hmm.".into(), "Svaret här.".into()));
    }

    #[test]
    fn no_tags_is_all_content() {
        let mut s = ThinkSplitter::default();
        let mut evs = s.feed("  Hej");
        evs.extend(s.feed(" <think>inte i början</think>"));
        evs.extend(s.flush());
        assert_eq!(texts(&evs).1, "  Hej <think>inte i början</think>");
    }

    #[test]
    fn base_url() {
        assert_eq!(api_base("https://api.openai.com"), "https://api.openai.com/v1");
        assert_eq!(api_base("https://api.openai.com/v1/"), "https://api.openai.com/v1");
        assert_eq!(api_base("https://openrouter.ai/api/v1"), "https://openrouter.ai/api/v1");
        assert_eq!(api_base("http://x/v1beta"), "http://x/v1beta");
        assert_eq!(api_base("http://localhost:1234"), "http://localhost:1234/v1");
    }

    #[test]
    fn error_texts() {
        assert!(
            error_text(401, r#"{"error":{"message":"Incorrect API key"}}"#).starts_with("API-nyckeln godkändes inte")
        );
        assert_eq!(error_text(500, r#"{"error":"boom"}"#), "AI-servern svarade med fel (500): boom");
        assert_eq!(error_text(502, "  plain  "), "AI-servern svarade med fel (502): plain");
    }
}
