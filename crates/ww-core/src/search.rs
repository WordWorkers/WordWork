//! Search across all documents (the search field in the document list).
//!
//! Searches the text of the Markdown files (not the frontmatter, which the
//! editor doesn't show either; own notes and comments are included) and
//! returns, per document, the number of matches and a few short snippets.

use serde::Serialize;

use crate::error::Result;
use crate::storage::{read_text, Storage, EXT};
use crate::text::split_frontmatter;

/// Snippets per document; the count covers all matches.
const MAX_SNIPPETS: usize = 3;
/// Characters of context on each side of a match in a snippet.
const CONTEXT: usize = 48;

#[derive(Debug, Clone, Copy, Default)]
pub struct SearchOptions {
    pub case_sensitive: bool,
    /// Only matches that aren't part of a longer word (like the search bar's "Hela ord").
    pub whole_word: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Snippet {
    /// Text before the match (starts with "…" if cut).
    pub before: String,
    /// The match itself, as written in the document.
    pub text: String,
    /// Text after the match (ends with "…" if cut).
    pub after: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SearchHit {
    pub name: String,
    pub modified: f64,
    /// The document's name matches.
    pub name_match: bool,
    /// Matches in the text.
    pub count: usize,
    pub snippets: Vec<Snippet>,
}

/// All documents whose name or text contains `query`: name matches first,
/// then most matches, then most recently changed.
pub fn search(storage: &Storage, query: &str, opts: SearchOptions) -> Result<Vec<SearchHit>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let re = regex::RegexBuilder::new(&regex::escape(query))
        .case_insensitive(!opts.case_sensitive)
        .build()
        .expect("escaped pattern");
    let mut hits = Vec::new();
    for doc in storage.list()? {
        let raw = read_text(&storage.root().join(format!("{}{EXT}", doc.name)))?;
        let text = split_frontmatter(&raw).1;
        let ranges = find(&re, text, opts.whole_word);
        let name_match = !find(&re, &doc.name, opts.whole_word).is_empty();
        if ranges.is_empty() && !name_match {
            continue;
        }
        // Matches close to the previous snippet are already visible in it.
        let mut snippets = Vec::new();
        let mut shown_to = 0;
        for &(a, b) in &ranges {
            if snippets.len() == MAX_SNIPPETS {
                break;
            }
            if !snippets.is_empty() && a < shown_to {
                continue;
            }
            snippets.push(snippet(text, a, b));
            shown_to = b + CONTEXT;
        }
        hits.push(SearchHit { name: doc.name, modified: doc.modified, name_match, count: ranges.len(), snippets });
    }
    hits.sort_by(|a, b| {
        b.name_match.cmp(&a.name_match).then(b.count.cmp(&a.count)).then(b.modified.total_cmp(&a.modified))
    });
    Ok(hits)
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Byte ranges of the matches (whole words only, if asked).
fn find(re: &regex::Regex, text: &str, whole_word: bool) -> Vec<(usize, usize)> {
    re.find_iter(text)
        .filter(|m| {
            !whole_word
                || (!text[..m.start()].chars().next_back().is_some_and(is_word_char)
                    && !text[m.end()..].chars().next().is_some_and(is_word_char))
        })
        .map(|m| (m.start(), m.end()))
        .collect()
}

/// Up to [`CONTEXT`] characters on each side, cut at a space, on one line.
fn snippet(text: &str, start: usize, end: usize) -> Snippet {
    // One line, without the most common Markdown markers (#, >, list bullets, **, __).
    let flat = |s: &str| {
        s.lines()
            .map(|line| {
                let t = line.trim_start();
                let t = t.trim_start_matches(['#', '>']).trim_start();
                let t = ["- ", "* ", "+ "].iter().find_map(|m| t.strip_prefix(m)).unwrap_or(t);
                t.replace("**", "").replace("__", "")
            })
            .collect::<Vec<_>>()
            .join(" ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    let before_all = &text[..start];
    let after_all = &text[end..];

    let mut before: String = before_all.chars().rev().take(CONTEXT).collect::<Vec<_>>().into_iter().rev().collect();
    let cut_before = before.len() < before_all.len();
    if cut_before {
        // Start at a word boundary.
        if let Some(i) = before.find(char::is_whitespace) {
            before = before[i..].to_string();
        }
    }
    let mut after: String = after_all.chars().take(CONTEXT).collect();
    let cut_after = after.len() < after_all.len();
    if cut_after {
        if let Some(i) = after.rfind(char::is_whitespace) {
            after.truncate(i);
        }
    }
    // Keep the space next to the match (split_whitespace would drop it).
    let lead = if before.ends_with(char::is_whitespace) { " " } else { "" };
    let trail = if after.starts_with(char::is_whitespace) { " " } else { "" };
    let mut before = format!("{}{lead}", flat(&before));
    let mut after = format!("{trail}{}", flat(&after));
    if cut_before {
        before = format!("…{}", before.trim_start());
    }
    if cut_after {
        after = format!("{}…", after.trim_end());
    }
    Snippet { before, text: flat(&text[start..end]), after }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Storage) {
        let dir = tempfile::tempdir().unwrap();
        let s = Storage::new(dir.path(), 5.0);
        (dir, s)
    }

    #[test]
    fn finds_across_documents() {
        let (_d, s) = store();
        s.create(Some("Hamlet"), "# Hamlet\n\nHamlet på Dramaten. Prinsen av Danmark.\n").unwrap();
        s.create(Some("Recension"), "Dramaten visar Hamlet igen.\n").unwrap();
        s.create(Some("Annat"), "Inget här.\n").unwrap();
        let hits = search(&s, "hamlet", SearchOptions::default()).unwrap();
        let names: Vec<_> = hits.iter().map(|h| (h.name.as_str(), h.name_match, h.count)).collect();
        assert_eq!(names, [("Hamlet", true, 2), ("Recension", false, 1)]);
        assert_eq!(
            hits[1].snippets[0],
            Snippet { before: "Dramaten visar ".into(), text: "Hamlet".into(), after: " igen.".into() }
        );
        // Case and whole words.
        let opts = SearchOptions { case_sensitive: true, whole_word: false };
        assert!(search(&s, "hamlet", opts).unwrap().is_empty());
        let opts = SearchOptions { case_sensitive: false, whole_word: true };
        assert!(search(&s, "dram", opts).unwrap().is_empty());
        assert_eq!(search(&s, "dramaten", opts).unwrap().len(), 2);
        assert!(search(&s, "  ", opts).unwrap().is_empty());
    }

    #[test]
    fn snippets_are_short_and_on_one_line() {
        let text = format!("{}\n\nett två tre MÅL fyra\nfem {}", "början ".repeat(20), "slut ".repeat(20));
        let start = text.find("MÅL").unwrap();
        let s = snippet(&text, start, start + "MÅL".len());
        assert!(s.before.starts_with('…') && s.before.ends_with("tre "), "{s:?}");
        assert!(s.after.starts_with(" fyra fem") && s.after.ends_with('…'), "{s:?}");
        assert!(!s.before.contains('\n') && s.before.chars().count() <= CONTEXT + 2);
        // Regex special characters are taken literally.
        let (_d, st) = store();
        st.create(Some("Pris"), "Det kostar 1.5 (ungefär).\n").unwrap();
        assert_eq!(search(&st, "(ungefär)", SearchOptions::default()).unwrap()[0].count, 1);
        assert!(search(&st, "1x5", SearchOptions::default()).unwrap().is_empty());
    }

    #[test]
    fn skips_frontmatter_and_markdown_markers() {
        let (_d, s) = store();
        s.create(Some("Text"), "---\ntitle: Hamlet\n---\n\n# Hamlet\n\n> **Hamlet** tvekar.\n").unwrap();
        let hit = &search(&s, "tvekar", SearchOptions::default()).unwrap()[0];
        assert_eq!(hit.snippets[0].before, "Hamlet Hamlet ");
        assert_eq!(search(&s, "title", SearchOptions::default()).unwrap().len(), 0);
        // Two matches close together: one snippet (both counted).
        let hit = &search(&s, "hamlet", SearchOptions::default()).unwrap()[0];
        assert_eq!((hit.count, hit.snippets.len()), (2, 1));
    }

    #[test]
    fn many_matches_few_snippets() {
        let (_d, s) = store();
        s.create(Some("Upprepning"), &"och lite mer text som skiljer träffarna åt. ".repeat(50)).unwrap();
        let hit = &search(&s, "och", SearchOptions::default()).unwrap()[0];
        assert_eq!((hit.count, hit.snippets.len()), (50, MAX_SNIPPETS));
    }
}
