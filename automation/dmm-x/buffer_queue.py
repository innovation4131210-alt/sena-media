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

DISCOVERY_TEMPLATES = (
    "【PR】今夜の人妻・熟女系。人気順から条件で絞ると、今日はこれが残りました。\n『{title}』{facts_line}\n詳細は返信に。18歳未満閲覧禁止。",
    "【PR】人気上位を全部並べるより、候補は1本だけ。\n『{title}』{facts_line}\n続きは返信に置きます。18歳未満閲覧禁止。",
    "【PR】今夜の候補メモ。人気順の中から、価格と評価まで見て残った1本。\n『{title}』{facts_line}\n詳細は返信に。18歳未満閲覧禁止。",
)

DECISION_TEMPLATES = (
    "【PR】寝る前にレビュー条件で1本だけ比較するなら、今日はこれ。\n『{title}』{facts_line}\n作品詳細はこちら。18歳未満閲覧禁止。",
    "【PR】レビュー順から、価格も確認して候補を1本に絞りました。\n『{title}』{facts_line}\n確認するならこちら。18歳未満閲覧禁止。",
    "【PR】今夜はレビュー重視。上位候補の中で条件を見て残ったのがこれ。\n『{title}』{facts_line}\n作品情報はこちら。18歳未満閲覧禁止。",
)

ENGAGEMENT_POSTS = (
    "夜の作品探し、最初に見るのはどれ？\n①価格 ②レビュー ③新着 ④出演者",
    "人気順とレビュー順、先に見るならどっち？\n①人気 ②レビュー",
    "作品を開く前に一番気になるのは？\n①価格 ②評価 ③あらすじ ④出演者",
    "候補が多いとき、どう絞る？\n①安い順 ②評価順 ③新着順 ④人気順",
    "夜に探すなら、短く1本だけ紹介される方がいい？\n①1本だけ ②3本比較",
    "ランキング上位と新着、先に見たいのは？\n①人気作 ②新着",
    "レビューは星の高さと件数、どっちを重視する？\n①星 ②件数",
    "作品選び、迷う時間はどれくらい？\n①1分以内 ②5分くらい ③じっくり",
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
    price = price_value(item)
    list_price = list_price_value(item)
    discount = discount_percent(item)

    if price is not None:
        if discount >= 10 and list_price:
            facts.append(f"{price:,}円（参考{list_price:,}円・約{discount}%OFF）")
        else:
            facts.append(f"{price:,}円")

    review = item.get("review") or {}
    try:
        average = float(review.get("average"))
        count = int(review.get("count") or 0)
        if average > 0 and count > 0:
            facts.append(f"★{average:.1f}（{count}件）")
    except (TypeError, ValueError):
        pass

    return " / ".join(facts[:2])


def facts_line(facts):
    return ("\n" + facts) if facts else ""


def ensure_x_length(text, affiliate_url=None):
    if len(text) <= 280:
        return text
    if affiliate_url and affiliate_url in text:
        compact = "【PR】作品情報はこちら。18歳未満閲覧禁止。\n" + affiliate_url
        if len(compact) <= 280:
            return compact
    raise RuntimeError("Generated post exceeds 280 characters")


def build_discovery_text(template_index, title, sort_order, facts=""):
    short_title = compact_title(title, limit=48)
    template = DISCOVERY_TEMPLATES[template_index % len(DISCOVERY_TEMPLATES)]
    return ensure_x_length(
        template.format(title=short_title, facts_line=facts_line(facts))
    )


def build_decision_text(template_index, title, sort_order, affiliate_url, facts="", meta=None):
    short_title = compact_title(title, limit=48)
    meta = meta or {}
    discount = int(meta.get("discount_pct") or 0)

    if discount >= 10:
        body = (
            f"【PR】今夜は買い時が分かりやすい1本。約{discount}%OFFになっています。\n"
            f"『{short_title}』"
            + facts_line(facts)
            + "\n価格条件を確認するならこちら。18歳未満閲覧禁止。"
        )
    else:
        template = DECISION_TEMPLATES[template_index % len(DECISION_TEMPLATES)]
        body = template.format(title=short_title, facts_line=facts_line(facts))

    return ensure_x_length(body + "\n" + affiliate_url, affiliate_url)


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


def list_price_value(item):
    raw = (item.get("prices") or {}).get("list_price")
    digits = "".join(ch for ch in str(raw or "") if ch.isdigit())
    return int(digits) if digits else None


def discount_percent(item):
    price = price_value(item)
    list_price = list_price_value(item)
    if not price or not list_price or list_price <= price:
        return 0
    return int(round((list_price - price) * 100 / list_price))


def main_image_url(item):
    images = item.get("imageURL") or {}
    return str(images.get("large") or images.get("list") or images.get("small") or "").strip()


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
            "list_price": list_price_value(item),
            "discount_pct": discount_percent(item),
            "image_url": main_image_url(item),
            "review_average": average,
            "review_count": review_count,
        })
    return candidates


def choose_conversion_candidate(candidates):
    # First-sale pilot:
    # Within the strongest eligible cohort, real discounts get first priority.
    # Otherwise favor lower purchase friction, then stronger review evidence.
    cohort = candidates[:20]
    if not cohort:
        return None

    def score(c):
        discount = c.get("discount_pct") or 0
        if discount >= 30:
            discount_tier = 0
        elif discount >= 10:
            discount_tier = 1
        else:
            discount_tier = 2
        return (
            discount_tier,
            -discount,
            c["price"] is None,
            c["price"] if c["price"] is not None else 10**12,
            -c["review_average"],
            -c["review_count"],
            c["position"],
        )

    return min(cohort, key=score)


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
                {
                    "price": chosen["price"],
                    "list_price": chosen["list_price"],
                    "discount_pct": chosen["discount_pct"],
                    "review_average": chosen["review_average"],
                    "review_count": chosen["review_count"],
                    "image_url": chosen["image_url"],
                },
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
    content_id, title, affiliate_url, actual_sort, facts, meta = choose_product(used_ids, preferred_sort)

    if first_reply:
        format_name = "discovery"
        index = int(state.get("discovery_template_index", 0)) % len(DISCOVERY_TEMPLATES)
        lead_text = build_discovery_text(index, title, actual_sort, facts)
        reply_text = (
            "【PR】作品詳細はこちら。価格・配信条件はリンク先でご確認ください。"
            "18歳未満閲覧禁止。\n" + affiliate_url
        )
        post = create_post(lead_text, channel_id, first_reply=reply_text)
        state["discovery_template_index"] = index + 1
        link_mode = "first_reply"
    else:
        format_name = "decision"
        index = int(state.get("decision_template_index", 0)) % len(DECISION_TEMPLATES)
        text = build_decision_text(index, title, actual_sort, affiliate_url, facts, meta)
        post = create_post(text, channel_id)
        state["decision_template_index"] = index + 1
        link_mode = "direct"

    history = list(state.get("used_content_ids", []))
    history.append(content_id)
    state["used_content_ids"] = history[-300:]
    state["last_content_id"] = content_id
    remember(
        state,
        post,
        kind="affiliate",
        template_index=index,
        content_id=content_id,
        sort_order=actual_sort,
    )
    state["post_history"][-1]["link_mode"] = link_mode
    state["post_history"][-1]["format"] = format_name
    state["post_history"][-1]["discount_pct"] = int(meta.get("discount_pct") or 0)
    state["post_history"][-1]["has_image_url"] = bool(meta.get("image_url"))
    state["content_strategy_version"] = "real-selection-v2"
    return f"affiliate/{format_name}/{actual_sort}/{link_mode}", post


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
