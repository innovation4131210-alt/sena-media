#!/usr/bin/env python3
import json
from pathlib import Path
import buffer_queue as app

def main():
    state = json.loads(Path("automation/dmm-x/state.json").read_text(encoding="utf-8"))
    failures = []

    try:
        channel_id = app.find_x_channel()
        if not channel_id:
            raise RuntimeError("exact X channel not found")
        print("BUFFER_OK: exact X channel found and active")
    except Exception as exc:
        failures.append("BUFFER")
        print(f"BUFFER_FAIL: {exc}")

    try:
        used_ids = set(str(v) for v in state.get("used_content_ids", []))
        content_id, title, affiliate_url, actual_sort, facts = app.choose_product(used_ids, "rank")
        if not content_id or not title or not affiliate_url:
            raise RuntimeError("eligible product candidate not found")

        discovery_index = int(state.get("discovery_template_index", 0)) % len(app.DISCOVERY_TEMPLATES)
        decision_index = int(state.get("decision_template_index", 0)) % len(app.DECISION_TEMPLATES)

        discovery = app.build_discovery_text(discovery_index, title, actual_sort, facts)
        reply = "【PR】作品詳細はこちら。価格・配信条件はリンク先でご確認ください。18歳未満閲覧禁止。\n" + affiliate_url
        decision = app.build_decision_text(decision_index, title, "review", affiliate_url, facts)

        for label, text in (
            ("discovery", discovery),
            ("reply", reply),
            ("decision", decision),
        ):
            if len(text) > 280:
                raise RuntimeError(f"{label} exceeds 280 characters")

        print("DMM_OK: API responded and eligible product candidate exists")
        print("COPY_OK: discovery, reply and decision formats fit X length limits")
    except Exception as exc:
        failures.append("DMM_OR_COPY")
        print(f"DMM_OR_COPY_FAIL: {exc}")

    print("NO_POST_CREATED: verification is read-only")
    if failures:
        raise SystemExit("VERIFY_FAIL: " + ",".join(failures))
    print("VERIFY_OK")

if __name__ == "__main__":
    main()
