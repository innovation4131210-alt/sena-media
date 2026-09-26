import { readFile, writeFile } from "node:fs/promises";

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
  if (data.posts?.pageInfo?.hasNextPage) throw new Error("Incomplete Buffer inventory; refusing mutation");
  return (data.posts?.edges ?? []).map(({node})=>node);
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

  for (const target of queue.posts.filter(p=>p.status==="pending")) {
    const found=existing.find(p=>sameTarget(p,target));
    if (!found) continue;
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
    const made=await createPost(target,channel);
    target.status="scheduled";
    target.bufferPostId=made.id;
    target.bufferDueAt=made.dueAt ?? target.dueAt;
    target.processedAt=new Date().toISOString();
    changed=true;
    scheduledCount+=1;

    existing=await inventory(channel);
    const readback=existing.find(p=>p.id===made.id);
    if (!readback || readback.status!=="scheduled" || readback.text!==target.text) {
      throw new Error(`Buffer readback failed: ${target.key}`);
    }
    if (queue.policy?.visualRequired===true && !(readback.assets??[]).some(a=>String(a.mimeType??"").startsWith("image/") || String(a.mimeType??"").startsWith("video/"))) {
      throw new Error(`Threads media readback failed: ${target.key}`);
    }
  }

  queue.updatedAt=new Date().toISOString();
  queue.lastRun={channelId:channel.id,channelName:channel.name,scheduledCount,verifiedAt:new Date().toISOString()};
  if (changed) await writeFile(QUEUE_FILE,JSON.stringify(queue,null,2)+"\n");
  console.log(JSON.stringify({ok:true,changed,...queue.lastRun},null,2));
}

main().catch(error=>{console.error(error.stack ?? error.message);process.exit(1);});
