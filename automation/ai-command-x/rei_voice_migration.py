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
BASE = Path("automation/ai-command-x")
POSTS_PATH = BASE / "posts.json"
MARKER_PATH = BASE / "rei_voice_migration_done.json"

TARGETS = [
    {
        "content_id": "D01-AM",
        "slot": "2026-09-30T08:10+09:00",
        "old": "【今日の指令】\nAIに「考えて」で終わらせない。\n\n最後に1行だけ足す。\n「提案ではなく、今ある材料で完成物まで作ってください。」\n\n相談相手から実行役へ。",
        "new": "僕はレイ。AI司令室の実行担当。\nAIに「考えて」で止まらせない。\n\n最後に1行だけ足す。\n「提案ではなく、今ある材料で完成物まで作ってください。」\n\n提案で終わらせない。ここから実行する。",
    },
    {
        "content_id": "D01-NOON",
        "slot": "2026-09-30T12:20+09:00",
        "old": "【実行ログ】\nnoteの下書きをAIに任せる実験。\nブラウザ操作で保存が詰まったので、方法そのものを変更。\n\n目的は“ブラウザ操作の成功”ではなく、“下書きを作ること”。\n\n自動化は手段に執着しない方が強い。",
        "new": "【実行ログ】\nnoteの下書きをAIに任せた。\nブラウザ保存で詰まったので、手段そのものを変更。\n\n目的は「ブラウザ操作を成功させること」じゃない。\n「下書きを完成させること」。\n\n手段より、目的を優先する。",
    },
    {
        "content_id": "D01-PM",
        "slot": "2026-09-30T20:30+09:00",
        "old": "今日の作戦報告。\n\nAIにnote原稿を作らせる\n→WXRでインポート\n→共有用リンクで公開前QC\n→人間が最終公開\n\nこの流れまで確認できた。\n失敗した手順も含めて実行ログに残していく。",
        "new": "今日の実行ログ。\n\nAIにnote原稿を作らせる\n→ WXRでインポート\n→ 共有リンクで公開前QC\n→ 人間が最終公開\n\nここまでは確認できた。\n失敗した手順も残す。次に同じ場所で止まらないために。",
    },
    {
        "content_id": "D02-AM",
        "slot": "2026-10-01T08:10+09:00",
        "old": "【今日の指令】\nAIの「完了しました」を、そのまま信用しない。\n\n文章→本文を見る\nファイル→実物を開く\n設定→反映を確認\n自動化→実行ログを見る\n\n“言った”ではなく“確認できた”で完了。",
        "new": "AIの「完了しました」は、僕は完了扱いにしない。\n\n文章 → 本文を見る\nファイル → 実物を開く\n設定 → 反映を確認\n自動化 → 実行ログを見る\n\n「言った」ではなく、「確認できた」で完了。",
    },
    {
        "content_id": "D02-NOON",
        "slot": "2026-10-01T12:20+09:00",
        "old": "AIへの依頼で削れる往復は多い。\n\n×「どうすればいい？」\n○「何を作るか」\n○「完成条件は何か」\n○「何を勝手に決めてはいけないか」\n\n長いプロンプトより、この3つの方が効くことが多い。",
        "new": "AIとの往復を減らすなら、最初に3つだけ決める。\n\n・何を作るか\n・完成条件は何か\n・何を勝手に変えてはいけないか\n\n長いプロンプトより、ここが曖昧じゃない方が進む。",
    },
    {
        "content_id": "D02-PM",
        "slot": "2026-10-01T20:30+09:00",
        "old": "ChatGPTを「相談相手」で終わらせず、調査→制作→修正→確認まで進めるための指示文を7場面に分けました。\n\n通常500円。Xで拡散すると100円。\nhttps://note.com/ai_command/n/n7b74f56a03dc",
        "new": "AI司令室で使っている指示を、7つの場面に分けてまとめた。\n\n調査 → 制作 → 修正 → 確認まで、AIを「相談相手」で終わらせないための実務用。\n\n通常500円。Xで拡散すると100円。\nhttps://note.com/ai_command/n/n7b74f56a03dc",
    },
    {
        "content_id": "D03-AM",
        "slot": "2026-10-02T08:10+09:00",
        "old": "【今日の指令】\nAIが質問ばかりして止まるなら、\n「質問するな」ではなく、\n\n“成果物を大きく変える質問だけ1つに絞る”\n\nこれでかなり進みやすくなる。",
        "new": "AIが質問ばかりして止まるなら、僕は「質問するな」とは言わない。\n\n「成果物を大きく変える質問だけ、1つに絞ってください。」\n\n確認は必要。\nでも、確認ループで仕事を止めない。",
    },
    {
        "content_id": "D03-NOON",
        "slot": "2026-10-02T12:20+09:00",
        "old": "【司令室メモ】\n自動化したい作業ほど、最初に“完了条件”を決める。\n\nボタンを押した→未完了\n設定を書いた→未完了\nコードを作った→未完了\n\n目的の結果が確認できて初めて完了。",
        "new": "【司令室メモ】\n自動化は「設定した」で終わりじゃない。\n\nボタンを押した → 未完了\n設定を書いた → 未完了\nコードを作った → 未完了\n\n目的の結果が確認できて、初めて完了。",
    },
    {
        "content_id": "D03-PM",
        "slot": "2026-10-02T20:30+09:00",
        "old": "AIに任せたのに、結局自分でやり直した作業ってありますか？\n\n文章作成 / 調査 / 資料 / SNS / 自動化 / その他\n\nその“止まる場所”を、AI司令室で順番に潰していきます。",
        "new": "AIに任せたのに、結局自分でやり直した作業ってありますか？\n\n文章 / 調査 / 資料 / SNS / 自動化 / その他\n\nその「止まる場所」を、AI司令室で1つずつ検証していく。\n失敗 → 原因 → 修正 → 結果まで残します。",
    },
]


def gql(query: str):
    key = os.environ["BUFFER_API_KEY"]
    req = urllib.request.Request(
        API,
        data=json.dumps({"query": query}).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=45) as r:
        payload = json.loads(r.read().decode("utf-8"))
    if payload.get("errors"):
        raise RuntimeError(payload["errors"])
    return payload["data"]


def qstr(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def select_twitter_channel():
    orgs = gql("query GetOrganizations { account { organizations { id name } } }")["account"]["organizations"]
    candidates = []
    for org in orgs:
        query = f'''query GetChannels {{ channels(input: {{ organizationId: {qstr(org["id"])} }}) {{ id name service }} }}'''
        for ch in gql(query)["channels"]:
            if ch["service"] != "twitter":
                continue
            candidates.append((org, ch))
            hay = (ch.get("name") or "").lower().replace("@", "")
            if CHANNEL_HINT in hay:
                return org, ch
    if len(candidates) == 1:
        return candidates[0]
    names = [f'{o["name"]}: {c["name"]} ({c["id"]})' for o, c in candidates]
    raise RuntimeError("Target X channel was not uniquely resolved. " + ", ".join(names))


def get_scheduled(org_id: str, channel_id: str):
    query = f'''
    query ScheduledPosts {{
      posts(first: 100, input: {{
        organizationId: {qstr(org_id)}
        filter: {{ status: [scheduled], channelIds: [{qstr(channel_id)}] }}
        sort: {{ field: dueAt, direction: asc }}
      }}) {{ edges {{ node {{ id text status dueAt channelId }} }} }}
    }}
    '''
    return [e["node"] for e in gql(query)["posts"]["edges"]]


def edit_text(post_id: str, text: str):
    query = f'''
    mutation EditPost {{
      editPost(input: {{ id: {qstr(post_id)}, text: {qstr(text)} }}) {{
        ... on PostActionSuccess {{ post {{ id text dueAt status }} }}
        ... on MutationError {{ message }}
      }}
    }}
    '''
    result = gql(query)["editPost"]
    if result.get("message") and not result.get("post"):
        raise RuntimeError(result["message"])
    return result["post"]


def parse_due(value: str):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(JST)


def slot_key(value: str):
    return datetime.fromisoformat(value).astimezone(JST).isoformat(timespec="minutes")


def update_source_of_truth():
    posts = json.loads(POSTS_PATH.read_text(encoding="utf-8"))
    by_id = {p["id"]: p for p in posts}
    for target in TARGETS:
        item = by_id.get(target["content_id"])
        if not item:
            raise RuntimeError(f'Missing content ID {target["content_id"]} in posts.json')
        if item["text"] not in (target["old"], target["new"]):
            raise RuntimeError(f'Unexpected Source of Truth text for {target["content_id"]}')
        item["text"] = target["new"]
    POSTS_PATH.write_text(json.dumps(posts, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    if MARKER_PATH.exists():
        print("R.E.I. voice migration already completed; nothing to do.")
        return

    org, channel = select_twitter_channel()
    print(f"Organization: {org['name']} ({org['id']})")
    print(f"Target channel: {channel['name']} ({channel['id']})")

    scheduled = get_scheduled(org["id"], channel["id"])
    by_slot = {p["dueAt"]: p for p in scheduled}
    target_pairs = []

    for target in TARGETS:
        target_dt = datetime.fromisoformat(target["slot"]).astimezone(timezone.utc)
        due_utc = target_dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        post = by_slot.get(due_utc)
        if not post:
            raise RuntimeError(f'Missing scheduled post at {target["slot"]}')
        if post.get("channelId") != channel["id"]:
            raise RuntimeError(f'Wrong channel at {target["slot"]}')
        if post.get("text") not in (target["old"], target["new"]):
            raise RuntimeError(f'Unexpected text at {target["slot"]}; refusing to overwrite')
        target_pairs.append((target, post))

    if len(target_pairs) != 9:
        raise RuntimeError(f"Expected 9 target posts, resolved {len(target_pairs)}")

    changed = 0
    for target, post in target_pairs:
        if post.get("text") == target["new"]:
            print(f'Already migrated: {target["content_id"]} {target["slot"]}')
            continue
        result = edit_text(post["id"], target["new"])
        print(f'Updated {target["content_id"]}: post={result["id"]} dueAt={result["dueAt"]}')
        changed += 1

    verified = get_scheduled(org["id"], channel["id"])
    verified_by_due = {p["dueAt"]: p for p in verified}
    for target in TARGETS:
        target_dt = datetime.fromisoformat(target["slot"]).astimezone(timezone.utc)
        due_utc = target_dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        post = verified_by_due.get(due_utc)
        if not post or post.get("text") != target["new"]:
            raise RuntimeError(f'Post-verification failed at {target["slot"]}')

    update_source_of_truth()
    MARKER_PATH.write_text(
        json.dumps(
            {
                "completedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "channel": channel["name"],
                "channelId": channel["id"],
                "updatedCount": changed,
                "verifiedCount": 9,
                "slots": [t["slot"] for t in TARGETS],
            },
            ensure_ascii=False,
            indent=2,
        ) + "\n",
        encoding="utf-8",
    )
    print(f"SUCCESS: R.E.I. voice migration verified for all 9 posts; changed={changed}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
