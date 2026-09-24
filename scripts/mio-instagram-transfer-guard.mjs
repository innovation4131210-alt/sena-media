export function validateTransferGate(receipt, post, prior, current, now = Date.now()) {
  if (receipt?.version !== 1 || receipt?.brandId !== '6940494' || receipt?.handle !== 'mio.ai_life' || receipt?.destination !== 'buffer' || receipt?.channelId !== '6aa630b7ea19ca0bde329146') throw Error('Transfer identity gate failed');
  const start = Date.parse(receipt.observationWindow?.startedAt);
  if (!Number.isFinite(start) || now < start || now - start > 60 * 60 * 1000) throw Error('Fresh cross-scheduler evidence required');
  if (receipt.metricool?.source !== 'Metricool.getScheduledPosts' || receipt.metricool?.rangeStart !== '2026-10-22' || receipt.metricool?.rangeEnd !== '2026-10-27' || receipt.metricool?.rangeResultCount !== 0 || receipt.metricool?.octoberRemainingCount !== 20) throw Error('Metricool absence or free-allocation gate failed');
  const slots = receipt.slots;
  if (!Array.isArray(slots) || slots.length !== 6 || new Set(slots.map(x => x.date)).size !== 6 || slots.some((x,i) => x.date !== `2026-10-${22+i}`)) throw Error('Exact six-date gate failed');
  const slot = slots.find(x => x.date === post.date);
  if (!slot || slot.mediaSha256 !== post.sha256 || slot.day !== post.day || Date.parse(slot.dueAt) !== Date.parse(post.publishAt) || post.account !== 'mio.ai_life' || post.qcStatus !== 'accepted' || post.aiDisclosure !== true) throw Error('Approved media/date gate failed');
  if (!Array.isArray(current) || current.some(x => x.id === slot.retiredBufferId || (x.dueAt && new Date(x.dueAt).toLocaleDateString('en-CA',{timeZone:'Asia/Tokyo'}) === post.date))) throw Error('Buffer date or retired ID remains occupied');
  if (prior && (prior.status !== 'cancelled_duplicate_metricool_primary' || prior.id !== slot.retiredBufferId || prior.duplicateOfMetricoolId !== slot.retiredMetricoolId || prior.mediaSha256 !== post.sha256)) throw Error('Unresolved prior intent; do not recreate');
  return {archivePrior: Boolean(prior), authorizationId: receipt.id};
}
