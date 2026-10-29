//! Ported from the old backend's tests/test_convert.py (plus the Phase 0
//! Pandoc spike tests). Uses `WW_PANDOC` or `pandoc` on PATH; every test is
//! skipped with a message if neither exists.

use std::io::Read;
use std::path::PathBuf;

use ww_core::convert::{export_options, Pandoc};

fn pandoc() -> Option<Pandoc> {
    let bin = std::env::var("WW_PANDOC").unwrap_or_else(|_| "pandoc".into());
    let p = Pandoc::new(bin, PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources"));
    match p.version() {
        Ok(_) => Some(p),
        Err(e) => {
            eprintln!("SKIPPED – no pandoc: {e}");
            None
        }
    }
}

const DOC: &str = "---
title: Hamlet på Dramaten
author: Mikke Schirén
---

# Hamlet

Det var en **fet** och *kursiv* kväll – med ”svenska citat” och \"raka\".

> Att vara eller inte vara.

- ett
- två
";

fn part(data: &[u8], name: &str) -> String {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(data)).unwrap();
    let mut s = String::new();
    z.by_name(name).unwrap().read_to_string(&mut s).unwrap();
    s
}

fn export(p: &Pandoc, doc: &str, fmt: &str, template: &str, chapters: u8) -> Vec<u8> {
    p.export("Hamlet på Dramaten", doc, fmt, template, chapters).unwrap().0
}

fn text(p: &Pandoc, doc: &str, fmt: &str, chapters: u8) -> String {
    String::from_utf8(export(p, doc, fmt, "standard", chapters)).unwrap()
}

#[test]
fn formats_listed() {
    let o = export_options();
    assert_eq!(o.formats.iter().map(|f| f.key).collect::<Vec<_>>(), ["docx", "odt", "rtf", "html", "md", "txt"]);
    assert_eq!(o.templates.iter().map(|t| t.key).collect::<Vec<_>>(), ["standard", "manus", "artikel"]);
    let j = serde_json::to_value(&o).unwrap();
    assert_eq!(
        j["formats"][0],
        serde_json::json!({"key": "docx", "label": "Word (.docx)", "templates": true, "pages": true})
    );
}

#[test]
fn export_all_formats() {
    let Some(p) = pandoc() else { return };
    for fmt in ["docx", "odt", "rtf", "html", "md", "txt"] {
        let (data, f) = p.export("Hamlet på Dramaten", DOC, fmt, "standard", 0).unwrap();
        assert!(data.len() > 100, "{fmt}");
        assert_eq!(ww_core::convert::export_file_name("Hamlet på Dramaten", f), format!("Hamlet på Dramaten.{fmt}"));
    }
}

#[test]
fn docx_content_metadata_and_quotes() {
    let Some(p) = pandoc() else { return };
    let data = export(&p, DOC, "docx", "standard", 0);
    let xml = part(&data, "word/document.xml");
    assert!(xml.contains("Att vara eller inte vara."));
    assert!(xml.contains("”svenska citat”") && xml.contains("&quot;raka&quot;"), "no English smart quotes");
    let core = part(&data, "docProps/core.xml");
    assert!(core.contains("Hamlet på Dramaten") && core.contains("Mikke Schirén"));
    assert!(part(&data, "word/styles.xml").contains(r#"w:val="sv-SE""#));
}

#[test]
fn templates() {
    let Some(p) = pandoc() else { return };
    for (fmt, styles) in [("docx", "word/styles.xml"), ("odt", "styles.xml")] {
        let data = export(&p, DOC, fmt, "manus", 0);
        assert!(part(&data, styles).contains("Times New Roman"), "{fmt}");
        assert_eq!(p.export("x", DOC, fmt, "nope", 0).unwrap_err().status, 400);
    }
}

#[test]
fn txt_and_md() {
    let Some(p) = pandoc() else { return };
    let txt = text(&p, DOC, "txt", 0);
    assert!(!txt.contains("title:") && txt.contains("Att vara eller inte vara.") && !txt.contains("**"));
    assert_eq!(text(&p, DOC, "md", 0), DOC);
}

#[test]
fn roundtrip_docx() {
    let Some(p) = pandoc() else { return };
    let data = export(&p, DOC, "docx", "standard", 0);
    let (name, md) = p.import("Hamlet (kopia).docx", &data).unwrap();
    assert_eq!(name, "Hamlet (kopia)");
    assert!(md.starts_with("---\n") && md.contains("title: Hamlet på Dramaten"), "{md}");
    for want in ["# Hamlet", "**fet**", "*kursiv*", "> Att vara eller inte vara.", "- ett", "”svenska citat”"] {
        assert!(md.contains(want), "{want:?} missing in\n{md}");
    }
}

#[test]
fn import_html_cleans_formatting() {
    let Some(p) = pandoc() else { return };
    let html = "<html><body><h2>Rubrik</h2>\
        <p>Hej <u>under</u> <span style='font-family:Comic Sans'>värld</span>\
        <img src='bild.png' alt='bild'> x<sup>2</sup></p>\
        <table><tr><th>Namn</th><th>Roll</th></tr><tr><td>Hamlet</td><td>Prins</td></tr></table>\
        </body></html>";
    let (_, md) = p.import("webb.html", html.as_bytes()).unwrap();
    assert!(md.contains("## Rubrik"));
    assert!(md.contains("Hej under värld x2"), "{md}");
    assert!(md.contains("Namn – Roll") && md.contains("Hamlet – Prins"));
    assert!(!md.contains('<') && !md.contains("png"));
}

#[test]
fn import_footnotes() {
    let Some(p) = pandoc() else { return };
    let data = p.export("fn", "Text[^1] här.\n\n[^1]: En fotnot.\n", "docx", "standard", 0).unwrap().0;
    let (_, md) = p.import("fn.docx", &data).unwrap();
    assert!(md.contains("Text[^1] här.") && md.contains("[^1]: En fotnot."), "{md}");
}

#[test]
fn footnotes_exported() {
    let Some(p) = pandoc() else { return };
    let doc = "---\ntitle: Fotnoter\n---\n\n# Fotnoter\n\nRomanen kom ut 1879.[^1] Den väckte debatt.[^kalla]\n\n\
        [^1]: *Röda rummet*, Bonniers.\n\n    Andra stycket i fotnoten.\n\n\
        [^kalla]: {==Enligt==}{>>kolla<<} samtida recensioner.\n\n<!-- egen anteckning -->\n";
    let data = export(&p, doc, "docx", "standard", 0);
    let notes = part(&data, "word/footnotes.xml");
    assert!(notes.contains("Röda rummet") && notes.contains("Andra stycket i fotnoten."));
    assert!(notes.contains("samtida recensioner") && !notes.contains("kolla"), "comments removed in footnotes too");
    let body = part(&data, "word/document.xml");
    assert!(body.contains("footnoteReference") && !body.contains("Röda rummet"));
    let odt = part(&export(&p, doc, "odt", "standard", 0), "content.xml");
    assert!(odt.contains("text:note") && odt.contains("Röda rummet"));
    let html = text(&p, doc, "html", 0);
    assert!(html.contains("footnote") && html.contains("Röda rummet"));
}

#[test]
fn import_text_encodings_and_errors() {
    let Some(p) = pandoc() else { return };
    assert_eq!(p.import("gammal.txt", b"\xC5sa p\xE5 \xF6n").unwrap().1, "Åsa på ön\n");
    assert_eq!(p.import("bild.png", b"x").unwrap_err().status, 400);
    let e = p.import("trasig.docx", b"inte en docx").unwrap_err();
    assert!(e.status == 400 && e.detail.contains("Pandoc"), "{}", e.detail);
    // Invalid characters in the file name are replaced.
    assert_eq!(p.import("Recension: Hamlet?.md", b"# Hej").unwrap().0, "Recension Hamlet");
    // ".md" is a hidden file without extension (as in Python) → rejected.
    assert_eq!(p.import(".md", b"x").unwrap_err().status, 400);
    assert_eq!(p.import("  .txt", b"x").unwrap().0, "Importerad");
}

#[test]
fn a4_page_size() {
    let Some(p) = pandoc() else { return };
    for template in ["standard", "manus", "artikel"] {
        let docx = part(&export(&p, DOC, "docx", template, 0), "word/document.xml");
        assert!(docx.contains(r#"w:w="11906""#) && docx.contains(r#"w:h="16838""#), "{template}");
        let styles = part(&export(&p, DOC, "odt", template, 0), "styles.xml");
        assert!(styles.contains(r#"fo:page-width="21cm""#) && styles.contains(r#"fo:page-height="29.7cm""#));
    }
}

#[test]
fn a4_rtf_and_html() {
    let Some(p) = pandoc() else { return };
    assert!(text(&p, DOC, "rtf", 0).contains(r"\paperw11906\paperh16838"));
    let html = text(&p, DOC, "html", 0);
    assert!(html.contains("size: A4") && html.contains("<title>Hamlet på Dramaten</title>"));
}

#[test]
fn notes_never_exported() {
    let Some(p) = pandoc() else { return };
    let doc = "---\ntitle: Krönika\n---\n\n# Krönika\n\nFörsta stycket.\n\n<!-- Kolla siffran med kommunen -->\n\n\
        Andra <!-- inne i stycket --> stycket.\n\n<!-- flera\nrader -->\n\n```\n<!-- kod behålls -->\n```\n";
    let md = text(&p, doc, "md", 0);
    assert!(!md.contains("Kolla siffran") && !md.contains("inne i") && !md.contains("rader"));
    assert!(
        md.contains("Andra stycket.") && md.contains("<!-- kod behålls -->") && md.starts_with("---\ntitle: Krönika")
    );
    for fmt in ["txt", "html"] {
        let out = text(&p, doc, fmt, 0);
        assert!(!out.contains("Kolla siffran") && !out.contains("flera"), "{fmt}");
    }
    let xml = part(&export(&p, doc, "docx", "standard", 0), "word/document.xml");
    assert!(!xml.contains("Kolla siffran") && xml.contains("Första stycket."));
    // The heading is both title and first in the text – only once in the Word file.
    assert_eq!(xml.matches("Krönika").count(), 1);
}

const BOOK: &str = "---\ntitle: Boken\n---\n\n# Boken\n\nFörord.\n\n## Kapitel 1\n\nEtt.\n\n## Kapitel 2\n\nTvå.\n";

#[test]
fn page_break_before_chapters_docx() {
    let Some(p) = pandoc() else { return };
    // Level 1: "# Boken" duplicates the title and is removed – no level-1 heading left.
    for (chapters, expected) in [(0, 0), (2, 2), (1, 0)] {
        let xml = part(&export(&p, BOOK, "docx", "standard", chapters), "word/document.xml");
        assert_eq!(xml.matches(r#"w:type="page""#).count(), expected, "chapters={chapters}");
    }
}

#[test]
fn page_break_first_heading_not_broken() {
    let Some(p) = pandoc() else { return };
    let doc = "# Del 1\n\nA.\n\n# Del 2\n\nB.\n\n# Del 3\n\nC.\n";
    let xml = part(&export(&p, doc, "docx", "standard", 1), "word/document.xml");
    assert_eq!(xml.matches(r#"w:type="page""#).count(), 2, "not before the first heading");
    let odt = export(&p, doc, "odt", "manus", 1);
    assert_eq!(part(&odt, "content.xml").matches(r#"text:style-name="Pagebreak""#).count(), 2);
    assert!(part(&odt, "styles.xml").contains(r#"style:name="Pagebreak""#));
    assert!(text(&p, doc, "rtf", 1).matches(r"\page").count() >= 2);
    assert_eq!(text(&p, doc, "html", 1).matches("break-after: page").count(), 2);
    assert!(!text(&p, doc, "md", 1).contains("page"), "Markdown is not affected");
    assert_eq!(p.export("x", doc, "docx", "standard", 3).unwrap_err().status, 400);
}

#[test]
fn comments_never_exported() {
    let Some(p) = pandoc() else { return };
    let doc = "# Text\n\nHon sa att {==hon aldrig varit där==}{>>Sa hon verkligen så?<<} och gick.\n\n\
        En **{==fet==}{>>kolla<<}** del. Fristående {>>bara kommentar<<} här.\n\n```\n{==kod==}{>>behålls<<}\n```\n";
    let md = text(&p, doc, "md", 0);
    assert!(!md.contains("Sa hon verkligen") && !md.split("```").next().unwrap().contains("{=="));
    assert!(md.contains("Hon sa att hon aldrig varit där och gick."));
    assert!(md.contains("En **fet** del. Fristående här."), "{md}");
    assert!(md.contains("{==kod==}{>>behålls<<}"), "code block untouched");
    let xml = part(&export(&p, doc, "docx", "standard", 0), "word/document.xml");
    assert!(!xml.contains("Sa hon verkligen") && !xml.contains("kolla") && xml.contains("aldrig varit där"));
}

#[test]
fn non_ascii_page_title() {
    // Phase 0 finding: without LC_ALL, Pandoc garbles non-ASCII arguments.
    let Some(p) = pandoc() else { return };
    let html = String::from_utf8(p.export("Ålgång", "# x\n", "html", "standard", 0).unwrap().0).unwrap();
    assert!(html.contains("<title>Ålgång</title>"));
}
