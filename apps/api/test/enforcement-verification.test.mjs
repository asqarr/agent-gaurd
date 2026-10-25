import assert from "node:assert/strict";
import test from "node:test";
import {
  enforcementVerificationFingerprint,
  runEnforcementVerification,
} from "../src/features/runtime/enforcement-verification.mjs";
import { renderEnforcementVerificationReport } from "../src/features/reports/verification-report.mjs";

const fixture = () => ({
  agent: {
    id: "agent-verification-test",
    workspaceId: "workspace-verification-test",
    name: "Synthetic agent",
    endpoint: "https://customer.example.test/agent",
    runtimeEnabled: true,
    tools: ["get_order", "issue_refund"],
  },
  policy: { id: "policy-1", name: "Refund guard", maxAmount: 50, maxAgeDays: 14, currency: "USD" },
  contract: { version: 3, allowedToolIds: ["get_order", "issue_refund"], maxRefundAmount: 50, maxOrderAgeDays: 14 },
});

test("enforcement verification passes synthetic policy, SDK, failure, and atomic replay checks without external effects", async () => {
  const input = fixture();
  const result = await runEnforcementVerification({
    ...input,
    consumeReplayProbe: async () => ({ attempts: 8, accepted: 1 }),
    now: new Date("2026-10-13T10:00:00.000Z"),
  });

  assert.equal(result.status, "passed");
  assert.equal(result.checks.length, 5);
  assert.ok(result.checks.every((item) => item.status === "passed"));
  assert.equal(result.checks.find((item) => item.id === "over_limit_refund")?.evidence.customerEndpointCalled, false);
  assert.equal(result.checks.find((item) => item.id === "gateway_unavailable")?.evidence.consumeTimeout.executions, 0);
  assert.equal(result.checks.find((item) => item.id === "gateway_unavailable")?.evidence.invokeTimeout.executions, 0);
  assert.equal(result.summary.customerEndpointCalls, 0);
  assert.equal(result.summary.externalToolCalls, 0);
  assert.equal(result.summary.financialSideEffects, 0);
  assert.ok(result.notTested.some((item) => item.includes("alternate direct-to-tool routes")));
});

test("a disabled refund tool cannot masquerade as proof that the configured refund ceiling works", async () => {
  const input = fixture();
  const result = await runEnforcementVerification({
    ...input,
    agent: { ...input.agent, tools: ["get_order"] },
    contract: { ...input.contract, allowedToolIds: ["get_order"] },
    consumeReplayProbe: async () => ({ attempts: 8, accepted: 1 }),
  });
  const check = result.checks.find((item) => item.id === "over_limit_refund");
  assert.equal(check?.status, "failed");
  assert.match(check?.observed ?? "", /not enabled for this agent/i);
});

test("enforcement verification fails if concurrent database consumption is not single-use", async () => {
  const result = await runEnforcementVerification({
    ...fixture(),
    consumeReplayProbe: async () => ({ attempts: 8, accepted: 2 }),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.checks.find((item) => item.id === "single_use_replay")?.status, "failed");
});

test("verification fingerprint changes when a policy or tool boundary changes", () => {
  const input = fixture();
  const baseline = enforcementVerificationFingerprint(input);
  assert.notEqual(enforcementVerificationFingerprint({
    ...input,
    policy: { ...input.policy, maxAmount: 75 },
  }), baseline);
  assert.notEqual(enforcementVerificationFingerprint({
    ...input,
    agent: { ...input.agent, tools: ["get_order"] },
  }), baseline);
  assert.notEqual(enforcementVerificationFingerprint({
    ...input,
    agent: { ...input.agent, endpoint: "https://new-customer.example.test/agent" },
  }), baseline);
  assert.notEqual(enforcementVerificationFingerprint({
    ...input,
    agent: { ...input.agent, status: "quarantined" },
  }), baseline);
});

test("shareable verification report escapes agent-controlled content and states the scope", async () => {
  const input = fixture();
  const verification = await runEnforcementVerification({
    ...input,
    agent: { ...input.agent, name: "<script>alert(1)</script>" },
    consumeReplayProbe: async () => ({ attempts: 8, accepted: 1 }),
  });
  const report = renderEnforcementVerificationReport({ verification, isCurrent: true });
  assert.equal(report.includes("<script>alert(1)</script>"), false);
  assert.match(report, /not an independent audit of the customer&#39;s application/);
  assert.match(report, /Financial side effects/);
  assert.match(report, /Not tested/);
  assert.match(report, /Reproduce:/);
  assert.match(report, /Next step:/);
});
