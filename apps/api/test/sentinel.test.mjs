import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSentinelSnapshot,
  compareSentinelSnapshots,
  fingerprintSentinelSnapshot,
  sentinelStatus,
} from "../src/features/sentinel/domain.mjs";

const agent = {
  provider: "OpenAI-compatible API",
  model: "gpt-4.1-mini",
  environment: "Production",
  endpoint: "https://agent.example/chat",
  tools: ["get_order", "issue_refund"],
};

const policy = {
  name: "Storefront refunds",
  maxAmount: 50,
  maxAgeDays: 14,
  currency: "USD",
  enforcement: "block_and_log",
};

test("sentinel fingerprints are stable regardless of tool order", () => {
  const first = buildSentinelSnapshot({ agent, policy, tools: [{ id: "issue_refund", risk: "critical", sideEffect: true }, { id: "get_order", risk: "read", sideEffect: false }] });
  const second = buildSentinelSnapshot({ agent: { ...agent, tools: [...agent.tools].reverse() }, policy, tools: [{ id: "get_order", risk: "read", sideEffect: false }, { id: "issue_refund", risk: "critical", sideEffect: true }] });
  assert.equal(fingerprintSentinelSnapshot(first), fingerprintSentinelSnapshot(second));
});

test("sentinel detects a high-impact tool and policy drift", () => {
  const baseline = buildSentinelSnapshot({ agent, policy, tools: [{ id: "get_order", risk: "read", sideEffect: false }] });
  const current = buildSentinelSnapshot({ agent: { ...agent, model: "new-model", tools: [...agent.tools, "cancel_order"] }, policy: { ...policy, maxAmount: 500 }, tools: [{ id: "get_order", risk: "read", sideEffect: false }, { id: "issue_refund", risk: "critical", sideEffect: true }, { id: "cancel_order", risk: "high", sideEffect: true }] });
  const result = compareSentinelSnapshots(baseline, current);
  assert.equal(result.drifted, true);
  assert.equal(result.severity, "critical");
  assert.ok(result.changes.some((change) => change.category === "tool_registry"));
  assert.ok(result.changes.some((change) => change.category === "policy"));
});

test("sentinel reports a clean protected baseline", () => {
  const snapshot = buildSentinelSnapshot({ agent, policy, tools: [{ id: "get_order", risk: "read", sideEffect: false }] });
  const result = compareSentinelSnapshots(snapshot, snapshot);
  assert.deepEqual(result, { drifted: false, severity: "none", changes: [] });
});

test("sentinel explicitly reports paused monitoring", () => {
  assert.equal(
    sentinelStatus({ baseline: { id: "baseline" }, drift: { drifted: false }, enabled: false }),
    "disabled",
  );
});
