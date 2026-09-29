#!/usr/bin/env python3
import csv
import json
import os
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

API = "https://api.buffer.com"
JST = timezone(timedelta(hours=9))
CHANNEL_HINT = os.getenv("BUFFER_CHANNEL_HINT", "ai_command_jp").lower().replace("@", "")
LOOKBACK_DAYS = int(os.getenv("LOOKBACK_DAYS", "30"))

BASE = Path("automation/ai-command-x")
POSTS_PATH = BASE / "posts.json"
ANALYTICS_DIR = BASE / "analytics"
POST_ANALYTICS_PATH = ANALYTICS_DIR / "posts.json"
DAILY_PATH = ANALYTICS_DIR / "daily.json"
CSV_PATH = ANALYTICS_DIR / "posts.csv"


def gql(query: str):
    key = os.environ["BUFFER_API_KEY"]
    req = urllib.request.Request(
        API,
        data=json.dumps({"query": query}).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=45) as r:
        payload = json.loads(r.read().decode("utf-8"))
    if payload.get("errors"):
        raise RuntimeError(payload["errors"])
    return payload["data"]


def qstr(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def get_organizations():
    return gql("query { account { organizations { id name } } }")["account"]["organizations"]


def get_channels(org_id: str):
    query = f"""
    query {{
      channels(input: {{ organizationId: {qstr(org_id)} }}) {{
        id
        name
        service
      }}
    }}
    """
    return gql(query)["channels"]


def select_twitter_channel():
    candidates = []
    for org in get_organizations():
        for ch in get_channels(org["id"]):
            if ch["service"] != "twitter":
                continue
            candidates.append((org, ch))
            hay = (ch.get("name") or "").lower().replace("@", "")
            if CHANNEL_HINT in hay:
                return org, ch
    if len(candidates) == 1:
        return candidates[0]
    names = [f'{o["name"]}: {c["name"]}' for o, c in candidates]
    raise RuntimeError(
        "Target X channel was not uniquely resolved. "
        + ("Candidates: " + ", ".join(names) if names else "No Twitter channel found.")
    )


def fetch_sent_posts(org_id: str, channel_id: str):
    query = f"""
    query {{
      sent: posts(
        first: 100
        input: {{
          organizationId: {qstr(org_id)}
          filter: {{ status: [sent], channelIds: [{qstr(channel_id)}] }}
          sort: {{ field: dueAt, direction: desc }}
        }}
      ) {{
        edges {{
          node {{
            id
            text
            sentAt
            dueAt
            externalLink
            metricsUpdatedAt
            metrics {{
              type
              name
              value
              unit
            }}
          }}
        }}
      }}
    }}
    """
    return [edge["node"] for edge in gql(query)["sent"]["edges"]]


def metric_map(metrics):
    out = {}
    for m in metrics or []:
        key = m.get("type") or m.get("name")
        if key:
            out[key] = m.get("value")
    return out


def safe_float(value):
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def iso_to_jst(value):
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(JST)


def note_destination(text):
    text = text or ""
    if "note.com/ai_command/n/ne79f153b4665" in text:
        return "free_entry"
    if "note.com/ai_command/n/nbb052c3cb0ad" in text:
        return "front_product"
    if "note.com/ai_command/n/n7b74f56a03dc" in text:
        return "core_product"
    if "note.com/ai_command" in text:
        return "note_home"
    return None


def main():
    prepared = json.loads(POSTS_PATH.read_text(encoding="utf-8"))
    by_text = {p["text"].strip(): p for p in prepared}

    org, channel = select_twitter_channel()
    sent = fetch_sent_posts(org["id"], channel["id"])
    cutoff = datetime.now(JST) - timedelta(days=LOOKBACK_DAYS)

    rows = []
    for post in sent:
        sent_dt = iso_to_jst(post.get("sentAt") or post.get("dueAt"))
        if sent_dt and sent_dt < cutoff:
            continue

        metrics = metric_map(post.get("metrics"))
        source = by_text.get((post.get("text") or "").strip(), {})
        impressions = safe_float(metrics.get("impressions"))
        likes = safe_float(metrics.get("likes"))
        comments = safe_float(metrics.get("comments"))
        reposts = safe_float(metrics.get("reposts"))
        quotes = safe_float(metrics.get("quotes"))
        clicks = safe_float(metrics.get("clicks"))
        saves = safe_float(metrics.get("saves"))
        interactions = likes + comments + reposts + quotes + clicks + saves
        interaction_rate = round((interactions / impressions) * 100, 4) if impressions else None
        click_rate = round((clicks / impressions) * 100, 4) if impressions else None

        rows.append({
            "contentId": source.get("id"),
            "contentType": source.get("type"),
            "experimentId": source.get("experimentId"),
            "hookVariant": source.get("hookVariant"),
            "bufferPostId": post.get("id"),
            "sentAt": sent_dt.isoformat(timespec="seconds") if sent_dt else None,
            "externalLink": post.get("externalLink"),
            "text": post.get("text"),
            "hasNoteLink": "note.com/" in (post.get("text") or ""),
            "noteDestination": note_destination(post.get("text")),
            "metricsUpdatedAt": post.get("metricsUpdatedAt"),
            "impressions": impressions,
            "likes": likes,
            "comments": comments,
            "reposts": reposts,
            "quotes": quotes,
            "clicks": clicks,
            "saves": saves,
            "bufferEngagementRate": metrics.get("engagementRate"),
            "interactionRatePct": interaction_rate,
            "clickRatePct": click_rate,
            "rawMetrics": metrics,
        })

    rows.sort(key=lambda r: r.get("sentAt") or "", reverse=True)

    daily = defaultdict(lambda: {
        "posts": 0,
        "impressions": 0.0,
        "likes": 0.0,
        "comments": 0.0,
        "reposts": 0.0,
        "quotes": 0.0,
        "clicks": 0.0,
        "saves": 0.0,
        "noteLinkPosts": 0,
    })

    for r in rows:
        day = (r.get("sentAt") or "")[:10] or "unknown"
        d = daily[day]
        d["posts"] += 1
        for k in ("impressions","likes","comments","reposts","quotes","clicks","saves"):
            d[k] += safe_float(r.get(k))
        if r.get("hasNoteLink"):
            d["noteLinkPosts"] += 1

    daily_rows = []
    for day in sorted(daily.keys(), reverse=True):
        d = daily[day]
        impressions = d["impressions"]
        interactions = d["likes"] + d["comments"] + d["reposts"] + d["quotes"] + d["clicks"] + d["saves"]
        daily_rows.append({
            "date": day,
            **d,
            "interactionRatePct": round((interactions / impressions) * 100, 4) if impressions else None,
            "clickRatePct": round((d["clicks"] / impressions) * 100, 4) if impressions else None,
        })

    ANALYTICS_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "channel": {
            "organizationId": org["id"],
            "organizationName": org["name"],
            "channelId": channel["id"],
            "channelName": channel["name"],
        },
        "lookbackDays": LOOKBACK_DAYS,
        "postCount": len(rows),
        "posts": rows,
    }
    POST_ANALYTICS_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    DAILY_PATH.write_text(json.dumps(daily_rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    fields = [
        "contentId","contentType","experimentId","hookVariant","bufferPostId","sentAt","externalLink","hasNoteLink","noteDestination",
        "impressions","likes","comments","reposts","quotes","clicks","saves",
        "bufferEngagementRate","interactionRatePct","clickRatePct","metricsUpdatedAt","text"
    ]
    with CSV_PATH.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for r in rows:
            writer.writerow({k: r.get(k) for k in fields})

    print(f"Target channel: {channel['name']} ({channel['id']})")
    print(f"Collected sent posts: {len(rows)}")
    if rows:
        top = max(rows, key=lambda x: safe_float(x.get("impressions")))
        print(f"Top impressions: {top.get('contentId') or top.get('bufferPostId')} = {top.get('impressions')}")
        note_clicks = sum(safe_float(r.get("clicks")) for r in rows if r.get("hasNoteLink"))
        print(f"Note-link clicks in window: {note_clicks}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
