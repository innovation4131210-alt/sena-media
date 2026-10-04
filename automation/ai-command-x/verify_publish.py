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
GRACE_MINUTES = int(os.getenv("PUBLISH_GRACE_MINUTES", "25"))

BASE = Path("automation/ai-command-x")
POSTS_PATH = BASE / "posts.json"
OUT_PATH = BASE / "health" / "publish_verification.json"
SLOTS = [(8, 10), (12, 20), (20, 30)]


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


def select_channel():
    orgs = gql("query { account { organizations { id name } } }")["account"]["organizations"]
    candidates = []
    for org in orgs:
        query = f"""
        query {{
          channels(input: {{ organizationId: {qstr(org["id"])} }}) {{
            id name service isDisconnected isLocked isQueuePaused
          }}
        }}
        """
        for ch in gql(query)["channels"]:
            if ch.get("service") != "twitter":
                continue
            candidates.append((org, ch))
            name = (ch.get("name") or "").lower().replace("@", "")
            if CHANNEL_HINT in name:
                return org, ch
    if len(candidates) == 1:
        return candidates[0]
    raise RuntimeError("Target ai_command_jp channel could not be uniquely resolved")


def fetch_posts(org_id: str, channel_id: str):
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
        edges {{ node {{ id text status dueAt sentAt externalLink }} }}
      }}
      scheduled: posts(
        first: 100
        input: {{
          organizationId: {qstr(org_id)}
          filter: {{ status: [scheduled], channelIds: [{qstr(channel_id)}] }}
          sort: {{ field: dueAt, direction: asc }}
        }}
      ) {{
        edges {{ node {{ id text status dueAt sentAt externalLink }} }}
      }}
    }}
    """
    data = gql(query)
    return (
        [e["node"] for e in data["sent"]["edges"]],
        [e["node"] for e in data["scheduled"]["edges"]],
    )


def utc_key(dt: datetime):
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def target_slot(now: datetime):
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")

    # A delayed evening workflow can start after midnight. Anchor the search to
    # the grace-adjusted JST date, including its previous day, not today's date.
    cutoff = now.astimezone(JST) - timedelta(minutes=GRACE_MINUTES)
    eligible = []
    for day in (cutoff.date(), cutoff.date() - timedelta(days=1)):
        for hour, minute in SLOTS:
            dt = datetime(day.year, day.month, day.day, hour, minute, tzinfo=JST)
            if dt <= cutoff:
                eligible.append(dt)
    return max(eligible, default=None)


def load_history():
    if not OUT_PATH.exists():
        return {"latest": None, "history": []}
    return json.loads(OUT_PATH.read_text(encoding="utf-8"))


def save_history(payload):
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    now = datetime.now(JST)
    slot = target_slot(now)
    if slot is None:
        print("No publish slot is old enough to verify yet; skipping.")
        return

    org, channel = select_channel()
    sent, scheduled = fetch_posts(org["id"], channel["id"])
    due = utc_key(slot)

    sent_match = [p for p in sent if p.get("dueAt") == due]
    scheduled_match = [p for p in scheduled if p.get("dueAt") == due]

    prepared = json.loads(POSTS_PATH.read_text(encoding="utf-8"))
    by_text = {p.get("text", "").strip(): p for p in prepared}
    errors = []
    warnings = []
    post = None

    if len(sent_match) == 1:
        post = sent_match[0]
    elif len(sent_match) > 1:
        errors.append(f"Multiple sent posts found for slot {slot.isoformat(timespec='minutes')}")
    elif scheduled_match:
        errors.append(f"Post is still scheduled after grace period: {slot.isoformat(timespec='minutes')}")
        post = scheduled_match[0]
    else:
        errors.append(f"No sent or scheduled post found for slot {slot.isoformat(timespec='minutes')}")

    content = by_text.get((post or {}).get("text", "").strip(), {}) if post else {}
    if post and post.get("status") == "sent":
        if not post.get("sentAt"):
            warnings.append("Sent post has no sentAt")
        if not post.get("externalLink"):
            warnings.append("Sent post has no externalLink")

    record = {
        "checkedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "slot": slot.isoformat(timespec="minutes"),
        "ok": not errors,
        "contentId": content.get("id"),
        "contentType": content.get("type"),
        "bufferPostId": (post or {}).get("id"),
        "bufferStatus": (post or {}).get("status"),
        "sentAt": (post or {}).get("sentAt"),
        "externalLink": (post or {}).get("externalLink"),
        "warnings": warnings,
        "errors": errors,
    }

    payload = load_history()
    history = [x for x in payload.get("history", []) if x.get("slot") != record["slot"]]
    history.append(record)
    history.sort(key=lambda x: x.get("slot") or "")
    payload = {"latest": record, "history": history[-120:]}
    save_history(payload)

    print(json.dumps(record, ensure_ascii=False, indent=2))
    if errors:
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
