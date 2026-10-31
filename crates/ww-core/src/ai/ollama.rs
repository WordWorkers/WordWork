//! Ollama's own API (`/api/tags`, `/api/show`, `/api/chat`). Here the app
//! controls the context window and the model's "thinking".

use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::{bad_gateway, describe, round1, AIEvent, AiClient, Message, ModelInfo, Outcome};
use crate::error::{Error, Result};

fn url(c: &AiClient, path: &str) -> String {
    format!("{}{path}", c.config.url)
}

pub(super) async fn availability(c: &AiClient) -> (bool, String) {
    let unreachable = |kind: &str| (false, format!("Ollama-servern på {} kan inte nås ({kind}).", c.config.url));
    // A server behind a proxy without /api/version still counts – the model list decides.
    if let Err(e) = c.http.get(url(c, "/api/version")).timeout(Duration::from_secs(3)).send().await {
        return unreachable(describe(&e));
    }
    match models(c).await {
        Ok(m) if !m.is_empty() => (true, String::new()),
        Ok(_) => (false, "Ollama-servern har ingen chattmodell installerad.".into()),
        Err(_) => unreachable("ogiltigt svar"),
    }
}

pub(super) async fn models(c: &AiClient) -> Result<Vec<ModelInfo>> {
    let err = |e: reqwest::Error| bad_gateway(format!("Kunde inte nå Ollama på {}: {}", c.config.url, describe(&e)));
    let tags: Value = c
        .http
        .get(url(c, "/api/tags"))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(err)?
        .json()
        .await
        .map_err(err)?;
    let mut out = Vec::new();
    for m in tags.get("models").and_then(Value::as_array).into_iter().flatten() {
        let name = m.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        let lower = name.to_lowercase();
        if lower.contains("embed") || lower.contains("ocr") {
            continue;
        }
        let caps: Vec<String> = match c
            .http
            .post(url(c, "/api/show"))
            .json(&json!({ "model": name }))
            .timeout(Duration::from_secs(30))
            .send()
            .await
        {
            Ok(r) => r
                .json::<Value>()
                .await
                .ok()
                .and_then(|v| v.get("capabilities").cloned())
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        if !caps.is_empty() && (!caps.iter().any(|c| c == "completion") || caps.iter().any(|c| c == "embedding")) {
            continue;
        }
        let size = m.get("size").and_then(Value::as_f64).unwrap_or(0.0);
        out.push(ModelInfo {
            name,
            size_gb: round1(size / 1e9),
            parameters: m.pointer("/details/parameter_size").and_then(Value::as_str).unwrap_or("").to_string(),
            thinking: caps.iter().any(|c| c == "thinking"),
        });
    }
    Ok(out)
}

pub(super) async fn chat(
    c: &AiClient,
    model: &str,
    messages: &[Message],
    think: bool,
    num_ctx: usize,
    cancel: &CancellationToken,
    emit: &mut (dyn FnMut(AIEvent) + Send),
) -> Result<Outcome> {
    let unreachable =
        |e: reqwest::Error| bad_gateway(format!("Kunde inte nå Ollama på {}: {}", c.config.url, describe(&e)));
    let payload = json!({
        "model": model,
        "messages": messages,
        "stream": true,
        "think": think,
        "options": { "temperature": if think { 0.6 } else { 0.4 }, "num_ctx": num_ctx },
    });
    let send = c.http.post(url(c, "/api/chat")).json(&payload).send();
    let res = tokio::select! {
        _ = cancel.cancelled() => return Ok(Outcome::Cancelled),
        r = send => r.map_err(unreachable)?,
    };
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        let body = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| v.get("error").and_then(Value::as_str).map(String::from))
            .unwrap_or(body);
        return Err(bad_gateway(format!("Ollama svarade med fel ({status}): {body}{}", think_hint(think, status))));
    }

    let mut stream = res.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let chunk = tokio::select! {
            _ = cancel.cancelled() => return Ok(Outcome::Cancelled),
            // A stalled stream counts as an error after 5 minutes, as before.
            next = tokio::time::timeout(Duration::from_secs(300), stream.next()) => {
                next.map_err(|_| bad_gateway(format!("Ollama på {} slutade svara.", c.config.url)))?
            }
        };
        let Some(chunk) = chunk else { break };
        buf.extend_from_slice(&chunk.map_err(unreachable)?);
        while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=nl).collect();
            handle_line(&line, model, emit).map_err(|e| with_think_hint(e, think))?;
        }
    }
    if !buf.is_empty() {
        handle_line(&buf, model, emit).map_err(|e| with_think_hint(e, think))?;
    }
    Ok(Outcome::Finished)
}

/// Some models crash on the server with thinking on (e.g. "CUDA error: an
/// illegal memory access") while working fine without it – say so.
const THINK_HINT: &str =
    " Om felet kommer tillbaka: avmarkera ”Tänk efter först” – alla modeller klarar inte tankesteg.";

fn think_hint(think: bool, status: u16) -> &'static str {
    if think && status >= 500 {
        THINK_HINT
    } else {
        ""
    }
}

/// The hint for an error reported in the middle of the answer.
fn with_think_hint(mut e: Error, think: bool) -> Error {
    if think && e.detail.starts_with("Ollama: ") {
        e.detail.push_str(THINK_HINT);
    }
    e
}

fn handle_line(line: &[u8], model: &str, emit: &mut (dyn FnMut(AIEvent) + Send)) -> Result<()> {
    let line = String::from_utf8_lossy(line);
    let line = line.trim();
    if line.is_empty() {
        return Ok(());
    }
    let chunk: Value =
        serde_json::from_str(line).map_err(|e| Error::bad_gateway(format!("Ogiltigt svar från Ollama: {e}")))?;
    if let Some(err) = chunk.get("error").filter(|e| !e.is_null() && e.as_str() != Some("")) {
        let msg = err.as_str().map(String::from).unwrap_or_else(|| err.to_string());
        return Err(bad_gateway(format!("Ollama: {msg}")));
    }
    let msg = &chunk["message"];
    if let Some(text) = msg.get("thinking").and_then(Value::as_str).filter(|t| !t.is_empty()) {
        emit(AIEvent::Thinking { text: text.to_string() });
    }
    if let Some(text) = msg.get("content").and_then(Value::as_str).filter(|t| !t.is_empty()) {
        emit(AIEvent::Content { text: text.to_string() });
    }
    if chunk.get("done").and_then(Value::as_bool) == Some(true) {
        let secs = |k: &str| chunk.get(k).and_then(Value::as_f64).unwrap_or(0.0) / 1e9;
        let tokens = chunk.get("eval_count").and_then(Value::as_u64).unwrap_or(0);
        let eval = secs("eval_duration");
        emit(AIEvent::Done {
            model: chunk.get("model").and_then(Value::as_str).unwrap_or(model).to_string(),
            tokens,
            seconds: round1(secs("total_duration")),
            tokens_per_second: (eval > 0.0).then(|| round1(tokens as f64 / eval)),
        });
    }
    Ok(())
}
