#!/usr/bin/env python3
import json
from collections import defaultdict
from pathlib import Path
import buffer_queue as app

OUT = Path(__file__).resolve().parents[2] / "analytics" / "dmm-actress-popularity.json"
SORTS = ("rank", "review", "date")

def actress_entries(item):
    raw = (item.get("iteminfo") or {}).get("actress") or []
    if isinstance(raw, dict):
        raw = [raw]
    out = []
    for a in raw:
        if not isinstance(a, dict):
            continue
        name = str(a.get("name") or "").strip()
        aid = a.get("id")
        if name:
            out.append({"id": aid, "name": name})
    return out

def target_match(item):
    title = str(item.get("title") or "")
    searchable = json.dumps(item.get("iteminfo") or {}, ensure_ascii=False) + title
    if any(word in searchable for word in app.BLOCKED_WORDS):
        return False
    return any(word in searchable for word in app.TARGET_WORDS)

def main():
    stats = defaultdict(lambda: {
        "id": None,
        "name": None,
        "rankScore": 0.0,
        "rankAppearances": 0,
        "reviewScore": 0.0,
        "reviewAppearances": 0,
        "dateScore": 0.0,
        "dateAppearances": 0,
        "targetAppearances": 0,
        "top20Appearances": 0,
        "bestRankPosition": None,
        "contentIds": [],
    })
    samples = {}
    weights = {"rank": 3.0, "review": 1.5, "date": 0.5}

    for sort in SORTS:
        items = app.dmm_items(sort)
        samples[sort] = len(items)
        for position, item in enumerate(items, start=1):
            actresses = actress_entries(item)
            matched = target_match(item)
            for a in actresses:
                key = str(a["id"] or a["name"])
                s = stats[key]
                s["id"] = a["id"]
                s["name"] = a["name"]
                base = max(1, 101 - position)
                s[f"{sort}Score"] += round(base * weights[sort], 3)
                s[f"{sort}Appearances"] += 1
                if matched:
                    s["targetAppearances"] += 1
                if position <= 20:
                    s["top20Appearances"] += 1
                if sort == "rank":
                    if s["bestRankPosition"] is None or position < s["bestRankPosition"]:
                        s["bestRankPosition"] = position
                cid = str(item.get("content_id") or item.get("product_id") or "").strip()
                if cid and cid not in s["contentIds"]:
                    s["contentIds"].append(cid)

    rows = []
    for s in stats.values():
        total = s["rankScore"] + s["reviewScore"] + s["dateScore"]
        # Bias toward current popularity while retaining review/new-release support.
        # TargetAppearances is not required: a famous actress can be selected when
        # the specific work itself matches the 人妻/熟女 audience filter.
        s["popularityScore"] = round(total, 3)
        s["contentIds"] = s["contentIds"][:10]
        rows.append(s)

    rows.sort(key=lambda x: (
        -x["popularityScore"],
        -(x["top20Appearances"] or 0),
        x["bestRankPosition"] if x["bestRankPosition"] is not None else 999,
        x["name"],
    ))

    target_rows = [r for r in rows if r["targetAppearances"] > 0]
    report = {
        "version": 1,
        "source": "DMM/FANZA Affiliate API ItemList",
        "sorts": list(SORTS),
        "samples": samples,
        "method": {
            "rankWeight": 3.0,
            "reviewWeight": 1.5,
            "dateWeight": 0.5,
            "positionBase": "101-position",
            "note": "Popularity proxy from current work rankings; not an official performer ranking."
        },
        "topOverall": rows[:30],
        "topTargetRelevant": target_rows[:30],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "samples": samples,
        "topTargetRelevant": [
            {
                "name": r["name"],
                "score": r["popularityScore"],
                "rankAppearances": r["rankAppearances"],
                "top20Appearances": r["top20Appearances"],
                "bestRankPosition": r["bestRankPosition"],
                "targetAppearances": r["targetAppearances"],
            }
            for r in target_rows[:15]
        ]
    }, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
