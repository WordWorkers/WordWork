//! Language tools: Hunspell spelling (via `spellbook`), the personal
//! dictionary, base forms for synonyms and the Synlex thesaurus (MyThes).
//! Ported from `language.py`.
//!
//! `spellbook` has no stemming API, so base forms are found with a small
//! suffix stripper that reads the `SFX` rules from the same `.aff` file
//! (the Swedish dictionary only uses suffixes). It is used for synonyms only,
//! where best effort is good enough.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use parking_lot::Mutex;
use serde::Serialize;

use crate::error::{Error, Result};
use crate::storage::atomic_write;

/// Longest word we try to check or suggest for (same as the Python version).
pub const MAX_WORD_LEN: usize = 64;
/// A personal-dictionary entry is a word or a phrase of at most this many words.
pub const MAX_PHRASE_WORDS: usize = 6;
const SUGGEST_CACHE: usize = 5_000;

pub struct Dictionaries {
    pub speller: spellbook::Dictionary,
    pub stemmer: Stemmer,
    pub thesaurus: HashMap<String, Vec<String>>,
    suggest_cache: Mutex<HashMap<String, Vec<String>>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SynonymGroup {
    pub word: String,
    /// The group is for the base form of an inflected word ("vackra" → "vacker").
    pub base_form: bool,
    pub synonyms: Vec<String>,
}

impl Dictionaries {
    /// Loads `sv_SE.aff`, `sv_SE.dic` and `th_sv_SE.dat` from `dir`.
    pub fn load(dir: &Path) -> Result<Self> {
        let aff = read(&dir.join("sv_SE.aff"))?;
        let dic = read(&dir.join("sv_SE.dic"))?;
        let speller = spellbook::Dictionary::new(&aff, &dic)
            .map_err(|e| Error::internal(format!("Kunde inte läsa ordlistan: {e}")))?;
        let stemmer = Stemmer::new(&aff, &dic);
        let thesaurus = parse_mythes(&read(&dir.join("th_sv_SE.dat"))?);
        Ok(Self { speller, stemmer, thesaurus, suggest_cache: Mutex::new(HashMap::new()) })
    }

    /// Raw Hunspell lookup (no personal dictionary, no cleaning).
    pub fn check(&self, word: &str) -> bool {
        self.speller.check(word)
    }

    /// Raw Hunspell suggestions.
    pub fn suggest(&self, word: &str) -> Vec<String> {
        let mut out = Vec::new();
        self.speller.suggest(word, &mut out);
        out
    }

    /// The words in `words` that are misspelled, as given. Words with digits,
    /// overlong words and entries in the personal dictionary are accepted.
    pub fn misspelled(&self, words: &[String], personal: &PersonalDictionary) -> Vec<String> {
        let entries = personal.entries();
        words
            .iter()
            .filter(|raw| {
                let w = clean(raw);
                if w.is_empty() || w.chars().count() > MAX_WORD_LEN || w.chars().any(char::is_numeric) {
                    return false;
                }
                !PersonalDictionary::accepts(&entries, w) && !self.check(w)
            })
            .cloned()
            .collect()
    }

    /// Corrections, best first, without the word itself. Cached.
    pub fn suggestions(&self, word: &str, limit: usize) -> Vec<String> {
        let w: String = clean(word).chars().take(MAX_WORD_LEN).collect();
        if w.is_empty() {
            return Vec::new();
        }
        if let Some(hit) = self.suggest_cache.lock().get(&w) {
            return hit.iter().take(limit).cloned().collect();
        }
        let mut out: Vec<String> = Vec::new();
        for s in self.suggest(&w) {
            if s != w && !out.contains(&s) {
                out.push(s);
            }
        }
        let mut cache = self.suggest_cache.lock();
        if cache.len() > SUGGEST_CACHE {
            cache.clear();
        }
        cache.insert(w, out.clone());
        out.truncate(limit);
        out
    }

    /// Synonym groups for the word and – if it is inflected – its base forms.
    pub fn synonyms(&self, word: &str) -> Vec<SynonymGroup> {
        let w = clean(word);
        if w.is_empty() {
            return Vec::new();
        }
        let lower = w.to_lowercase();
        let mut heads: Vec<String> = Vec::new();
        let push = |cand: String, heads: &mut Vec<String>| {
            if self.thesaurus.contains_key(&cand) && !heads.contains(&cand) {
                heads.push(cand);
            }
        };
        push(w.to_string(), &mut heads);
        push(lower.clone(), &mut heads);
        for stem in self.stemmer.stems(w) {
            let lower_stem = stem.to_lowercase();
            push(stem, &mut heads);
            push(lower_stem, &mut heads);
        }
        heads
            .into_iter()
            .map(|h| SynonymGroup {
                base_form: h.to_lowercase() != lower,
                synonyms: self.thesaurus[&h].clone(),
                word: h,
            })
            .collect()
    }
}

fn read(path: &Path) -> Result<String> {
    fs::read_to_string(path).map_err(|e| Error::internal(format!("{}: {e}", path.display())))
}

/// Python: `word.strip().strip("-'’")`.
pub fn clean(word: &str) -> &str {
    word.trim().trim_matches(['-', '\'', '’'])
}

/// A word or a phrase (2–6 words separated by single spaces); `None` if invalid.
pub fn normalize_entry(entry: &str) -> Option<String> {
    let parts: Vec<&str> = entry.split_whitespace().collect();
    if parts.is_empty() || parts.len() > MAX_PHRASE_WORDS || parts.iter().any(|p| p.chars().count() > MAX_WORD_LEN) {
        return None;
    }
    Some(parts.join(" "))
}

/// Python's sort key `str.casefold` (close enough for word lists).
fn casefold(s: &str) -> String {
    s.to_lowercase().replace('ß', "ss")
}

// ---------------------------------------------------------------- personal dictionary

/// The personal dictionary: one word or phrase per line in a plain text file
/// (`.wordwork/ordlista.txt`). Lines starting with `#` are comments.
///
/// Phrases ("open source") are only accepted as a whole: matching them against
/// the text happens in the editor, which knows word order and position. A word
/// that only occurs inside a phrase is therefore *not* accepted on its own here.
pub struct PersonalDictionary {
    path: PathBuf,
    inner: Mutex<(HashSet<String>, Option<SystemTime>)>,
}

impl PersonalDictionary {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        let d = Self { path: path.into(), inner: Mutex::new((HashSet::new(), None)) };
        d.reload_if_changed();
        d
    }

    /// The file may also be edited by hand – reread it when it changed.
    fn reload_if_changed(&self) {
        let mtime = fs::metadata(&self.path).and_then(|m| m.modified()).ok();
        let mut inner = self.inner.lock();
        if mtime == inner.1 {
            return;
        }
        let mut entries = HashSet::new();
        if let Ok(text) = fs::read_to_string(&self.path) {
            for line in text.lines() {
                if line.trim_start().starts_with('#') {
                    continue;
                }
                if let Some(e) = normalize_entry(line) {
                    entries.insert(e);
                }
            }
        }
        *inner = (entries, mtime);
    }

    fn entries(&self) -> HashSet<String> {
        self.reload_if_changed();
        self.inner.lock().0.clone()
    }

    /// "Bergman" in the list accepts only "Bergman"; "fanzine" also accepts "Fanzine".
    fn accepts(entries: &HashSet<String>, word: &str) -> bool {
        entries.contains(word)
            || (word.chars().next().is_some_and(char::is_uppercase) && entries.contains(&word.to_lowercase()))
    }

    pub fn contains(&self, word: &str) -> bool {
        Self::accepts(&self.entries(), word)
    }

    /// Sorted case-insensitively, as in the file.
    pub fn words(&self) -> Vec<String> {
        let mut words: Vec<String> = self.entries().into_iter().collect();
        words.sort_by_cached_key(|w| (casefold(w), w.clone()));
        words
    }

    fn modify(&self, f: impl FnOnce(&mut HashSet<String>)) -> Result<()> {
        self.reload_if_changed();
        let mut inner = self.inner.lock();
        f(&mut inner.0);
        let mut words: Vec<&String> = inner.0.iter().collect();
        words.sort_by_cached_key(|w| (casefold(w), (*w).clone()));
        let text: String = words.iter().map(|w| format!("{w}\n")).collect();
        atomic_write(&self.path, &text)?;
        inner.1 = fs::metadata(&self.path).and_then(|m| m.modified()).ok();
        Ok(())
    }

    pub fn add(&self, entry: &str) -> Result<()> {
        let e = valid_entry(entry)?;
        self.modify(|w| {
            w.insert(e);
        })
    }

    pub fn remove(&self, entry: &str) -> Result<()> {
        self.modify(|w| {
            w.remove(entry);
        })
    }

    pub fn rename(&self, old: &str, new: &str) -> Result<()> {
        let new = valid_entry(new)?;
        if !self.entries().contains(old) {
            return Err(Error::not_found(format!("”{old}” finns inte i ordlistan.")));
        }
        self.modify(|w| {
            w.remove(old);
            w.insert(new);
        })
    }

    /// Replaces the whole list (editing it as text). Empty lines are ignored.
    pub fn replace_all(&self, lines: &[String]) -> Result<()> {
        let mut entries = HashSet::new();
        let mut invalid = Vec::new();
        for raw in lines.iter().filter(|l| !l.trim().is_empty()) {
            match normalize_entry(raw) {
                Some(e) => {
                    entries.insert(e);
                }
                None => invalid.push(raw.trim().to_string()),
            }
        }
        if !invalid.is_empty() {
            let shown: Vec<_> = invalid.into_iter().take(5).collect();
            return Err(Error::bad_request(format!("Ogiltiga rader (högst sex ord per rad): {}", shown.join(", "))));
        }
        self.modify(|w| *w = entries)
    }
}

fn valid_entry(entry: &str) -> Result<String> {
    normalize_entry(entry).ok_or_else(|| Error::bad_request("Ange ett ord eller en fras på högst sex ord."))
}

// ---------------------------------------------------------------- stemming

struct Suffix {
    flag: char,
    strip: String,
    add: String,
    condition: Condition,
}

/// Hunspell affix condition: a sequence of single chars or `[...]` / `[^...]` sets,
/// matched against the end of the base form.
struct Condition(Vec<(bool, Vec<char>)>); // (negated, chars); empty chars = any

impl Condition {
    fn parse(s: &str) -> Self {
        if s == "." {
            return Self(Vec::new());
        }
        let mut parts = Vec::new();
        let mut chars = s.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                '[' => {
                    let neg = chars.peek() == Some(&'^');
                    if neg {
                        chars.next();
                    }
                    let set: Vec<char> = chars.by_ref().take_while(|&c| c != ']').collect();
                    parts.push((neg, set));
                }
                '.' => parts.push((false, Vec::new())),
                c => parts.push((false, vec![c])),
            }
        }
        Self(parts)
    }

    fn matches_end(&self, word: &str) -> bool {
        let tail: Vec<char> = word.chars().rev().take(self.0.len()).collect();
        if tail.len() < self.0.len() {
            return false;
        }
        self.0.iter().rev().zip(tail.iter()).all(|((neg, set), c)| set.is_empty() || (set.contains(c) != *neg))
    }
}

pub struct Stemmer {
    suffixes: Vec<Suffix>,
    /// stem → flags
    stems: HashMap<String, HashSet<char>>,
}

impl Stemmer {
    pub fn new(aff: &str, dic: &str) -> Self {
        let mut suffixes = Vec::new();
        for line in aff.lines() {
            let f: Vec<&str> = line.split_whitespace().collect();
            // SFX <flag> <strip> <add>[/flags] <condition>
            if f.len() >= 5 && f[0] == "SFX" {
                let (Some(flag), true) = (f[1].chars().next(), f[1].chars().count() == 1) else { continue };
                let strip = if f[2] == "0" { "" } else { f[2] };
                let add = f[3].split('/').next().unwrap_or("");
                let add = if add == "0" { "" } else { add };
                suffixes.push(Suffix {
                    flag,
                    strip: strip.to_string(),
                    add: add.to_string(),
                    condition: Condition::parse(f[4]),
                });
            }
        }
        let mut stems: HashMap<String, HashSet<char>> = HashMap::new();
        for line in dic.lines().skip(1) {
            let entry = line.split(['\t', ' ']).next().unwrap_or("");
            let (word, flags) = split_dic_entry(entry);
            if !word.is_empty() {
                stems.entry(word.to_string()).or_default().extend(flags.chars());
            }
        }
        Self { suffixes, stems }
    }

    /// Dictionary stems that `word` can be an inflection of (including itself).
    pub fn stems(&self, word: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let lower = word.to_lowercase();
        for w in [word, lower.as_str()] {
            if self.stems.contains_key(w) && !out.iter().any(|s| s == w) {
                out.push(w.to_string());
            }
            for sfx in &self.suffixes {
                let Some(base) = w.strip_suffix(sfx.add.as_str()) else { continue };
                let base = format!("{base}{}", sfx.strip);
                if base.is_empty() || !sfx.condition.matches_end(&base) {
                    continue;
                }
                if self.stems.get(&base).is_some_and(|f| f.contains(&sfx.flag)) && !out.contains(&base) {
                    out.push(base);
                }
            }
        }
        out
    }
}

/// `word/FLAGS` – a `/` may be escaped as `\/` in the word.
fn split_dic_entry(entry: &str) -> (&str, &str) {
    let bytes = entry.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            i += 2;
            continue;
        }
        if bytes[i] == b'/' && i > 0 {
            return (&entry[..i], &entry[i + 1..]);
        }
        i += 1;
    }
    (entry, "")
}

// ---------------------------------------------------------------- thesaurus

/// MyThes: first line is the encoding, then `word|count` followed by `count`
/// lines of `(pos)|syn|syn …`.
pub fn parse_mythes(text: &str) -> HashMap<String, Vec<String>> {
    let lines: Vec<&str> = text.lines().collect();
    let mut result: HashMap<String, Vec<String>> = HashMap::new();
    let mut i = 1;
    while i < lines.len() {
        let (head, count) = lines[i].split_once('|').unwrap_or((lines[i], ""));
        let head = head.trim();
        i += 1;
        let n: usize = count.trim().parse().unwrap_or(0);
        let syns = result.entry(head.to_string()).or_default();
        for line in lines.iter().skip(i).take(n) {
            for s in line.split('|').skip(1) {
                let s = s.trim();
                if !s.is_empty() && s != head && !syns.iter().any(|x| x == s) {
                    syns.push(s.to_string());
                }
            }
        }
        i += n;
    }
    result.retain(|_, v| !v.is_empty());
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn condition_matching() {
        let c = Condition::parse("[^aeiou]y");
        assert!(!c.matches_end("boy"));
        assert!(c.matches_end("fly"));
        assert!(Condition::parse(".").matches_end("x"));
        assert!(Condition::parse("[ae]").matches_end("hare"));
    }

    #[test]
    fn mythes() {
        let t = parse_mythes("UTF-8\nhus|1\n(subst)|byggnad|hus|kåk\nx|0\n");
        assert_eq!(t["hus"], vec!["byggnad", "kåk"]);
        assert!(!t.contains_key("x"));
    }

    #[test]
    fn dic_entry() {
        assert_eq!(split_dic_entry("alster/ACFY"), ("alster", "ACFY"));
        assert_eq!(split_dic_entry("-/-06XY"), ("-", "-06XY"));
        assert_eq!(split_dic_entry("1\\/2/A"), ("1\\/2", "A"));
    }
}
