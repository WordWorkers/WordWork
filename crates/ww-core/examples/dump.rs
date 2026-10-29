//! Prints what the app would show for a data folder (JSON), e.g. to compare
//! with the old backend: cargo run -p ww-core --example dump -- <data dir> [trash|list]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let s = ww_core::storage::Storage::new(&args[1], 5.0);
    let v = match args.get(2).map(String::as_str).unwrap_or("list") {
        // Word counts the old app stored in every history index vs ours.
        "words" => {
            let mut bad = vec![];
            let mut n = 0;
            for dir in walk(&s.root().join(".history")).into_iter().chain(walk(&s.root().join(".trash"))) {
                let Ok(t) = std::fs::read_to_string(dir.join("index.json")) else { continue };
                let index: Vec<ww_core::storage::Version> = serde_json::from_str(&t).unwrap();
                for v in index {
                    let text = std::fs::read_to_string(dir.join(format!("{}.md", v.id))).unwrap();
                    n += 1;
                    if ww_core::text::count_words(&text) != v.words {
                        bad.push(format!("{}/{}", dir.display(), v.id));
                    }
                }
            }
            serde_json::json!({"versions": n, "mismatch": bad})
        }
        // dump <dir> lang <resources/sv> <words.txt>: misspelled + synonym heads per word
        "lang" => {
            let d = ww_core::language::Dictionaries::load(std::path::Path::new(&args[3])).unwrap();
            let p = ww_core::language::PersonalDictionary::new(s.root().join(".wordwork/ordlista.txt"));
            let words: Vec<String> = std::fs::read_to_string(&args[4]).unwrap().lines().map(String::from).collect();
            let syn: serde_json::Map<String, serde_json::Value> = words
                .iter()
                .map(|w| {
                    (
                        w.clone(),
                        serde_json::json!(d
                            .synonyms(w)
                            .iter()
                            .map(|g| (g.word.clone(), g.base_form))
                            .collect::<Vec<_>>()),
                    )
                })
                .collect();
            serde_json::json!({"misspelled": d.misspelled(&words, &p), "synonyms": syn})
        }
        // dump <dir> export <resources> <out dir>: same matrix as /tmp/e2e/export_ref.py
        "export" => {
            let pandoc =
                ww_core::convert::Pandoc::new(std::env::var("WW_PANDOC").unwrap_or_else(|_| "pandoc".into()), &args[3]);
            let mut docs: Vec<std::path::PathBuf> = Vec::new();
            for dir in [s.root().to_path_buf(), s.root().join(".trash")] {
                for e in std::fs::read_dir(dir).unwrap().flatten() {
                    if e.path().extension().is_some_and(|x| x == "md") && e.path().is_file() {
                        docs.push(e.path());
                    }
                }
            }
            let mut n = 0;
            for path in &docs {
                let name = path.file_stem().unwrap().to_string_lossy().into_owned();
                let md = std::fs::read_to_string(path).unwrap();
                let matrix: [(&str, &[&str], &[u8]); 6] = [
                    ("docx", &["standard", "manus", "artikel"], &[0, 1]),
                    ("odt", &["standard", "manus", "artikel"], &[0, 1]),
                    ("rtf", &["standard"], &[0, 1]),
                    ("html", &["standard"], &[0, 1]),
                    ("md", &["standard"], &[0]),
                    ("txt", &["standard"], &[0]),
                ];
                for (fmt, tpls, chs) in matrix {
                    for t in tpls {
                        for &c in chs {
                            let (data, f) = pandoc.export(&name, &md, fmt, t, c).unwrap();
                            std::fs::write(format!("{}/{name}__{t}_{c}.{}", args[4], f.ext), data).unwrap();
                            n += 1;
                        }
                    }
                }
            }
            serde_json::json!({"files": n, "documents": docs.len()})
        }
        // dump <dir> import <resources> <file>...: name + Markdown per file
        "import" => {
            let pandoc =
                ww_core::convert::Pandoc::new(std::env::var("WW_PANDOC").unwrap_or_else(|_| "pandoc".into()), &args[3]);
            let mut out = serde_json::Map::new();
            for f in &args[4..] {
                let name = std::path::Path::new(f).file_name().unwrap().to_string_lossy().into_owned();
                let r = pandoc.import(&name, &std::fs::read(f).unwrap());
                out.insert(name, serde_json::json!(r.map(|(n, m)| vec![n, m]).map_err(|e| e.detail)));
            }
            serde_json::Value::Object(out)
        }
        // dump <dir> messages <cases.json>: build_messages for each case (prompt parity)
        "messages" => {
            let cases: Vec<serde_json::Value> =
                serde_json::from_str(&std::fs::read_to_string(&args[3]).unwrap()).unwrap();
            let out: Vec<serde_json::Value> = cases
                .iter()
                .map(|c| {
                    let history: Vec<ww_core::ai::Message> = serde_json::from_value(c["history"].clone()).unwrap();
                    let r = ww_core::ai::build_messages(
                        c["document"].as_str().unwrap(),
                        c["selection"].as_str().unwrap(),
                        &history,
                        c["prompt"].as_str().unwrap(),
                        c["quick"].as_str(),
                    );
                    match r {
                        Ok(m) => {
                            let chars = m.iter().map(|x| x.content.chars().count()).sum();
                            serde_json::json!({"ok": m, "ctx": ww_core::ai::context_size(chars)})
                        }
                        Err(e) => serde_json::json!({"err": e.detail}),
                    }
                })
                .collect();
            serde_json::json!(out)
        }
        "trash" => serde_json::to_value(ww_core::userdata::list_trash(&s).unwrap()).unwrap(),
        _ => serde_json::to_value(s.list().unwrap()).unwrap(),
    };
    println!("{}", serde_json::to_string_pretty(&v).unwrap());
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    std::fs::read_dir(dir).map(|it| it.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()).unwrap_or_default()
}
