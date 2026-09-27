#!/usr/bin/env python3
import json
from pathlib import Path
import buffer_queue as app

STATE = Path(__file__).resolve().parent / "state.json"
OUT = Path(__file__).resolve().parents[2] / "analytics" / "dmm-selection-preview.json"

def main():
    state = json.loads(STATE.read_text(encoding="utf-8"))
    used = set(str(x) for x in state.get("used_content_ids", []))
    picks = []

    for preferred in ("rank", "review"):
        content_id, title, affiliate_url, actual_sort, facts, meta = app.choose_product(used, preferred)
        used.add(content_id)
        picks.append({
            "preferredSort": preferred,
            "actualSort": actual_sort,
            "contentId": content_id,
            "actressName": meta.get("actress_name"),
            "actressPopularityScore": meta.get("actress_popularity_score"),
            "knownActressPoolUsed": meta.get("known_actress_pool_used"),
            "price": meta.get("price"),
            "discountPct": meta.get("discount_pct"),
            "reviewAverage": meta.get("review_average"),
            "reviewCount": meta.get("review_count"),
            "campaignActive": meta.get("campaign_active"),
            "recentRelease": meta.get("recent_release"),
            "facts": facts,
        })

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "version": 1,
        "strategy": "real-selection-v5-actress-first",
        "picks": picks,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"picks": picks}, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
