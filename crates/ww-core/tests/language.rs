//! Ported from the old backend's tests/test_language.py.

use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

use ww_core::language::{Dictionaries, PersonalDictionary};

fn dict() -> &'static Dictionaries {
    static D: OnceLock<Dictionaries> = OnceLock::new();
    D.get_or_init(|| Dictionaries::load(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources/sv")).unwrap())
}

fn words(s: &str) -> Vec<String> {
    s.split_whitespace().map(String::from).collect()
}

fn personal() -> (tempfile::TempDir, PersonalDictionary, PathBuf) {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join(".wordwork/ordlista.txt");
    (dir, PersonalDictionary::new(&path), path)
}

#[test]
fn check_swedish_text() {
    let (_d, p, _) = personal();
    let w = words("Det här är en recenssion av teaterföreställningen på Dramaten 2026 i Göteborgs-Posten");
    assert_eq!(dict().misspelled(&w, &p), ["recenssion"]);
}

#[test]
fn compounds_and_capitalisation() {
    let (_d, p, _) = personal();
    let w = words("kärnkraftverksolycka Kulturjournalisten Strindbergs TV");
    assert!(dict().misspelled(&w, &p).is_empty());
}

#[test]
fn punctuation_and_digits_are_ignored() {
    let (_d, p, _) = personal();
    // The editor sends words without sentence punctuation; leading/trailing
    // dashes and apostrophes are stripped like the old `_clean`.
    // A lone "–" is reported, exactly as the old app did (the editor never sends it).
    let w = vec!["–".into(), "'recension'".into(), "-ord-".into(), "x2".into(), "".into(), "a".repeat(70)];
    assert_eq!(dict().misspelled(&w, &p), ["–"]);
}

#[test]
fn suggest() {
    assert!(dict().suggestions("recenssion", 6).iter().any(|s| s == "recension"));
    assert!(dict().suggestions("recenssion", 1).len() <= 1);
    assert!(!dict().suggestions("recension", 6).iter().any(|s| s == "recension"), "never the word itself");
    assert!(dict().suggestions("  ", 6).is_empty());
}

#[test]
fn personal_dictionary() {
    let (_d, p, path) = personal();
    assert_eq!(dict().misspelled(&words("Lagercrantzsk"), &p), ["Lagercrantzsk"]);
    p.add("Lagercrantzsk").unwrap();
    assert_eq!(p.words(), ["Lagercrantzsk"]);
    assert!(dict().misspelled(&words("Lagercrantzsk"), &p).is_empty());
    assert_eq!(fs::read_to_string(&path).unwrap(), "Lagercrantzsk\n");
    // Lower case in the list also accepts a capital first letter, not the other way round.
    p.add("fanzinekultur").unwrap();
    assert_eq!(dict().misspelled(&words("Fanzinekultur lagercrantzsk"), &p), ["lagercrantzsk"]);
    p.remove("Lagercrantzsk").unwrap();
    assert_eq!(p.words(), ["fanzinekultur"]);
    assert_eq!(p.add("ett två tre fyra fem sex sju").unwrap_err().status, 400);
    assert_eq!(p.add("   ").unwrap_err().status, 400);
}

#[test]
fn phrases_in_dictionary() {
    let (_d, p, _) = personal();
    p.add("  open   source ").unwrap();
    assert!(p.words().contains(&"open source".to_string()));
    // Words of a phrase are not accepted on their own – the editor decides from context.
    assert_eq!(dict().misspelled(&words("source"), &p), ["source"]);
    p.remove("open source").unwrap();
    assert!(!p.words().contains(&"open source".to_string()));
}

#[test]
fn synonyms_with_base_form() {
    let groups = dict().synonyms("vackra");
    let vacker = groups.iter().find(|g| g.word == "vacker").expect("base form");
    assert!(vacker.base_form && vacker.synonyms.iter().any(|s| s == "ljuvlig"));
    let vackra = groups.iter().find(|g| g.word == "vackra").expect("inflected form has its own synonyms");
    assert!(!vackra.base_form);

    let direct = dict().synonyms("Bra");
    assert_eq!(direct[0].word, "bra");
    assert!(!direct[0].base_form);
    assert!(dict().synonyms("xyzzy").is_empty());
}

#[test]
fn edit_dictionary() {
    let (_d, p, path) = personal();
    p.add("Lagercrantz").unwrap();
    p.rename("Lagercrantz", "Lagercrantzsk").unwrap();
    assert_eq!(p.words(), ["Lagercrantzsk"]);
    assert_eq!(p.rename("finns-inte", "x").unwrap_err().status, 404);
    let lines: Vec<String> = ["  open  source ", "", "fanzine", "fanzine"].map(String::from).to_vec();
    p.replace_all(&lines).unwrap();
    assert_eq!(p.words(), ["fanzine", "open source"]);
    assert_eq!(fs::read_to_string(&path).unwrap(), "fanzine\nopen source\n");
    let e = p.replace_all(&["ett två tre fyra fem sex sju".to_string()]).unwrap_err();
    assert!(e.status == 400 && e.detail.contains("Ogiltiga"));
}

#[test]
fn dictionary_file_edited_by_hand() {
    let (_d, p, path) = personal();
    p.add("qzfanzinx").unwrap();
    fs::write(&path, "# kommentar\nBergmansk\nNew  York Times\n").unwrap();
    // Make sure the mtime differs even on coarse file systems.
    let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
    fs::File::options().write(true).open(&path).unwrap().set_modified(later).unwrap();
    assert_eq!(p.words(), ["Bergmansk", "New York Times"]);
    assert_eq!(dict().misspelled(&words("Bergmansk qzfanzinx"), &p), ["qzfanzinx"]);
}

#[test]
fn sorted_like_python_casefold() {
    let (_d, p, path) = personal();
    p.replace_all(&["Öland", "abc", "Åre", "Bergman", "ärlig"].map(String::from)).unwrap();
    // casefold sorts by code point (ä U+E4 < å U+E5), as Python did.
    assert_eq!(fs::read_to_string(&path).unwrap(), "abc\nBergman\närlig\nÅre\nÖland\n");
}
