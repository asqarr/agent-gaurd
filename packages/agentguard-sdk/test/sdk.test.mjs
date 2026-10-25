import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { AgentGuardClient, AgentGuardUnavailableError, stableStringify, verifyExecutionReceipt } from "../src/index.mjs";

function fakeFetchFactory({ tamper = false, fail = false } = {}) {
  let consumed = 0;
  const token = "ag_live_test-token";
  const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
  return {
    get consumed() { return consumed; },
    fetch: async (url, init) => {
      if (fail) throw new Error("network down");
      const body = JSON.parse(init.body);
      if (url.endsWith("/invoke")) {
        const call = { name: "issue_refund", arguments: { order_id: "ORDER-1", amount: 40 } };
        const payload = {
          version: 1,
          approvalId: "approval-1",
          agentId: "agent-1",
          workspaceId: "workspace-1",
          requestId: "request-1",
          tool: call.name,
          arguments: call.arguments,
          context: { actorId: "user-1", orderId: "ORDER-1", issuedAt: "2026-10-13T10:00:00.000Z" },
          policyVersion: "runtime-v1",
          expiresAt: "2099-01-01T00:00:00.000Z",
        };
        const signature = createHmac("sha256", token).update(canonical(payload)).digest("base64url");
        return new Response(JSON.stringify({
          requestId: "request-1",
          assistantText: "",
          tool_calls: [call],
          approved_tool_calls: [{ call: tamper ? { ...call, arguments: { ...call.arguments, amount: 4000 } } : call, approval: { id: "approval-1", payload, signature, expiresAt: payload.expiresAt } }],
          blocked_tool_calls: [],
          guard: { decision: "ALLOW", execution: "PASS_THROUGH", reasons: [] },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      consumed += 1;
      const consumedAt = new Date().toISOString();
      const receiptPayload = {
        version: 1,
        approvalId: "approval-1",
        agentId: "agent-1",
        workspaceId: "workspace-1",
        requestId: "request-1",
        tool: body.toolCall.name,
        arguments: body.toolCall.arguments,
        context: { actorId: "user-1", orderId: "ORDER-1", issuedAt: "2026-10-13T10:00:00.000Z" },
        consumedAt,
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
      const signature = createHmac("sha256", token).update(canonical(receiptPayload)).digest("base64url");
      return new Response(JSON.stringify({
        approved: true,
        approvalId: "approval-1",
        execution: "AUTHORIZED_ONCE",
        executionReceipt: { payload: receiptPayload, signature },
      }), { status: 200 });
    },
  };
}

test("SDK never executes a sensitive tool when the gateway is unavailable", async () => {
  const client = new AgentGuardClient({ baseUrl: "https://guard.test", agentId: "agent-1", token: "ag_live_test-token", fetchImpl: async () => { throw new Error("offline"); } });
  let executions = 0;
  await assert.rejects(
    client.execute({ input: "refund", executionContext: { actorId: "user-1", orderId: "ORDER-1", issuedAt: Date.now() }, tools: { issue_refund: async () => { executions += 1; } } }),
    AgentGuardUnavailableError,
  );
  assert.equal(executions, 0);
});

test("SDK consumes approval before executing and rejects modified arguments", async () => {
  const fake = fakeFetchFactory();
  const client = new AgentGuardClient({ baseUrl: "https://guard.test", agentId: "agent-1", token: "ag_live_test-token", fetchImpl: fake.fetch });
  let executions = 0;
  const result = await client.execute({ input: "refund", tools: { issue_refund: async (args) => { executions += 1; assert.equal(args.amount, 40); return "ok"; } } });
  assert.equal(fake.consumed, 1);
  assert.equal(executions, 1);
  assert.deepEqual(result.executions, ["ok"]);

  const tampered = new AgentGuardClient({ baseUrl: "https://guard.test", agentId: "agent-1", token: "ag_live_test-token", fetchImpl: fakeFetchFactory({ tamper: true }).fetch });
  await assert.rejects(tampered.execute({ input: "refund", tools: { issue_refund: async () => { throw new Error("must not run"); } } }), /arguments changed/);
});

test("SDK validates every executor before consuming any approval", async () => {
  const fake = fakeFetchFactory();
  const fetchWithMissingExecutor = async (url, init) => {
    const response = await fake.fetch(url, init);
    if (!url.endsWith("/invoke")) return response;
    const body = await response.json();
    body.approved_tool_calls.push({
      call: { name: "cancel_order", arguments: { order_id: "ORDER-1" } },
      approval: body.approved_tool_calls[0].approval,
    });
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const client = new AgentGuardClient({ baseUrl: "https://guard.test", agentId: "agent-1", token: "ag_live_test-token", fetchImpl: fetchWithMissingExecutor });
  let executions = 0;
  await assert.rejects(
    client.execute({ input: "refund", tools: { issue_refund: async () => { executions += 1; } } }),
    /No executor is registered for cancel_order/,
  );
  assert.equal(fake.consumed, 0);
  assert.equal(executions, 0);
});

test("canonical approval material changes when one argument changes", () => {
  assert.notEqual(
    stableStringify({ tool: "issue_refund", arguments: { amount: 40 } }),
    stableStringify({ tool: "issue_refund", arguments: { amount: 41 } }),
  );
});

test("execution receipts are signed, time-bound, and bind exact arguments", () => {
  const token = "ag_live_test-token";
  const payload = {
    version: 1,
    approvalId: "approval-once",
    agentId: "agent-1",
    workspaceId: "workspace-1",
    requestId: "request-1",
    tool: "issue_refund",
    arguments: { order_id: "ORDER-1", amount: 40 },
    context: { actorId: "user-1", orderId: "ORDER-1" },
    consumedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30000).toISOString(),
  };
  const signature = createHmac("sha256", token).update(stableStringify(payload)).digest("base64url");
  const receipt = { payload, signature };
  assert.equal(verifyExecutionReceipt(receipt, token), true);
  assert.equal(verifyExecutionReceipt(receipt, "another-secret"), false);
  assert.equal(verifyExecutionReceipt({ ...receipt, payload: { ...payload, arguments: { ...payload.arguments, amount: 400 } } }, token), false);
  assert.equal(verifyExecutionReceipt(receipt, token, { now: Date.parse(payload.expiresAt) }), false);
});
