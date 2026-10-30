//! Ported from the old backend's tests/test_api.py and tests/test_userdata.py
//! (storage parts; HTTP-only tests such as host checks and headers are gone
//! with the HTTP server).

use std::fs;
use std::path::Path;

use serde_json::{json, Value};
use tempfile::TempDir;
use ww_core::storage::{data_dir_problem, Storage};
use ww_core::userdata::{
    append_chat, backup_zip, delete_chat, list_chats, list_trash, read_chat, restore_trash, save_chat, Restored,
    SettingsStore, TrashItem,
};

fn setup() -> (TempDir, Storage) {
    let dir = TempDir::new().unwrap();
    let s = Storage::new(dir.path(), 5.0);
    (dir, s)
}

fn trash_names(root: &Path) -> Vec<String> {
    fs::read_dir(root.join(".trash")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect()
}

#[test]
fn create_list_read_save() {
    let (dir, s) = setup();
    assert_eq!(s.create(Some("Recension: Hamlet"), "").unwrap_err().status, 400);
    s.create(Some("Recension Hamlet"), "# Hamlet\n").unwrap();
    let doc = s.read("Recension Hamlet").unwrap();
    assert_eq!(doc.content, "# Hamlet\n");
    s.save("Recension Hamlet", "# Hamlet\n\nAtt vara eller inte vara.\n", Some(doc.modified), false).unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("Recension Hamlet.md")).unwrap(),
        "# Hamlet\n\nAtt vara eller inte vara.\n"
    );
    let listing = s.list().unwrap();
    assert_eq!(listing.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(), ["Recension Hamlet"]);
    assert_eq!(listing[0].words, 6);
}

#[test]
fn unique_names_and_swedish_chars() {
    let (_d, s) = setup();
    assert_eq!(s.create(None, "").unwrap().name, "Namnlös");
    assert_eq!(s.create(None, "").unwrap().name, "Namnlös 2");
    let c = s.create(Some("Åsa på ön"), "").unwrap();
    assert!(s.read(&c.id).is_ok());
}

#[test]
fn path_traversal_rejected() {
    let (_d, s) = setup();
    assert_eq!(s.create(Some("../evil"), "").unwrap_err().status, 400);
    assert_eq!(s.create(Some(".dold"), "").unwrap_err().status, 400);
    assert!(matches!(s.read("../etc").unwrap_err().status, 400 | 404));
}

#[test]
fn conflict_detection() {
    let (_d, s) = setup();
    s.create(Some("A"), "").unwrap();
    assert_eq!(s.save("A", "x", Some(1.0), false).unwrap_err().status, 409);
}

#[test]
fn rename_and_delete_to_trash() {
    let (dir, s) = setup();
    s.create(Some("Utkast"), "text").unwrap();
    s.save("Utkast", "mer text", None, true).unwrap();
    s.rename("Utkast", "Krönika").unwrap();
    assert_eq!(s.read("Utkast").unwrap_err().status, 404);
    assert_eq!(s.history("Krönika").unwrap().len(), 1);

    s.create(Some("Annan"), "").unwrap();
    assert_eq!(s.rename("Krönika", "Annan").unwrap_err().status, 409);

    s.delete("Krönika").unwrap();
    assert_eq!(s.read("Krönika").unwrap_err().status, 404);
    let trash = trash_names(dir.path());
    assert!(trash.iter().any(|n| n.ends_with("Krönika.md")));
    assert!(trash.iter().any(|n| n.ends_with("Krönika.history")));
}

#[test]
fn case_only_rename() {
    let (_d, s) = setup();
    s.create(Some("essä"), "x").unwrap();
    s.save("essä", "y", None, true).unwrap();
    let r = s.rename("essä", "Essä").unwrap();
    assert_eq!(r.name, "Essä");
    assert_eq!(s.read("Essä").unwrap().content, "y");
    assert_eq!(s.history("Essä").unwrap().len(), 1);
}

#[test]
fn deleting_twice_in_one_second_keeps_both() {
    let (dir, s) = setup();
    s.create(Some("A"), "ett").unwrap();
    s.delete("A").unwrap();
    s.create(Some("A"), "två").unwrap();
    s.delete("A").unwrap();
    let docs: Vec<_> = trash_names(dir.path()).into_iter().filter(|n| n.ends_with("-A.md")).collect();
    assert_eq!(docs.len(), 2, "{docs:?}");
}

#[test]
fn auto_snapshot_throttled() {
    let (_d, s) = setup();
    s.create(Some("D"), "").unwrap();
    for i in 0..3 {
        s.save("D", &format!("version {i}"), None, false).unwrap();
    }
    let hist = s.history("D").unwrap();
    assert_eq!(hist.len(), 1);
    assert_eq!(hist[0].kind, "auto");
}

#[test]
fn manual_and_named_snapshots_and_restore() {
    let (_d, s) = setup();
    s.create(Some("D"), "").unwrap();
    s.save("D", "ett", None, true).unwrap();
    s.save("D", "ett", None, true).unwrap(); // identical → no new version
    s.save("D", "två", None, false).unwrap();
    let v = s.snapshot("D", "named", "Till redaktör").unwrap().unwrap();
    assert_eq!(v.kind, "named");

    let hist = s.history("D").unwrap();
    assert_eq!(hist.iter().map(|v| v.label.as_str()).collect::<Vec<_>>(), ["Till redaktör", ""]);
    let first = hist.last().unwrap().id.clone();
    assert_eq!(s.read_version("D", &first).unwrap(), "ett");

    s.save("D", "tre – osparad i historik", None, false).unwrap();
    s.restore("D", &first).unwrap();
    assert_eq!(s.read("D").unwrap().content, "ett");
    let contents: Vec<String> = s.history("D").unwrap().iter().map(|v| s.read_version("D", &v.id).unwrap()).collect();
    assert!(contents.iter().any(|c| c == "tre – osparad i historik"), "saved before restore");
}

#[test]
fn named_label_on_unchanged_text() {
    let (_d, s) = setup();
    s.create(Some("D"), "").unwrap();
    s.save("D", "ett", None, true).unwrap();
    let v = s.snapshot("D", "named", "Skickad").unwrap().unwrap();
    assert_eq!((v.kind.as_str(), v.label.as_str()), ("named", "Skickad"));
    assert_eq!(s.history("D").unwrap().len(), 1);
}

#[test]
fn bad_version_id() {
    let (_d, s) = setup();
    s.create(Some("D"), "").unwrap();
    assert_eq!(s.read_version("D", "../../x").unwrap_err().status, 404);
    assert_eq!(s.read_version("D", "nope").unwrap_err().status, 404);
}

#[test]
fn frontmatter_not_counted_and_preserved() {
    let (dir, s) = setup();
    let text = "---\ntitel: Hamlet på Dramaten\nförfattare: Mikke\n---\n\nTre ord här.\n";
    s.create(Some("FM"), text).unwrap();
    assert_eq!(s.list().unwrap()[0].words, 3);
    assert_eq!(fs::read_to_string(dir.path().join("FM.md")).unwrap(), text);
}

#[cfg(unix)]
#[test]
fn unwritable_data_dir_reported() {
    use std::os::unix::fs::PermissionsExt;
    let dir = TempDir::new().unwrap();
    let data = dir.path().join("data");
    fs::create_dir(&data).unwrap();
    fs::set_permissions(&data, fs::Permissions::from_mode(0o500)).unwrap();
    let writable = fs::write(data.join("probe"), "x").is_ok(); // root ignores permissions
    if !writable {
        assert!(data_dir_problem(&data).unwrap().contains("Kan inte skriva i datamappen"));
        let s = Storage::new(&data, 5.0);
        assert_eq!(s.create(Some("x"), "").unwrap_err().status, 500);
    }
    fs::set_permissions(&data, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(data_dir_problem(&data).is_none());
}

// ---------------------------------------------------------------- userdata

#[test]
fn settings_roundtrip() {
    let (dir, s) = setup();
    let st = SettingsStore::new(dir.path());
    assert_eq!(st.read(), None);
    let v = json!({"theme": "sepia", "size": 21, "quoteStyle": "angle", "aiThink": false});
    st.write(&v).unwrap();
    assert_eq!(Value::Object(st.read().unwrap()), v);
    let file = fs::read_to_string(dir.path().join(".wordwork/settings.json")).unwrap();
    assert_eq!(
        file,
        "{\n \"theme\": \"sepia\",\n \"size\": 21,\n \"quoteStyle\": \"angle\",\n \"aiThink\": false\n}\n"
    );
    assert!(s.list().unwrap().is_empty(), "the settings file is not a document");
}

#[test]
fn settings_validation() {
    let (dir, _s) = setup();
    let st = SettingsStore::new(dir.path());
    assert_eq!(st.write(&json!([1, 2])).unwrap_err().status, 422);
    assert_eq!(st.write(&json!({"x": "a".repeat(70_000)})).unwrap_err().status, 400);
    fs::create_dir_all(dir.path().join(".wordwork")).unwrap();
    fs::write(dir.path().join(".wordwork/settings.json"), "{trasig").unwrap();
    assert_eq!(st.read(), Some(serde_json::Map::new()));
}

#[test]
fn chats_save_list_read_delete() {
    let (dir, s) = setup();
    s.create(Some("Krönika"), "").unwrap();
    let msgs = json!([
        {"role": "user", "content": "Fråga?", "label": "Granska språket", "pending": true},
        {"role": "assistant", "content": "Svar.", "thinking": "hmm", "meta": "qwen · 3 s", "extra": 1},
    ]);
    let r = save_chat(&s, "Krönika", "c1", &msgs, "qwen").unwrap();
    assert_eq!((r.title.as_str(), r.messages), ("Granska språket", 2));
    let chat = read_chat(&s, "Krönika", "c1").unwrap();
    assert_eq!(chat["messages"][0], json!({"role": "user", "content": "Fråga?", "label": "Granska språket"}));
    assert_eq!(
        chat["messages"][1],
        json!({"role": "assistant", "content": "Svar.", "thinking": "hmm", "meta": "qwen · 3 s"})
    );
    let created = chat["created"].clone();

    save_chat(&s, "Krönika", "c2", &json!([{"role": "user", "content": "Andra"}]), "").unwrap();
    save_chat(&s, "Krönika", "c1", &msgs, "").unwrap();
    let mut ids: Vec<_> = list_chats(&s, "Krönika").unwrap().into_iter().map(|c| c.id).collect();
    ids.sort();
    assert_eq!(ids, ["c1", "c2"]);
    assert_eq!(read_chat(&s, "Krönika", "c1").unwrap()["created"], created);

    delete_chat(&s, "Krönika", "c2").unwrap();
    assert_eq!(list_chats(&s, "Krönika").unwrap().iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["c1"]);
    assert!(trash_names(dir.path()).iter().any(|n| n.ends_with("Krönika.chat-c2.json")));
    assert_eq!(read_chat(&s, "Krönika", "c2").unwrap_err().status, 404);
}

#[test]
fn chat_validation() {
    let (_d, s) = setup();
    s.create(Some("Doc"), "").unwrap();
    assert!(matches!(save_chat(&s, "Doc", "../x", &json!([]), "").unwrap_err().status, 400 | 404));
    assert_eq!(save_chat(&s, "Doc", "a.b", &json!([]), "").unwrap_err().status, 400);
    assert_eq!(save_chat(&s, "Doc", "c1", &json!([{"role": "system", "content": "x"}]), "").unwrap_err().status, 400);
    assert_eq!(save_chat(&s, "Saknas", "c1", &json!([]), "").unwrap_err().status, 404);
    assert_eq!(list_chats(&s, "Saknas").unwrap_err().status, 404);
}

#[test]
fn append_chat_keeps_order_and_limit() {
    let (_d, s) = setup();
    s.create(Some("Doc"), "").unwrap();
    append_chat(&s, "Doc", "c1", &[json!({"role": "user", "content": "1"})], "m").unwrap();
    let r =
        append_chat(&s, "Doc", "c1", &[json!({"role": "assistant", "content": "2", "meta": "Avbrutet"})], "m").unwrap();
    assert_eq!(r.messages, 2);
    let many: Vec<Value> = (0..450).map(|i| json!({"role": "user", "content": i.to_string()})).collect();
    let r = append_chat(&s, "Doc", "c1", &many, "m").unwrap();
    assert_eq!(r.messages, 400);
    assert_eq!(read_chat(&s, "Doc", "c1").unwrap()["messages"][399]["content"], "449");
}

#[test]
fn chats_follow_rename_and_delete() {
    let (dir, s) = setup();
    s.create(Some("Gammal"), "").unwrap();
    save_chat(&s, "Gammal", "c1", &json!([{"role": "user", "content": "Hej"}]), "").unwrap();
    s.rename("Gammal", "Ny").unwrap();
    assert_eq!(list_chats(&s, "Ny").unwrap()[0].id, "c1");
    s.create(Some("Gammal"), "").unwrap();
    assert!(list_chats(&s, "Gammal").unwrap().is_empty());

    s.delete("Ny").unwrap();
    assert!(trash_names(dir.path()).iter().any(|n| n.ends_with("Ny.chats")));
    assert!(!dir.path().join(".chats/Ny").exists());
}

#[test]
fn trash_list_and_restore() {
    let (_d, s) = setup();
    s.create(Some("Essä"), "# Essä\n\nEtt två tre.\n").unwrap();
    s.snapshot("Essä", "named", "v1").unwrap();
    save_chat(&s, "Essä", "c1", &json!([{"role": "user", "content": "Hej"}]), "").unwrap();
    save_chat(&s, "Essä", "c2", &json!([{"role": "user", "content": "Andra"}]), "").unwrap();
    delete_chat(&s, "Essä", "c2").unwrap();
    let trash = list_trash(&s).unwrap();
    let TrashItem::Chat { id, title, .. } = &trash[0] else { panic!("{trash:?}") };
    assert_eq!((trash.len(), title.as_str()), (1, "Andra"));
    assert_eq!(restore_trash(&s, id).unwrap(), Restored { kind: "chat", name: "Essä".into(), id: Some("c2".into()) });
    assert_eq!(list_chats(&s, "Essä").unwrap().len(), 2);

    s.delete("Essä").unwrap();
    let item = list_trash(&s).unwrap().remove(0);
    let TrashItem::Document { id, name, history, chats, .. } = &item else { panic!("{item:?}") };
    assert_eq!((name.as_str(), *history, *chats), ("Essä", true, 2));
    // A new document with the same name exists – the restored one gets another name.
    s.create(Some("Essä"), "").unwrap();
    assert_eq!(
        restore_trash(&s, id).unwrap(),
        Restored { kind: "document", name: "Essä (återställd)".into(), id: None }
    );
    assert_eq!(s.read("Essä (återställd)").unwrap().content, "# Essä\n\nEtt två tre.\n");
    assert_eq!(s.history("Essä (återställd)").unwrap().len(), 1);
    assert_eq!(list_chats(&s, "Essä (återställd)").unwrap().len(), 2);
    assert!(list_trash(&s).unwrap().is_empty());
    // JSON shape the frontend expects.
    let j = serde_json::to_value(&item).unwrap();
    assert_eq!(j["kind"], "document");
    assert!(j["deleted"].as_str().unwrap().ends_with("+00:00"));
}

#[test]
fn trash_errors() {
    let (_d, s) = setup();
    assert_eq!(restore_trash(&s, "finns-inte.md").unwrap_err().status, 404);
    assert_eq!(restore_trash(&s, "../x").unwrap_err().status, 400);
    s.create(Some("A"), "").unwrap();
    save_chat(&s, "A", "c1", &json!([{"role": "user", "content": "Hej"}]), "").unwrap();
    delete_chat(&s, "A", "c1").unwrap();
    let TrashItem::Chat { id, .. } = list_trash(&s).unwrap().remove(0) else { panic!() };
    s.delete("A").unwrap();
    let e = restore_trash(&s, &id).unwrap_err();
    assert_eq!(e.status, 400);
    assert!(e.detail.contains("Återställ dokumentet först"));
}

#[test]
fn backup_contains_everything() {
    let (dir, s) = setup();
    s.create(Some("Text"), "Hej").unwrap();
    SettingsStore::new(dir.path()).write(&json!({"theme": "dark"})).unwrap();
    save_chat(&s, "Text", "c1", &json!([{"role": "user", "content": "Hej"}]), "").unwrap();
    let mut buf = std::io::Cursor::new(Vec::new());
    backup_zip(&s, &mut buf).unwrap();
    let zip = zip::ZipArchive::new(std::io::Cursor::new(buf.into_inner())).unwrap();
    let names: Vec<String> = zip.file_names().map(|n| n.unwrap().into_owned()).collect();
    for want in ["Text.md", ".wordwork/settings.json", ".chats/Text/c1.json"] {
        assert!(names.iter().any(|n| n == want), "{want} missing in {names:?}");
    }
}
