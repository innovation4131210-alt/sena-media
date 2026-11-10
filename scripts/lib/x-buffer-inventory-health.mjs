// Observation only: never creates, releases holds, reschedules, or changes posts.
// Limits are warning thresholds, not permission to change the posting cadence.
export function evaluateXInventoryHealth(queue, inventory, checkedAt) {
  const now = Date.parse(checkedAt);
  if (!Number.isFinite(now)) throw new Error("Invalid inventory health checkedAt");
  const thresholds = { minimumFutureScheduled: 3, maximumGapHours: 36 };
  const hour = 60 * 60 * 1000;
  const future = post => Number.isFinite(Date.parse(post.dueAt)) && Date.parse(post.dueAt) > now;
  const pending = queue.posts.filter(post => post.status === "pending" && future(post));
  // Source readiness is structural only. Actual media validation and provider
  // readback remain mandatory in the existing scheduler before reservation.
  const ready = pending.filter(post => typeof post.text === "string" && post.text.trim() &&
    typeof post.mediaUrl === "string" && /^https:\/\//.test(post.mediaUrl));
  const scheduled = inventory.filter(post => post.status === "scheduled");
  const futureScheduled = scheduled.filter(future).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  const invalidScheduledCount = scheduled.filter(post => !Number.isFinite(Date.parse(post.dueAt))).length;
  const times = futureScheduled.map(post => Date.parse(post.dueAt));
  const largestGapHours = times.length ? Math.max(...times.map((time, i) =>
    (time - (i === 0 ? now : times[i - 1])) / hour)) : null;
  const reasons = [];
  if (!futureScheduled.length) reasons.push("no_future_provider_reservations");
  else {
    if (futureScheduled.length < thresholds.minimumFutureScheduled) reasons.push("fewer_than_three_future_reservations");
    if (largestGapHours > thresholds.maximumGapHours) reasons.push("observed_reservation_gap_over_36_hours");
  }
  if (invalidScheduledCount) reasons.push("provider_scheduled_due_at_invalid");
  const coverageStatus = invalidScheduledCount ? "unverified" : !futureScheduled.length ? "empty" :
    reasons.length ? "low_coverage" : "sufficient_observed";
  const sourceStatus = ready.length ? "available" : pending.length ? "blocked" : "exhausted";
  if (!ready.length) reasons.push(pending.length ? "future_source_not_ready" : "future_source_exhausted");
  const status = invalidScheduledCount ? "inventory_unverified" : !futureScheduled.length ?
    (ready.length ? "unreserved" : "exhausted") : coverageStatus === "low_coverage" ?
      "low_coverage" : sourceStatus === "blocked" ? "source_blocked" : sourceStatus === "exhausted" ? "source_exhausted" : "healthy";
  return {
    schemaVersion: 1,
    checkedAt,
    status,
    ok: status === "healthy",
    severity: !futureScheduled.length || invalidScheduledCount ? "error" : status === "healthy" ? "none" : "warning",
    coverageStatus,
    sourceStatus,
    futureScheduledCount: futureScheduled.length,
    futurePendingCount: pending.length,
    futureReadyPendingCount: ready.length,
    futureBlockedPendingCount: pending.length - ready.length,
    heldCount: queue.posts.filter(post => String(post.status).startsWith("held")).length,
    futureHeldCount: queue.posts.filter(post => String(post.status).startsWith("held") && future(post)).length,
    historicalScheduledCount: queue.posts.filter(post => post.status === "scheduled" && !future(post)).length,
    overdueProviderScheduledCount: scheduled.filter(post => Number.isFinite(Date.parse(post.dueAt)) && Date.parse(post.dueAt) <= now).length,
    invalidProviderScheduledCount: invalidScheduledCount,
    nextScheduledAt: times.length ? new Date(times[0]).toISOString() : null,
    lastScheduledAt: times.length ? new Date(times.at(-1)).toISOString() : null,
    largestGapHours,
    thresholds,
    reasons,
    mutationAllowed: false,
    note: "Provider reservations and source inventory are separate from execution success. Source readiness does not verify media availability. Observations never authorize catch-up, reuse, or release of held posts.",
  };
}

export function reportXInventoryHealth(health, label) {
  if (health.ok) return;
  const message = `${label}: ${health.status}; future reservations=${health.futureScheduledCount}; ready future sources=${health.futureReadyPendingCount}; ${health.reasons.join(", ")}`;
  // GitHub annotations plus a failed run for empty/unverified provider inventory.
  // The queue audit has already been saved; workflow persistence uses always().
  console.error(`::${health.severity} title=X posting inventory requires attention::${message}`);
  if (health.severity === "error") process.exitCode = 1;
}
