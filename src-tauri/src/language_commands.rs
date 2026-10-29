//! Phase 2: spelling, the personal dictionary and synonyms. Same arguments
//! and JSON as the old `/api/spell/*` and `/api/synonyms` routes.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;
use ww_core::language::{Dictionaries, PersonalDictionary, SynonymGroup};
use ww_core::{Error, Result};

use crate::state::{AppState, DataCtx};

/// Runs `f` on a blocking thread once the dictionaries are loaded (max 60 s).
async fn with_language<T: Send + 'static>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&Dictionaries, &PersonalDictionary) -> Result<T> + Send + 'static,
) -> Result<T> {
    let lang = state.language.clone();
    let ctx: Arc<DataCtx> = state.data();
    tauri::async_runtime::spawn_blocking(move || {
        let start = Instant::now();
        loop {
            match lang.get() {
                Some(Ok(d)) => return f(d, &ctx.personal),
                Some(Err(e)) => return Err(Error::internal(format!("Språkresurserna kunde inte laddas: {e}"))),
                None if start.elapsed() > Duration::from_secs(60) => {
                    return Err(Error::internal("Språkresurserna laddas fortfarande."))
                }
                None => std::thread::sleep(Duration::from_millis(20)),
            }
        }
    })
    .await
    .map_err(|e| Error::internal(e.to_string()))?
}

/// Personal-dictionary work doesn't need the big dictionaries.
async fn with_personal<T: Send + 'static>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&PersonalDictionary) -> Result<T> + Send + 'static,
) -> Result<T> {
    let ctx: Arc<DataCtx> = state.data();
    tauri::async_runtime::spawn_blocking(move || f(&ctx.personal)).await.map_err(|e| Error::internal(e.to_string()))?
}

#[derive(Serialize)]
pub struct Misspelled {
    misspelled: Vec<String>,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn spell_check(state: State<'_, AppState>, words: Vec<String>) -> Result<Misspelled> {
    if words.len() > 5000 {
        return Err(Error::new(422, "Högst 5 000 ord per anrop."));
    }
    with_language(&state, move |d, p| Ok(Misspelled { misspelled: d.misspelled(&words, p) })).await
}

#[derive(Serialize)]
pub struct Suggestions {
    word: String,
    suggestions: Vec<String>,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn spell_suggest(state: State<'_, AppState>, word: String, limit: Option<usize>) -> Result<Suggestions> {
    let limit = limit.unwrap_or(6).clamp(1, 12);
    with_language(&state, move |d, _| Ok(Suggestions { suggestions: d.suggestions(&word, limit), word })).await
}

#[derive(Serialize)]
pub struct Synonyms {
    word: String,
    groups: Vec<SynonymGroup>,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn synonyms(state: State<'_, AppState>, word: String) -> Result<Synonyms> {
    with_language(&state, move |d, _| Ok(Synonyms { groups: d.synonyms(&word), word })).await
}

#[derive(Serialize)]
pub struct Words {
    words: Vec<String>,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dict_get(state: State<'_, AppState>) -> Result<Words> {
    with_personal(&state, |p| Ok(Words { words: p.words() })).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dict_add(state: State<'_, AppState>, word: String) -> Result<Words> {
    with_personal(&state, move |p| {
        p.add(&word)?;
        Ok(Words { words: p.words() })
    })
    .await
}

/// Replaces the whole list (editing it as text).
#[tauri::command(rename_all = "snake_case")]
pub async fn dict_replace(state: State<'_, AppState>, words: Vec<String>) -> Result<Words> {
    if words.len() > 20_000 {
        return Err(Error::new(422, "Högst 20 000 rader."));
    }
    with_personal(&state, move |p| {
        p.replace_all(&words)?;
        Ok(Words { words: p.words() })
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dict_rename(state: State<'_, AppState>, word: String, new_word: String) -> Result<Words> {
    with_personal(&state, move |p| {
        p.rename(&word, &new_word)?;
        Ok(Words { words: p.words() })
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dict_remove(state: State<'_, AppState>, word: String) -> Result<Words> {
    with_personal(&state, move |p| {
        p.remove(&word)?;
        Ok(Words { words: p.words() })
    })
    .await
}
