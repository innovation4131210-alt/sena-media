import { readFile, writeFile } from "node:fs/promises";

const EXPECTED_CHANNEL_ID = "6ab74779ea19ca0bdef024db";
const API_URL = "https://api.buffer.com";
const QUEUE_FILE = new URL("../automation/x-buffer/mio-queue.json", import.meta.url);

function normalize(value) {
  return String(value ?? "").trim().replace(/^@/, "").toLowerCase();
}

async function gql(query, variables = {}) {
  const key = process.env.X_BUFFER_API_KEY;
  if (!key) throw new Error("X_BUFFER_API_KEY is not configured");
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {"Content-Type":"application/json", Authorization:`Bearer ${key}`},
    body: JSON.stringify({query, variables}),
    signal: AbortSignal.timeout(30000),
  });
  const raw = await response.text();
  let json;
  try { json = JSON.parse(raw); } catch {
    throw new Error(`Buffer returned non-JSON (${response.status}): ${raw.slice(0,300)}`);
  }
  if (!response.ok || json.errors?.length || !json.data) {
    throw new Error(`Buffer API error: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.data;
}

async function resolveChannel() {
  const account = await gql("query { account { organizations { id name } } }");
  const matches = [];
  for (const organization of account.account?.organizations ?? []) {
    const data = await gql(
      `query($organizationId: OrganizationId!) {
        channels(input:{organizationId:$organizationId}) {
          id name displayName service isQueuePaused isDisconnected isLocked
        }
      }`,
      {organizationId:organization.id}
    );
    for (const channel of data.channels ?? []) {
      if (!["twitter","x"].includes(String(channel.service).toLowerCase())) continue;
      if (![channel.name,channel.displayName].some(v=>normalize(v)==="mio_ai_life_jp")) continue;
      matches.push({...channel,organizationId:organization.id});
    }
  }
  if (matches.length !== 1) throw new Error(`Expected exactly one @mio_ai_life_jp X channel; found ${matches.length}`);
  const channel = matches[0];
  if (channel.id !== EXPECTED_CHANNEL_ID) throw new Error("Buffer channel identity mismatch");
  if (channel.isDisconnected || channel.isLocked || channel.isQueuePaused) throw new Error("@mio_ai_life_jp Buffer channel unavailable");
  return channel;
}

async function inventory(channel) {
  const data = await gql(
    `query($organizationId: OrganizationId!, $channelId: ChannelId!) {
      posts(first:100,input:{
        organizationId:$organizationId,
        filter:{channelIds:[$channelId]},
        sort:[{field:dueAt,direction:asc}]
      }) {
        edges { node { id text status dueAt sentAt externalLink channelId assets { id mimeType } } }
        pageInfo { hasNextPage }
      }
    }`,
    {organizationId:channel.organizationId,channelId:channel.id}
  );
  const connection = data.posts;
  if (!Array.isArray(connection?.edges) || connection.pageInfo?.hasNextPage !== false) {
    throw new Error("Incomplete Buffer inventory; refusing mutation");
  }
  const rows = connection.edges.map(edge => edge?.node);
  if (rows.some(row => !row?.id || row.channelId !== channel.id || typeof row.status !== "string" || typeof row.text !== "string")) {
    throw new Error("Buffer inventory channel or shape mismatch");
  }
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("Duplicate Buffer inventory IDs");
  return rows;
}

function sameTarget(post,target) {
  const when=Date.parse(post.dueAt ?? post.sentAt ?? "");
  return post.text===target.text && Number.isFinite(when) && Math.abs(when-Date.parse(target.dueAt))<=60000;
}

function sameSlot(post,target) {
  const when=Date.parse(post.dueAt ?? post.sentAt ?? "");
  return Number.isFinite(when) && Math.abs(when-Date.parse(target.dueAt))<=60000;
}

async function verifyMedia(url) {
  if (!url) throw new Error("visualRequired post is missing mediaUrl");
  const response = await fetch(url, {
    method:"GET",
    headers:{Range:"bytes=0-64"},
    redirect:"follow",
    signal:AbortSignal.timeout(20000),
  });
  if (!response.ok && response.status!==206) throw new Error(`Media unavailable (${response.status}): ${url}`);
  const type=response.headers.get("content-type") ?? "";
  if (!type.startsWith("image/") && !type.startsWith("video/")) throw new Error(`Unsupported media type (${type})`);
  return type;
}

async function createPost(target,channel) {
  const mediaType=await verifyMedia(target.mediaUrl);
  const asset = mediaType.startsWith("video/")
    ? {video:{url:target.mediaUrl}}
    : {image:{url:target.mediaUrl}};
  const data = await gql(
    `mutation($input: CreatePostInput!) {
      createPost(input:$input) {
        __typename
        ... on PostActionSuccess { post { id text status dueAt channelId assets { id mimeType } } }
        ... on MutationError { message }
      }
    }`,
    {input:{
      text:target.text,
      channelId:channel.id,
      dueAt:target.dueAt,
      schedulingType:"automatic",
      mode:"customScheduled",
      aiAssisted:true,
      assets:[asset],
      needsApproval:false,
      saveToDraft:false
    }}
  );
  if (!data.createPost?.post?.id) throw new Error(data.createPost?.message ?? "Unknown Buffer createPost error");
  return data.createPost.post;
}

async function main() {
  const queue=JSON.parse(await readFile(QUEUE_FILE,"utf8"));
  if (queue.policy?.enabled !== true) {
    console.log("MIO X migration queue disabled; clean no-op.");
    return;
  }
  if (!process.env.X_BUFFER_API_KEY) {
    console.log("X_BUFFER_API_KEY missing; clean no-op.");
    return;
  }

  const channel=await resolveChannel();
  let existing=await inventory(channel);
  let changed=false;

  for (const target of queue.posts.filter(p => ["pending", "creating", "created_unverified"].includes(p.status))) {
    const matches = existing.filter(p => sameTarget(p, target));
    if (matches.length > 1) throw new Error(`Duplicate Buffer target: ${target.key}`);
    const found = matches[0];
    if (!found) {
      if (target.status !== "pending") throw new Error(`Unresolved Buffer create; manual reconciliation required: ${target.key}`);
      continue;
    }
    if (!["sent", "scheduled"].includes(found.status)) throw new Error(`Unexpected Buffer recovery status: ${target.key}: ${found.status}`);
    if (target.bufferPostId && target.bufferPostId !== found.id) throw new Error(`Buffer recovery ID mismatch: ${target.key}`);
    target.status=found.status==="sent"?"sent":"scheduled";
    target.bufferPostId=found.id;
    target.bufferDueAt=found.dueAt ?? target.dueAt;
    target.externalLink=found.externalLink ?? null;
    target.recoveredAt=new Date().toISOString();
    changed=true;
  }

  const now=Date.now();
  let scheduledCount=existing.filter(p=>p.status==="scheduled").length;
  const cap=Math.min(9,queue.policy?.maxScheduled ?? 9);

  for (const target of queue.posts.filter(p=>p.status==="pending").sort((a,b)=>Date.parse(a.dueAt)-Date.parse(b.dueAt))) {
    const due=Date.parse(target.dueAt);
    if (!Number.isFinite(due)) throw new Error(`Invalid dueAt: ${target.key}`);
    if (due<=now) {
      target.status="expired_no_catchup";
      target.expiredAt=new Date().toISOString();
      changed=true;
      continue;
    }
    if (scheduledCount>=cap) break;
    const occupied=existing.find(p=>sameSlot(p,target));
    if (occupied) {
      throw new Error(`MIO X dueAt already occupied by Buffer post ${occupied.id}: ${target.key}`);
    }
    if (queue.policy?.visualRequired===true && !target.mediaUrl) {
      target.status="held_visual_required";
      target.holdReason="Every MIO X original post must include an approved image or video.";
      changed=true;
      continue;
    }
    target.status = "creating";
    target.attemptedAt = new Date().toISOString();
    await writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2) + "\n");
    const made = await createPost(target, channel);
    target.status = "created_unverified";
    target.bufferPostId=made.id;
    target.bufferDueAt=made.dueAt ?? target.dueAt;
    target.processedAt=new Date().toISOString();
    changed=true;
    scheduledCount+=1;

    await writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2) + "\n");
    existing=await inventory(channel);
    const readback=existing.find(p=>p.id===made.id);
    if (!readback || readback.status!=="scheduled" || readback.text!==target.text || Date.parse(readback.dueAt)!==Date.parse(target.dueAt)) {
      throw new Error(`Buffer readback failed: ${target.key}`);
    }
    if (queue.policy?.visualRequired===true && !(readback.assets??[]).some(a=>String(a.mimeType??"").startsWith("image/") || String(a.mimeType??"").startsWith("video/"))) {
      throw new Error(`Visual asset readback failed: ${target.key}`);
    }
    target.status = "scheduled";
    await writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2) + "\n");
  }

  queue.updatedAt=new Date().toISOString();
  queue.lastRun={channelId:channel.id,channelName:channel.name,scheduledCount,verifiedAt:new Date().toISOString()};
  if (changed) await writeFile(QUEUE_FILE,JSON.stringify(queue,null,2)+"\n");
  console.log(JSON.stringify({ok:true,changed,...queue.lastRun},null,2));
}

main().catch(error=>{console.error(error.stack ?? error.message);process.exit(1);});

