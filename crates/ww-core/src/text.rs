//! Small text helpers shared by storage, export and AI: frontmatter, word
//! count and document-name rules.

use std::sync::LazyLock;

use crate::error::{Error, Result};

pub const MAX_NAME: usize = 120;

/// YAML frontmatter at the start of the file (same rule as the frontend and Pandoc):
/// `---` line, not directly followed by an empty line, then up to `---` or `...`.
static FRONTMATTER: LazyLock<fancy_regex::Regex> = LazyLock::new(|| {
    fancy_regex::Regex::new(
        r"\A\x{feff}?---[ \t]*\r?\n(?![ \t]*\r?\n)(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|\z)",
    )
    .expect("frontmatter regex")
});

/// Python's `\w` is "isalnum() or _": letters and *all* numbers (also ½ and ²),
/// but not combining marks. Rust's `\w` differs on both, so spell it out to
/// count exactly like the old app.
static WORD: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"[\p{L}\p{N}_]+(?:[-'’][\p{L}\p{N}_]+)*").expect("word regex"));

/// Splits `text` into (frontmatter including delimiters, body).
pub fn split_frontmatter(text: &str) -> (&str, &str) {
    match FRONTMATTER.find(text) {
        Ok(Some(m)) => (&text[..m.end()], &text[m.end()..]),
        _ => ("", text),
    }
}

/// Words in the body text (frontmatter is not counted).
pub fn count_words(text: &str) -> usize {
    WORD.find_iter(split_frontmatter(text).1).count()
}

fn forbidden(c: char) -> bool {
    matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (c as u32) < 0x20
}

/// Normalises whitespace and checks that `name` can be a document file name.
pub fn validate_name(name: &str) -> Result<String> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err(Error::bad_request("Namnet får inte vara tomt."));
    }
    if name.chars().count() > MAX_NAME {
        return Err(Error::bad_request(format!("Namnet får vara högst {MAX_NAME} tecken.")));
    }
    if name.starts_with('.') || name.chars().any(forbidden) {
        return Err(Error::bad_request(r#"Namnet får inte börja med punkt eller innehålla \ / : * ? " < > |"#));
    }
    Ok(name)
}

/// Turns e.g. an imported file name into a valid document name.
pub fn safe_name(name: &str, fallback: &str) -> String {
    let replaced: String = name.chars().map(|c| if forbidden(c) { ' ' } else { c }).collect();
    let trimmed = replaced.trim_start_matches(['.', ' ']);
    let joined = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = joined.chars().take(MAX_NAME).collect();
    let cut = cut.trim();
    if cut.is_empty() {
        fallback.to_string()
    } else {
        cut.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter() {
        let text = "---\ntitel: Hamlet\n---\n\nTre ord här.\n";
        assert_eq!(split_frontmatter(text), ("---\ntitel: Hamlet\n---\n", "\nTre ord här.\n"));
        assert_eq!(count_words(text), 3);
        // A thematic break, not frontmatter.
        assert_eq!(split_frontmatter("---\n\nText\n\n---\n").0, "");
        assert_eq!(split_frontmatter("---\na: 1\n...\nText").1, "Text");
        assert_eq!(split_frontmatter("\u{feff}---\na: 1\n---").1, "");
        assert_eq!(split_frontmatter("---\r\na: 1\r\n---\r\nX").1, "X");
        assert_eq!(split_frontmatter("Text\n---\na: 1\n---\n").0, "");
    }

    #[test]
    fn words() {
        assert_eq!(count_words("# Hamlet\n\nAtt vara eller inte vara.\n"), 6);
        assert_eq!(count_words("EU-kommissionen säger att det är Annas bok, inte Pers’."), 9);
        assert_eq!(count_words("rock'n'roll – 12 mars"), 3);
        // Python counts ½ and ² as words (isalnum), like the old app did.
        assert_eq!(count_words("Vad är ½ när x²"), 5);
    }

    #[test]
    fn names() {
        assert_eq!(validate_name("  Åsa   på\tön ").unwrap(), "Åsa på ön");
        for bad in ["", "   ", "../evil", ".dold", "Recension: Hamlet", "a/b", "a\u{1}b"] {
            assert_eq!(validate_name(bad).unwrap_err().status, 400, "{bad:?}");
        }
        assert!(validate_name(&"x".repeat(120)).is_ok());
        assert!(validate_name(&"x".repeat(121)).is_err());
        assert_eq!(safe_name("..Recension: Hamlet?.docx", "Importerad"), "Recension Hamlet .docx");
        assert_eq!(safe_name("...", "Importerad"), "Importerad");
    }
}
