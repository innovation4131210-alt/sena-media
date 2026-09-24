import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const CHANNEL_ID = '6aa72524ea19ca0bde39313c';
export const HANDLE = 'sena.virtual.studio';
// Buffer Free is 10 per channel. Retain the existing one-slot safety margin.
export const SAFE_QUEUE_LIMIT = 9;
const statePath = 'automation/30day/sena-state.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sameTime = (a, b) => Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b);
const dayKey = value => new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 10);

export async function channelPosts(gql, channel, status) {
  if (!['scheduled', 'sent', 'error'].includes(status)) throw Error('Invalid inventory status');
  const data = await gql(`query($organizationId: OrganizationId!, $channelId: ChannelId!) {
    posts(first:100,input:{organizationId:$organizationId,filter:{status:[${status}],channelIds:[$channelId]}}) {
      edges { node { id channelId text dueAt status } }
      pageInfo { hasNextPage }
    }
  }`, {organizationId: channel.organizationId, channelId: channel.id});
  const result = data.posts;
  if (!Array.isArray(result?.edges) || result.pageInfo?.hasNextPage !== false) throw Error(`Incomplete ${status} listing; refusing to schedule`);
  const rows = result.edges.map(edge => edge.node);
  if (rows.some(row => !row?.id || row.channelId !== channel.id || row.status !== status)) throw Error('Channel-scoped inventory mismatch');
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw Error('Duplicate inventory IDs');
  return rows;
}
export function remainingCapacity(queued, channelId = CHANNEL_ID) {
  const target = queued.filter(post => post.channelId === channelId && post.status === 'scheduled');
  return Math.max(0, SAFE_QUEUE_LIMIT - target.length);
}
export function verifyReservation(rows, id, item, channelId = CHANNEL_ID) {
  const matches = rows.filter(post => post.id === id);
  if (matches.length !== 1 || matches[0].channelId !== channelId || matches[0].status !== 'scheduled' || matches[0].text !== item.caption || !sameTime(matches[0].dueAt, item.publishAt)) throw Error(`Buffer readback mismatch at D${item.day}`);
  if (rows.filter(post => post.dueAt && dayKey(post.dueAt) === item.date).length !== 1) throw Error(`Duplicate Buffer date at D${item.day}`);
  return matches[0];
}
export async function runRollingQueue({transport = fetch, env = process.env, clock = Date.now} = {}) {
  const key = env.BUFFER_API_KEY;
  if (!key) throw Error('SENA_BUFFER_API_KEY is not configured');
  const manifest = JSON.parse(await readFile('automation/30day/publishing-manifest.json', 'utf8'));
  async function readState(path, fallback) {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  }
  const state = await readState(statePath, {version: 2, scheduled: []});
  const legacy = await readState('automation/sena-month/state.json', {items: []});
  for (const old of legacy.items ?? []) if (!state.scheduled.some(post => post.day === old.day)) state.scheduled.push({...old, migratedFrom: 'sena-month'});
  const timestamp = () => new Date(clock()).toISOString();
  async function save() {
    await mkdir('automation/30day', {recursive: true});
    await writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
  }
  async function gql(query, variables = {}) {
    const response = await transport('https://api.buffer.com', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${key}`}, body: JSON.stringify({query, variables}), signal: AbortSignal.timeout(45000)});
    if (!response.ok) throw Error(`Buffer HTTP ${response.status}`);
    const result = await response.json();
    if (result.errors?.length || !result.data) throw Error('Buffer GraphQL operation failed');
    return result.data;
  }
  const account = await gql('query { account { organizations { id name } } }');
  const found = [];
  for (const org of account.account.organizations) {
    const data = await gql('query($organizationId: OrganizationId!) { channels(input:{organizationId:$organizationId}) { id name displayName service isQueuePaused isDisconnected isLocked } }', {organizationId: org.id});
    for (const channel of data.channels) if (String(channel.service).toLowerCase() === 'instagram' && [channel.name, channel.displayName].includes(HANDLE)) found.push({organizationId: org.id, ...channel});
  }
  if (found.length !== 1) throw Error('Expected exactly one SENA Instagram channel');
  const channel = found[0];
  if (channel.id !== CHANNEL_ID || channel.isDisconnected || channel.isLocked || channel.isQueuePaused) throw Error('SENA identity or publishability check failed');
  const queued = await channelPosts(gql, channel, 'scheduled');
  const sent = await channelPosts(gql, channel, 'sent');
  const failed = await channelPosts(gql, channel, 'error');
  const known = [...queued, ...sent, ...failed];
  state.version = 2;
  state.lastRunAt = timestamp();
  state.channel = {id: channel.id, name: channel.name, displayName: channel.displayName};
  if (Object.hasOwn(state, 'observedOrganizationScheduledCount')) {
    state.legacyOrganizationCountObservation = {count: state.observedOrganizationScheduledCount, note: 'Historical organization-wide count; never use for per-channel capacity.'};
    delete state.observedOrganizationScheduledCount;
  }
  state.observedChannelScheduledCount = queued.length;
  state.capacityScope = 'channel';
  state.safeQueueLimit = SAFE_QUEUE_LIMIT;
  state.createdThisRun = [];
  state.blocked = [];
  state.pendingCreates ??= [];
  let capacity = remainingCapacity(queued, channel.id);
  for (const item of manifest.sena) {
    if (item.account !== HANDLE || item.aiDisclosure !== true || item.qcStatus !== 'accepted') throw Error(`Invalid account/disclosure/QC at D${item.day}`);
    const recorded = state.scheduled.find(post => post.day === item.day);
    if (recorded) {
      const live = known.find(post => post.id === recorded.bufferPostId);
      if (live) recorded.lastObservedStatus = live.status;
      if (!live) state.blocked.push({day: item.day, bufferPostId: recorded.bufferPostId, reason: 'recorded_post_missing_from_api'});
      else if (live.status === 'error') state.blocked.push({day: item.day, bufferPostId: recorded.bufferPostId, reason: 'recorded_post_failed'});
      else if (live.text !== item.caption || !sameTime(live.dueAt, item.publishAt)) state.blocked.push({day: item.day, bufferPostId: recorded.bufferPostId, reason: 'recorded_post_content_or_time_drift'});
      else {
        recorded.verifiedAt = timestamp();
        state.pendingCreates = state.pendingCreates.filter(post => post.day !== item.day);
      }
      if (recorded.mediaSha256 && recorded.mediaSha256 !== item.sha256) throw Error(`Scheduled media changed at D${item.day}`);
      continue;
    }
    const matches = known.filter(post => post.text === item.caption);
    if (matches.length > 1) throw Error(`Multiple exact-caption posts at D${item.day}`);
    if (matches.length) {
      const post = matches[0];
      if (!sameTime(post.dueAt, item.publishAt)) throw Error(`Existing caption has different date at D${item.day}`);
      state.scheduled.push({day: item.day, bufferPostId: post.id, dueAt: post.dueAt, reconciled: true, lastObservedStatus: post.status, mediaVerification: 'requires API media verification; not recreated'});
      if (post.status === 'error') state.blocked.push({day: item.day, bufferPostId: post.id, reason: 'recorded_post_failed'});
      else state.pendingCreates = state.pendingCreates.filter(entry => entry.day !== item.day);
      await save();
      continue;
    }
    if (state.pendingCreates.some(post => post.day === item.day)) { state.blocked.push({day: item.day, reason: 'unresolved_create_attempt'}); continue; }
    if (known.some(post => post.dueAt && dayKey(post.dueAt) === item.date)) { state.blocked.push({day: item.day, reason: 'existing_post_on_tokyo_date'}); continue; }
    if (!capacity) continue;
    if (Date.parse(item.publishAt) <= clock() + 10 * 60 * 1000) { state.blocked.push({day: item.day, reason: 'past_or_imminent_slot'}); continue; }
    const expected = `media/sena-30day-2026-09-28/${item.filename}`;
    if (item.mediaPath !== expected || !/^SENA_\d{4}-\d{2}-\d{2}_D\d{2}\.jpeg$/.test(item.filename)) throw Error('Invalid exact media path');
    let bytes;
    try { bytes = await readFile(expected); }
    catch (error) { if (error.code === 'ENOENT') { state.blocked.push({day: item.day, reason: 'missing_exact_media'}); continue; } throw error; }
    if (hash(bytes) !== item.sha256) throw Error(`Local media mismatch at D${item.day}`);
    const ref = env.GITHUB_SHA || 'main';
    const url = `https://raw.githubusercontent.com/innovation4131210-alt/sena-media/${ref}/${expected}`;
    const response = await transport(url, {signal: AbortSignal.timeout(45000)});
    if (!response.ok) throw Error(`Media HTTP ${response.status} at D${item.day}`);
    if (hash(Buffer.from(await response.arrayBuffer())) !== item.sha256) throw Error(`Remote media mismatch at D${item.day}`);
    const dueAt = new Date(item.publishAt).toISOString();
    state.pendingCreates.push({day: item.day, dueAt, caption: item.caption, attemptedAt: timestamp()});
    await save();
    const data = await gql('mutation($input: CreatePostInput!) { createPost(input:$input) { __typename ... on PostActionSuccess { post { id text dueAt status } } ... on MutationError { message } } }', {
      input: {text: item.caption, channelId: channel.id, schedulingType: 'automatic', mode: 'customScheduled', dueAt, aiAssisted: true, assets: [{image: {url, metadata: {altText: 'SENA AI-generated lifestyle image'}}}], metadata: {instagram: {type: 'post', shouldShareToFeed: true, isAiGenerated: true}}}
    });
    const post = data.createPost?.post;
    if (!post?.id) throw Error('Buffer create returned no post ID; preserve pending intent');
    const entry = {day: item.day, date: item.date, bufferPostId: post.id, dueAt: post.dueAt, mediaUrl: url, mediaSha256: item.sha256, caption: item.caption, lastObservedStatus: 'created_unverified'};
    state.scheduled.push(entry);
    await save();
    const current = await channelPosts(gql, channel, 'scheduled');
    const observed = verifyReservation(current, post.id, item, channel.id);
    entry.lastObservedStatus = observed.status;
    entry.verifiedAt = timestamp();
    state.pendingCreates = state.pendingCreates.filter(attempt => attempt.day !== item.day);
    state.createdThisRun.push({day: item.day, id: post.id, dueAt: observed.dueAt, verifiedAt: entry.verifiedAt});
    known.push(observed);
    capacity = remainingCapacity(current, channel.id);
    await save();
  }
  state.lastVerifiedAt = timestamp();
  state.remainingChannelCapacity = capacity;
  await save();
  const result = {ok: state.blocked.length === 0, capacityScope: 'channel', safeQueueLimit: SAFE_QUEUE_LIMIT, scheduledBefore: queued.length, created: state.createdThisRun, remainingCapacity: capacity, blocked: state.blocked};
  console.log(JSON.stringify(result));
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runRollingQueue();
  if (!result.ok) process.exitCode = 2;
}
