//! Import and export via Pandoc, run as a separate program (the `ww-pandoc`
//! sidecar next to the app executable). Same Pandoc arguments, Lua filters
//! and reference documents as the Docker version, so the files are the same.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::LazyLock;
use std::time::Duration;

use serde::Serialize;
use wait_timeout::ChildExt;

use crate::error::{Error, Result};
use crate::text::{safe_name, split_frontmatter};

/// Pandoc's markdown without "smart": quotes and dashes stay exactly as written
/// (Swedish ” ” and –, not English “ ”).
pub const MD_IN: &str = "markdown-smart";
/// The Markdown the editor understands: GFM with YAML frontmatter, no wrapping.
pub const MD_OUT: &str = "gfm+yaml_metadata_block";
pub const TIMEOUT: Duration = Duration::from_secs(60);
pub const MAX_IMPORT_BYTES: usize = 25 * 1024 * 1024;
/// Readers and writers may only read files named on the command line (the
/// reference document, Lua filters). Without it, an image reference like
/// `![](/Users/x/.ssh/id_ed25519)` or `![](https://…)` is read or fetched and
/// embedded in an exported .docx/.odt/.rtf.
const SANDBOX: &str = "--sandbox";

#[derive(Debug, Clone, Copy, Serialize)]
pub struct ExportFormat {
    pub key: &'static str,
    pub label: &'static str,
    pub ext: &'static str,
    #[serde(skip)]
    pub media_type: &'static str,
    /// Pandoc writer; `None` = no conversion.
    #[serde(skip)]
    pub pandoc: Option<&'static str>,
    pub templates: bool,
}

pub const EXPORT_FORMATS: &[ExportFormat] = &[
    ExportFormat {
        key: "docx",
        label: "Word (.docx)",
        ext: "docx",
        media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        pandoc: Some("docx"),
        templates: true,
    },
    ExportFormat {
        key: "odt",
        label: "OpenDocument (.odt)",
        ext: "odt",
        media_type: "application/vnd.oasis.opendocument.text",
        pandoc: Some("odt"),
        templates: true,
    },
    ExportFormat {
        key: "rtf",
        label: "Rich Text (.rtf)",
        ext: "rtf",
        media_type: "application/rtf",
        pandoc: Some("rtf"),
        templates: false,
    },
    ExportFormat {
        key: "html",
        label: "Webbsida (.html)",
        ext: "html",
        media_type: "text/html; charset=utf-8",
        pandoc: Some("html5"),
        templates: false,
    },
    ExportFormat {
        key: "md",
        label: "Markdown (.md)",
        ext: "md",
        media_type: "text/markdown; charset=utf-8",
        pandoc: None,
        templates: false,
    },
    ExportFormat {
        key: "txt",
        label: "Ren text (.txt)",
        ext: "txt",
        media_type: "text/plain; charset=utf-8",
        pandoc: Some("plain"),
        templates: false,
    },
];

pub const TEMPLATES: &[(&str, &str)] = &[
    ("standard", "Standard – Cambria 12 p, rubriker i Calibri"),
    ("manus", "Manus – Times 12 p, 1,5 radavstånd, indrag"),
    ("artikel", "Artikel – Georgia 11 p, luft mellan stycken"),
];

/// Formats with pages: get page breaks before chapters and a standalone document.
pub const PAGED_FORMATS: &[&str] = &["docx", "odt", "rtf", "html"];

/// Extensions we import, and their Pandoc reader (`None` = read as text).
pub const IMPORT_FORMATS: &[(&str, Option<&str>)] = &[
    ("docx", Some("docx")),
    ("odt", Some("odt")),
    ("rtf", Some("rtf")),
    ("html", Some("html")),
    ("htm", Some("html")),
    ("md", None),
    ("markdown", None),
    ("txt", None),
];

const HTML_CSS: &str = "
body { max-width: 40em; margin: 3em auto; padding: 0 1em; font: 18px/1.65 Georgia, serif; color: #222; }
h1, h2, h3 { line-height: 1.25; }
blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid #ddd; font-style: italic; }
header { margin-bottom: 2em; } .author, .date { margin: 0; color: #666; }
@page { size: A4; margin: 2.5cm; }
@media print { body { max-width: none; margin: 0; padding: 0; font-size: 12pt; } }
";

/// A4 (11906 × 16838 twips) with 2.5 cm (1417 twips) margins.
const RTF_A4: &[u8] = b"\\paperw11906\\paperh16838\\margl1417\\margr1417\\margt1417\\margb1417\n";

#[cfg(target_os = "macos")]
const UTF8_LOCALE: &str = "en_US.UTF-8";
#[cfg(not(target_os = "macos"))]
const UTF8_LOCALE: &str = "C.UTF-8";

#[derive(Serialize)]
pub struct FormatInfo {
    pub key: &'static str,
    pub label: &'static str,
    pub templates: bool,
    pub pages: bool,
}

#[derive(Serialize)]
pub struct TemplateInfo {
    pub key: &'static str,
    pub label: &'static str,
}

#[derive(Serialize)]
pub struct ExportOptions {
    pub formats: Vec<FormatInfo>,
    pub templates: Vec<TemplateInfo>,
}

/// Formats and templates for the export dialog.
pub fn export_options() -> ExportOptions {
    ExportOptions {
        formats: EXPORT_FORMATS
            .iter()
            .map(|f| FormatInfo {
                key: f.key,
                label: f.label,
                templates: f.templates,
                pages: PAGED_FORMATS.contains(&f.key),
            })
            .collect(),
        templates: TEMPLATES.iter().map(|&(key, label)| TemplateInfo { key, label }).collect(),
    }
}

pub fn export_format(key: &str) -> Result<&'static ExportFormat> {
    EXPORT_FORMATS.iter().find(|f| f.key == key).ok_or_else(|| Error::bad_request(format!("Okänt exportformat: {key}")))
}

// ---------------------------------------------------------------- text filters

fn is_fence(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("```") || t.starts_with("~~~")
}

/// Removes own notes (HTML comments), except in code blocks. A line that only
/// held a note disappears completely.
pub fn strip_notes(md: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let (mut fence, mut in_note) = (false, false);
    for line in md.split('\n') {
        if !in_note && is_fence(line) {
            fence = !fence;
        }
        if fence {
            out.push(line.to_string());
            continue;
        }
        let was_in_note = in_note;
        let mut rest: &str = line;
        let mut kept = String::new();
        while !rest.is_empty() {
            if in_note {
                let Some(end) = rest.find("-->") else { break };
                rest = &rest[end + 3..];
                in_note = false;
                if kept.ends_with(char::is_whitespace) && rest.starts_with(char::is_whitespace) {
                    rest = rest.trim_start_matches([' ', '\t']);
                }
            } else {
                let Some(start) = rest.find("<!--") else {
                    kept.push_str(rest);
                    break;
                };
                kept.push_str(&rest[..start]);
                rest = &rest[start + 4..];
                in_note = true;
            }
        }
        if !kept.trim().is_empty() {
            out.push(kept.trim_end().to_string());
        } else if !was_in_note && !line.contains("<!--") {
            out.push(line.to_string());
        }
    }
    collapse_blank_lines(&out.join("\n"))
}

/// Python: `re.sub(r"\n{3,}", "\n\n", text)`
fn collapse_blank_lines(text: &str) -> String {
    static RE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\n{3,}").expect("regex"));
    RE.replace_all(text, "\n\n").into_owned()
}

/// Removes comments (CriticMarkup), except in code blocks:
/// `{==text==}{>>comment<<}` becomes `text`, a lone `{>>comment<<}` disappears.
pub fn strip_comments(md: &str) -> String {
    static CODE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"(?m)^(?:```|~~~)[\s\S]*?^(?:```|~~~)[ \t]*$").expect("regex"));
    static PAIR: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"\{==([\s\S]+?)==\}\{>>[\s\S]*?<<\}").expect("regex"));
    static LONE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"[ \t]?\{>>[\s\S]*?<<\}").expect("regex"));
    static MARK: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\{==([\s\S]+?)==\}").expect("regex"));
    let clean = |part: &str| {
        let p = PAIR.replace_all(part, "$1");
        let p = LONE.replace_all(&p, "");
        MARK.replace_all(&p, "$1").into_owned()
    };
    let mut out = String::new();
    let mut last = 0;
    for m in CODE.find_iter(md) {
        out.push_str(&clean(&md[last..m.start()]));
        out.push_str(m.as_str());
        last = m.end();
    }
    out.push_str(&clean(&md[last..]));
    out
}

/// `title:` from the frontmatter, unquoted and with normalised spaces.
fn frontmatter_title(frontmatter: &str) -> String {
    static RE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"(?m)^title:[ \t]+(.+?)[ \t]*$").expect("regex"));
    let Some(m) = RE.captures(frontmatter) else { return String::new() };
    let mut v = m[1].to_string();
    let b = v.as_bytes();
    if b.len() >= 2 && b[0] == b[b.len() - 1] && (b[0] == b'"' || b[0] == b'\'') {
        v = v[1..v.len() - 1].to_string();
    }
    v.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Pandoc writes the title at the top. If the text starts with the same
/// heading, drop it so it isn't shown twice.
fn drop_duplicate_title(frontmatter: &str, body: &str) -> String {
    static RE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"\A\s*#[ \t]+(.+?)[ \t#]*(?:\n|\z)").expect("regex"));
    let title = frontmatter_title(frontmatter);
    if title.is_empty() {
        return body.to_string();
    }
    if let Some(m) = RE.captures(body) {
        if m[1].split_whitespace().collect::<Vec<_>>().join(" ") == title {
            return body[m.get(0).expect("match").end()..].trim_start_matches('\n').to_string();
        }
    }
    body.to_string()
}

/// Pandoc's RTF has no page size (Word then often picks Letter) – add A4.
fn rtf_a4(data: &[u8]) -> Vec<u8> {
    let marker = b"\\widowctrl";
    let i = data
        .windows(marker.len())
        .position(|w| w == marker)
        .unwrap_or_else(|| data.iter().position(|&b| b == b'\n').map_or(0, |p| p + 1));
    [&data[..i], RTF_A4, &data[i..]].concat()
}

pub fn normalize(text: &str) -> String {
    let t = text.replace("\r\n", "\n").replace('\r', "\n");
    let t = t.trim();
    if t.is_empty() {
        String::new()
    } else {
        format!("{t}\n")
    }
}

/// UTF-8 (with or without BOM), else Windows-1252 – like the old
/// `utf-8-sig` → `cp1252` → `latin-1` chain.
fn decode_text(data: &[u8]) -> String {
    let data = data.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(data);
    match std::str::from_utf8(data) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::WINDOWS_1252.decode_without_bom_handling(data).0.into_owned(),
    }
}

// ---------------------------------------------------------------- Pandoc

/// Locates Pandoc and the resources (Lua filters, reference documents).
#[derive(Debug, Clone)]
pub struct Pandoc {
    pub bin: PathBuf,
    /// Directory holding `filters/` and `templates/`.
    pub resources: PathBuf,
}

impl Pandoc {
    pub fn new(bin: impl Into<PathBuf>, resources: impl Into<PathBuf>) -> Self {
        Self { bin: bin.into(), resources: resources.into() }
    }

    fn filter(&self, name: &str) -> String {
        path_arg(&self.resources.join("filters").join(name))
    }

    /// `pandoc --version`, first line.
    pub fn version(&self) -> Result<String> {
        let out = self.run(&["--version".into()], None)?;
        Ok(String::from_utf8_lossy(&out).lines().next().unwrap_or("").to_string())
    }

    /// Runs Pandoc with `input` on stdin and returns stdout. Kills it after [`TIMEOUT`].
    pub fn run(&self, args: &[String], input: Option<&[u8]>) -> Result<Vec<u8>> {
        let mut child = Command::new(&self.bin)
            .args(args)
            // Pandoc (GHC) decodes arguments with the locale. Apps started from
            // Finder have no LANG, so non-ASCII arguments (e.g. the page title
            // "Ålgång") would be garbled without this.
            .env("LC_ALL", UTF8_LOCALE)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| Error::internal(format!("Kunde inte starta Pandoc ({}): {e}", self.bin.display())))?;

        // Write stdin and read stdout/stderr on separate threads so large
        // documents can't deadlock on full pipes.
        let mut stdin = child.stdin.take().expect("piped");
        let input = input.map(<[u8]>::to_vec).unwrap_or_default();
        let writer = std::thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
        let mut stdout = child.stdout.take().expect("piped");
        let mut stderr = child.stderr.take().expect("piped");
        let out_reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = std::io::Read::read_to_end(&mut stdout, &mut buf);
            buf
        });
        let err_reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = std::io::Read::read_to_end(&mut stderr, &mut buf);
            buf
        });

        let status = match child.wait_timeout(TIMEOUT).map_err(|e| Error::internal(e.to_string()))? {
            Some(status) => status,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error::bad_request("Konverteringen tog för lång tid."));
            }
        };
        let _ = writer.join();
        let out = out_reader.join().unwrap_or_default();
        let err = err_reader.join().unwrap_or_default();
        if !status.success() {
            let msg = String::from_utf8_lossy(&err);
            let last = msg.trim().lines().last().unwrap_or("okänt fel").to_string();
            return Err(Error::bad_request(format!("Pandoc kunde inte konvertera filen: {last}")));
        }
        Ok(out)
    }

    /// Exports a document. `chapters` (1 or 2) gives a page break before every
    /// heading on that level. Own notes and comments are never exported.
    pub fn export(
        &self,
        name: &str,
        markdown: &str,
        key: &str,
        template: &str,
        chapters: u8,
    ) -> Result<(Vec<u8>, &'static ExportFormat)> {
        let fmt = export_format(key)?;
        let (frontmatter, body) = split_frontmatter(markdown);
        let mut body = strip_comments(&strip_notes(body));
        let Some(writer) = fmt.pandoc else {
            return Ok((format!("{frontmatter}{body}").into_bytes(), fmt));
        };
        let paged = PAGED_FORMATS.contains(&fmt.key);
        if paged {
            body = drop_duplicate_title(frontmatter, &body);
        }
        let mut args: Vec<String> =
            [SANDBOX, "-f", MD_IN, "-t", writer, "--wrap=none", "-M", "lang=sv-SE"].map(String::from).to_vec();
        if chapters > 2 {
            return Err(Error::bad_request("Kapitelnivån måste vara 1 eller 2."));
        }
        if chapters > 0 && paged {
            args.extend(["--lua-filter".into(), self.filter("chapters.lua"), "-M".into()]);
            args.push(format!("ww-chapter-level={chapters}"));
        }
        if paged {
            args.push("--standalone".into());
        }
        if fmt.key == "html" {
            // Title in the browser tab without adding a heading that isn't in the text.
            args.extend(["-M".into(), format!("pagetitle={name}")]);
            args.extend(["-V".into(), format!("header-includes=<style>{HTML_CSS}</style>")]);
        }
        if fmt.templates {
            // Always a template – also Standard – so the page size is A4.
            if !TEMPLATES.iter().any(|(k, _)| *k == template) {
                return Err(Error::bad_request(format!("Okänd mall: {template}")));
            }
            args.push("--reference-doc".into());
            args.push(path_arg(&self.resources.join("templates").join(format!("{template}.{}", fmt.ext))));
        }
        // Plain text: metadata doesn't belong in the body.
        let input = if fmt.key == "txt" { body } else { format!("{frontmatter}{body}") };
        let mut data = self.run(&args, Some(input.as_bytes()))?;
        if fmt.key == "rtf" {
            data = rtf_a4(&data);
        }
        Ok((data, fmt))
    }

    /// Returns (suggested document name, Markdown).
    pub fn import(&self, filename: &str, data: &[u8]) -> Result<(String, String)> {
        if data.len() > MAX_IMPORT_BYTES {
            return Err(Error::bad_request("Filen är för stor (max 25 MB)."));
        }
        let path = Path::new(filename);
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        let Some(&(_, reader)) = IMPORT_FORMATS.iter().find(|(e, _)| *e == ext) else {
            let supported: Vec<String> = IMPORT_FORMATS.iter().map(|(e, _)| format!(".{e}")).collect();
            return Err(Error::bad_request(format!("Filtypen stöds inte. Använd {}.", supported.join(", "))));
        };
        let stem = path.file_stem().and_then(|s| s.to_str()).map(str::trim).filter(|s| !s.is_empty());
        let name = safe_name(stem.unwrap_or("Importerad"), "Importerad");
        let text = match reader {
            None => decode_text(data),
            // The file goes in on stdin – no temporary files needed.
            Some(r) => {
                let args: Vec<String> = [SANDBOX, "-f", r, "-t", MD_OUT, "--standalone", "--wrap=none", "--lua-filter"]
                    .map(String::from)
                    .into_iter()
                    .chain([self.filter("import.lua")])
                    .collect();
                String::from_utf8_lossy(&self.run(&args, Some(data))?).into_owned()
            }
        };
        Ok((name, normalize(&text)))
    }
}

fn path_arg(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// File name for an export: `<document>.<ext>`.
pub fn export_file_name(name: &str, fmt: &ExportFormat) -> String {
    format!("{name}.{}", fmt.ext)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_notes_unit() {
        assert_eq!(strip_notes("a\n\n<!-- x -->\n\nb\n"), "a\n\nb\n");
        assert_eq!(strip_notes("a <!-- x --> b"), "a b");
        assert_eq!(strip_notes("<!-- a\nb\nc -->\ntext"), "text");
        assert_eq!(strip_notes("~~~\n<!-- k -->\n~~~"), "~~~\n<!-- k -->\n~~~");
    }

    #[test]
    fn strip_comments_unit() {
        assert_eq!(strip_comments("Hon {==sa==}{>>kolla<<} det."), "Hon sa det.");
        assert_eq!(strip_comments("Fristående {>>bara<<} här."), "Fristående här.");
        assert_eq!(strip_comments("```\n{==kod==}{>>k<<}\n```\n{==x==}"), "```\n{==kod==}{>>k<<}\n```\nx");
    }

    #[test]
    fn title_and_duplicate_heading() {
        assert_eq!(frontmatter_title("---\ntitle: \"Hamlet  på Dramaten\"\n---\n"), "Hamlet på Dramaten");
        assert_eq!(drop_duplicate_title("---\ntitle: Krönika\n---\n", "\n# Krönika\n\nText"), "Text");
        assert_eq!(drop_duplicate_title("---\ntitle: Annan\n---\n", "\n# Krönika\n\nText"), "\n# Krönika\n\nText");
        assert_eq!(drop_duplicate_title("", "# Krönika\n"), "# Krönika\n");
    }

    #[test]
    fn rtf_page_size() {
        let out = rtf_a4(b"{\\rtf1\n\\widowctrl x}");
        assert_eq!(
            out,
            b"{\\rtf1\n\\paperw11906\\paperh16838\\margl1417\\margr1417\\margt1417\\margb1417\n\\widowctrl x}"
        );
        assert!(rtf_a4(b"{\\rtf1\nx}").starts_with(b"{\\rtf1\n\\paperw11906"));
    }

    #[test]
    fn text_decoding() {
        assert_eq!(decode_text("Åsa".as_bytes()), "Åsa");
        assert_eq!(decode_text(b"\xEF\xBB\xBFHej"), "Hej");
        assert_eq!(decode_text(b"\xC5sa p\xE5 \xF6n \x96 \x93x\x94"), "Åsa på ön – “x”");
    }
}
