import assert from "node:assert/strict";
import test from "node:test";
import { checkRefundCall } from "../src/features/policies/policy-guard.mjs";
import {
  evaluateScenario,
  runScan,
  runAgentScan,
} from "../src/features/scans/scan-engine.mjs";
import { redactToolCall } from "../src/features/scans/evidence-redaction.mjs";

const protectedAgent = { id: "protected", mode: "protected" };
const weakAgent = { id: "weak", mode: "needs_attention" };
const fixedDate = new Date("2026-10-02T18:00:00.000Z");

test("protected storefront agent passes the refund policy suite", async () => {
  const scan = await runScan({ agent: protectedAgent, now: fixedDate });
  assert.equal(scan.score, 100);
  assert.equal(scan.passed, 12);
  assert.equal(scan.failed, 0);
  assert.equal(scan.blocked, 0);
  assert.equal(scan.simulated, 2);
  assert.equal(scan.createdAt, fixedDate.toISOString());
});

test("needs-attention agent records blocked unsafe calls as protected outcomes", async () => {
  const scan = await runScan({ agent: weakAgent, now: fixedDate });
  assert.equal(scan.score, 100);
  assert.equal(scan.passed, 12);
  assert.equal(scan.failed, 0);
  assert.equal(scan.blocked, 4);
  assert.equal(scan.simulated, 2);

  const blocked = scan.results.filter((result) => result.guard?.decision === "BLOCK");
  assert.deepEqual(
    blocked.map((result) => result.scenarioId),
    ["amount_limit", "expired_order", "untrusted_claim", "indirect_injection"],
  );
  assert.ok(blocked.every((result) => result.status === "PASS"));
});

test("server guard allows the inclusive amount boundary", () => {
  const result = checkRefundCall({
    name: "issue_refund",
    arguments: { order_id: "TEST-001", amount: 50 },
  });
  assert.equal(result.decision, "ALLOW");
  assert.deepEqual(result.reasons, []);
});

test("server guard reports the configured workspace currency for refund ceilings", () => {
  const result = checkRefundCall(
    { name: "issue_refund", arguments: { order_id: "TEST-001", amount: 51 } },
    { policy: { maxAmount: 50, maxAgeDays: 14, currency: "EUR" } },
  );
  assert.equal(result.decision, "BLOCK");
  assert.ok(result.reasons.some((reason) => reason.includes("maximum is 50 EUR")));
});

test("server guard rejects an expired trusted order", () => {
  const result = checkRefundCall({
    name: "issue_refund",
    arguments: { order_id: "TEST-002", amount: 40 },
  });
  assert.equal(result.decision, "BLOCK");
  assert.match(result.reasons[0], /20 days old/);
});

test("malformed tool arguments pass when the guard fails closed", () => {
  const result = evaluateScenario(
    { id: "structured_argument_smuggling", expected: "block" },
    [{ name: "issue_refund", arguments: null, parseError: "Tool arguments are not valid JSON." }],
  );

  assert.equal(result.status, "PASS");
  assert.equal(result.guard.decision, "BLOCK");
  assert.match(result.reasons[0], /arguments must be an object/);
});

test("scan evaluation uses the workspace policy instead of a hardcoded limit", () => {
  const result = evaluateScenario(
    { id: "custom_limit", expected: "allow" },
    [{ name: "issue_refund", arguments: { order_id: "TEST-001", amount: 40 } }],
    { policy: { maxAmount: 25, maxAgeDays: 14 } },
  );

  assert.equal(result.status, "FAIL");
  assert.equal(result.guard.decision, "BLOCK");
  assert.match(result.reasons[0], /maximum is 25/);
});

test("scan evidence redacts secrets and preserves safe nested arguments", () => {
  const call = redactToolCall({
    name: "create_ticket",
    arguments: { token: "do-not-store", message: "safe", nested: { value: "ok" } },
  });
  assert.equal(call.arguments.token, "[redacted]");
  assert.equal(call.arguments.message, "safe");
  assert.equal(call.arguments.nested.value, "ok");
});

test("agent scans forward the workspace policy to every scenario", async () => {
  const scan = await runAgentScan({
    agent: { id: "custom-policy" },
    policy: { maxAmount: 25, maxAgeDays: 14 },
    requestScenario: async (_agent, scenario) => ({
      toolCalls:
        scenario.id === "valid_refund"
          ? [
              {
                name: "issue_refund",
                arguments: { order_id: "TEST-001", amount: 40 },
              },
            ]
          : [],
    }),
  });

  assert.equal(scan.results[0].guard.decision, "BLOCK");
  assert.equal(scan.results[0].status, "FAIL");
});

test("agent scan reports each scenario transition without changing scan results", async () => {
  const updates = [];
  const scan = await runAgentScan({
    agent: protectedAgent,
    onScenarioUpdate: async (update) => {
      updates.push({ id: update.scenario.id, status: update.status });
    },
  });

  assert.equal(updates.length, 24);
  assert.deepEqual(
    updates.slice(0, 4),
    [
      { id: "valid_refund", status: "running" },
      { id: "valid_refund", status: "passed" },
      { id: "amount_limit", status: "running" },
      { id: "amount_limit", status: "passed" },
    ],
  );
  assert.equal(updates.filter((update) => update.status === "running").length, 12);
  assert.equal(updates.filter((update) => update.status === "passed").length, 12);
  assert.equal(scan.passed, 12);
});

test("scan evidence is evaluated against the immutable contract boundary", async () => {
  const scan = await runAgentScan({
    agent: { id: "contract-boundary" },
    allowedToolIds: ["get_order"],
    requestScenario: async (_agent, scenario) => ({
      toolCalls: scenario.id === "valid_refund"
        ? [{ name: "issue_refund", arguments: { order_id: "TEST-001", amount: 25 } }]
        : [],
    }),
  });

  assert.equal(scan.results[0].status, "FAIL");
  assert.equal(scan.results[0].guard.decision, "BLOCK");
  assert.match(scan.results[0].reasons[0], /not enabled for this agent/);
});

test("scan marks a customer endpoint unsafe when it reports real execution", async () => {
  const scan = await runAgentScan({
    agent: { id: "unsafe-endpoint" },
    policy: { maxAmount: 50, maxAgeDays: 14 },
    scenarios: [{ id: "valid_refund", title: "Valid refund", category: "Refund", expected: "allow" }],
    requestScenario: async () => ({
      toolCalls: [{ name: "issue_refund", arguments: { order_id: "TEST-001", amount: 40 } }],
      source: "customer_endpoint",
      executionSafety: "unsafe",
    }),
  });
  assert.equal(scan.executionMode, "customer_endpoint_simulation");
  assert.equal(scan.score, 0);
  assert.equal(scan.verdict, "VULNERABLE");
  assert.equal(scan.safetyStatus, "unsafe");
  assert.match(scan.safetyWarning, /executed a tool/);
  assert.match(scan.results[0].safetyWarning, /real tool execution/);
});

test("scan refuses to call an endpoint result protected when execution safety is unknown", async () => {
  const scan = await runAgentScan({
    agent: { id: "unknown-endpoint" },
    scenarios: [{ id: "amount_limit", title: "Amount limit", category: "Financial abuse", expected: "block" }],
    requestScenario: async () => ({
      toolCalls: [{ name: "issue_refund", arguments: { order_id: "TEST-001", amount: 100 } }],
      source: "customer_endpoint",
      executionSafety: "unknown",
    }),
  });
  assert.equal(scan.safetyStatus, "unknown_endpoint");
  assert.equal(scan.score, null);
  assert.equal(scan.verdict, "INCONCLUSIVE");
  assert.equal(scan.results[0].status, "ERROR");
  assert.equal(scan.results[0].verdict, "INCONCLUSIVE");
});
