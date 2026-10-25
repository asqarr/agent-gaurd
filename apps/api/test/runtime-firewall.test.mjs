import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalMatchesCall,
  buildApprovalPayload,
  createRuntimeToken,
  enforceExecutionContext,
  finalizeRuntimeCalls,
  hashRuntimeToken,
  inspectRuntimeCalls,
  normalizeExecutionContext,
  signApproval,
  verifyApprovalSignature,
} from "../src/features/runtime/runtime-firewall.mjs";

const policy = { maxAmount: 50, maxAgeDays: 14, currency: "USD" };

test("runtime tokens are high-entropy and only their hash is persisted", () => {
  const first = createRuntimeToken();
  const second = createRuntimeToken();
  assert.match(first, /^ag_live_[A-Za-z0-9_-]{40,}$/);
  assert.notEqual(first, second);
  assert.notEqual(hashRuntimeToken(first), first);
  assert.equal(hashRuntimeToken(first), hashRuntimeToken(first));
});

test("runtime firewall passes an allowed read-only tool through", () => {
  const result = inspectRuntimeCalls([
    { name: "get_order", arguments: { order_id: "TEST-001" } },
  ], { allowedToolIds: ["get_order"], policy });
  assert.equal(result.decision, "ALLOW");
  assert.equal(result.execution, "PASS_THROUGH");
  assert.equal(result.toolCalls.length, 1);
});

test("runtime firewall fails closed on an unsafe or unscoped tool call", () => {
  const result = inspectRuntimeCalls([
    { name: "issue_refund", arguments: { order_id: "TEST-001", amount: 100 } },
    { name: "cancel_order", arguments: { order_id: "TEST-001" } },
  ], { allowedToolIds: ["issue_refund"], policy });
  assert.equal(result.decision, "BLOCK");
  assert.equal(result.execution, "NOT_EXECUTED");
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.inspections.length, 2);
  assert.ok(result.reasons.some((reason) => reason.includes("maximum")));
  assert.ok(result.reasons.some((reason) => reason.includes("not enabled")));
});

test("sensitive runtime approvals require a bound identity, order and current time", () => {
  const call = { name: "issue_refund", arguments: { order_id: "TEST-001", amount: 40 } };
  const initial = inspectRuntimeCalls([call], { allowedToolIds: ["issue_refund"], policy });
  const blocked = finalizeRuntimeCalls(enforceExecutionContext(initial.inspections, normalizeExecutionContext(undefined)));
  assert.equal(blocked.decision, "BLOCK");
  assert.equal(blocked.execution, "NOT_EXECUTED");
  assert.deepEqual(blocked.toolCalls, []);
  const context = normalizeExecutionContext({ actorId: "user-1", tenantId: "tenant-1", orderId: "TEST-001", issuedAt: new Date().toISOString() });
  const allowed = finalizeRuntimeCalls(enforceExecutionContext(initial.inspections, context));
  assert.equal(allowed.decision, "ALLOW");
});

test("approval signatures bind the exact tool call and reject argument tampering", () => {
  const token = createRuntimeToken();
  const call = { name: "issue_refund", arguments: { order_id: "TEST-001", amount: 40 } };
  const payload = buildApprovalPayload({
    agentId: "agent-1",
    workspaceId: "workspace-1",
    requestId: "request-1",
    call,
    context: { actorId: "user-1", orderId: "TEST-001", issuedAt: new Date().toISOString() },
    expiresAt: new Date(Date.now() + 30000).toISOString(),
  });
  const signature = signApproval(payload, token);
  assert.equal(verifyApprovalSignature(payload, signature, token), true);
  assert.equal(approvalMatchesCall(payload, call), true);
  assert.equal(approvalMatchesCall(payload, { ...call, arguments: { ...call.arguments, amount: 4000 } }), false);
  assert.equal(verifyApprovalSignature({ ...payload, arguments: { ...payload.arguments, amount: 4000 } }, signature, token), false);
});

test("direct sensitive execution is rejected by a correctly configured customer executor", async () => {
  let executions = 0;
  const executeRefund = async (call, authorization) => {
    if (!authorization?.approved || authorization.tool !== call.name) {
      throw new Error("Refund must be authorized by AgentGuard before execution.");
    }
    executions += 1;
  };
  await assert.rejects(executeRefund({ name: "issue_refund" }, null), /must be authorized/);
  await executeRefund({ name: "issue_refund" }, { approved: true, tool: "issue_refund" });
  assert.equal(executions, 1);
});
