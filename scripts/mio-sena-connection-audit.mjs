import {mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

// Diagnostics only: no Buffer mutations, no credential or caption output.
export const KNOWN_MIO_X_POST = '6aad59f2bce81a431d4ceabb';
export async function queryBuffer(key, query, variables = {}, transport = fetch) {
  if (!/^\s*query\b/.test(query) || /\bmutation\b/.test(query)) throw Error('Read-only query required');
  const response = await transport('https://api.buffer.com', {
    method: 'POST',
    headers: {Authorization: `Bearer ${key}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({query, variables}), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error(`Buffer HTTP ${response.status}`);
  const result = await response.json();
  if (result.errors?.length || !result.data) throw Error('Buffer GraphQL query failed');
  return result.data;
}
export function summarize(channel, connection) {
  if (!Array.isArray(connection.edges) || typeof connection.pageInfo?.hasNextPage !== 'boolean') throw Error('Incomplete response shape');
  const posts = connection.edges.map(({node}) => node);
  const counts = {};
  for (const post of posts) counts[post.status] = (counts[post.status] || 0) + 1;
  return {
    id: channel.id, name: channel.name, service: channel.service,
    isDisconnected: channel.isDisconnected, isLocked: channel.isLocked, isQueuePaused: channel.isQueuePaused,
    inventoryComplete: !connection.pageInfo.hasNextPage,
    knownMioXPostPresent: posts.some(post => post.id === KNOWN_MIO_X_POST),
    counts,
    posts: posts.map(post => ({
      id: post.id, status: post.status, dueAt: post.dueAt, sentAt: post.sentAt,
      externalLink: post.externalLink,
      textHash: createHash('sha256').update(post.text || '').digest('hex'),
    })),
  };
}
export async function audit(keyEntries, transport = fetch) {
  const report = {version: 1, checkedAt: new Date().toISOString(), readOnly: true, connections: [], mioXMatches: []};
  for (const [keyName, key] of keyEntries) {
    const entry = {keyName, credentialPresent: Boolean(key), channels: [], errors: []};
    report.connections.push(entry);
    if (!key) continue;
    try {
      const account = await queryBuffer(key, 'query { account { organizations { id } } }', {}, transport);
      if (!Array.isArray(account.account?.organizations)) throw Error('Organization response missing');
      for (const org of account.account.organizations) {
        const data = await queryBuffer(key, 'query($organizationId: OrganizationId!) { channels(input:{organizationId:$organizationId}) { id name service isDisconnected isLocked isQueuePaused } }', {organizationId: org.id}, transport);
        if (!Array.isArray(data.channels)) throw Error('Channel response missing');
        for (const channel of data.channels) {
          if (!['instagram','threads','twitter','x','tiktok'].includes(String(channel.service).toLowerCase())) continue;
          try {
            const data = await queryBuffer(key, 'query($organizationId: OrganizationId!, $channelId: ChannelId!) { posts(first:100,input:{organizationId:$organizationId,filter:{channelIds:[$channelId]}}) { edges { node { id text status dueAt sentAt externalLink } } pageInfo { hasNextPage } } }', {organizationId: org.id, channelId: channel.id}, transport);
            const summary = summarize(channel, data.posts);
            entry.channels.push(summary);
            if (summary.knownMioXPostPresent && ['twitter','x'].includes(String(channel.service).toLowerCase())) {
              report.mioXMatches.push({keyName, channelId: channel.id, name: channel.name, available: !channel.isDisconnected && !channel.isLocked && !channel.isQueuePaused, inventoryComplete: summary.inventoryComplete});
            }
          } catch (error) { entry.errors.push({channelId: channel.id, message: error.message}); }
        }
      }
    } catch (error) { entry.errors.push({message: error.message}); }
  }
  report.complete = report.connections.every(entry => entry.credentialPresent && entry.errors.length === 0 && entry.channels.every(channel => channel.inventoryComplete));
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await audit(['MIO_BUFFER_API_KEY','SENA_BUFFER_API_KEY'].map(name => [name, process.env[name]]));
  await mkdir('analytics', {recursive: true});
  await writeFile('analytics/mio-sena-connection-audit.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({checkedAt: report.checkedAt, complete: report.complete, mioXMatches: report.mioXMatches, connections: report.connections.map(({keyName, credentialPresent, channels, errors}) => ({keyName, credentialPresent, channels: channels.map(({posts, ...rest}) => rest), errors}))}, null, 2));
  if (!report.complete) process.exitCode = 1;
}
