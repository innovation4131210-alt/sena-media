#!/usr/bin/env python3
import buffer_queue as app

SENSITIVE_NAMES = {"title", "affiliateURL", "URL", "name", "comment", "keyword"}

def key_tree(value, depth=0, max_depth=3):
    if depth > max_depth:
        return "<max-depth>"
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if k in SENSITIVE_NAMES:
                out[k] = "<redacted>"
            elif isinstance(v, (dict, list)):
                out[k] = key_tree(v, depth + 1, max_depth)
            else:
                out[k] = type(v).__name__
        return out
    if isinstance(value, list):
        return [key_tree(value[0], depth + 1, max_depth)] if value else []
    return type(value).__name__

def main():
    items = app.dmm_items("rank")
    if not items:
        raise SystemExit("No items returned")
    item = items[0]
    safe = {
        "top_level_keys": sorted(item.keys()),
        "prices_schema": key_tree(item.get("prices") or {}),
        "campaign_schema": key_tree(item.get("campaign") or {}),
        "review_schema": key_tree(item.get("review") or {}),
        "date_type": type(item.get("date")).__name__,
        "imageURL_schema": key_tree(item.get("imageURL") or {}),
        "sampleImageURL_schema": key_tree(item.get("sampleImageURL") or {}),
        "sampleMovieURL_schema": key_tree(item.get("sampleMovieURL") or {}),
        "iteminfo_schema": key_tree(item.get("iteminfo") or {}),
    }
    import json
    print(json.dumps(safe, ensure_ascii=False, indent=2))
    print("SCHEMA_ONLY_OK: no product values intentionally emitted")

if __name__ == "__main__":
    main()
