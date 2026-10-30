//! One question to the assistant: validate, build the messages, stream the
//! answer, and save question + answer in the document's conversation – also
//! when the user presses *Stoppa* (the answer is then marked "Avbrutet").

use serde::Deserialize;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::{build_messages, context_size, quick_prompt, AIEvent, AiClient, Message, Outcome};
use crate::error::{Error, Result};
use crate::storage::Storage;
use crate::userdata::{append_chat, check_chat_target};

fn yes() -> bool {
    true
}

/// Same fields as the old `ChatRequest` body.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct ChatRequest {
    #[serde(default)]
    pub model: String,
    #[serde(default = "yes")]
    pub think: bool,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub quick: Option<String>,
    #[serde(default)]
    pub document: String,
    #[serde(default)]
    pub selection: String,
    #[serde(default)]
    pub history: Vec<Message>,
    /// If both are set, question and answer are saved in that conversation.
    #[serde(default)]
    pub document_name: Option<String>,
    #[serde(default)]
    pub chat_id: Option<String>,
    #[serde(default)]
    pub label: String,
}

impl ChatRequest {
    /// The size limits the old API enforced (422).
    fn check_sizes(&self) -> Result<()> {
        let too_long = |s: &str, max: usize| s.chars().count() > max;
        if too_long(&self.prompt, 10_000)
            || too_long(&self.document, 1_000_000)
            || too_long(&self.selection, 1_000_000)
            || self.history.len() > 100
            || self.history.iter().any(|m| too_long(&m.content, 200_000))
            || too_long(&self.label, 200)
            || self.document_name.as_deref().is_some_and(|n| too_long(n, 200))
            || self.chat_id.as_deref().is_some_and(|c| too_long(c, 64))
        {
            return Err(Error::new(422, "Frågan är för stor."));
        }
        Ok(())
    }
}

/// Python's `f"{x:g}"` for the seconds in the meta line (1.5 → "1.5", 2.0 → "2").
fn fmt_g(x: f64) -> String {
    if x.fract() == 0.0 && x.abs() < 1e15 {
        format!("{}", x as i64)
    } else {
        format!("{x}")
    }
}

/// Runs one question. Errors *before* streaming (validation, server down) are
/// returned; errors while streaming are sent as an `error` event and saved.
pub async fn run_chat(
    client: &AiClient,
    storage: &Storage,
    req: ChatRequest,
    cancel: &CancellationToken,
    emit: &mut (dyn FnMut(AIEvent) + Send),
) -> Result<Outcome> {
    req.check_sizes()?;
    let (available, reason) = client.availability().await;
    if !available {
        return Err(Error::new(503, reason));
    }
    let quick = req.quick.as_deref().filter(|q| !q.is_empty());
    if quick.is_some_and(|q| quick_prompt(q).is_none()) {
        return Err(Error::bad_request("Okänt snabbval."));
    }
    let messages = build_messages(&req.document, &req.selection, &req.history, &req.prompt, quick)?;
    let num_ctx = context_size(messages.iter().map(|m| m.content.chars().count()).sum());
    let question = messages.last().map(|m| m.content.clone()).unwrap_or_default();
    let save_to = match (&req.document_name, &req.chat_id) {
        (Some(name), Some(cid)) if !name.is_empty() && !cid.is_empty() => {
            check_chat_target(storage, name, cid)?;
            Some((name.clone(), cid.clone()))
        }
        _ => None,
    };

    let mut model = if req.model.is_empty() { client.default_model().to_string() } else { req.model.clone() };
    let (mut content, mut thinking, mut meta, mut error) = (String::new(), String::new(), String::new(), String::new());
    emit(AIEvent::Start { question: question.clone() });
    let result = {
        let mut collect = |ev: AIEvent| {
            match &ev {
                AIEvent::Content { text } => content.push_str(text),
                AIEvent::Thinking { text } => thinking.push_str(text),
                AIEvent::Done { model: m, seconds, tokens_per_second, .. } => {
                    if !m.is_empty() {
                        model = m.clone();
                    }
                    let tps = tokens_per_second
                        .map(|t| format!(" · {} tokens/s", t.round_ties_even() as i64))
                        .unwrap_or_default();
                    meta = format!("{model} · {} s{tps}", fmt_g(*seconds));
                }
                _ => {}
            }
            emit(ev);
        };
        client.chat(&req.model, &messages, req.think, num_ctx, cancel, &mut collect).await
    };
    let outcome = match result {
        Ok(o) => o,
        Err(e) => {
            error = e.detail.clone();
            emit(AIEvent::Error { message: e.detail });
            Outcome::Finished
        }
    };

    if let Some((name, cid)) = save_to {
        if outcome == Outcome::Cancelled && meta.is_empty() {
            meta = "Avbrutet".into();
        }
        let user_text = if quick.is_some() { question } else { req.prompt.clone() };
        let user = json!({ "role": "user", "content": user_text, "label": req.label });
        let answer: Value = json!({
            "role": "assistant", "content": content, "thinking": thinking, "meta": meta, "error": error,
        });
        if let Err(e) = append_chat(storage, &name, &cid, &[user, answer], &model) {
            log::warn!("Kunde inte spara AI-samtalet: {}", e.detail);
        }
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    #[test]
    fn g_format() {
        assert_eq!(super::fmt_g(1.5), "1.5");
        assert_eq!(super::fmt_g(2.0), "2");
        assert_eq!(super::fmt_g(12.3), "12.3");
    }
}
