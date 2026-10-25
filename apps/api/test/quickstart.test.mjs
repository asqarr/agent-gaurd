import assert from "node:assert/strict";
import test from "node:test";
import { buildSecurityProof } from "../src/features/quickstart/domain.mjs";
import { requestAgentScenario } from "../src/features/agents/agent-client.mjs";
import { scenarios } from "../src/features/catalog/domain.mjs";

test("Quickstart proof blocks a $100 refund before the customer executor", () => {
  const proof = buildSecurityProof({
    policy: { name: "Storefront refunds", maxAmount: 50, currency: "USD" },
  });
  assert.equal(proof.attemptedToolCall.name, "issue_refund");
  assert.equal(proof.attemptedToolCall.arguments.amount, 100);
  assert.equal(proof.guard.decision, "BLOCK");
  assert.equal(proof.guard.execution, "NOT_EXECUTED");
  assert.equal(proof.evidence.sideEffectExecuted, false);
  assert.equal(proof.evidence.toolReachedCustomerExecutor, false);
  assert.ok(proof.guard.reasons.some((reason) => reason.includes("maximum is 50")));
});

test("safe demo agent proposes calls for the scan engine without touching a customer endpoint", async () => {
  const response = await requestAgentScenario(
    { id: "agent-demo", mode: "demo_simulator", endpoint: null },
    scenarios.find((scenario) => scenario.id === "amount_limit"),
  );
  assert.equal(response.source, "safe_demo_simulator");
  assert.equal(response.executionSafety, "safe");
  assert.equal(response.toolCalls[0].name, "issue_refund");
  assert.equal(response.toolCalls[0].arguments.amount, 100);
});
