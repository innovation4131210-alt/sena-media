#!/usr/bin/env python3
import json
from pathlib import Path
import buffer_queue as app

def main():
    state = json.loads(Path("automation/dmm-x/state.json").read_text(encoding="utf-8"))

    # 1) Verify Buffer credential + exact X channel without creating a post.
    channel_id = app.find_x_channel()
    if not channel_id:
        raise RuntimeError("Buffer X channel verification failed")

    # 2) Verify DMM credential/API and that the current filters still yield products.
    used_ids = set(str(v) for v in state.get("used_content_ids", []))
    content_id, title, affiliate_url, actual_sort, facts = app.choose_product(used_ids, "rank")
    if not content_id or not title or not affiliate_url:
        raise RuntimeError("DMM candidate verification failed")

    # 3) Verify generated copy stays within X standard length.
    idx = int(state.get("affiliate_template_index", 0)) % len(app.AFFILIATE_TEMPLATES)
    text = app.build_affiliate_text(idx, title, actual_sort, affiliate_url, facts)
    if len(text) > 280:
        raise RuntimeError("Generated affiliate text exceeds 280 characters")

    lead = text.removesuffix("\n" + affiliate_url) if text.endswith("\n" + affiliate_url) else text.replace(affiliate_url, "").rstrip()
    reply = "【PR】作品詳細はこちら。価格・配信条件はリンク先でご確認ください。18歳未満閲覧禁止。\n" + affiliate_url
    if len(lead) > 280 or len(reply) > 280:
        raise RuntimeError("Thread lead/reply exceeds 280 characters")

    # Never print secrets, URLs, product titles, or channel IDs.
    print("BUFFER_OK: exact X channel found and active")
    print("DMM_OK: API responded and eligible product candidate exists")
    print("COPY_OK: direct and first-reply variants fit X length limits")
    print("VERIFY_OK: no post was created")

if __name__ == "__main__":
    main()
