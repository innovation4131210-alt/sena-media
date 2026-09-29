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
TARGET_QUEUE_SIZE = int(os.getenv("TARGET_QUEUE_SIZE", "9"))
SLOTS = [(8, 10), (12, 20), (20, 30)]

BASE = Path("automation/ai-command-x")
POSTS_PATH = BASE / "posts.json"
STATE_PATH = BASE / "state.json"


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
    return gql("query GetOrganizations { account { organizations { id name } } }")["account"]["organizations"]


def get_channels(org_id: str):
    query = f"""
    query GetChannels {{
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

    names = [f'{o["name"]}: {c["name"]} ({c["id"]})' for o, c in candidates]
    raise RuntimeError(
        "Target X channel was not uniquely resolved. "
        + ("Candidates: " + ", ".join(names) if names else "No Twitter channel found.")
    )


def get_existing_posts(org_id: str, channel_id: str):
    query = f"""
    query ExistingPosts {{
      scheduled: posts(
        first: 100
        input: {{
          organizationId: {qstr(org_id)}
          filter: {{ status: [scheduled], channelIds: [{qstr(channel_id)}] }}
          sort: {{ field: dueAt, direction: asc }}
        }}
      ) {{
        edges {{ node {{ id text status dueAt channelId }} }}
      }}
      sent: posts(
        first: 100
        input: {{
          organizationId: {qstr(org_id)}
          filter: {{ status: [sent], channelIds: [{qstr(channel_id)}] }}
          sort: {{ field: dueAt, direction: desc }}
        }}
      ) {{
        edges {{ node {{ id text status dueAt channelId }} }}
      }}
    }}
    """
    data = gql(query)
    scheduled = [e["node"] for e in data["scheduled"]["edges"]]
    sent = [e["node"] for e in data["sent"]["edges"]]
    return scheduled, sent


def create_scheduled_post(channel_id: str, text: str, due: datetime):
    due_utc = (
        due.astimezone(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
    query = f"""
    mutation CreateScheduledPost {{
      createPost(input: {{
        text: {qstr(text)}
        channelId: {qstr(channel_id)}
        schedulingType: automatic
        mode: customScheduled
        dueAt: {qstr(due_utc)}
      }}) {{
        ... on PostActionSuccess {{
          post {{ id text dueAt status }}
        }}
        ... on MutationError {{
          message
        }}
      }}
    }}
    """
    result = gql(query)["createPost"]
    if result.get("message") and not result.get("post"):
        raise RuntimeError(result["message"])
    return result["post"]


def load_state():
    if not STATE_PATH.exists():
        return {"usedPostIds": [], "scheduledHistory": []}
    data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    data.setdefault("usedPostIds", [])
    data.setdefault("scheduledHistory", [])
    return data


def save_state(state):
    STATE_PATH.write_text(
        json.dumps(state, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def parse_due(value: str):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(JST)


def future_slots(now: datetime, days: int = 14):
    slots = []
    for offset in range(days + 1):
        day = (now + timedelta(days=offset)).date()
        for hour, minute in SLOTS:
            dt = datetime(day.year, day.month, day.day, hour, minute, tzinfo=JST)
            if dt > now + timedelta(minutes=5):
                slots.append(dt)
    return sorted(slots)


def slot_key(dt: datetime):
    return dt.isoformat(timespec="minutes")


def main():
    posts = json.loads(POSTS_PATH.read_text(encoding="utf-8"))
    state = load_state()
    used = set(state["usedPostIds"])

    org, channel = select_twitter_channel()
    scheduled, sent = get_existing_posts(org["id"], channel["id"])

    existing_texts = {
        p.get("text", "").strip()
        for p in (scheduled + sent)
        if p.get("text")
    }

    # Backfill state from Buffer so manually queued/pre-existing posts are never reused later.
    changed = False
    for item in posts:
        if item["text"].strip() in existing_texts and item["id"] not in used:
            used.add(item["id"])
            changed = True

    occupied = {
        slot_key(parse_due(p["dueAt"]))
        for p in scheduled
        if p.get("dueAt")
    }

    unused = [
        p for p in posts
        if p["id"] not in used and p["text"].strip() not in existing_texts
    ]
    needed = max(0, TARGET_QUEUE_SIZE - len(scheduled))
    available = [
        dt for dt in future_slots(datetime.now(JST))
        if slot_key(dt) not in occupied
    ]

    print(f"Organization: {org['name']} ({org['id']})")
    print(f"Target channel: {channel['name']} ({channel['id']})")
    print(f"Already scheduled: {len(scheduled)}")
    print(f"Known used IDs: {len(used)}")
    print(f"Prepared but unused: {len(unused)}")
    print(f"Need to add: {needed}")

    todo = min(needed, len(unused), len(available))
    for item, due in zip(unused[:todo], available[:todo]):
        print(f"Scheduling {item['id']} at {slot_key(due)}")
        post = create_scheduled_post(channel["id"], item["text"], due)
        print(f"Created Buffer post {post['id']} dueAt={post['dueAt']}")
        used.add(item["id"])
        state["usedPostIds"] = sorted(used)
        state["scheduledHistory"].append({
            "contentId": item["id"],
            "bufferPostId": post["id"],
            "dueAt": post["dueAt"],
            "recordedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        })
        save_state(state)
        changed = True

    if changed:
        state["usedPostIds"] = sorted(used)
        save_state(state)

    if needed == 0:
        print("Queue target already satisfied.")
    elif todo == 0 and not unused:
        print("No unused prepared content remains.")
    else:
        print(f"Done. Scheduled {todo} new post(s).")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
