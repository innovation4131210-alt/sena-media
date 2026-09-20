#!/usr/bin/env python3
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from datetime import datetime, timedelta, timezone

BUFFER_API_URL = "https://api.buffer.com"
DMM_API_URL = "https://api.dmm.com/affiliate/v3/ItemList"
BUFFER_KEY = os.environ.get("BUFFER_API_KEY", "").strip()
DMM_API_ID = os.environ.get("DMM_API_ID", "").strip()
RUN_SCHEDULE = os.environ.get("RUN_SCHEDULE", "").strip()
DMM_AFFILIATE_ID = "eromimimimi-990"
STATE_PATH = Path("automation/dmm-x/state.json")

# 未成年・非同意・違法性を連想させる商品は自動選定から除外します。
BLOCKED_WORDS = (
    "レイプ", "強姦", "輪姦", "痴漢", "盗撮", "催眠", "睡眠姦",
    "児童", "幼女", "ロリ", "未成年", "女子校生", "中学生", "小学生",
    "近親", "獣姦", "無修正",
)
TARGET_WORDS = ("人妻", "熟女", "主婦", "奥様", "妻")

SORT_LABELS = {
    "rank": "人気上位",
    "review": "高評価",
    "date": "新着",
}

AFFILIATE_TEMPLATES = (
    "【PR】{label}から今日の1本。\n『{title}』\n気になる方だけ作品詳細へ。18歳未満閲覧禁止。",
    "【PR】今夜の候補を1本だけ。\n『{title}』\n{label}からピックアップしました。18歳未満閲覧禁止。",
    "【PR】大人向け作品メモ。\n{label}で見つけた『{title}』\n詳細はリンク先で確認できます。18歳未満閲覧禁止。",
    "【PR】作品選びで迷ったら候補に。\n『{title}』\n今回は{label}から選びました。18歳未満閲覧禁止。",
    "【PR】こっそり確認したい作品をピックアップ。\n『{title}』\n詳細はリンク先へ。18歳未満閲覧禁止。",
    "【PR】本日の大人向け作品メモ。\n『{title}』\n気になる方だけ作品情報をご確認ください。18歳未満閲覧禁止。",
)

ENGAGEMENT_POSTS = (
    "作品を選ぶとき、いちばん気になるのは？\n①雰囲気 ②ストーリー ③出演者 ④レビュー\nこっそり番号で教えてください🌙🔞",
    "人妻・熟女作品は、落ち着いた雰囲気とドラマ性のどちらを重視しますか？🌙\n①雰囲気派 ②ストーリー派",
    "作品探しはいつすることが多いですか？\n①昼休み ②夜 ③寝る前\n今後の紹介時間の参考にします🌙🔞",
    "新着と高評価作品、先にチェックしたいのはどちらですか？\n①新着 ②高評価",
    "短時間で見つけたい派？じっくり比較したい派？\n①すぐ決める ②レビューまで確認する🌙",
    "今夜の作品選び、重視するのは？\n①自然な雰囲気 ②大人っぽさ ③物語性 ④知名度🔞",
    "気になる作品は保存して後で見る派？その場で確認する派？🌙\n①保存派 ②すぐ見る派",
    "人妻・熟女ジャンルで次に多めに紹介してほしいのは？\n①新着 ②人気作 ③高評価作🔞",
    "作品紹介は短い一言と詳しい説明、どちらが見やすいですか？\n①短文 ②詳しめ",
    "夜の作品選びで迷う時間はどれくらい？\n①1分以内 ②5分くらい ③じっくり比較🌙",
    "ランキング上位と隠れた新着、気になるのはどちら？\n①人気作 ②新着作🔞",
    "作品ページで最初に見るところは？\n①画像 ②あらすじ ③レビュー ④出演者",
    "平日と休日、作品を探すことが多いのはどちらですか？\n①平日 ②休日🌙",
    "次の紹介は人気順と評価順、どちらを先に見たいですか？\n①人気順 ②評価順🔞",
)


def request_json(url, *, data=None, headers=None):
    req = urllib.request.Request(
        url,
        data=data,
        headers=headers or {},
        method="POST" if data is not None else "GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.load(res)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"External API returned HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError("External API connection failed") from exc


def gql(query):
    if not BUFFER_KEY:
        raise RuntimeError("BUFFER_API_KEY is not configured")
    data = request_json(
        BUFFER_API_URL,
        data=json.dumps({"query": query}).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {BUFFER_KEY}",
        },
    )
    if data.get("errors"):
        raise RuntimeError(data["errors"][0].get("message", "Buffer GraphQL error"))
    return data["data"]


def esc(value):
    return json.dumps(value, ensure_ascii=False)


def compact_title(value, limit=54):
    title = " ".join(str(value or "").split())
    if not title:
        return "作品タイトルはリンク先で確認"
    if len(title) <= limit:
        return title
    return title[: limit - 1].rstrip() + "…"


def product_facts(item):
    facts = []
    prices = item.get("prices") or {}
    raw_price = prices.get("price")
    if raw_price is not None:
        digits = "".join(ch for ch in str(raw_price) if ch.isdigit())
        if digits:
            facts.append(f"{int(digits):,}円")

    review = item.get("review") or {}
    try:
        average = float(review.get("average"))
        count = int(review.get("count") or 0)
        if average > 0 and count > 0:
            facts.append(f"★{average:.1f}（{count}件）")
    except (TypeError, ValueError):
        pass

    return " / ".join(facts[:2])


def build_affiliate_text(template_index, title, sort_order, affiliate_url, facts=""):
    label = SORT_LABELS.get(sort_order, "注目作品")
    short_title = compact_title(title)
    body = AFFILIATE_TEMPLATES[template_index].format(
        label=label,
        title=short_title,
    )
    if facts:
        body += "\n" + facts
    text = body + "\n" + affiliate_url

    # タイトルやURLが長い場合も、投稿自体は止めずに短文へ安全にフォールバックします。
    if len(text) > 280:
        text = (
            f"【PR】{label}から今日の1本。作品詳細はこちら。"
            "18歳未満閲覧禁止。\n"
            + affiliate_url
        )
    if len(text) > 280:
        raise RuntimeError("Generated post exceeds 280 characters")
    return text


def find_x_channel():
    orgs = gql("query { account { organizations { id name } } }")["account"]["organizations"]
    for org in orgs:
        query = (
            "query { channels(input: { organizationId: "
            + esc(org["id"])
            + " }) { id name service isDisconnected isLocked isQueuePaused } }"
        )
        for channel in gql(query)["channels"]:
            if channel["service"] == "twitter" and channel["name"].lower() == "ero_mimimimi":
                if channel["isDisconnected"] or channel["isLocked"] or channel["isQueuePaused"]:
                    raise RuntimeError("X channel is disconnected, locked, or paused")
                return channel["id"]
    raise RuntimeError("Connected X channel ero_mimimimi was not found")


def dmm_items(sort_order):
    if not DMM_API_ID:
        raise RuntimeError("DMM_API_ID is not configured")
    params = {
        "api_id": DMM_API_ID,
        "affiliate_id": DMM_AFFILIATE_ID,
        "site": "FANZA",
        "service": "digital",
        "floor": "videoa",
        "hits": 100,
        "sort": sort_order,
        "output": "json",
    }
    data = request_json(
        DMM_API_URL + "?" + urllib.parse.urlencode(params),
        headers={"User-Agent": "dmm-x-auto-post/2.0"},
    )
    result = data.get("result") or {}
    if result.get("status") not in (None, 200, "200"):
        raise RuntimeError("DMM API returned an error")
    return result.get("items") or []


def price_value(item):
    raw = (item.get("prices") or {}).get("price")
    digits = "".join(ch for ch in str(raw or "") if ch.isdigit())
    return int(digits) if digits else None


def review_values(item):
    review = item.get("review") or {}
    try:
        average = float(review.get("average") or 0)
    except (TypeError, ValueError):
        average = 0.0
    try:
        count = int(review.get("count") or 0)
    except (TypeError, ValueError):
        count = 0
    return average, count


def eligible_candidates(items, used_ids):
    candidates = []
    for position, item in enumerate(items):
        content_id = str(item.get("content_id") or item.get("product_id") or "").strip()
        title = str(item.get("title") or "").strip()
        searchable = json.dumps(item.get("iteminfo") or {}, ensure_ascii=False) + title
        affiliate_url = str(item.get("affiliateURL") or "").strip()
        if not content_id or not affiliate_url or content_id in used_ids:
            continue
        if any(word in searchable for word in BLOCKED_WORDS):
            continue
        if not any(word in searchable for word in TARGET_WORDS):
            continue
        average, review_count = review_values(item)
        candidates.append({
            "item": item,
            "position": position,
            "content_id": content_id,
            "title": title,
            "affiliate_url": affiliate_url,
            "price": price_value(item),
            "review_average": average,
            "review_count": review_count,
        })
    return candidates


def choose_conversion_candidate(candidates):
    # First-sale pilot:
    # keep relevance by considering only the highest-ranked/reviewed eligible cohort,
    # then favor lower purchase friction (lower known price), using review strength
    # as a tie-breaker. Missing prices are kept behind known-price candidates.
    cohort = candidates[:20]
    if not cohort:
        return None
    return min(
        cohort,
        key=lambda c: (
            c["price"] is None,
            c["price"] if c["price"] is not None else 10**12,
            -c["review_average"],
            -c["review_count"],
            c["position"],
        ),
    )


def choose_product(used_ids, preferred_sort):
    # 78 verified DMM clicks produced 0 conversions through 2026-09-21.
    # For the next controlled pilot, preserve rank/review relevance but select
    # a lower-friction offer from the top eligible cohort instead of blindly
    # taking the first API item.
    orders = [preferred_sort]
    if preferred_sort != "date":
        orders.append("date")
    for sort_order in orders:
        candidates = eligible_candidates(dmm_items(sort_order), used_ids)
        chosen = choose_conversion_candidate(candidates)
        if chosen:
            item = chosen["item"]
            return (
                chosen["content_id"],
                chosen["title"],
                chosen["affiliate_url"],
                sort_order,
                product_facts(item),
            )
    raise RuntimeError("No eligible unpublished DMM product was found")


def create_post(text, channel_id, *, first_reply=None):
    metadata = ""
    if first_reply:
        metadata = (
            ", metadata: { twitter: { thread: ["
            + "{ text: " + esc(text) + " }, "
            + "{ text: " + esc(first_reply) + " }"
            + "] } }"
        )
    mutation = """mutation {
      createPost(input: {
        text: %s,
        channelId: %s,
        schedulingType: automatic,
        mode: addToQueue
        %s
      }) {
        ... on PostActionSuccess { post { id text dueAt } }
        ... on MutationError { message }
      }
    }""" % (esc(text), esc(channel_id), metadata)
    result = gql(mutation)["createPost"]
    if result.get("message"):
        raise RuntimeError(result["message"])
    return result["post"]


def remember(state, post, *, kind, template_index, content_id=None, sort_order=None):
    entry = {
        "buffer_post_id": post["id"],
        "due_at": post.get("dueAt"),
        "kind": kind,
        "template_index": template_index,
    }
    if content_id:
        entry["content_id"] = content_id
    if sort_order:
        entry["sort"] = sort_order
    post_history = list(state.get("post_history", []))
    post_history.append(entry)
    state["post_history"] = post_history[-100:]
    state["last_buffer_post_id"] = post["id"]
    state["last_due_at"] = post.get("dueAt")


def queue_engagement(state, channel_id):
    index = int(state.get("engagement_index", 0)) % len(ENGAGEMENT_POSTS)
    post = create_post(ENGAGEMENT_POSTS[index], channel_id)
    state["engagement_index"] = index + 1
    remember(state, post, kind="engagement", template_index=index)
    return "engagement", post


def queue_affiliate(state, channel_id, preferred_sort, *, first_reply=False):
    used_ids = set(str(value) for value in state.get("used_content_ids", []))
    content_id, title, affiliate_url, actual_sort, facts = choose_product(used_ids, preferred_sort)
    index = int(state.get("affiliate_template_index", 0)) % len(AFFILIATE_TEMPLATES)
    text = build_affiliate_text(index, title, actual_sort, affiliate_url, facts)

    link_mode = "direct"
    if first_reply:
        direct_suffix = "\n" + affiliate_url
        if text.endswith(direct_suffix):
            lead_text = text[: -len(direct_suffix)]
        else:
            lead_text = text.replace(affiliate_url, "").rstrip()
        reply_text = (
            "【PR】作品詳細はこちら。価格・配信条件はリンク先でご確認ください。"
            "18歳未満閲覧禁止。\n" + affiliate_url
        )
        post = create_post(lead_text, channel_id, first_reply=reply_text)
        link_mode = "first_reply"
    else:
        post = create_post(text, channel_id)

    history = list(state.get("used_content_ids", []))
    history.append(content_id)
    state["used_content_ids"] = history[-300:]
    state["last_content_id"] = content_id
    state["affiliate_template_index"] = index + 1
    remember(
        state,
        post,
        kind="affiliate",
        template_index=index,
        content_id=content_id,
        sort_order=actual_sort,
    )
    state["post_history"][-1]["link_mode"] = link_mode
    return f"affiliate/{actual_sort}/{link_mode}", post


def persist_state(state):
    STATE_PATH.write_text(
        json.dumps(state, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main():
    state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    channel_id = find_x_channel()

    # Idempotent daily batch:
    # if a later queue item fails, successful earlier items are marked done
    # and will be skipped on retry instead of being duplicated.
    jst = timezone(timedelta(hours=9))
    batch_date = datetime.now(jst).date().isoformat()
    if state.get("batch_date") != batch_date:
        state["batch_date"] = batch_date
        state["batch_slots"] = {}
        persist_state(state)

    slots = state.setdefault("batch_slots", {})
    queued = []

    if not slots.get("engagement"):
        label, post = queue_engagement(state, channel_id)
        slots["engagement"] = {
            "buffer_post_id": post.get("id"),
            "due_at": post.get("dueAt"),
        }
        persist_state(state)
        queued.append((label, post))
    else:
        print("Skip engagement: already queued for this JST date")

    if not slots.get("rank_first_reply"):
        label, post = queue_affiliate(state, channel_id, "rank", first_reply=True)
        slots["rank_first_reply"] = {
            "buffer_post_id": post.get("id"),
            "due_at": post.get("dueAt"),
        }
        persist_state(state)
        queued.append((label, post))
    else:
        print("Skip rank_first_reply: already queued for this JST date")

    if not slots.get("review_direct"):
        label, post = queue_affiliate(state, channel_id, "review", first_reply=False)
        slots["review_direct"] = {
            "buffer_post_id": post.get("id"),
            "due_at": post.get("dueAt"),
        }
        persist_state(state)
        queued.append((label, post))
    else:
        print("Skip review_direct: already queued for this JST date")

    state.pop("next_index", None)
    persist_state(state)

    for label, post in queued:
        print(f"Queued {label} post for {post.get('dueAt')}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
