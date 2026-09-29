#!/usr/bin/env python3
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

API = "https://api.buffer.com"
JST = timezone(timedelta(hours=9))
CHANNEL_HINT = os.getenv("BUFFER_CHANNEL_HINT", "ai_command_jp").lower().replace("@", "")
MIN_QUEUE = int(os.getenv("MIN_QUEUE", "9"))
MIN_UNUSED = int(os.getenv("MIN_UNUSED", "9"))

BASE = Path("automation/ai-command-x")
POSTS_PATH = BASE / "posts.json"
STATE_PATH = BASE / "state.json"
ANALYTICS_PATH = BASE / "analytics" / "posts.json"
HEALTH_DIR = BASE / "health"
STATUS_PATH = HEALTH_DIR / "status.json"

NOTE_URLS = {
    "home": "https://note.com/ai_command",
    "free_entry": "https://note.com/ai_command/n/ne79f153b4665",
    "front_product": "https://note.com/ai_command/n/nbb052c3cb0ad",
    "paid_product": "https://note.com/ai_command/n/n7b74f56a03dc",
}


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


def find_channel():
    orgs = gql("query { account { organizations { id name } } }")["account"]["organizations"]
    candidates = []
    for org in orgs:
        query = f"""
        query {{
          channels(input: {{ organizationId: {qstr(org["id"])} }}) {{
            id
            name
            service
            isDisconnected
            isLocked
            isQueuePaused
          }}
        }}
        """
        for ch in gql(query)["channels"]:
            if ch["service"] != "twitter":
                continue
            candidates.append((org, ch))
            name = (ch.get("name") or "").lower().replace("@", "")
            if CHANNEL_HINT in name:
                return org, ch
    if len(candidates) == 1:
        return candidates[0]
    raise RuntimeError("Target ai_command_jp channel could not be uniquely resolved")


def scheduled_posts(org_id: str, channel_id: str):
    query = f"""
    query {{
      posts(
        first: 100
        input: {{
          organizationId: {qstr(org_id)}
          filter: {{ status: [scheduled], channelIds: [{qstr(channel_id)}] }}
          sort: {{ field: dueAt, direction: asc }}
        }}
      ) {{
        edges {{ node {{ id dueAt text }} }}
      }}
    }}
    """
    return [e["node"] for e in gql(query)["posts"]["edges"]]


def parse_dt(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def check_public_url(url):
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 AI-Command-Healthcheck/1.0"},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read(300000).decode("utf-8", errors="replace")
        return r.status, body


def main():
    errors = []
    now_utc = datetime.now(timezone.utc)
    org, channel = find_channel()

    if channel.get("isDisconnected"):
        errors.append("Buffer channel is disconnected")
    if channel.get("isLocked"):
        errors.append("Buffer channel is locked")
    if channel.get("isQueuePaused"):
        errors.append("Buffer queue is paused")

    scheduled = scheduled_posts(org["id"], channel["id"])
    if len(scheduled) < MIN_QUEUE:
        errors.append(f"Scheduled queue below target: {len(scheduled)} < {MIN_QUEUE}")

    posts = json.loads(POSTS_PATH.read_text(encoding="utf-8"))
    state = json.loads(STATE_PATH.read_text(encoding="utf-8")) if STATE_PATH.exists() else {}
    used = set(state.get("usedPostIds", []))
    unused = [p for p in posts if p.get("id") not in used]
    if len(unused) < MIN_UNUSED:
        errors.append(f"Prepared backlog too low: {len(unused)} unused < {MIN_UNUSED}")

    by_text = {p.get("text", "").strip(): p for p in posts}
    index_by_id = {p.get("id"): i for i, p in enumerate(posts)}
    queue_items = []
    unknown_scheduled = []
    seen_ids = set()
    duplicate_ids = []
    allowed_slots = {(8, 10), (12, 20), (20, 30)}
    mapped_indexes = []

    for item in scheduled:
        due_jst = parse_dt(item["dueAt"]).astimezone(JST)
        source = by_text.get((item.get("text") or "").strip())
        content_id = source.get("id") if source else None

        queue_items.append({
            "bufferPostId": item.get("id"),
            "contentId": content_id,
            "contentType": source.get("type") if source else None,
            "dueAtJst": due_jst.isoformat(timespec="minutes"),
        })

        if not source:
            unknown_scheduled.append(item.get("id"))
            continue

        if content_id in seen_ids:
            duplicate_ids.append(content_id)
        seen_ids.add(content_id)

        if (due_jst.hour, due_jst.minute) not in allowed_slots:
            errors.append(
                f"Unexpected Buffer slot time for {content_id}: "
                f"{due_jst.isoformat(timespec='minutes')}"
            )

        mapped_indexes.append(index_by_id[content_id])

    if unknown_scheduled:
        errors.append(
            "Scheduled Buffer post(s) do not match the current Source of Truth: "
            + ", ".join(unknown_scheduled)
        )
    if duplicate_ids:
        errors.append(
            "Duplicate content IDs in scheduled Buffer queue: "
            + ", ".join(sorted(set(duplicate_ids)))
        )
    if mapped_indexes and mapped_indexes != sorted(mapped_indexes):
        errors.append("Scheduled Buffer queue is not in Source of Truth order")

    analytics_age_minutes = None
    if ANALYTICS_PATH.exists():
        analytics = json.loads(ANALYTICS_PATH.read_text(encoding="utf-8"))
        generated = analytics.get("generatedAt")
        if generated:
            generated_dt = parse_dt(generated)
            analytics_age_minutes = round((now_utc - generated_dt).total_seconds() / 60, 1)
            if analytics_age_minutes > 600:
                errors.append(f"Analytics snapshot stale: {analytics_age_minutes} minutes")
        else:
            errors.append("Analytics snapshot missing generatedAt")
    else:
        errors.append("Analytics snapshot file missing")

    note_status = {}
    for label, url in NOTE_URLS.items():
        try:
            code, body = check_public_url(url)
            ok = code == 200
            if label == "free_entry":
                ok = ok and ("ChatGPTが質問ばかり" in body or "ne79f153b4665" in body)
            elif label == "front_product":
                ok = ok and ("AI司令書" in body or "nbb052c3cb0ad" in body)
            elif label == "paid_product":
                ok = ok and ("完成まで任せる" in body or "n7b74f56a03dc" in body)
            elif label == "home":
                ok = ok and ("ai_command" in body)
            note_status[label] = {"url": url, "httpStatus": code, "ok": ok}
            if not ok:
                errors.append(f"note public page check failed: {label} HTTP {code}")
        except Exception as exc:
            note_status[label] = {"url": url, "ok": False, "error": str(exc)}
            errors.append(f"note public page unavailable: {label}")

    status = {
        "checkedAt": now_utc.isoformat(timespec="seconds"),
        "ok": not errors,
        "channel": {
            "id": channel["id"],
            "name": channel["name"],
            "isDisconnected": channel.get("isDisconnected"),
            "isLocked": channel.get("isLocked"),
            "isQueuePaused": channel.get("isQueuePaused"),
        },
        "scheduledCount": len(scheduled),
        "queueIntegrity": {
            "allMappedToSourceOfTruth": not unknown_scheduled,
            "noDuplicateContentIds": not duplicate_ids,
            "inSourceOrder": (not mapped_indexes) or mapped_indexes == sorted(mapped_indexes),
            "items": queue_items,
        },
        "unusedPreparedCount": len(unused),
        "analyticsAgeMinutes": analytics_age_minutes,
        "notePublicPages": note_status,
        "errors": errors,
    }

    HEALTH_DIR.mkdir(parents=True, exist_ok=True)
    STATUS_PATH.write_text(json.dumps(status, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(status, ensure_ascii=False, indent=2))

    if errors:
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        HEALTH_DIR.mkdir(parents=True, exist_ok=True)
        STATUS_PATH.write_text(
            json.dumps({
                "checkedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "ok": False,
                "errors": [f"healthcheck exception: {exc}"],
            }, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
