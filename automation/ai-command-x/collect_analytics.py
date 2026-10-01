#!/usr/bin/env python3
import csv
import json
import os
import math
import re
from urllib.parse import urlsplit
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
AGE_PATH = ANALYTICS_DIR / "age_snapshots.json"


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
    matches = []
    for org in get_organizations():
        for channel in get_channels(org['id']):
            name = (channel.get('name') or '').lower().replace('@', '').strip()
            if channel['service'] == 'twitter' and name == CHANNEL_HINT:
                matches.append((org, channel))
    if len(matches) != 1:
        raise RuntimeError('Target X channel must match ai_command_jp exactly and uniquely.')
    if matches[0][1]['id'] != '6abb9a71ea19ca0bde216771':
        raise RuntimeError('Target X channel ID changed; review required before collecting.')
    return matches[0]


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
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def complete_sum(values):
    values = list(values)
    return sum(values) if values and all(v is not None for v in values) else None


def rate(total, impressions):
    return round(total / impressions * 100, 4) if total is not None and impressions is not None and impressions > 0 else None


NOTE_IDS = {
    'ne79f153b4665': 'free_entry',
    'nbb052c3cb0ad': 'front_product',
    'n7b74f56a03dc': 'core_product',
    'n29d46a1b4341': 'free_A',
    'n465168c06f64': 'free_B',
}


def note_destination(url):
    parts = urlsplit(url)
    if parts.hostname not in {'note.com', 'www.note.com'}:
        return None
    if parts.path.startswith('/ai_command/n/'):
        return NOTE_IDS.get(parts.path.rstrip('/').split('/')[-1], 'other_note')
    return 'note_home' if parts.path.rstrip('/') == '/ai_command' else 'other_note'


def permitted_url(url):
    parts = urlsplit(url)
    return parts.scheme == 'https' and parts.hostname in {'t.co', 'note.com', 'www.note.com'} and parts.port in (None, 443) and not parts.username and not parts.password


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not permitted_url(newurl):
            raise ValueError('redirect_destination_not_allowlisted')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def classify_links(text, cache, checked_at):
    evidence = []
    urls = re.findall(r'https?://[^\s<>]+', text or '')
    for raw in urls:
        url = raw.rstrip('。、,.)]）')
        parts = urlsplit(url)
        if parts.hostname in {'note.com', 'www.note.com'}:
            evidence.append({'originalUrl': url, 'finalUrl': url, 'status': 'direct', 'destination': note_destination(url), 'checkedAt': checked_at})
        elif parts.hostname == 't.co':
            if url not in cache:
                try:
                    if not permitted_url(url):
                        raise ValueError('unsafe_url')
                    req = urllib.request.Request(url, headers={'User-Agent': 'AI-Command-Link-Audit/1.0'})
                    with urllib.request.build_opener(SafeRedirect()).open(req, timeout=12) as response:
                        final = response.geturl()
                        # Reading the response is unnecessary: only the HTTP redirect is used.
                        if urlsplit(final).hostname == 't.co':
                            raise ValueError('short_url_not_resolved')
                    cache[url] = {'originalUrl': url, 'finalUrl': final, 'status': 'resolved', 'destination': note_destination(final), 'checkedAt': checked_at}
                except Exception:
                    cache[url] = {'originalUrl': url, 'finalUrl': None, 'status': 'unresolved', 'destination': None, 'checkedAt': checked_at}
            evidence.append(cache[url])
    destinations = [e['destination'] for e in evidence if e.get('destination')]
    has_note = True if destinations else None if any(e['status'] == 'unresolved' for e in evidence) else False
    return has_note, destinations[0] if destinations else None, evidence


def iso_to_jst(value):
    if not value:
        return None
    return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(JST)


def summarize(items):
    result = {'posts': len(items), 'metricCoverage': {}}
    for key in ('impressions', 'likes', 'comments', 'reposts', 'quotes', 'clicks', 'saves'):
        known = [r[key] for r in items if r.get(key) is not None]
        result[key] = sum(known) if len(known) == len(items) else None
        result['metricCoverage'][key] = {'known': len(known), 'missing': len(items) - len(known), 'knownSum': sum(known) if known else None}
    note_known = [r for r in items if r['hasNoteLink'] is not None]
    result['noteLinkPosts'] = sum(r['hasNoteLink'] is True for r in items) if len(note_known) == len(items) else None
    result['knownNoteLinkPosts'] = sum(r['hasNoteLink'] is True for r in items)
    result['unknownLinkPosts'] = len(items) - len(note_known)
    interactions = complete_sum(result[k] for k in ('likes', 'comments', 'reposts', 'quotes', 'clicks', 'saves'))
    result['interactionRatePct'] = rate(interactions, result['impressions'])
    result['clickRatePct'] = rate(result['clicks'], result['impressions'])
    return result


def main():
    prepared = json.loads(POSTS_PATH.read_text(encoding="utf-8"))
    by_text = {p["text"].strip(): p for p in prepared}

    org, channel = select_twitter_channel()
    sent = fetch_sent_posts(org["id"], channel["id"])
    cutoff = datetime.now(JST) - timedelta(days=LOOKBACK_DAYS)

    now = datetime.now(timezone.utc)
    collected_at = now.isoformat(timespec="seconds")
    link_cache = {}
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
        interactions = complete_sum([likes, comments, reposts, quotes, clicks, saves])
        interaction_rate = rate(interactions, impressions)
        click_rate = rate(clicks, impressions)

        has_note, destination, link_evidence = classify_links(post.get("text"), link_cache, collected_at)
        metric_dt = iso_to_jst(post.get("metricsUpdatedAt"))
        rows.append({
            "contentId": source.get("id"),
            "contentType": source.get("type"),
            "experimentId": source.get("experimentId"),
            "hookVariant": source.get("hookVariant"),
            "bufferPostId": post.get("id"),
            "sentAt": sent_dt.isoformat(timespec="seconds") if sent_dt else None,
            "externalLink": post.get("externalLink"),
            "text": post.get("text"),
            "hasNoteLink": has_note,
            "noteDestination": destination,
            "linkEvidence": link_evidence,
            "collectedAt": collected_at,
            "elapsedHours": round((now - sent_dt).total_seconds() / 3600, 3) if sent_dt else None,
            "metricElapsedHours": round((metric_dt - sent_dt).total_seconds() / 3600, 3) if metric_dt and sent_dt else None,
            "metricStatus": {k: "reported" if safe_float(metrics.get(k)) is not None else "missing" for k in ("impressions", "likes", "comments", "reposts", "quotes", "clicks", "saves")},
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

    daily = defaultdict(list)
    for row in rows:
        daily[(row.get('sentAt') or '')[:10] or 'unknown'].append(row)
    daily_rows = [{'date': day, **summarize(daily[day])} for day in sorted(daily, reverse=True)]

    ANALYTICS_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "generatedAt": collected_at,
        "schemaVersion": 2,
        "notePurchases": None,
        "noteRevenueJpy": None,
        "purchaseAttribution": "unavailable",
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
    age_data = json.loads(AGE_PATH.read_text()) if AGE_PATH.exists() else {'schemaVersion': 2, 'posts': {}}
    current_ids = {row['bufferPostId'] for row in rows}
    age_data['posts'] = {key: value for key, value in age_data['posts'].items() if key in current_ids}
    for row in rows:
        entry = age_data['posts'].setdefault(row['bufferPostId'], {})
        for hours in (24, 72):
            key = str(hours)
            entry.setdefault(key, {'status': 'pending', 'snapshot': None})
            elapsed = row.get('elapsedHours')
            metric_age = row.get('metricElapsedHours')
            if elapsed is not None and hours <= elapsed <= hours + 2 and metric_age is not None and hours <= metric_age <= hours + 2:
                if entry[key]['snapshot'] is None and row['impressions'] is not None:
                    entry[key] = {'status': 'captured', 'snapshot': row.copy()}
            elif elapsed is not None and elapsed > hours + 2 and entry[key]['snapshot'] is None:
                entry[key]['status'] = 'not_collected_or_delayed'
    age_data['generatedAt'] = collected_at
    AGE_PATH.write_text(json.dumps(age_data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
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
        summary = summarize(rows)
        print('Metric coverage: ' + json.dumps(summary['metricCoverage']))
        print('Unresolved link posts: ' + str(summary['unknownLinkPosts']))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

