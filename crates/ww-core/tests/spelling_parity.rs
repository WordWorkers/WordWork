//! Spelling parity with the old app (spylls). The fixture is produced by
//! `tools/spylls_reference.py` from real Swedish text (README, sample documents).

use std::path::PathBuf;

use ww_core::language::Dictionaries;

fn load() -> (Dictionaries, serde_json::Value) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let d = Dictionaries::load(&root.join("../../resources/sv")).unwrap();
    let r = std::fs::read_to_string(root.join("tests/fixtures/spylls_reference.json")).unwrap();
    (d, serde_json::from_str(&r).unwrap())
}

/// Known, accepted differences (see docs/phase0.md).
const KNOWN_DIFFERENCES: &[&str] = &["assistant", "JS-alternativ"];

#[test]
fn check_and_stems_match_spylls() {
    let (d, r) = load();
    let mut diffs = vec![];
    for (w, v) in r["words"].as_object().unwrap() {
        if d.check(w) != v["ok"].as_bool().unwrap() && !KNOWN_DIFFERENCES.contains(&w.as_str()) {
            diffs.push(w.clone());
        }
    }
    assert!(diffs.is_empty(), "check differs from spylls for {diffs:?}");

    let stems = r["stems"].as_object().unwrap();
    let mut missing = 0;
    let mut total = 0;
    for (w, s) in stems {
        let want: Vec<&str> = s.as_array().unwrap().iter().filter_map(|x| x.as_str()).collect();
        if want.is_empty() {
            continue;
        }
        total += 1;
        let got = d.stemmer.stems(w);
        if !want.iter().all(|x| got.iter().any(|g| g == x)) {
            missing += 1;
        }
    }
    assert!(missing * 100 <= total * 2, "stems missing for {missing} of {total} words (max 2 %)");
}

#[test]
fn suggestions_cover_spylls_first_choice() {
    let (d, r) = load();
    for w in ["fellstavat", "ordbehnadlare", "kulturjornalist", "sommmar", "nåogn", "stockhlom", "tyvär"] {
        let want = r["words"][w]["sugg"][0].as_str().unwrap();
        let got = d.suggest(w);
        assert!(got.iter().take(3).any(|g| g == want), "{w}: want {want} in top 3, got {got:?}");
    }
}
