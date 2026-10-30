import assert from "node:assert/strict";
import test from "node:test";
import { buildPolicyFixProposal } from "../src/features/scans/policy-fix.mjs";

function evidence({ scenarioId = "amount_limit", amount = 100, orderId = "TEST-001" } = {}) {
  const scan = {
    id: "scan-policy-fix-test",
    status: "completed",
    safetyStatus: "safe",
    executionMode: "safe_demo_simulation",
    policySnapshot: { policy: {
      id: "policy-test",
      version: 7,
      maxAmount: 150,
      maxAgeDays: 30,
      currency: "USD",
    } },
  };
  const result = {
    scenarioId,
    verdict: "VULNERABLE",
    guard: { decision: "ALLOW", execution: "SIMULATED" },
    executionSafety: "safe",
    executionMode: "safe_demo_simulation",
    call: { name: "issue_refund", arguments: { order_id: orderId, amount } },
  };
  return { scan, result, policy: scan.policySnapshot.policy };
}

test("amount limit proposal changes only enough to block the observed amount", () => {
  const proposal = buildPolicyFixProposal(evidence());
  assert.equal(proposal.field, "maxAmount");
  assert.equal(proposal.expectedPolicyVersion, 7);
  assert.equal(proposal.currentValue, 150);
  assert.equal(proposal.evidenceValue, 100);
  assert.equal(proposal.proposedValue, 99.99);
  assert.equal(proposal.scope, "workspace");
  assert.match(proposal.warning, /all agents/i);
});

test("expired-order proposal uses the trusted fixture boundary", () => {
  const proposal = buildPolicyFixProposal(evidence({ scenarioId: "expired_order", amount: 40, orderId: "TEST-002" }));
  assert.equal(proposal.field, "maxAgeDays");
  assert.equal(proposal.currentValue, 30);
  assert.equal(proposal.evidenceValue, 20);
  assert.equal(proposal.proposedValue, 19);
});

test("proposal is absent unless saved evidence is safe, vulnerable and allowed", () => {
  const base = evidence();
  const rejected = [
    { result: { ...base.result, verdict: "INCONCLUSIVE" } },
    { result: { ...base.result, guard: { decision: "BLOCK", execution: "NOT_EXECUTED" } } },
    { result: { ...base.result, executionSafety: "unknown" } },
    { scan: { ...base.scan, safetyStatus: "unsafe" } },
    { policy: { ...base.policy, maxAmount: 50 } },
    { result: { ...base.result, call: { ...base.result.call, arguments: { ...base.result.call.arguments, amount: 100.001 } } } },
  ];
  for (const overrides of rejected) {
    assert.equal(buildPolicyFixProposal({ ...base, ...overrides }), null);
  }
});
