#!/usr/bin/env python3
import json, os, sys, urllib.request
from datetime import datetime, timezone

API="https://api.buffer.com"
CHANNEL_HINT="ai_command_jp"
DUE_UTC="2026-10-02T23:10:00.000Z"
OLD="""【今日の指令】
「いい感じにして」は禁止。

完成物：SNS文1本
長さ：100字以内
変えない事実：日時は未定
公開：しない

合否が見える依頼にすると、修正が速い。"""
NEW="""【今日の指令】
僕は『いい感じにして』では頼まない。

完成物：SNS文1本
長さ：100字以内
変えない事実：日時は未定
公開：しない

合否が見える条件まで渡す。修正はその方が速い。"""

def gql(query):
    req=urllib.request.Request(API,data=json.dumps({"query":query}).encode("utf-8"),
        headers={"Content-Type":"application/json","Authorization":f"Bearer {os.environ['BUFFER_API_KEY']}"},method="POST")
    with urllib.request.urlopen(req,timeout=45) as r:
        payload=json.loads(r.read().decode("utf-8"))
    if payload.get("errors"): raise RuntimeError(payload["errors"])
    return payload["data"]

def q(s): return json.dumps(s,ensure_ascii=False)

def target():
    orgs=gql("query { account { organizations { id name } } }")["account"]["organizations"]
    for org in orgs:
        channels=gql(f'query {{ channels(input: {{ organizationId: {q(org["id"])} }}) {{ id name service }} }}')["channels"]
        for ch in channels:
            if ch["service"]=="twitter" and CHANNEL_HINT in (ch.get("name") or "").lower().replace("@",""):
                return org,ch
    raise RuntimeError("AI Command X channel not found")

def scheduled(org_id,ch_id):
    query=f'''query {{
      posts(first:100,input:{{organizationId:{q(org_id)},filter:{{status:[scheduled],channelIds:[{q(ch_id)}]}},sort:{{field:dueAt,direction:asc}}}})
      {{ edges {{ node {{ id text dueAt status channelId }} }} }}
    }}'''
    return [e["node"] for e in gql(query)["posts"]["edges"]]

def edit(post_id):
    query=f'''mutation {{
      editPost(input:{{id:{q(post_id)},text:{q(NEW)}}}) {{
        ... on PostActionSuccess {{ post {{ id text dueAt status }} }}
        ... on MutationError {{ message }}
      }}
    }}'''
    r=gql(query)["editPost"]
    if r.get("message") and not r.get("post"): raise RuntimeError(r["message"])
    return r["post"]

def main():
    org,ch=target()
    posts=scheduled(org["id"],ch["id"])
    matches=[p for p in posts if p.get("dueAt")==DUE_UTC]
    if len(matches)!=1: raise RuntimeError(f"Expected one post at {DUE_UTC}, found {len(matches)}")
    p=matches[0]
    if p["text"] not in (OLD,NEW): raise RuntimeError("Unexpected D04-AM text; refusing overwrite")
    if p["text"]==OLD:
        edit(p["id"])
        print(f"Updated D04-AM post={p['id']} dueAt={p['dueAt']}")
    else:
        print("D04-AM already uses R.E.I. voice")
    verify=[x for x in scheduled(org["id"],ch["id"]) if x.get("dueAt")==DUE_UTC]
    if len(verify)!=1 or verify[0].get("text")!=NEW:
        raise RuntimeError("Verification failed")
    print(f"SUCCESS: verified D04-AM in Buffer. scheduled_count={len(posts)}")

if __name__=="__main__":
    try: main()
    except Exception as e:
        print(f"ERROR: {e}",file=sys.stderr); sys.exit(1)
