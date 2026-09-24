import { readFile, writeFile } from "node:fs/promises";

const API_URL = "https://api.buffer.com";
const QUEUE_FILE = new URL("../automation/x-buffer/sena-queue.json", import.meta.url);

function normalize(value) {
  return String(value ?? "").trim().replace(/^@/, "").toLowerCase();
}

async function gql(query, variables = {}) {
  const key = process.env.X_BUFFER_API_KEY;
  if (!key) throw new Error("X_BUFFER_API_KEY is not configured");
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30000),
  });
  const raw = await response.text();
  let json;
  try { json = JSON.parse(raw); } catch {
    throw new Error(`Buffer returned non-JSON (${response.status}): ${raw.slice(0, 300)}`);
  }
  if (!response.ok || json.errors?.length || !json.data) {
    throw new Error(`Buffer API error: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.data;
}

async function resolveSenaChannel() {
  const account = await gql("query { account { organizations { id name } } }");
  const matches = [];
  for (const organization of account.account?.organizations ?? []) {
    const data = await gql(
      `query($organizationId: OrganizationId!) {
        channels(input: { organizationId: $organizationId }) {
          id name displayName service isQueuePaused isDisconnected isLocked
        }
      }`,
      { organizationId: organization.id },
    );
    for (const channel of data.channels ?? []) {
      if (!["twitter", "x"].includes(String(channel.service).toLowerCase())) continue;
      if (![channel.name, channel.displayName].some((v) => normalize(v) === "sena_ai_studio")) continue;
      matches.push({ ...channel, organizationId: organization.id });
    }
  }
  if (matches.length !== 1) throw new Error(`Expected exactly one @sena_ai_studio X channel; found ${matches.length}`);
  const channel = matches[0];
  if (channel.isDisconnected || channel.isLocked || channel.isQueuePaused) {
    throw new Error("@sena_ai_studio Buffer channel is unavailable");
  }
  return channel;
}

async function inventory(channel) {
  const data = await gql(
    `query($organizationId: OrganizationId!, $channelId: ChannelId!) {
      posts(first: 100, input: {
        organizationId: $organizationId
        filter: { channelIds: [$channelId] }
        sort: [{ field: dueAt, direction: asc }]
      }) {
        edges { node { id text status dueAt sentAt externalLink channelId } }
        pageInfo { hasNextPage }
      }
    }`,
    { organizationId: channel.organizationId, channelId: channel.id },
  );
  if (data.posts?.pageInfo?.hasNextPage) throw new Error("Buffer inventory is incomplete; refusing mutation");
  return (data.posts?.edges ?? []).map(({ node }) => node);
}

function sameTarget(post, target) {
  const when = Date.parse(post.dueAt ?? post.sentAt ?? "");
  return post.text === target.text &&
    Number.isFinite(when) &&
    Math.abs(when - Date.parse(target.dueAt)) <= 60_000;
}

async function verifyMedia(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: { Range: "bytes=0-64" },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok && response.status !== 206) throw new Error(`Media unavailable (${response.status}): ${url}`);
  const type = response.headers.get("content-type") ?? "";
  if (!type.startsWith("image/")) throw new Error(`Media is not an image (${type}): ${url}`);
}

async function createPost(target, channel) {
  await verifyMedia(target.mediaUrl);
  const data = await gql(
    `mutation($input: CreatePostInput!) {
      createPost(input: $input) {
        __typename
        ... on PostActionSuccess {
          post { id text status dueAt channelId assets { id mimeType } }
        }
        ... on MutationError { message }
      }
    }`,
    {
      input: {
        text: target.text,
        channelId: channel.id,
        dueAt: target.dueAt,
        schedulingType: "automatic",
        mode: "customScheduled",
        aiAssisted: true,
        assets: [{ image: { url: target.mediaUrl } }],
        needsApproval: false,
        saveToDraft: false,
      },
    },
  );
  if (!data.createPost?.post?.id) {
    throw new Error(data.createPost?.message ?? "Unknown Buffer createPost error");
  }
  return data.createPost.post;
}

async function main() {
  if (!process.env.X_BUFFER_API_KEY) {
    console.log("X_BUFFER_API_KEY not configured; clean no-op.");
    return;
  }

  const queue = JSON.parse(await readFile(QUEUE_FILE, "utf8"));
  if (queue.policy?.enabled === false) {
    console.log("SENA X automation disabled by policy.");
    return;
  }

  const channel = await resolveSenaChannel();
  let existing = await inventory(channel);
  let changed = false;

  for (const target of queue.posts.filter((p) => p.status === "pending")) {
    const found = existing.find((p) => sameTarget(p, target));
    if (!found) continue;
    target.status = found.status === "sent" ? "sent" : "scheduled";
    target.bufferPostId = found.id;
    target.bufferDueAt = found.dueAt ?? target.dueAt;
    target.externalLink = found.externalLink ?? null;
    target.recoveredAt = new Date().toISOString();
    changed = true;
  }

  const now = Date.now();
  const maxScheduled = Math.min(9, queue.policy?.maxScheduled ?? 9);
  let scheduledCount = existing.filter((p) => p.status === "scheduled").length;
  let created = 0;

  for (const target of queue.posts
    .filter((p) => p.status === "pending")
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))) {

    const due = Date.parse(target.dueAt);
    if (!Number.isFinite(due)) throw new Error(`Invalid dueAt: ${target.key}`);
    if (due <= now) {
      target.status = "expired_no_catchup";
      target.expiredAt = new Date().toISOString();
      changed = true;
      continue;
    }
    if (scheduledCount >= maxScheduled) break;

    const made = await createPost(target, channel);
    target.status = "scheduled";
    target.bufferPostId = made.id;
    target.bufferDueAt = made.dueAt ?? target.dueAt;
    target.processedAt = new Date().toISOString();
    scheduledCount += 1;
    created += 1;
    changed = true;

    existing = await inventory(channel);
    const readback = existing.find((p) => p.id === made.id);
    if (!readback || readback.status !== "scheduled" || readback.text !== target.text) {
      throw new Error(`Buffer readback failed: ${target.key}`);
    }
  }

  queue.updatedAt = new Date().toISOString();
  queue.lastRun = {
    channelId: channel.id,
    channelName: channel.name,
    scheduledCount,
    created,
    verifiedAt: new Date().toISOString(),
  };

  if (changed) await writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2) + "\n");
  console.log(JSON.stringify({ ok: true, changed, ...queue.lastRun }, null, 2));
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
