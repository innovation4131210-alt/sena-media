import assert from "node:assert/strict";
import { evaluateXInventoryHealth } from "./lib/x-buffer-inventory-health.mjs";

const checkedAt = "2026-11-10T23:00:00.000Z";
const at = hours => new Date(Date.parse(checkedAt) + hours * 3600000).toISOString();
const source = (hours, extra = {}) => ({ status: "pending", dueAt: at(hours), text: "approved source", mediaUrl: "https://example.invalid/image.jpg", ...extra });
const remote = (hours, extra = {}) => ({ id: `post-${hours}`, status: "scheduled", dueAt: at(hours), ...extra });
const evaluate = (posts = [], inventory = []) => evaluateXInventoryHealth({ posts }, inventory, checkedAt);
let count = 0;
function check(name, fn) { fn(); count++; console.log("PASS X inventory health", name); }

check("empty is an error and never invents a reservation", () => {
  const health = evaluate();
  assert.equal(health.status, "exhausted");
  assert.equal(health.sourceStatus, "exhausted");
  assert.equal(health.coverageStatus, "empty");
  assert.equal(health.severity, "error");
  assert.equal(health.ok, false);
  assert.equal(health.nextScheduledAt, null);
  assert.equal(health.mutationAllowed, false);
});
check("historical local scheduled records never count as provider coverage", () => {
  const posts = [source(-24, { status: "scheduled" }), source(-1), source(24, { status: "held_visual_required" })];
  const before = JSON.stringify(posts);
  const health = evaluate(posts);
  assert.equal(health.status, "exhausted");
  assert.equal(health.futurePendingCount, 0);
  assert.equal(health.futureScheduledCount, 0);
  assert.equal(health.historicalScheduledCount, 1);
  assert.equal(health.futureHeldCount, 1);
  assert.equal(JSON.stringify(posts), before);
});
check("pending is not a reservation", () => {
  const health = evaluate([source(24)]);
  assert.equal(health.status, "unreserved");
  assert.equal(health.severity, "error");
  assert.equal(health.futureReadyPendingCount, 1);
});
check("held, unresolved and non-HTTPS sources cannot make stock healthy", () => {
  const health = evaluate([
    source(1, { status: "held_visual_required" }), source(2, { status: "creating" }),
    source(3, { status: "created_unverified" }), source(4, { mediaUrl: null }),
    source(5, { mediaUrl: "http://example.invalid/image.jpg" }), source(6, { text: " " }),
  ]);
  assert.equal(health.futurePendingCount, 3);
  assert.equal(health.futureReadyPendingCount, 0);
  assert.equal(health.futureBlockedPendingCount, 3);
  assert.equal(health.sourceStatus, "blocked");
  assert.equal(health.severity, "error");
});
check("one reservation is a warning even with source available", () => {
  const health = evaluate([source(30)], [remote(6)]);
  assert.equal(health.status, "low_coverage");
  assert.equal(health.severity, "warning");
  assert.equal(health.nextScheduledAt, at(6));
});
check("three daily reservations and future source have observed coverage", () => {
  const health = evaluate([source(78)], [remote(54), remote(6), remote(30)]);
  assert.equal(health.status, "healthy");
  assert.equal(health.coverageStatus, "sufficient_observed");
  assert.equal(health.largestGapHours, 24);
  assert.equal(health.lastScheduledAt, at(54));
});
check("full provider stock without future sources warns before it runs out", () => {
  const health = evaluate([], [remote(6), remote(30), remote(54)]);
  assert.equal(health.status, "source_exhausted");
  assert.equal(health.coverageStatus, "sufficient_observed");
  assert.equal(health.severity, "warning");
});
check("blocked source is distinguished from exhausted source", () => {
  const health = evaluate([source(78, { mediaUrl: null })], [remote(6), remote(30), remote(54)]);
  assert.equal(health.status, "source_blocked");
  assert.equal(health.sourceStatus, "blocked");
});
check("a distant next reservation is low coverage regardless of count", () => {
  const health = evaluate([source(200)], [remote(72), remote(96), remote(120)]);
  assert.equal(health.status, "low_coverage");
  assert.equal(health.largestGapHours, 72);
});
check("an internal reservation gap cannot look healthy", () => {
  const health = evaluate([source(200)], [remote(6), remote(60), remote(84)]);
  assert.equal(health.status, "low_coverage");
  assert.equal(health.largestGapHours, 54);
});
check("overdue, sent and errored provider rows do not count as future stock", () => {
  const health = evaluate([], [remote(-1), remote(0), remote(6, { status: "sent" }), remote(30, { status: "error" })]);
  assert.equal(health.status, "exhausted");
  assert.equal(health.overdueProviderScheduledCount, 2);
  assert.equal(health.futureScheduledCount, 0);
});
check("invalid provider dueAt prevents a healthy result", () => {
  const health = evaluate([source(100)], [remote(6), remote(30), remote(54), remote(80, { dueAt: "invalid" })]);
  assert.equal(health.status, "inventory_unverified");
  assert.equal(health.coverageStatus, "unverified");
  assert.equal(health.severity, "error");
});
check("invalid source dueAt never counts as future source", () => {
  const health = evaluate([source(6, { dueAt: "invalid" })]);
  assert.equal(health.futurePendingCount, 0);
  assert.equal(health.status, "exhausted");
});
check("exact threshold remains sufficient observed coverage", () => {
  const health = evaluate([source(120)], [remote(36), remote(72), remote(108)]);
  assert.equal(health.coverageStatus, "sufficient_observed");
});
console.log(`${count} inventory health tests passed; pure observation with no I/O.`);
