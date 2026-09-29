#!/usr/bin/env python3
import json
from pathlib import Path

BASE = Path("automation/ai-command-x")
POSTS = BASE / "posts.json"
BATCH_DIR = BASE / "rei_voice_batches"

posts = json.loads(POSTS.read_text(encoding="utf-8"))
by_id = {p["id"]: p for p in posts}
seen = set()
changed = []

for path in sorted(BATCH_DIR.glob("*.json")):
    batch = json.loads(path.read_text(encoding="utf-8"))
    for item in batch:
        pid = item["id"]
        if pid in seen:
            raise RuntimeError(f"Duplicate batch id: {pid}")
        seen.add(pid)
        if pid not in by_id:
            raise RuntimeError(f"Unknown post id: {pid}")
        new_text = item["text"].strip()
        if not new_text:
            raise RuntimeError(f"Empty text: {pid}")
        if by_id[pid]["text"] != new_text:
            by_id[pid]["text"] = new_text
            changed.append(pid)

POSTS.write_text(json.dumps(posts, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Applied {len(changed)} R.E.I. voice updates: {', '.join(changed) if changed else 'none'}")
print(f"Batch-covered IDs: {len(seen)}")
