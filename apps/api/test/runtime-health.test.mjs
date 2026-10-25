import assert from "node:assert/strict";
import test from "node:test";
import { summarizeRuntimeHealth } from "../src/features/runtime/runtime-health.mjs";

const now = new Date("2026-10-13T12:00:00.000Z");
const metrics = {
  sampleCount: 4,
  decisionCount: 3,
  allowCount: 2,
  blockCount: 1,
  errorCount: 1,
  quotaRejectedCount: 2,
  p50Ms: 85,
  p95Ms: 240,
  lastEventAt: "2026-10-13T11:59:00.000Z",
  lastDecisionAt: "2026-10-13T11:57:00.000Z",
  lastErrorAt: "2026-10-13T11:59:00.000Z",
  recentIssues: [],
};

test("runtime health reports observed traffic and keeps quota rejects out of technical error rate", () => {
  const result = summarizeRuntimeHealth({ metrics, runtimeEnabled: true, now });
  assert.equal(result.observationStatus, "degraded", "latest technical error must be visible");
  assert.equal(result.errorRatePercent, 25);
  assert.equal(result.sampleCount, 4);
  assert.equal(result.quotaRejectedCount, 2);
  assert.equal(result.observedOnly, true);
});

test("runtime health distinguishes no data, quota-only activity, stale traffic, and disabled firewall", () => {
  assert.equal(summarizeRuntimeHealth({ metrics: {}, runtimeEnabled: true, now }).observationStatus, "no_data");
  assert.equal(summarizeRuntimeHealth({ metrics: { quotaRejectedCount: 3 }, runtimeEnabled: true, now }).observationStatus, "quota_limited");
  assert.equal(summarizeRuntimeHealth({
    metrics: { ...metrics, errorCount: 0, lastErrorAt: null, lastEventAt: "2026-10-13T11:00:00.000Z" },
    runtimeEnabled: true,
    now,
  }).observationStatus, "no_recent_traffic");
  assert.equal(summarizeRuntimeHealth({ metrics, runtimeEnabled: false, now }).observationStatus, "disabled");
});

test("runtime health marks recent decisions as observed, not as an uptime guarantee", () => {
  const result = summarizeRuntimeHealth({
    metrics: {
      ...metrics,
      errorCount: 0,
      lastErrorAt: null,
      lastEventAt: "2026-10-13T11:59:00.000Z",
      lastDecisionAt: "2026-10-13T11:59:00.000Z",
    },
    runtimeEnabled: true,
    now,
  });
  assert.equal(result.observationStatus, "observed");
  assert.equal(result.observedOnly, true);
});
