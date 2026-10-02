import {mkdir, readFile, writeFile} from 'node:fs/promises';

const API_URL = 'https://api.buffer.com';
const KEY = process.env.DMM_BUFFER_API_KEY || '';
const TARGET = 'ero_mimimimi';
const STATE_PATH = 'automation/dmm-x/state.json';
const OUT_PATH = 'analytics/dmm-x-live-audit.json';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function gql(query, variables = {}) {
  if (!KEY) throw new Error('DMM_BUFFER_API_KEY is not configured');
  if (!/^\s*query\b/.test(query) || /\bmutation\b/.test(query)) throw new Error('Read-only query required');

  const fallbackDelays = [2000, 5000, 10000];
  let lastStatus = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${KEY}`},
      body: JSON.stringify({query, variables}),
      signal: AbortSignal.timeout(30000),
    });
    lastStatus = res.status;

    let json = {};
    try {
      json = await res.json();
    } catch {
      json = {};
    }

    if (res.ok && !json.errors?.length && json.data) {
      return json.data;
    }

    if (![429, 500, 502, 503, 504].includes(res.status)) {
      throw new Error(`Buffer query failed: ${res.status}`);
    }
    if (attempt >= 3) break;

    let waitMs = fallbackDelays[attempt];
    if (res.status === 429) {
      const raw = Number(res.headers.get('retry-after'));
      if (Number.isFinite(raw) && raw > 0) {
        waitMs = Math.min(90000, Math.max(1000, Math.round(raw * 1000)));
      }
    }
    await sleep(waitMs);
  }
  throw new Error(`Buffer query failed after retries: ${lastStatus}`);
}

function metricMap(metrics = []) {
  return Object.fromEntries(metrics.map(m => [m.type, Number(m.value ?? 0)]));
}

function ctr(clicks, impressions) {
  return impressions > 0 ? Number((clicks * 100 / impressions).toFixed(2)) : null;
}

function xWeightedLength(text = '') {
  const urlRe = /https?:\/\/\S+/g;
  let total = 0;
  let cursor = 0;
  for (const match of String(text).matchAll(urlRe)) {
    for (const char of String(text).slice(cursor, match.index)) {
      const cp = char.codePointAt(0);
      total += (
        (cp >= 0x0000 && cp <= 0x10FF) ||
        (cp >= 0x2000 && cp <= 0x200D) ||
        (cp >= 0x2010 && cp <= 0x201F) ||
        (cp >= 0x2032 && cp <= 0x2037)
      ) ? 1 : 2;
    }
    total += 23;
    cursor = match.index + match[0].length;
  }
  for (const char of String(text).slice(cursor)) {
    const cp = char.codePointAt(0);
    total += (
      (cp >= 0x0000 && cp <= 0x10FF) ||
      (cp >= 0x2000 && cp <= 0x200D) ||
      (cp >= 0x2010 && cp <= 0x201F) ||
      (cp >= 0x2032 && cp <= 0x2037)
    ) ? 1 : 2;
  }
  return total;
}

function scheduledReadback(post, history = {}) {
  const text = String(post.text || '');
  const expectedActressName = String(history.actress_name || '').trim() || null;
  const campaignExpected = history.campaign_active ?? null;
  return {
    text,
    xWeightedLength: xWeightedLength(text),
    withinXLimit: xWeightedLength(text) <= 280,
    isGenericFallbackOnly: /^【PR】作品情報はこちら。18歳未満閲覧禁止。\s+https?:\/\/\S+$/.test(text.trim()),
    hasAffiliateUrl: /https?:\/\/\S+/.test(text),
    expectedActressName,
    actressNamePresent: expectedActressName ? text.includes(expectedActressName) : null,
    campaignExpected,
    campaignMentionPresent: campaignExpected === true ? /キャンペーン/.test(text) : null,
    campaignTitle: history.campaign_title || null,
    campaignEnd: history.campaign_end || null,
  };
}

function summarizeGroup(items) {
  const totals = items.reduce((a, p) => {
    a.posts += 1;
    a.impressions += p.impressions ?? 0;
    a.clicks += p.clicks ?? 0;
    a.reactions += p.reactions ?? 0;
    a.comments += p.comments ?? 0;
    a.reposts += p.reposts ?? 0;
    return a;
  }, {posts: 0, impressions: 0, clicks: 0, reactions: 0, comments: 0, reposts: 0});
  totals.ctrPct = ctr(totals.clicks, totals.impressions);
  return totals;
}

async function main() {
  const state = JSON.parse(await readFile(STATE_PATH, 'utf8'));
  const historyById = new Map((state.post_history || []).map(x => [x.buffer_post_id, x]));

  const account = await gql('query { account { organizations { id } } }');
  let match = null;
  for (const org of account.account?.organizations || []) {
    const channels = await gql(
      'query($organizationId: OrganizationId!) { channels(input:{organizationId:$organizationId}) { id name service isDisconnected isLocked isQueuePaused } }',
      {organizationId: org.id}
    );
    for (const ch of channels.channels || []) {
      if (String(ch.service).toLowerCase() === 'twitter' && String(ch.name).toLowerCase() === TARGET) {
        match = {orgId: org.id, channel: ch};
        break;
      }
    }
    if (match) break;
  }
  if (!match) throw new Error('DMM X channel ero_mimimimi was not found');

  const inventory = await gql(
    'query($organizationId: OrganizationId!, $channelId: ChannelId!) { posts(first:100,input:{organizationId:$organizationId,filter:{channelIds:[$channelId]}}) { edges { node { id text status dueAt sentAt externalLink } } pageInfo { hasNextPage } } }',
    {organizationId: match.orgId, channelId: match.channel.id}
  );
  if (inventory.posts?.pageInfo?.hasNextPage) throw new Error('DMM inventory exceeds first 100 posts; audit is incomplete');

  const all = (inventory.posts?.edges || []).map(e => e.node);
  const counts = {};
  for (const p of all) counts[p.status] = (counts[p.status] || 0) + 1;

  const scheduled = all
    .filter(p => p.status === 'scheduled')
    .sort((a,b) => new Date(a.dueAt) - new Date(b.dueAt))
    .map(p => ({
      id: p.id,
      dueAt: p.dueAt,
      ...(() => {
        const h = historyById.get(p.id) || {};
        return {
          kind: h.kind ?? null,
          format: h.format ?? null,
          linkMode: h.link_mode ?? null,
          contentId: h.content_id ?? null,
          sort: h.sort ?? null,
          discountPct: h.discount_pct ?? null,
          campaignActive: h.campaign_active ?? null,
          readback: scheduledReadback(p, h),
        };
      })(),
    }));

  const sentCandidates = all
    .filter(p => p.status === 'sent')
    .sort((a,b) => new Date(b.sentAt || b.dueAt) - new Date(a.sentAt || a.dueAt))
    .slice(0, 40);

  const sentMetrics = [];
  for (const p of sentCandidates) {
    try {
      const data = await gql(
        'query($id: PostId!) { post(input:{id:$id}) { id status dueAt sentAt externalLink metricsUpdatedAt metrics { type name value unit } } }',
        {id: p.id}
      );
      const post = data.post;
      const m = metricMap(post?.metrics || []);
      const h = historyById.get(p.id) || {};
      sentMetrics.push({
        id: p.id,
        sentAt: post?.sentAt ?? p.sentAt ?? null,
        externalLink: post?.externalLink ?? p.externalLink ?? null,
        metricsUpdatedAt: post?.metricsUpdatedAt ?? null,
        kind: h.kind ?? null,
        format: h.format ?? null,
        linkMode: h.link_mode ?? null,
        contentId: h.content_id ?? null,
        sort: h.sort ?? null,
        discountPct: h.discount_pct ?? null,
        campaignActive: h.campaign_active ?? null,
        impressions: m.impressions ?? m.views ?? m.reach ?? null,
        clicks: m.clicks ?? null,
        reactions: m.reactions ?? m.likes ?? null,
        comments: m.comments ?? null,
        reposts: m.reposts ?? m.shares ?? null,
      });
    } catch (e) {
      sentMetrics.push({id: p.id, sentAt: p.sentAt ?? null, metricsError: e.message});
    }
  }

  const comparable = sentMetrics.filter(p => Number.isFinite(p.impressions) && Number.isFinite(p.clicks));
  const affiliate = comparable.filter(p => p.kind === 'affiliate');
  const byFormat = {};
  for (const name of ['discovery','decision']) {
    byFormat[name] = summarizeGroup(affiliate.filter(p => p.format === name));
  }
  const byLinkMode = {};
  for (const name of ['first_reply','direct']) {
    byLinkMode[name] = summarizeGroup(affiliate.filter(p => p.linkMode === name));
  }

  const report = {
    version: 1,
    checkedAt: new Date().toISOString(),
    readOnly: true,
    account: TARGET,
    connection: {
      channelId: match.channel.id,
      service: match.channel.service,
      isDisconnected: match.channel.isDisconnected,
      isLocked: match.channel.isLocked,
      isQueuePaused: match.channel.isQueuePaused,
      healthy: !match.channel.isDisconnected && !match.channel.isLocked && !match.channel.isQueuePaused,
    },
    inventory: {
      complete: true,
      counts,
      scheduledCount: scheduled.length,
      scheduled,
    },
    metrics: {
      samplePosts: comparable.length,
      overall: summarizeGroup(comparable),
      affiliate: summarizeGroup(affiliate),
      byFormat,
      byLinkMode,
      posts: sentMetrics,
      note: 'Buffer platform metrics only. DMM conversions/revenue require official DMM report data and are not inferred here.',
    },
    sourceState: {
      batchDate: state.batch_date ?? null,
      contentStrategyVersion: state.content_strategy_version ?? null,
      lastBufferPostId: state.last_buffer_post_id ?? null,
      lastDueAt: state.last_due_at ?? null,
    }
  };

  await mkdir('analytics', {recursive: true});
  await writeFile(OUT_PATH, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({
    checkedAt: report.checkedAt,
    healthy: report.connection.healthy,
    scheduledCount: report.inventory.scheduledCount,
    nextScheduled: report.inventory.scheduled.slice(0, 5),
    metrics: {
      samplePosts: report.metrics.samplePosts,
      overall: report.metrics.overall,
      byFormat: report.metrics.byFormat,
      byLinkMode: report.metrics.byLinkMode,
    }
  }, null, 2));
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
