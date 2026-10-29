"""Runs tests/fixtures/storage_scenario.json against the OLD Python storage and
writes the normalised result to tests/fixtures/storage_parity.json. The Rust
test `storage_parity` runs the same scenario and must produce the same files.

    python3 tools/storage_parity.py ../word-work/backend
"""
import json, re, sys, tempfile
from dataclasses import asdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "crates/ww-core/tests/fixtures"
sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else str(ROOT.parent / "word-work/backend"))
from app.storage import (Storage, SettingsStore, save_chat, append_chat, delete_chat,  # noqa: E402
                         list_chats, list_trash, restore_trash)

def normalise(text: str, ids: dict) -> str:
    def vid(m):
        return ids.setdefault(m.group(0), f"<V{len(ids)}>")
    text = re.sub(r"\d{8}T\d{12}", vid, text)
    text = re.sub(r"\d{8}T\d{6}", "<STAMP>", text)
    text = re.sub(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?\+00:00", "<ISO>", text)
    return text

def run(tmp: Path) -> dict:
    s = Storage(tmp, 5)
    calls = []
    for op, *a in json.loads((FIX / "storage_scenario.json").read_text(encoding="utf-8")):
        if op == "create": r = asdict(s.create(a[0], a[1])); r.pop("modified")
        elif op == "save": s.save(a[0], a[1], None, a[2]); r = None
        elif op == "snapshot": v = s.snapshot(a[0], a[1], a[2]); r = v and asdict(v)
        elif op == "restore": s.restore(a[0], list(reversed(s.history(a[0])))[a[1]].id); r = None
        elif op == "chat": r = save_chat(s, a[0], a[1], a[2], a[3])
        elif op == "append": r = append_chat(s, a[0], a[1], a[2], a[3])
        elif op == "chat_delete": delete_chat(s, a[0], a[1]); r = None
        elif op == "rename": r = asdict(s.rename(a[0], a[1])); r.pop("modified")
        elif op == "settings": SettingsStore(tmp).write(a[0]); r = None
        elif op == "delete": s.delete(a[0]); r = None
        elif op == "restore_trash":
            entry = next(i["id"] for i in list_trash(s) if i["kind"] == "document" and i["name"] == a[0])
            r = restore_trash(s, entry)
        calls.append([op, r])
    listing = [{k: v for k, v in asdict(d).items() if k != "modified"} for d in s.list()]
    state = {
        "calls": calls,
        "list": sorted(listing, key=lambda d: d["name"]),
        "history": {d["name"]: [asdict(v) for v in s.history(d["name"])] for d in listing},
        "chats": {d["name"]: list_chats(s, d["name"]) for d in listing},
        "trash": sorted(list_trash(s), key=lambda i: (i["kind"], i["name"])),
    }
    files = {}
    for p in sorted(tmp.rglob("*")):
        if p.is_file():
            files[p.relative_to(tmp).as_posix()] = p.read_text(encoding="utf-8")
    ids: dict = {}
    files = {normalise(k, ids): normalise(v, ids) for k, v in files.items()}
    return {"files": files, "state": json.loads(normalise(json.dumps(state, ensure_ascii=False, sort_keys=True), ids))}

if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as d:
        out = run(Path(d))
    (FIX / "storage_parity.json").write_text(json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"{len(out['files'])} files")
