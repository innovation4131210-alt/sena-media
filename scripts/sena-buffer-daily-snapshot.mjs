import {mkdir, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export const SENA_CHANNEL_ID = '6aa72524ea19ca0bde39313c';
const HANDLE = 'sena.virtual.studio';

// Read-only collector: never create, edit, cancel, or retry a social post.
export async function queryBuffer(key, query, variables = {}, transport = fetch) {
  if (!/^\s*query\b/.test(query) || /\bmutation\b/.test(query)) throw Error('Read-only query required');
  const response = await transport('https://api.buffer.com', {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${key}`},
    body:JSON.stringify({query, variables}), signal:AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error(`Buffer HTTP ${response.status}`);
  const result = await response.json();
  if (result.errors?.length || !result.data) throw Error('Buffer GraphQL query failed');
  return result.data;
}

export function buildSnapshot(channel, data, now = new Date()) {
  if (channel.id !== SENA_CHANNEL_ID || String(channel.service).toLowerCase() !== 'instagram' ||
      ![channel.name, channel.displayName].includes(HANDLE)) throw Error('Exact SENA identity required');
  for (const flag of ['isDisconnected','isLocked','isQueuePaused']) {
    if (typeof channel[flag] !== 'boolean') throw Error(`Channel availability missing: ${flag}`);
  }
  const seen = new Set();
  const lists = {};
  for (const [name, expectedStatus] of [['sent','sent'],['failed','error'],['scheduled','scheduled']]) {
    const connection = data[name];
    if (!Array.isArray(connection?.edges) || connection.pageInfo?.hasNextPage !== false) {
      throw Error(`Incomplete ${name} inventory; do not declare complete or overwrite last-good snapshot`);
    }
    lists[name] = connection.edges.map(({node}) => {
      if (!node?.id || node.status !== expectedStatus || seen.has(node.id)) throw Error('Invalid or duplicate post identity');
      seen.add(node.id);
      return node; // Preserve API zeros and missing metrics exactly; never coerce null to zero.
    });
  }
  const tokyoDate = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  return {
    capturedAt:now.toISOString(), tokyoDate, readOnly:true, inventoryComplete:true,
    channel:{id:channel.id,name:channel.name,displayName:channel.displayName,
      isDisconnected:channel.isDisconnected,isLocked:channel.isLocked,isQueuePaused:channel.isQueuePaused},
    channelAvailable:!channel.isDisconnected && !channel.isLocked && !channel.isQueuePaused,
    ...lists,
  };
}

export async function collectSnapshot(key, transport = fetch, now = new Date()) {
  if (!key) throw Error('SENA_BUFFER_API_KEY is not configured');
  const account = await queryBuffer(key, 'query { account { organizations { id } } }', {}, transport);
  if (!Array.isArray(account.account?.organizations)) throw Error('Organization response missing');
  const matches = [];
  for (const org of account.account.organizations) {
    const data = await queryBuffer(key, 'query($organizationId: OrganizationId!) { channels(input:{organizationId:$organizationId}) { id name displayName service isQueuePaused isDisconnected isLocked } }', {organizationId:org.id}, transport);
    if (!Array.isArray(data.channels)) throw Error('Channel response missing');
    for (const channel of data.channels) {
      if (channel.id === SENA_CHANNEL_ID && String(channel.service).toLowerCase() === 'instagram' &&
          [channel.name,channel.displayName].includes(HANDLE)) matches.push({...channel,organizationId:org.id});
    }
  }
  if (matches.length !== 1) throw Error('Expected exactly one connected SENA channel');
  const channel = matches[0];
  const data = await queryBuffer(key, `query($organizationId: OrganizationId!, $channelId: ChannelId!) {
    sent: posts(first:100,input:{organizationId:$organizationId,filter:{status:[sent],channelIds:[$channelId]},sort:[{field:dueAt,direction:desc}]}) {
      edges { node { id text status dueAt sentAt externalLink metrics { type name value unit } metricsUpdatedAt } }
      pageInfo { hasNextPage }
    }
    failed: posts(first:100,input:{organizationId:$organizationId,filter:{status:[error],channelIds:[$channelId]},sort:[{field:dueAt,direction:desc}]}) {
      edges { node { id text status dueAt } } pageInfo { hasNextPage }
    }
    scheduled: posts(first:100,input:{organizationId:$organizationId,filter:{status:[scheduled],channelIds:[$channelId]},sort:[{field:dueAt,direction:asc}]}) {
      edges { node { id text status dueAt } } pageInfo { hasNextPage }
    }
  }`, {organizationId:channel.organizationId,channelId:channel.id}, transport);
  return buildSnapshot(channel, data, now);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const snapshot = await collectSnapshot(process.env.BUFFER_API_KEY);
  snapshot.workflowRunId = process.env.GITHUB_RUN_ID || null;
  await mkdir('analytics/sena-buffer-history', {recursive:true});
  const body = JSON.stringify(snapshot,null,2)+'\n';
  await writeFile('analytics/sena-buffer-latest.json',body);
  await writeFile(`analytics/sena-buffer-history/${snapshot.tokyoDate}.json`,body);
  console.log(JSON.stringify({ok:snapshot.channelAvailable && snapshot.failed.length===0,capturedAt:snapshot.capturedAt,
    inventoryComplete:snapshot.inventoryComplete,sent:snapshot.sent.length,failed:snapshot.failed.length,scheduled:snapshot.scheduled.length}));
  if (!snapshot.channelAvailable || snapshot.failed.length) process.exitCode=2;
}
