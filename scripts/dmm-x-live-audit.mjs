import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';

const API_URL = 'https://api.buffer.com';
const KEY = process.env.DMM_BUFFER_API_KEY || '';
const TARGET = 'ero_mimimimi';
const STATE_PATH = 'automation/dmm-x/state.json';
const OUT_PATH = 'analytics/dmm-x-live-audit.json';

let cooldown = null;
let readDeadline = Infinity;

function rateLimitError(retryAfter) {
  const seconds = Number(retryAfter);
  const until = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) : NaN;
  const waitMs = Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000 : (Number.isFinite(until) && until > Date.now() ? until - Date.now() : 60000);
  cooldown = {status: 429, retryAt: new Date(Date.now() + waitMs).toISOString()};
  return Object.assign(new Error('Buffer rate limited; collection stopped'), {cooldown});
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function gql(query, variables = {}) {
  if (cooldown) throw Object.assign(new Error('Buffer cooldown active'), {cooldown});
  if (!KEY) throw new Error('DMM_BUFFER_API_KEY is not configured');
  if (!/^\s*query\b/.test(query) || /\bmutation\b/.test(query)) throw new Error('Read-only query required');

  const fallbackDelays = [2000, 5000, 10000];
  let lastStatus = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (Date.now() >= readDeadline) throw Object.assign(new Error('Audit time budget exhausted'), {timeBudget: true});
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${KEY}`},
      body: JSON.stringify({query, variables}),
      signal: AbortSignal.timeout(Math.max(1, Math.min(30000, readDeadline - Date.now()))),
    });
    lastStatus = res.status;
    if (res.status === 429) throw rateLimitError(res.headers.get('retry-after'));

    let json = {};
    try {
      json = await res.json();
    } catch {
      json = {};
    }

    if (res.ok && !json.errors?.length && json.data) {
      return json.data;
    }

    if (![500, 502, 503, 504].includes(res.status)) {
      throw new Error(`Buffer query failed: ${res.status}`);
    }
    if (attempt >= 3) break;

    const waitMs = fallbackDelays[attempt];
    await sleep(Math.max(0, Math.min(waitMs, readDeadline - Date.now())));
  }
  throw new Error(`Buffer query failed after retries: ${lastStatus}`);
}

function metricMap(metrics = []) {
  return Object.fromEntries(metrics.map(m => [m.type, (typeof m.value !== 'number' && typeof m.value !== 'string') || String(m.value).trim() === ''
    ? null : (Number.isFinite(Number(m.value)) ? Number(m.value) : null)]));
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
  const campaignTitle = String(history.campaign_title || '').trim() || null;
  const weightedLength = xWeightedLength(text);
  const isGenericFallbackOnly = /^【PR】作品情報はこちら。18歳未満閲覧禁止。\s+https?:\/\/\S+$/.test(text.trim());
  const hasAffiliateUrl = /https?:\/\/\S+/.test(text);
  const actressNamePresent = expectedActressName ? text.includes(expectedActressName) : null;
  const valueProofPresent = /★\s*\d|\d+件|\d+%OFF|\d[\d,]*円|人気|ランキング|レビュー/.test(text);
  const campaignEvidencePresent = campaignExpected === true
    ? Boolean((campaignTitle && text.includes(campaignTitle)) || /FANZA公式|キャンペーン/.test(text))
    : null;

  return {
    text,
    xWeightedLength: weightedLength,
    withinXLimit: weightedLength <= 280,
    isGenericFallbackOnly,
    hasAffiliateUrl,
    expectedActressName,
    actressNamePresent,
    valueProofPresent,
    campaignExpected,
    campaignEvidencePresent,
    campaignTitle,
    campaignEnd: history.campaign_end || null,
    p0ChecksPass: (
      !isGenericFallbackOnly &&
      hasAffiliateUrl &&
      weightedLength <= 280 &&
      actressNamePresent !== false &&
      valueProofPresent &&
      campaignEvidencePresent !== false
    ),
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
  totals.metricCoverage = {};
  for (const key of ['impressions', 'clicks', 'reactions', 'comments', 'reposts']) {
    totals.metricCoverage[key] = items.filter(p => Number.isFinite(p[key])).length;
    if (!totals.metricCoverage[key]) totals[key] = null;
  }
  totals.ctrPct = ctr(totals.clicks, totals.impressions);
  return totals;
}

async function main() {
  // Leave time for the workflow to persist the result within its eight-minute budget.
  readDeadline = Date.now() + 240000;
  let previous = null;
  try {
    previous = JSON.parse(await readFile(OUT_PATH, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const previousRetryAt = previous?.account === TARGET
    ? previous.metrics?.coverage?.cooldown?.retryAt : null;
  const previousRetryTime = typeof previousRetryAt === 'string' ? Date.parse(previousRetryAt) : NaN;
  if (Number.isFinite(previousRetryTime) && previousRetryTime > Date.now()) {
    console.log(JSON.stringify({
      status: 'cooldown_active',
      retryAt: previousRetryAt,
      preservedCheckedAt: previous.checkedAt ?? null,
      note: 'No Buffer requests made; previous inventory and metric timestamps retained unchanged.',
    }));
    return;
  }
  const previousById = new Map(previous?.account === TARGET
    ? (previous.metrics?.posts || []).map(post => [post.id, post]) : []);
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

  const inventoryCheckedAt = new Date().toISOString();
  const sentMetrics = sentCandidates.map(p => ({
    ...(previousById.get(p.id) || {}),
    id: p.id,
    sentAt: p.sentAt ?? null,
    externalLink: p.externalLink ?? null,
    collectionStatus: previousById.has(p.id) ? 'cached' : 'not_collected',
  }));
  let attempted = 0;
  let collectionStatus = 'in_progress';
  const deadline = readDeadline;
  await persistReport(); // Inventory survives later metric failures or interruption locally.
  for (const [index, p] of sentCandidates.entries()) {
    if (Date.now() >= deadline) {
      collectionStatus = 'time_budget_exhausted';
      break;
    }
    attempted += 1;
    try {
      const data = await gql(
        'query($id: PostId!) { post(input:{id:$id}) { id status dueAt sentAt externalLink metricsUpdatedAt metrics { type name value unit } } }',
        {id: p.id}
      );
      const post = data.post;
      const m = metricMap(post?.metrics || []);
      const h = historyById.get(p.id) || {};
      if (!post || post.id !== p.id) throw new Error('Buffer post readback missing or mismatched');
      sentMetrics[index] = {
        collectionStatus: 'fresh',
        fetchedAt: new Date().toISOString(),
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
      };
    } catch (e) {
      sentMetrics[index] = {...sentMetrics[index], metricsError: e.message};
      if (e.cooldown || e.timeBudget || Date.now() >= deadline) {
        collectionStatus = e.cooldown ? 'rate_limited' : 'time_budget_exhausted';
        break;
      }
    }
    await persistReport();
  }
  if (collectionStatus === 'in_progress') {
    collectionStatus = sentMetrics.every(p => p.collectionStatus === 'fresh') ? 'complete' : 'partial';
  }
  await persistReport();

  async function persistReport() {
    const comparable = sentMetrics.filter(p => p.collectionStatus === 'fresh').filter(p => Number.isFinite(p.impressions) && Number.isFinite(p.clicks));
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
      version: 2,
      checkedAt: inventoryCheckedAt,
      updatedAt: new Date().toISOString(),
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
        coverage: {
          totalSent: counts.sent || 0,
          selected: sentCandidates.length,
          attempted,
          fetched: sentMetrics.filter(p => p.collectionStatus === 'fresh').length,
          comparable: comparable.length,
          cached: sentMetrics.filter(p => p.collectionStatus === 'cached').length,
          missing: sentMetrics.filter(p => p.collectionStatus === 'not_collected').length,
          status: collectionStatus,
          cooldown,
        },
        freshness: {
          oldestMetricsUpdatedAt: comparable.map(p => p.metricsUpdatedAt).filter(Boolean).sort()[0] ?? null,
          newestMetricsUpdatedAt: comparable.map(p => p.metricsUpdatedAt).filter(Boolean).sort().at(-1) ?? null,
        },
        overall: summarizeGroup(comparable),
        affiliate: summarizeGroup(affiliate),
        byFormat,
        byLinkMode,
        posts: sentMetrics,
        note: 'Buffer platform metrics only. Aggregates use this pass only; cached per-post values retain their original timestamps and are excluded. DMM conversions/revenue require official DMM report data and are not inferred here.',
      },
      sourceState: {
        batchDate: state.batch_date ?? null,
        contentStrategyVersion: state.content_strategy_version ?? null,
        lastBufferPostId: state.last_buffer_post_id ?? null,
        lastDueAt: state.last_due_at ?? null,
      }
    };

    await mkdir('analytics', {recursive: true});
    await writeFile(`${OUT_PATH}.tmp`, JSON.stringify(report, null, 2) + '\n');
    await rename(`${OUT_PATH}.tmp`, OUT_PATH);
    if (collectionStatus !== 'in_progress') console.log(JSON.stringify({
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
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});

