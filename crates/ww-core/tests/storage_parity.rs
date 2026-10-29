//! Byte-for-byte parity with the old Python storage: runs
//! fixtures/storage_scenario.json and compares every file written (and every
//! API result) with fixtures/storage_parity.json, which
//! `tools/storage_parity.py` produced by running the same scenario through the
//! Python code. Timestamps and version ids are normalised the same way.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use ww_core::storage::Storage;
use ww_core::userdata::{
    append_chat, delete_chat, list_chats, list_trash, restore_trash, save_chat, SettingsStore, TrashItem,
};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

struct Normaliser {
    ids: HashMap<String, String>,
    vid: regex::Regex,
    stamp: regex::Regex,
    iso: regex::Regex,
}

impl Normaliser {
    fn new() -> Self {
        Self {
            ids: HashMap::new(),
            vid: regex::Regex::new(r"\d{8}T\d{12}").unwrap(),
            stamp: regex::Regex::new(r"\d{8}T\d{6}").unwrap(),
            iso: regex::Regex::new(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?\+00:00").unwrap(),
        }
    }

    fn run(&mut self, text: &str) -> String {
        let mut out = String::new();
        let mut last = 0;
        for m in self.vid.find_iter(text) {
            out.push_str(&text[last..m.start()]);
            let n = self.ids.len();
            out.push_str(self.ids.entry(m.as_str().to_string()).or_insert_with(|| format!("<V{n}>")));
            last = m.end();
        }
        out.push_str(&text[last..]);
        let out = self.stamp.replace_all(&out, "<STAMP>");
        self.iso.replace_all(&out, "<ISO>").into_owned()
    }
}

fn without_modified(v: impl serde::Serialize) -> Value {
    let mut v = serde_json::to_value(v).unwrap();
    v.as_object_mut().unwrap().remove("modified");
    v
}

fn collect(dir: &Path, root: &Path, out: &mut Vec<(Vec<String>, PathBuf)>) {
    for e in fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            collect(&p, root, out);
        } else {
            let parts = p.strip_prefix(root).unwrap().iter().map(|c| c.to_string_lossy().into_owned()).collect();
            out.push((parts, p));
        }
    }
}

#[test]
fn same_files_and_results_as_python() {
    let tmp = tempfile::TempDir::new().unwrap();
    let s = Storage::new(tmp.path(), 5.0);
    let scenario: Vec<Vec<Value>> =
        serde_json::from_str(&fs::read_to_string(fixture("storage_scenario.json")).unwrap()).unwrap();
    let str_ = |v: &Value| v.as_str().unwrap().to_string();
    let mut calls = Vec::new();
    for step in &scenario {
        let op = step[0].as_str().unwrap();
        let a = &step[1..];
        let r: Value = match op {
            "create" => without_modified(s.create(a[0].as_str(), a[1].as_str().unwrap()).unwrap()),
            "save" => {
                s.save(&str_(&a[0]), a[1].as_str().unwrap(), None, a[2].as_bool().unwrap()).unwrap();
                Value::Null
            }
            "snapshot" => json!(s.snapshot(&str_(&a[0]), &str_(&a[1]), &str_(&a[2])).unwrap()),
            "restore" => {
                let mut h = s.history(&str_(&a[0])).unwrap();
                h.reverse();
                s.restore(&str_(&a[0]), &h[a[1].as_u64().unwrap() as usize].id).unwrap();
                Value::Null
            }
            "chat" => json!(save_chat(&s, &str_(&a[0]), &str_(&a[1]), &a[2], &str_(&a[3])).unwrap()),
            "append" => {
                json!(append_chat(&s, &str_(&a[0]), &str_(&a[1]), a[2].as_array().unwrap(), &str_(&a[3])).unwrap())
            }
            "chat_delete" => {
                delete_chat(&s, &str_(&a[0]), &str_(&a[1])).unwrap();
                Value::Null
            }
            "rename" => without_modified(s.rename(&str_(&a[0]), &str_(&a[1])).unwrap()),
            "settings" => {
                SettingsStore::new(tmp.path()).write(&a[0]).unwrap();
                Value::Null
            }
            "delete" => {
                s.delete(&str_(&a[0])).unwrap();
                Value::Null
            }
            "restore_trash" => {
                let entry = list_trash(&s)
                    .unwrap()
                    .into_iter()
                    .find_map(|i| match i {
                        TrashItem::Document { id, name, .. } if name == str_(&a[0]) => Some(id),
                        _ => None,
                    })
                    .unwrap();
                json!(restore_trash(&s, &entry).unwrap())
            }
            other => panic!("unknown op {other}"),
        };
        calls.push(json!([op, r]));
    }

    let mut listing: Vec<Value> = s.list().unwrap().into_iter().map(without_modified).collect();
    listing.sort_by_key(|d| d["name"].as_str().unwrap().to_string());
    let names: Vec<String> = listing.iter().map(|d| d["name"].as_str().unwrap().to_string()).collect();
    let mut trash: Vec<Value> = list_trash(&s).unwrap().into_iter().map(|t| json!(t)).collect();
    trash.sort_by_key(|t| (t["kind"].as_str().unwrap().to_string(), t["name"].as_str().unwrap().to_string()));
    let state = json!({
        "calls": calls,
        "list": listing,
        "history": names.iter().map(|n| (n.clone(), json!(s.history(n).unwrap()))).collect::<serde_json::Map<_, _>>(),
        "chats": names.iter().map(|n| (n.clone(), json!(list_chats(&s, n).unwrap()))).collect::<serde_json::Map<_, _>>(),
        "trash": trash,
    });

    // Files in the same order as Python's sorted(rglob) → same <Vn> numbering.
    let mut files = Vec::new();
    collect(tmp.path(), tmp.path(), &mut files);
    files.sort();
    let mut norm = Normaliser::new();
    let mut got_files = serde_json::Map::new();
    for (parts, path) in files {
        let k = norm.run(&parts.join("/"));
        let v = norm.run(&fs::read_to_string(path).unwrap());
        got_files.insert(k, Value::String(v));
    }
    let got_state: Value = serde_json::from_str(&norm.run(&state.to_string())).unwrap();

    let want: Value = serde_json::from_str(&fs::read_to_string(fixture("storage_parity.json")).unwrap()).unwrap();
    let want_files = want["files"].as_object().unwrap();
    let mut keys: Vec<_> = want_files.keys().chain(got_files.keys()).collect();
    keys.sort();
    keys.dedup();
    for k in keys {
        assert_eq!(got_files.get(k), want_files.get(k), "file {k} differs from Python");
    }
    for key in ["calls", "list", "history", "chats", "trash"] {
        assert_eq!(got_state[key], want["state"][key], "{key} differs from Python");
    }
}
