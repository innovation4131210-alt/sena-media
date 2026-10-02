#!/usr/bin/env python3
import json
import os
import re
import sys
import time
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
ENABLE_DMM_MEDIA = os.environ.get("ENABLE_DMM_MEDIA", "false").strip().lower() == "true"
DMM_AFFILIATE_ID = "eromimimimi-990"
STATE_PATH = Path("automation/dmm-x/state.json")
ACTRESS_POPULARITY_PATH = Path(__file__).resolve().parents[2] / "analytics" / "dmm-actress-popularity.json"

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

# If a currently popular performer exists in the eligible cohort, prefer that
# cohort instead of selecting an unknown performer solely on price/discount.
KNOWN_ACTRESS_SCORE_THRESHOLD = 150.0


def item_actresses(item):
    raw = (item.get("iteminfo") or {}).get("actress") or []
    if isinstance(raw, dict):
        raw = [raw]
    out = []
    for actress in raw:
        if not isinstance(actress, dict):
            continue
        name = str(actress.get("name") or "").strip()
        actress_id = actress.get("id")
        if name:
            out.append({"id": actress_id, "name": name})
    return out


def load_actress_popularity():
    try:
        data = json.loads(ACTRESS_POPULARITY_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}

    scores = {}
    for row in data.get("topOverall", []):
        score = float(row.get("popularityScore") or 0)
        if row.get("id") is not None:
            scores[f"id:{row['id']}"] = max(score, scores.get(f"id:{row['id']}", 0))
        name = str(row.get("name") or "").strip()
        if name:
            scores[f"name:{name}"] = max(score, scores.get(f"name:{name}", 0))
    return scores


ACTRESS_POPULARITY = load_actress_popularity()


def actress_signal(item):
    best_name = ""
    best_score = 0.0
    names = []
    for actress in item_actresses(item):
        name = actress["name"]
        names.append(name)
        score = 0.0
        if actress.get("id") is not None:
            score = max(score, ACTRESS_POPULARITY.get(f"id:{actress['id']}", 0.0))
        score = max(score, ACTRESS_POPULARITY.get(f"name:{name}", 0.0))
        if score > best_score:
            best_score = score
            best_name = name
    if not best_name and names:
        best_name = names[0]
    return best_name, round(best_score, 3), names


DISCOVERY_TEMPLATES = (
    "【PR】今夜の人気女優から、条件で絞ると今日はこれ。\n『{title}』{facts_line}\n詳細はこちら。18歳未満閲覧禁止。",
    "【PR】人気作品を全部並べるより、知っている女優から1本だけ。\n『{title}』{facts_line}\n詳細はこちら。18歳未満閲覧禁止。",
    "【PR】今夜の候補メモ。人気女優の作品から価格と評価まで見て残った1本。\n『{title}』{facts_line}\n詳細はこちら。18歳未満閲覧禁止。",
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


def request_json(url, *, data=None, headers=None, service_name="External API"):
    req = urllib.request.Request(
        url,
        data=data,
        headers=headers or {},
        method="POST" if data is not None else "GET",
    )
    retry_delays = (10, 30, 60)
    for attempt in range(len(retry_delays) + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return json.load(res)
        except urllib.error.HTTPError as exc:
            if exc.code == 429 and attempt < len(retry_delays):
                raw_retry_after = str(exc.headers.get("Retry-After") or "").strip()
                try:
                    retry_after = max(1, min(90, int(raw_retry_after)))
                except ValueError:
                    retry_after = retry_delays[attempt]
                print(
                    f"{service_name} rate limited; retrying after {retry_after}s "
                    f"(attempt {attempt + 1}/{len(retry_delays) + 1})",
                    file=sys.stderr,
                )
                time.sleep(retry_after)
                continue
            if exc.code == 429:
                raise RuntimeError(
                    f"{service_name} rate limited after {len(retry_delays) + 1} attempts"
                ) from exc
            raise RuntimeError(f"{service_name} returned HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"{service_name} connection failed") from exc


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
        service_name="Buffer API",
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


def product_facts(item, actress_name=""):
    facts = []
    if actress_name:
        facts.append(f"出演：{actress_name}")

    price = price_value(item)
    list_price = list_price_value(item)
    discount = discount_percent(item)

    if price is not None:
        if discount >= 10 and list_price:
            facts.append(f"{price:,}円（参考{list_price:,}円・約{discount}%OFF）")
        else:
            facts.append(f"{price:,}円")

    if len(facts) < 2:
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


def x_weighted_length(text):
    """Return the twitter-text weighted length used by X's 280 limit.

    X counts most CJK characters as weight 2 and HTTP(S) URLs as 23
    characters regardless of their literal length.
    """
    total = 0
    cursor = 0
    for match in re.finditer(r"https?://\S+", str(text or "")):
        for char in text[cursor:match.start()]:
            codepoint = ord(char)
            total += 1 if (
                0x0000 <= codepoint <= 0x10FF
                or 0x2000 <= codepoint <= 0x200D
                or 0x2010 <= codepoint <= 0x201F
                or 0x2032 <= codepoint <= 0x2037
            ) else 2
        total += 23
        cursor = match.end()
    for char in text[cursor:]:
        codepoint = ord(char)
        total += 1 if (
            0x0000 <= codepoint <= 0x10FF
            or 0x2000 <= codepoint <= 0x200D
            or 0x2010 <= codepoint <= 0x201F
            or 0x2032 <= codepoint <= 0x2037
        ) else 2
    return total


def ensure_x_length(text, affiliate_url=None):
    if x_weighted_length(text) <= 280:
        return text
    if affiliate_url and affiliate_url in text:
        compact = "【PR】作品情報はこちら。18歳未満閲覧禁止。\n" + affiliate_url
        if x_weighted_length(compact) <= 280:
            return compact
    raise RuntimeError("Generated post exceeds X weighted length 280")


def build_discovery_text(template_index, title, sort_order, affiliate_url, facts=""):
    short_title = compact_title(title, limit=48)
    template = DISCOVERY_TEMPLATES[template_index % len(DISCOVERY_TEMPLATES)]
    body = template.format(title=short_title, facts_line=facts_line(facts))
    return ensure_x_length(body + "\n" + affiliate_url, affiliate_url)


def build_decision_text(template_index, title, sort_order, affiliate_url, facts="", meta=None):
    short_title = compact_title(title, limit=48)
    meta = meta or {}
    discount = int(meta.get("discount_pct") or 0)
    campaign = bool(meta.get("campaign_active"))
    recent = bool(meta.get("recent_release"))

    if campaign and discount >= 10:
        body = (
            f"【PR】今夜はキャンペーン対象＋約{discount}%OFFの1本。\n"
            f"『{short_title}』"
            + facts_line(facts)
            + "\n今見る理由がはっきりしている候補です。18歳未満閲覧禁止。"
        )
    elif discount >= 10:
        body = (
            f"【PR】今夜は買い時が分かりやすい1本。約{discount}%OFF。\n"
            f"『{short_title}』"
            + facts_line(facts)
            + "\n価格条件を確認するならこちら。18歳未満閲覧禁止。"
        )
    elif campaign:
        body = (
            f"【PR】キャンペーン対象から1本だけ。\n"
            f"『{short_title}』"
            + facts_line(facts)
            + "\n今の候補として確認するならこちら。18歳未満閲覧禁止。"
        )
    elif recent:
        body = (
            f"【PR】新着側から今夜の候補を1本。\n"
            f"『{short_title}』"
            + facts_line(facts)
            + "\n新しい作品を先に見るならこちら。18歳未満閲覧禁止。"
        )
    else:
        template = DECISION_TEMPLATES[template_index % len(DECISION_TEMPLATES)]
        body = template.format(title=short_title, facts_line=facts_line(facts))

    return ensure_x_length(body + "\n" + affiliate_url, affiliate_url)


def channel_inventory(organization_id, channel_id):
    query = (
        "query { posts(first: 100, input: { organizationId: "
        + esc(organization_id)
        + ", filter: { channelIds: ["
        + esc(channel_id)
        + "] } }) { edges { node { id text status dueAt sentAt externalLink } } "
        + "pageInfo { hasNextPage } } }"
    )
    result = gql(query)["posts"]
    if result["pageInfo"]["hasNextPage"]:
        raise RuntimeError("Incomplete DMM X Buffer inventory; stop before mutation")
    return [edge["node"] for edge in result["edges"]]


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
                return channel["id"], channel_inventory(org["id"], channel["id"])
    raise RuntimeError("Connected X channel ero_mimimimi was not found")


def due_timestamp(value):
    parsed = parse_dmm_datetime(value)
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).timestamp()


def batch_due_slots(batch_date):
    jst = timezone(timedelta(hours=9))
    day = datetime.fromisoformat(batch_date)
    return {
        "engagement": day.replace(hour=12, minute=30, second=0, microsecond=0, tzinfo=jst),
        "rank_first_reply": day.replace(hour=21, minute=30, second=0, microsecond=0, tzinfo=jst),
        "review_direct": day.replace(hour=23, minute=30, second=0, microsecond=0, tzinfo=jst),
    }


def recovered_content_id(text):
    raw = str(text or "")
    patterns = (
        r"/cid=([a-zA-Z0-9_]+)/",
        r"cid%3D([a-zA-Z0-9_]+)",
        r"[?&]cid=([a-zA-Z0-9_]+)",
    )
    for pattern in patterns:
        match = re.search(pattern, raw)
        if match:
            return match.group(1)
    return None


def recover_existing_batch(state, posts, batch_date):
    slots = state.setdefault("batch_slots", {})
    history = list(state.get("post_history", []))
    used_ids = list(state.get("used_content_ids", []))
    recovered = []

    for slot_name, expected_at in batch_due_slots(batch_date).items():
        expected_ts = expected_at.astimezone(timezone.utc).timestamp()
        matches = []
        for post in posts:
            if post.get("status") not in ("scheduled", "sent"):
                continue
            actual_ts = due_timestamp(post.get("dueAt"))
            if actual_ts is not None and abs(actual_ts - expected_ts) <= 60:
                matches.append(post)

        if len(matches) > 1:
            raise RuntimeError(
                f"Multiple DMM X posts occupy {slot_name} for {batch_date}; stop before mutation"
            )
        if not matches:
            continue

        post = matches[0]
        existing_slot = slots.get(slot_name)
        if existing_slot and existing_slot.get("buffer_post_id") not in (None, post.get("id")):
            raise RuntimeError(f"Saved {slot_name} conflicts with live Buffer inventory")

        slots[slot_name] = {
            "buffer_post_id": post.get("id"),
            "due_at": post.get("dueAt"),
            "recovered_from_buffer": True,
        }

        if not any(row.get("buffer_post_id") == post.get("id") for row in history):
            content_id = recovered_content_id(post.get("text"))
            row = {
                "buffer_post_id": post.get("id"),
                "due_at": post.get("dueAt"),
                "kind": "engagement" if slot_name == "engagement" else "affiliate",
                "recovered_from_buffer": True,
            }
            if slot_name != "engagement":
                row["format"] = "discovery" if slot_name == "rank_first_reply" else "decision"
                row["link_mode"] = "direct"
                if content_id:
                    row["content_id"] = content_id
                    if content_id not in used_ids:
                        used_ids.append(content_id)
            history.append(row)
        recovered.append({"slot": slot_name, "id": post.get("id"), "status": post.get("status")})

    state["post_history"] = history[-100:]
    state["used_content_ids"] = used_ids[-300:]
    return recovered


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
        service_name="DMM API",
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


def parse_dmm_datetime(value):
    text = str(value or "").strip()
    if not text:
        return None
    for candidate in (text, text.replace("/", "-")):
        try:
            return datetime.fromisoformat(candidate.replace("Z", "+00:00"))
        except ValueError:
            pass
        try:
            return datetime.strptime(candidate[:19], "%Y-%m-%d %H:%M:%S")
        except ValueError:
            pass
    return None


def next_jst_slot(hour, minute):
    jst = timezone(timedelta(hours=9))
    now = datetime.now(jst).replace(tzinfo=None)
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return target


def active_campaign_info(item, required_at=None):
    campaigns = item.get("campaign") or []
    if isinstance(campaigns, dict):
        campaigns = [campaigns]
    now = datetime.now(timezone(timedelta(hours=9))).replace(tzinfo=None)
    for campaign in campaigns:
        if not isinstance(campaign, dict):
            continue
        begin = parse_dmm_datetime(campaign.get("date_begin"))
        end = parse_dmm_datetime(campaign.get("date_end"))
        if begin is not None and begin.tzinfo is not None:
            begin = begin.astimezone(timezone(timedelta(hours=9))).replace(tzinfo=None)
        if end is not None and end.tzinfo is not None:
            end = end.astimezone(timezone(timedelta(hours=9))).replace(tzinfo=None)
        active_now = (begin is None or begin <= now) and (end is None or now <= end)
        covers_post = required_at is None or end is None or required_at <= end
        if active_now and covers_post:
            return {
                "active": True,
                "title": str(campaign.get("title") or "").strip(),
                "date_begin": begin.isoformat(sep=" ") if begin else "",
                "date_end": end.isoformat(sep=" ") if end else "",
            }
    return {"active": False, "title": "", "date_begin": "", "date_end": ""}


def active_campaign(item, required_at=None):
    return bool(active_campaign_info(item, required_at=required_at).get("active"))


def recent_release(item, days=14):
    released = parse_dmm_datetime(item.get("date"))
    if released is None:
        return False
    if released.tzinfo is not None:
        released = released.astimezone(timezone(timedelta(hours=9))).replace(tzinfo=None)
    now = datetime.now(timezone(timedelta(hours=9))).replace(tzinfo=None)
    delta = now - released
    return timedelta(0) <= delta <= timedelta(days=days)


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


def eligible_candidates(items, used_ids, source_sort, campaign_required_at=None):
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
        # The account persona is a mature-wife curator; the product itself does
        # not need to be in the 人妻/熟女 genre. Requiring those keywords was
        # over-constraining the pool and causing unknown-performer selections.
        average, review_count = review_values(item)
        actress_name, actress_popularity_score, actress_names = actress_signal(item)
        campaign_info = active_campaign_info(item, required_at=campaign_required_at)
        candidates.append({
            "item": item,
            "position": position + 1,
            "source_sort": source_sort,
            "content_id": content_id,
            "title": title,
            "affiliate_url": affiliate_url,
            "price": price_value(item),
            "list_price": list_price_value(item),
            "discount_pct": discount_percent(item),
            "image_url": main_image_url(item),
            "campaign_active": bool(campaign_info.get("active")),
            "campaign_title": campaign_info.get("title") or "",
            "campaign_end": campaign_info.get("date_end") or "",
            "recent_release": recent_release(item),
            "review_average": average,
            "review_count": review_count,
            "actress_name": actress_name,
            "actress_names": actress_names,
            "actress_popularity_score": actress_popularity_score,
        })
    return candidates


def choose_conversion_candidate(candidates, campaign_focus=False):
    # Demand-first selector:
    # 1) current FANZA rank/review evidence
    # 2) recognized actress
    # 3) review depth / rating
    # 4) discount and price
    # This prevents a cheap but weak-demand title from beating a proven title.
    cohort = candidates[:50]
    if not cohort:
        return None

    def has_demand(c):
        source = c.get("source_sort")
        pos = int(c.get("position") or 999)
        review_count = int(c.get("review_count") or 0)
        actress_score = float(c.get("actress_popularity_score") or 0)

        if source == "rank" and pos <= 30:
            return True
        if source == "review" and pos <= 30 and review_count >= 10:
            return True
        if actress_score >= KNOWN_ACTRESS_SCORE_THRESHOLD and pos <= 40:
            return True
        return False

    demand_pool = [c for c in cohort if has_demand(c)]
    if not demand_pool:
        return None

    campaign_pool = [c for c in demand_pool if c.get("campaign_active")]
    if campaign_focus and campaign_pool:
        demand_pool = campaign_pool

    known = [
        c for c in demand_pool
        if (c.get("actress_popularity_score") or 0) >= KNOWN_ACTRESS_SCORE_THRESHOLD
    ]
    pool = known if known else demand_pool
    using_known_pool = bool(known)

    def score(c):
        source = c.get("source_sort")
        pos = int(c.get("position") or 999)
        discount = int(c.get("discount_pct") or 0)
        actress_score = float(c.get("actress_popularity_score") or 0)
        review_average = float(c.get("review_average") or 0)
        review_count = int(c.get("review_count") or 0)

        if source == "rank" and pos <= 10:
            demand_tier = 0
        elif source == "rank" and pos <= 30:
            demand_tier = 1
        elif source == "review" and pos <= 10 and review_count >= 20:
            demand_tier = 1
        else:
            demand_tier = 2

        if actress_score >= 500:
            actress_tier = 0
        elif actress_score >= 300:
            actress_tier = 1
        elif actress_score >= KNOWN_ACTRESS_SCORE_THRESHOLD:
            actress_tier = 2
        else:
            actress_tier = 3

        if review_count >= 50 and review_average >= 4.5:
            proof_tier = 0
        elif review_count >= 10 and review_average >= 4.0:
            proof_tier = 1
        else:
            proof_tier = 2

        if discount >= 30:
            value_tier = 0
        elif discount >= 10:
            value_tier = 1
        else:
            value_tier = 2

        return (
            demand_tier,
            actress_tier,
            proof_tier,
            pos,
            -actress_score,
            -review_count,
            -review_average,
            value_tier,
            -discount,
            c["price"] is None,
            c["price"] if c["price"] is not None else 10**12,
        )

    chosen = min(pool, key=score)
    chosen["known_actress_pool_used"] = using_known_pool
    chosen["demand_gate_passed"] = True
    return chosen


def choose_product(used_ids, preferred_sort, *, campaign_focus=False, required_at=None):
    # Actress-first conversion strategy:
    # the mature-wife account persona curates mainstream/popular performers.
    # Product genre is not forced to 人妻/熟女; recognition, current rank,
    # price/discount and review strength determine the pick.
    # Newness alone is not enough. Only rank/review sources are used.
    if required_at is not None:
        if required_at.tzinfo is not None:
            campaign_required_at = required_at.astimezone(
                timezone(timedelta(hours=9))
            ).replace(tzinfo=None)
        else:
            campaign_required_at = required_at
    else:
        campaign_required_at = (
            next_jst_slot(21, 30) if campaign_focus else next_jst_slot(23, 30)
        )
    orders = [preferred_sort, "rank" if preferred_sort != "rank" else "review"]
    seen_orders = []
    for sort_order in orders:
        if sort_order in seen_orders:
            continue
        seen_orders.append(sort_order)
        candidates = eligible_candidates(
            dmm_items(sort_order), used_ids, sort_order,
            campaign_required_at=campaign_required_at,
        )
        chosen = choose_conversion_candidate(candidates, campaign_focus=campaign_focus)
        if chosen:
            item = chosen["item"]
            return (
                chosen["content_id"],
                chosen["title"],
                chosen["affiliate_url"],
                sort_order,
                product_facts(item, chosen.get("actress_name") or ""),
                {
                    "price": chosen["price"],
                    "list_price": chosen["list_price"],
                    "discount_pct": chosen["discount_pct"],
                    "review_average": chosen["review_average"],
                    "review_count": chosen["review_count"],
                    "image_url": chosen["image_url"],
                    "campaign_active": bool(chosen.get("campaign_active")),
                    "campaign_title": chosen.get("campaign_title") or "",
                    "campaign_end": chosen.get("campaign_end") or "",
                    "recent_release": bool(chosen.get("recent_release")),
                    "actress_name": chosen.get("actress_name") or "",
                    "actress_names": chosen.get("actress_names") or [],
                    "actress_popularity_score": chosen.get("actress_popularity_score") or 0,
                    "known_actress_pool_used": bool(chosen.get("known_actress_pool_used")),
                    "demand_gate_passed": bool(chosen.get("demand_gate_passed")),
                    "source_position": chosen.get("position"),
                    "source_sort": chosen.get("source_sort"),
                },
            )
    raise RuntimeError("No eligible unpublished DMM product was found")


def create_post(text, channel_id, *, due_at, first_reply=None, image_url=None):
    image_url = str(image_url or "").strip() if ENABLE_DMM_MEDIA else ""
    top_assets = ""
    metadata = ""

    if first_reply:
        root_assets = ""
        if image_url:
            root_assets = ", assets: [{ image: { url: " + esc(image_url) + " } }]"
        metadata = (
            ", metadata: { twitter: { thread: ["
            + "{ text: " + esc(text) + root_assets + " }, "
            + "{ text: " + esc(first_reply) + " }"
            + "] } }"
        )
    elif image_url:
        top_assets = ", assets: [{ image: { url: " + esc(image_url) + " } }]"

    if due_at.tzinfo is None:
        raise RuntimeError("DMM X due_at must be timezone-aware")
    due_at_utc = due_at.astimezone(timezone.utc)
    if due_at_utc <= datetime.now(timezone.utc):
        raise RuntimeError("Refusing to schedule a DMM X post in the past")
    due_at_iso = due_at_utc.isoformat(timespec="milliseconds").replace("+00:00", "Z")

    mutation = """mutation {
      createPost(input: {
        text: %s,
        channelId: %s,
        schedulingType: automatic,
        mode: customScheduled,
        dueAt: %s
        %s
        %s
      }) {
        ... on PostActionSuccess { post { id text dueAt assets { id mimeType } } }
        ... on MutationError { message }
      }
    }""" % (esc(text), esc(channel_id), esc(due_at_iso), top_assets, metadata)
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


def queue_engagement(state, channel_id, due_at):
    index = int(state.get("engagement_index", 0)) % len(ENGAGEMENT_POSTS)
    post = create_post(ENGAGEMENT_POSTS[index], channel_id, due_at=due_at)
    state["engagement_index"] = index + 1
    remember(state, post, kind="engagement", template_index=index)
    return "engagement", post


def queue_affiliate(
    state, channel_id, preferred_sort, *, due_at, first_reply=False, campaign_focus=False
):
    used_ids = set(str(value) for value in state.get("used_content_ids", []))
    content_id, title, affiliate_url, actual_sort, facts, meta = choose_product(
        used_ids, preferred_sort, campaign_focus=campaign_focus, required_at=due_at
    )

    if first_reply:
        # Live Buffer audit on 2026-09-27 showed the first-reply cohort at
        # 0 clicks / 134 impressions (6 posts) versus direct-link cohort at
        # 2 clicks / 211 impressions (6 posts). Preserve the discovery copy
        # and product-selection logic, but move the affiliate URL into the
        # lead post so only link placement changes in the next test window.
        format_name = "discovery"
        index = int(state.get("discovery_template_index", 0)) % len(DISCOVERY_TEMPLATES)
        campaign_note = ""
        if meta.get("campaign_active"):
            campaign_title = str(meta.get("campaign_title") or "").strip()
            campaign_end = str(meta.get("campaign_end") or "").strip()
            end_label = campaign_end[:10] if campaign_end else ""
            if end_label:
                campaign_note = f"\nFANZA公式キャンペーン対象（{end_label}まで）"
            else:
                campaign_note = "\nFANZA公式キャンペーン対象"
        lead_text = build_discovery_text(
            index, title, actual_sort, affiliate_url, facts + campaign_note
        )
        post = create_post(
            lead_text,
            channel_id,
            due_at=due_at,
            image_url=meta.get("image_url"),
        )
        state["discovery_template_index"] = index + 1
        link_mode = "direct"
    else:
        format_name = "decision"
        index = int(state.get("decision_template_index", 0)) % len(DECISION_TEMPLATES)
        text = build_decision_text(index, title, actual_sort, affiliate_url, facts, meta)
        post = create_post(
            text, channel_id, due_at=due_at, image_url=meta.get("image_url")
        )
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
    state["post_history"][-1]["campaign_active"] = bool(meta.get("campaign_active"))
    state["post_history"][-1]["campaign_title"] = meta.get("campaign_title") or ""
    state["post_history"][-1]["campaign_end"] = meta.get("campaign_end") or ""
    state["post_history"][-1]["campaign_focus"] = bool(campaign_focus)
    state["post_history"][-1]["recent_release"] = bool(meta.get("recent_release"))
    state["post_history"][-1]["actress_name"] = meta.get("actress_name") or ""
    state["post_history"][-1]["actress_popularity_score"] = meta.get("actress_popularity_score") or 0
    state["post_history"][-1]["known_actress_pool_used"] = bool(meta.get("known_actress_pool_used"))
    state["post_history"][-1]["demand_gate_passed"] = bool(meta.get("demand_gate_passed"))
    state["post_history"][-1]["source_position"] = meta.get("source_position")
    state["post_history"][-1]["source_sort"] = meta.get("source_sort")
    state["post_history"][-1]["media_enabled"] = bool(ENABLE_DMM_MEDIA and meta.get("image_url"))
    state["content_strategy_version"] = "real-selection-v7-campaign-demand-first"
    return f"affiliate/{format_name}/{actual_sort}/{link_mode}", post


def persist_state(state):
    STATE_PATH.write_text(
        json.dumps(state, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main():
    state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    channel_id, live_posts = find_x_channel()

    # Idempotent daily batch:
    # before creating anything, recover today's existing Buffer IDs by their
    # fixed queue slots. This prevents duplicates when external creation
    # succeeded but the previous state push did not.
    jst = timezone(timedelta(hours=9))
    batch_date = datetime.now(jst).date().isoformat()
    if state.get("batch_date") != batch_date:
        state["batch_date"] = batch_date
        state["batch_slots"] = {}

    recovered = recover_existing_batch(state, live_posts, batch_date)
    persist_state(state)
    for item in recovered:
        print(
            f"Recovered existing {item['slot']} post "
            f"{item['id']} ({item['status']}) for {batch_date}"
        )

    slots = state.setdefault("batch_slots", {})
    due_slots = batch_due_slots(batch_date)
    now_jst = datetime.now(jst)
    queued = []

    if not slots.get("engagement") and due_slots["engagement"] > now_jst:
        label, post = queue_engagement(state, channel_id, due_slots["engagement"])
        slots["engagement"] = {
            "buffer_post_id": post.get("id"),
            "due_at": post.get("dueAt"),
        }
        persist_state(state)
        queued.append((label, post))
    elif slots.get("engagement"):
        print("Skip engagement: already queued for this JST date")
    else:
        print("Skip engagement: fixed 12:30 JST slot already passed")

    if not slots.get("rank_first_reply") and due_slots["rank_first_reply"] > now_jst:
        label, post = queue_affiliate(
            state,
            channel_id,
            "rank",
            due_at=due_slots["rank_first_reply"],
            first_reply=True,
            campaign_focus=True,
        )
        slots["rank_first_reply"] = {
            "buffer_post_id": post.get("id"),
            "due_at": post.get("dueAt"),
        }
        persist_state(state)
        queued.append((label, post))
    elif slots.get("rank_first_reply"):
        print("Skip rank_first_reply: already queued for this JST date")
    else:
        print("Skip rank_first_reply: fixed 21:30 JST slot already passed")

    if not slots.get("review_direct") and due_slots["review_direct"] > now_jst:
        label, post = queue_affiliate(
            state,
            channel_id,
            "review",
            due_at=due_slots["review_direct"],
            first_reply=False,
        )
        slots["review_direct"] = {
            "buffer_post_id": post.get("id"),
            "due_at": post.get("dueAt"),
        }
        persist_state(state)
        queued.append((label, post))
    elif slots.get("review_direct"):
        print("Skip review_direct: already queued for this JST date")
    else:
        print("Skip review_direct: fixed 23:30 JST slot already passed")

    state.pop("next_index", None)
    persist_state(state)

    state["last_run"] = {
        "status": "success",
        "at": datetime.now(timezone.utc).isoformat(),
        "batch_date": batch_date,
        "recovered_count": len(recovered),
        "created_count": len(queued),
    }
    persist_state(state)

    for label, post in queued:
        print(f"Queued {label} post for {post.get('dueAt')}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        try:
            failed_state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
            failed_state["last_run"] = {
                "status": "failed",
                "at": datetime.now(timezone.utc).isoformat(),
                "error": str(exc),
            }
            persist_state(failed_state)
        except Exception as state_exc:
            print(f"ERROR: failed to persist run status: {state_exc}", file=sys.stderr)
        sys.exit(1)
