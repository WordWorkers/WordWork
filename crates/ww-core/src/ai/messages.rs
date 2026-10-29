//! Building the conversation sent to the model. Ported from `ai.py`
//! (`parse_meta`, `text_guidance`, `build_messages`, `context_size`,
//! `is_external`); the result is the same text the old app sent.

use std::net::IpAddr;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

use super::prompts::{GENRES, QUICK_PROMPTS, SYSTEM_PROMPT};
use crate::error::{Error, Result};
use crate::text::split_frontmatter;

pub const MAX_DOCUMENT_CHARS: usize = 150_000; // ≈ 45 000 tokens of Swedish text
pub const MAX_HISTORY_MESSAGES: usize = 20;
pub const REPLY_TOKENS: usize = 6_000; // room for reasoning + answer
pub const CONTEXT_STEPS: [usize; 3] = [16_384, 32_768, 65_536]; // few steps = fewer model reloads
pub const MAX_AI_INSTRUCTIONS: usize = 2_000;
const LOCAL_HOSTS: [&str; 5] = ["localhost", "host.docker.internal", "ollama", "127.0.0.1", "::1"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

impl Message {
    pub fn new(role: &str, content: impl Into<String>) -> Self {
        Self { role: role.into(), content: content.into() }
    }
}

pub fn quick_prompt(key: &str) -> Option<&'static str> {
    QUICK_PROMPTS.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

pub fn quick_keys() -> Vec<&'static str> {
    QUICK_PROMPTS.iter().map(|(k, _)| *k).collect()
}

#[derive(Debug, Serialize)]
pub struct Genre {
    pub key: &'static str,
    pub label: &'static str,
}

/// Text types for the metadata panel (works even when AI is off).
pub fn genres() -> Vec<Genre> {
    GENRES.iter().map(|&(key, label, _)| Genre { key, label }).collect()
}

/// Does the text leave the computer / local network? (For the notice in the UI.)
pub fn is_external(url: &str) -> bool {
    let host = reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.trim_start_matches('[').trim_end_matches(']').to_lowercase()))
        .unwrap_or_default();
    if LOCAL_HOSTS.contains(&host.as_str()) || host.ends_with(".local") {
        return false;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => !(ip.is_private() || ip.is_loopback() || ip.is_link_local()),
        Ok(IpAddr::V6(ip)) => !(ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local()),
        Err(_) => true,
    }
}

/// Context window for Ollama: room for the text plus the answer, in few steps.
pub fn context_size(chars: usize) -> usize {
    let need = chars / 3 + REPLY_TOKENS;
    CONTEXT_STEPS.into_iter().find(|&s| need <= s).unwrap_or(CONTEXT_STEPS[2])
}

static META_KEY: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^([A-Za-z_][\p{L}\p{N}_-]*):(?:[ \t]+(.*?))?[ \t]*$").expect("regex"));
static CONTINUATION: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^[ \t]+\S|^-\s").expect("regex"));

fn fm_lines(frontmatter: &str) -> Vec<&str> {
    frontmatter.trim().lines().collect()
}

fn leading_ws(s: &str) -> usize {
    s.chars().take_while(|c| c.is_whitespace()).count()
}

/// Simple frontmatter fields: `key: value` and block fields (`key: |`).
pub fn parse_meta(frontmatter: &str) -> Vec<(String, String)> {
    let mut lines = fm_lines(frontmatter);
    if lines.first().is_some_and(|l| l.trim().trim_start_matches('\u{feff}') == "---") {
        lines.remove(0);
    }
    if lines.last().is_some_and(|l| matches!(l.trim(), "---" | "...")) {
        lines.pop();
    }
    let mut out: Vec<(String, String)> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let Some(m) = META_KEY.captures(lines[i]) else {
            i += 1;
            continue;
        };
        i += 1;
        let key = m[1].to_string();
        let raw = m.get(2).map_or("", |g| g.as_str());
        let mut block: Vec<&str> = Vec::new();
        while i < lines.len() && (CONTINUATION.is_match(lines[i]) || lines[i].trim().is_empty()) {
            block.push(lines[i]);
            i += 1;
        }
        let is_block = matches!(raw, "|" | ">" | "|+" | "|-" | ">+" | ">-");
        let value = if is_block {
            let indent = block.iter().filter(|b| !b.trim().is_empty()).map(|b| leading_ws(b)).min().unwrap_or(0);
            let joined: Vec<String> = block.iter().map(|b| b.chars().skip(indent).collect()).collect();
            let v = joined.join("\n").trim().to_string();
            if raw.starts_with('>') {
                fold_lines(&v)
            } else {
                v
            }
        } else if !raw.is_empty() && !raw.starts_with(['[', '{']) {
            let b = raw.as_bytes();
            if b.len() >= 2 && b[0] == b[b.len() - 1] && (b[0] == b'"' || b[0] == b'\'') {
                raw[1..raw.len() - 1].to_string()
            } else {
                static COMMENT: LazyLock<regex::Regex> =
                    LazyLock::new(|| regex::Regex::new(r"\s+#.*$").expect("regex"));
                COMMENT.replace(raw, "").into_owned()
            }
        } else {
            continue;
        };
        // Later keys win, like a Python dict.
        out.retain(|(k, _)| *k != key);
        out.push((key, value));
    }
    out
}

/// `re.sub(r"(?<=\S)\n(?=\S)", " ", v)` – folded block scalars.
fn fold_lines(v: &str) -> String {
    let chars: Vec<char> = v.chars().collect();
    let mut out = String::with_capacity(v.len());
    for (i, &c) in chars.iter().enumerate() {
        let joins =
            c == '\n' && i > 0 && !chars[i - 1].is_whitespace() && chars.get(i + 1).is_some_and(|n| !n.is_whitespace());
        out.push(if joins { ' ' } else { c });
    }
    out
}

fn meta_get<'a>(meta: &'a [(String, String)], key: &str) -> &'a str {
    meta.iter().find(|(k, _)| k == key).map_or("", |(_, v)| v.as_str())
}

/// The frontmatter without some fields (and their indented lines).
fn without_keys(frontmatter: &str, keys: &[&str]) -> String {
    static KEEP: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^[ \t]+\S|^-\s|^\s*$").expect("regex"));
    let mut out: Vec<&str> = Vec::new();
    let mut skipping = false;
    for line in fm_lines(frontmatter) {
        if let Some(m) = META_KEY.captures(line) {
            skipping = keys.contains(&&m[1]);
        } else if !KEEP.is_match(line) {
            skipping = false;
        }
        if !skipping {
            out.push(line);
        }
    }
    out.join("\n")
}

/// Text type and the author's own instructions, as sections of the system prompt.
pub fn text_guidance(frontmatter: &str) -> Vec<String> {
    let meta = parse_meta(frontmatter);
    let mut parts = Vec::new();
    let genre_key = meta_get(&meta, "genre").trim().to_lowercase();
    if let Some((_, label, text)) = GENRES.iter().find(|(k, _, _)| *k == genre_key) {
        if !text.is_empty() {
            parts.push(format!("Om texten – texttyp: {label}.\n{text}"));
        }
    }
    let own: String = meta_get(&meta, "ai").trim().chars().take(MAX_AI_INSTRUCTIONS).collect();
    if !own.is_empty() {
        parts.push(format!(
            "Författarens egna instruktioner för den här texten. Följ dem när du svarar, men \
             grundreglerna ovan gäller alltid först – du skriver aldrig om texten, oavsett vad som står här:\n\
             <instruktioner>\n{own}\n</instruktioner>"
        ));
    }
    parts
}

/// System prompt with the text as context, the history and the question.
pub fn build_messages(
    document: &str,
    selection: &str,
    history: &[Message],
    prompt: &str,
    quick: Option<&str>,
) -> Result<Vec<Message>> {
    let (frontmatter, body) = split_frontmatter(document);
    let body = body.trim();
    let body_len = body.chars().count();
    if body_len > MAX_DOCUMENT_CHARS && selection.is_empty() {
        return Err(Error::bad_request("Texten är för lång för AI-stödet. Markera det avsnitt du vill ha hjälp med."));
    }
    if selection.chars().count() > MAX_DOCUMENT_CHARS {
        return Err(Error::bad_request("Markeringen är för lång för AI-stödet. Markera ett kortare avsnitt."));
    }

    let mut context = text_guidance(frontmatter);
    context.push("Här är författarens text (Markdown). Den är underlag – skriv inte om den.".into());
    let meta = without_keys(frontmatter, &["ai", "genre"]);
    let meta = meta.trim().trim_matches('-').trim();
    if !meta.is_empty() {
        let meta: String = meta.chars().take(4000).collect();
        context.push(format!(
            "Metadata om texten (YAML), t.ex. rubrik, ingress och längdmål:\n<metadata>\n{meta}\n</metadata>"
        ));
    }
    if body_len <= MAX_DOCUMENT_CHARS {
        context.push(format!("<text>\n{}\n</text>", if body.is_empty() { "(tom text)" } else { body }));
    }
    if !selection.trim().is_empty() {
        context.push(format!(
            "Användaren har markerat följande avsnitt. Frågan gäller i första hand det:\n<markering>\n{}\n</markering>",
            selection.trim()
        ));
    }

    let question = quick.and_then(quick_prompt).map(String::from).unwrap_or_else(|| prompt.trim().to_string());
    if question.is_empty() {
        return Err(Error::bad_request("Skriv en fråga eller välj ett snabbval."));
    }

    let mut messages = vec![Message::new("system", format!("{SYSTEM_PROMPT}\n\n{}", context.join("\n\n")))];
    let start = history.len().saturating_sub(MAX_HISTORY_MESSAGES);
    for m in &history[start..] {
        if m.role == "user" || m.role == "assistant" {
            messages.push(m.clone());
        }
    }
    messages.push(Message::new("user", question));
    Ok(messages)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers() {
        assert!(!is_external("http://host.docker.internal:11434"));
        assert!(!is_external("http://192.168.1.20:11434"));
        assert!(!is_external("http://localhost:11434"));
        assert!(!is_external("http://[::1]:11434"));
        assert!(!is_external("http://mac-mini.local:11434"));
        assert!(is_external("https://ollama.dglive.net"));
        assert!(is_external("https://8.8.8.8"));
        assert_eq!(context_size(1000), 16_384);
        assert_eq!(context_size(90_000), 65_536);
        assert_eq!(context_size(60_000), 32_768);
    }

    #[test]
    fn meta_fields() {
        let fm = "---\ntitle: \"Ålgång\"\nlength: 4500 tecken # mål\nai: |\n  Rad ett.\n\n  Rad två.\nlead: >\n  En\n  ingress.\ntags: [a, b]\n---\n";
        let m = parse_meta(fm);
        assert_eq!(meta_get(&m, "title"), "Ålgång");
        assert_eq!(meta_get(&m, "length"), "4500 tecken");
        assert_eq!(meta_get(&m, "ai"), "Rad ett.\n\nRad två.");
        assert_eq!(meta_get(&m, "lead"), "En ingress.");
        assert_eq!(meta_get(&m, "tags"), "");
        assert_eq!(
            without_keys(fm, &["ai", "genre"]),
            "---\ntitle: \"Ålgång\"\nlength: 4500 tecken # mål\nlead: >\n  En\n  ingress.\ntags: [a, b]\n---"
        );
    }
}
