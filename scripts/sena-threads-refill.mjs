import { readFile, writeFile } from "node:fs/promises";

const EXPECTED_CHANNEL_ID = "6ab75347ea19ca0bdef0d04a";
const API_URL = "https://api.buffer.com";
const QUEUE_FILE = new URL("../automation/sena-threads/queue.json", import.meta.url);

function normalize(value) {
  return String(value ?? "").trim().replace(/^@/, "").toLowerCase();
}

async function gql(query, variables = {}) {
  const key = process.env.SENA_BUFFER_API_KEY;
  if (!key) throw new Error("SENA_BUFFER_API_KEY is not configured");
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
      if (String(channel.service).toLowerCase() !== "threads") continue;
      if (![channel.name,channel.displayName].some(v=>normalize(v)==="sena.virtual.studio")) continue;
      matches.push({...channel,organizationId:organization.id});
    }
  }
  if (matches.length !== 1) throw new Error(`Expected exactly one @sena.virtual.studio Threads channel; found ${matches.length}`);
  const channel = matches[0];
  if (channel.id !== EXPECTED_CHANNEL_ID) throw new Error("Buffer channel identity mismatch");
  if (channel.isDisconnected || channel.isLocked || channel.isQueuePaused) throw new Error("@sena.virtual.studio Threads channel unavailable");
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

async function verifyMedia(url) {
  if (!url) throw new Error("SENA Threads visual post is missing mediaUrl");
  const r = await fetch(url,{method:"GET",headers:{Range:"bytes=0-64"},redirect:"follow",signal:AbortSignal.timeout(20000)});
  if (!r.ok && r.status!==206) throw new Error(`Media unavailable (${r.status}): ${url}`);
  const type=r.headers.get("content-type") ?? "";
  if (!type.startsWith("image/") && !type.startsWith("video/")) throw new Error(`Unsupported media type (${type})`);
  return type;
}

async function createPost(target,channel) {
  const mediaType=await verifyMedia(target.mediaUrl);
  const asset=mediaType.startsWith("video/") ? {video:{url:target.mediaUrl}} : {image:{url:target.mediaUrl}};
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

async function editPostText(postId,text) {
  const data = await gql(
    `mutation($input: EditPostInput!) {
      editPost(input:$input) {
        __typename
        ... on PostActionSuccess { post { id text status dueAt channelId assets { id mimeType } } }
        ... on MutationError { message }
      }
    }`,
    {input:{id:postId,text,aiAssisted:true}}
  );
  if (!data.editPost?.post?.id) throw new Error(data.editPost?.message ?? "Unknown Buffer editPost error");
  return data.editPost.post;
}

async function main() {
  const queue=JSON.parse(await readFile(QUEUE_FILE,"utf8"));
  if (queue.policy?.enabled !== true) {
    console.log("SENA Threads queue disabled; clean no-op.");
    return;
  }
  if (!process.env.SENA_BUFFER_API_KEY) {
    console.log("SENA_BUFFER_API_KEY missing; clean no-op.");
    return;
  }

  const channel=await resolveChannel();
  let existing=await inventory(channel);
  let changed=false;

  for (const target of queue.posts.filter(p=>p.status==="scheduled" && p.bufferPostId)) {
    let remote=existing.find(p=>p.id===target.bufferPostId);
    if (!remote) throw new Error(`Scheduled Buffer post missing: ${target.key}`);
    if (remote.status==="sent") {
      target.status="sent";
      target.externalLink=remote.externalLink ?? target.externalLink ?? null;
      target.sentAt=remote.sentAt ?? null;
      target.statusSyncedAt=new Date().toISOString();
      changed=true;
      continue;
    }
    if (remote.status!=="scheduled") throw new Error(`Unexpected Buffer status for ${target.key}: ${remote.status}`);
    const due=Date.parse(remote.dueAt ?? "");
    if (!Number.isFinite(due) || Math.abs(due-Date.parse(target.dueAt))>60000) throw new Error(`Buffer dueAt mismatch: ${target.key}`);
    if (remote.text!==target.text) {
      await editPostText(remote.id,target.text);
      existing=await inventory(channel);
      remote=existing.find(p=>p.id===target.bufferPostId);
      if (!remote || remote.status!=="scheduled" || remote.text!==target.text) throw new Error(`Buffer edit readback failed: ${target.key}`);
      if (queue.policy?.visualRequired===true && !(remote.assets??[]).some(a=>String(a.mimeType??"").startsWith("image/") || String(a.mimeType??"").startsWith("video/"))) {
        throw new Error(`Threads media lost after edit: ${target.key}`);
      }
      target.textReconciledAt=new Date().toISOString();
      changed=true;
    }
  }

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
    if (queue.policy?.visualRequired===true && !target.mediaUrl) {
      target.status="held_visual_required";
      target.holdReason="Every SENA Threads original post must include an approved image or video.";
      changed=true;
      continue;
    }
    if (existing.some(p => {
      const time = Date.parse(p.dueAt ?? p.sentAt ?? "");
      return Number.isFinite(time) && Math.abs(time - due) <= 60000;
    })) throw new Error(`Buffer dueAt already occupied: ${target.key}`);
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
      throw new Error(`Threads media readback failed: ${target.key}`);
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

