#!/usr/bin/env python3
import json
from pathlib import Path
import buffer_queue as app

def main():
    state = json.loads(Path("automation/dmm-x/state.json").read_text(encoding="utf-8"))
    failures = []

    # Buffer check: authenticate and find exact X channel. Never creates a post.
    try:
        channel_id = app.find_x_channel()
        if not channel_id:
            raise RuntimeError("exact X channel not found")
        print("BUFFER_OK: exact X channel found and active")
    except Exception as exc:
        failures.append("BUFFER")
        print(f"BUFFER_FAIL: {exc}")

    # DMM check: authenticate, fetch candidates, and validate copy generation.
    try:
        used_ids = set(str(v) for v in state.get("used_content_ids", []))
        content_id, title, affiliate_url, actual_sort, facts = app.choose_product(used_ids, "rank")
        if not content_id or not title or not affiliate_url:
            raise RuntimeError("eligible product candidate not found")

        idx = int(state.get("affiliate_template_index", 0)) % len(app.AFFILIATE_TEMPLATES)
        text = app.build_affiliate_text(idx, title, actual_sort, affiliate_url, facts)
        if len(text) > 280:
            raise RuntimeError("generated affiliate text exceeds 280 characters")

        lead = text.removesuffix("\n" + affiliate_url) if text.endswith("\n" + affiliate_url) else text.replace(affiliate_url, "").rstrip()
        reply = "【PR】作品詳細はこちら。価格・配信条件はリンク先でご確認ください。18歳未満閲覧禁止。\n" + affiliate_url
        if len(lead) > 280 or len(reply) > 280:
            raise RuntimeError("thread lead/reply exceeds 280 characters")

        print("DMM_OK: API responded and eligible product candidate exists")
        print("COPY_OK: direct and first-reply variants fit X length limits")
    except Exception as exc:
        failures.append("DMM")
        print(f"DMM_FAIL: {exc}")

    print("NO_POST_CREATED: verification is read-only")
    if failures:
        raise SystemExit("VERIFY_FAIL: " + ",".join(failures))
    print("VERIFY_OK")

if __name__ == "__main__":
    main()
