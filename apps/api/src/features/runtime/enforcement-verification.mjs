import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  AgentGuardClient,
  AgentGuardError,
  AgentGuardUnavailableError,
  stableStringify,
} from "@agentguard/sdk";
import { inspectRuntimeCalls, enforceExecutionContext, finalizeRuntimeCalls } from "./runtime-firewall.mjs";

const verifierVersion = "runtime-verifier-v1";
const syntheticOrder = "AG-VERIFY-ORDER";

function signed(payload, token) {
  return createHmac("sha256", token).update(stableStringify(payload)).digest("base64url");
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeSdkGateway({ token, agentId, mode }) {
  const requestId = `verify-${randomUUID()}`;
  const call = {
    name: "issue_refund",
    arguments: { order_id: syntheticOrder, amount: 40 },
  };
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const payload = {
    version: 1,
    approvalId: `verification-${randomUUID()}`,
    agentId,
    workspaceId: "synthetic-verification-workspace",
    requestId,
    tool: call.name,
    arguments: call.arguments,
    context: {
      actorId: "synthetic-verification-actor",
      tenantId: "synthetic-verification-tenant",
      orderId: syntheticOrder,
      issuedAt: new Date().toISOString(),
    },
    policyVersion: verifierVersion,
    expiresAt,
  };
  const approval = { id: payload.approvalId, payload, signature: signed(payload, token), expiresAt };
  const presentedCall = mode === "tamper"
    ? { ...call, arguments: { ...call.arguments, amount: 41 } }
    : call;
  let consumed = false;
  let consumeAttempts = 0;

  const fetchImpl = async (url, options = {}) => {
    if (mode === "unavailable") throw new Error("synthetic gateway outage");
    if (mode === "timeout" || (mode === "consume_timeout" && !url.endsWith("/invoke"))) {
      return new Promise((resolve, reject) => {
        const abort = () => {
          const error = new Error("synthetic gateway timeout");
          error.name = "AbortError";
          reject(error);
        };
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (url.endsWith("/invoke")) {
      return jsonResponse({
        requestId,
        assistantText: "Synthetic conformance response.",
        tool_calls: [call],
        approved_tool_calls: [{ call: presentedCall, approval }],
        blocked_tool_calls: [],
        guard: { decision: "ALLOW", execution: "PASS_THROUGH", reasons: [] },
      });
    }

    consumeAttempts += 1;
    if (mode === "replay" && consumed) {
      return jsonResponse({ error: "Approval is expired or has already been consumed.", code: "APPROVAL_REPLAYED_OR_EXPIRED" }, 409);
    }
    consumed = true;
    const consumedAt = new Date().toISOString();
    const receiptPayload = {
      version: 1,
      approvalId: payload.approvalId,
      agentId,
      workspaceId: payload.workspaceId,
      requestId,
      tool: call.name,
      arguments: call.arguments,
      context: payload.context,
      consumedAt,
      expiresAt,
    };
    return jsonResponse({
      approved: true,
      approvalId: payload.approvalId,
      execution: "AUTHORIZED_ONCE",
      executionReceipt: { payload: receiptPayload, signature: signed(receiptPayload, token) },
    });
  };

  return { fetchImpl, get consumeAttempts() { return consumeAttempts; } };
}

async function verifySdkBehavior({ mode, agentId, executions }) {
  const token = `ag_verify_${randomBytes(32).toString("base64url")}`;
  const gateway = makeSdkGateway({ token, agentId, mode });
  const client = new AgentGuardClient({
    baseUrl: "https://agentguard.synthetic.invalid",
    agentId,
    token,
    fetchImpl: gateway.fetchImpl,
    timeoutMs: 100,
  });
  const tools = {
    issue_refund: async () => {
      executions.count += 1;
      return { simulated: true };
    },
  };

  if (mode === "replay") {
    await client.execute({ input: "synthetic replay check", tools });
    try {
      await client.execute({ input: "synthetic replay check", tools });
      return { passed: false, consumeAttempts: gateway.consumeAttempts, executions: executions.count };
    } catch (error) {
      return {
        passed: error instanceof AgentGuardError && error.code === "APPROVAL_REPLAYED_OR_EXPIRED" && executions.count === 1,
        consumeAttempts: gateway.consumeAttempts,
        executions: executions.count,
      };
    }
  }

  try {
    await client.execute({ input: "synthetic SDK conformance check", tools });
    return { passed: mode === "valid" && executions.count === 1, consumeAttempts: gateway.consumeAttempts, executions: executions.count };
  } catch (error) {
    const passed = mode === "tamper"
      ? error instanceof AgentGuardError && error.code === "APPROVAL_MISMATCH" && executions.count === 0 && gateway.consumeAttempts === 0
      : mode === "unavailable" || mode === "timeout" || mode === "consume_timeout"
        ? error instanceof AgentGuardUnavailableError && executions.count === 0
        : false;
    return { passed, code: error instanceof AgentGuardError ? error.code : "UNEXPECTED_ERROR", consumeAttempts: gateway.consumeAttempts, executions: executions.count };
  }
}

function check({ id, title, tool, passed, expected, observed, reproduction, remediation, evidence = {} }) {
  return {
    id,
    title,
    tool,
    status: passed ? "passed" : "failed",
    expected,
    observed,
    reproduction,
    remediation,
    evidence: { ...evidence, customerEndpointCalled: false, externalToolCalls: 0, financialSideEffects: 0 },
  };
}

export function enforcementVerificationFingerprint({ agent, policy, contract }) {
  const input = {
    verifierVersion,
    runtimeEnabled: Boolean(agent.runtimeEnabled),
    agentStatus: agent.status ?? null,
    endpointFingerprint: agent.endpoint
      ? createHash("sha256").update(String(agent.endpoint)).digest("hex")
      : null,
    toolIds: [...(agent.tools ?? [])].sort(),
    policy: {
      id: policy?.id ?? null,
      name: policy?.name ?? "Storefront refunds",
      maxAmount: Number(policy?.maxAmount ?? 50),
      maxAgeDays: Number(policy?.maxAgeDays ?? 14),
      currency: policy?.currency ?? "USD",
    },
    contract: {
      version: Number(contract?.version ?? 0),
      allowedToolIds: [...(contract?.allowedToolIds ?? agent.tools ?? [])].sort(),
      maxRefundAmount: Number(contract?.maxRefundAmount ?? policy?.maxAmount ?? 50),
      maxOrderAgeDays: Number(contract?.maxOrderAgeDays ?? policy?.maxAgeDays ?? 14),
    },
  };
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

/**
 * Exercises the AgentGuard policy, SDK package, and PostgreSQL one-time consume
 * primitive using synthetic calls and no customer endpoint or real executor.
 */
export async function runEnforcementVerification({
  agent,
  policy,
  contract,
  consumeReplayProbe,
  now = new Date(),
}) {
  if (!agent?.id || !agent?.workspaceId) throw new TypeError("A workspace-scoped agent is required.");
  if (typeof consumeReplayProbe !== "function") throw new TypeError("A database replay probe is required.");

  const effectivePolicy = {
    ...policy,
    maxAmount: Math.min(Number(policy?.maxAmount ?? 50), Number(contract?.maxRefundAmount ?? policy?.maxAmount ?? 50)),
    maxAgeDays: Math.min(Number(policy?.maxAgeDays ?? 14), Number(contract?.maxOrderAgeDays ?? policy?.maxAgeDays ?? 14)),
  };
  const allowedToolIds = contract?.allowedToolIds ?? agent.tools ?? [];
  const call = {
    name: "issue_refund",
    arguments: { order_id: syntheticOrder, amount: effectivePolicy.maxAmount + 1 },
  };
  const initial = inspectRuntimeCalls([call], {
    allowedToolIds,
    policy: effectivePolicy,
    orders: { [syntheticOrder]: { ageDays: 1 } },
  });
  const contextual = enforceExecutionContext(initial.inspections, {
    actorId: "synthetic-verification-actor",
    tenantId: "synthetic-verification-tenant",
    orderId: syntheticOrder,
    issuedAt: now.toISOString(),
  });
  const policyResult = finalizeRuntimeCalls(contextual);
  const refundCeilingReason = policyResult.reasons.find((reason) => reason.startsWith("Requested amount is "));
  const checks = [check({
    id: "over_limit_refund",
    title: "Over-limit refund is blocked before execution",
    tool: "issue_refund",
    passed: policyResult.decision === "BLOCK" && policyResult.execution === "NOT_EXECUTED" && Boolean(refundCeilingReason),
    expected: `BLOCK refund above ${effectivePolicy.currency ?? "USD"} ${effectivePolicy.maxAmount}; no executor call`,
    reproduction: `Submit the synthetic issue_refund call for ${call.arguments.amount} against ${syntheticOrder}; its amount is one unit above the active ceiling.`,
    remediation: refundCeilingReason ? "No action required for this check. Keep the refund policy and allowed-tool contract under change control." : "Enable the refund tool only if needed and configure a refund ceiling; rerun to verify the specific ceiling rule, not just a generic block.",
    observed: `${policyResult.decision} / ${policyResult.execution}${refundCeilingReason ? ` / ${refundCeilingReason}` : ` / ${policyResult.reasons.join("; ") || "No refund-ceiling reason returned"}`}`, 
    evidence: { attemptedAmount: call.arguments.amount, ceiling: effectivePolicy.maxAmount, reasons: policyResult.reasons, syntheticExecutorCalls: 0 },
  })];

  const tamperExecutions = { count: 0 };
  const tamper = await verifySdkBehavior({ mode: "tamper", agentId: agent.id, executions: tamperExecutions });
  checks.push(check({
    id: "argument_tampering",
    title: "SDK rejects arguments changed after approval",
    tool: "issue_refund",
    passed: tamper.passed,
    expected: "Reject the altered call before consume and before executor",
    reproduction: "Obtain a synthetic approval, change its refund amount, and pass the altered arguments to the bundled SDK executor.",
    remediation: "No action required for this check. Keep the SDK on the execution path and never execute raw model Tool Calls.",
    observed: tamper.passed ? "APPROVAL_MISMATCH / not consumed / not executed" : `${tamper.code ?? "unexpected"} / ${tamper.executions} executor calls`, 
    evidence: { syntheticExecutorCalls: tamper.executions, consumeAttempts: tamper.consumeAttempts },
  }));

  const replay = await consumeReplayProbe();
  const replayExecutions = { count: 0 };
  const sdkReplay = await verifySdkBehavior({ mode: "replay", agentId: agent.id, executions: replayExecutions });
  checks.push(check({
    id: "single_use_replay",
    title: "Concurrent and SDK replay attempts cannot reuse approval",
    tool: "issue_refund",
    passed: replay.accepted === 1 && replay.attempts >= 2 && sdkReplay.passed,
    expected: "Exactly one PostgreSQL consume succeeds; SDK replay does not execute twice",
    reproduction: "Submit eight concurrent consumes for one synthetic approval, then replay the same signed approval through the SDK.",
    remediation: "No action required for this check. Keep all API replicas on the same transactional PostgreSQL store; do not replace atomic consume with process-local state.",
    observed: `${replay.accepted}/${replay.attempts} database consumes accepted / ${sdkReplay.executions} synthetic SDK executions across replay attempts`, 
    evidence: { databaseProbe: replay, sdkProbe: sdkReplay, syntheticExecutorCalls: sdkReplay.executions },
  }));

  const outageExecutions = { count: 0 };
  const outage = await verifySdkBehavior({ mode: "unavailable", agentId: agent.id, executions: outageExecutions });
  const timeoutExecutions = { count: 0 };
  const timeout = await verifySdkBehavior({ mode: "timeout", agentId: agent.id, executions: timeoutExecutions });
  const consumeTimeoutExecutions = { count: 0 };
  const consumeTimeout = await verifySdkBehavior({ mode: "consume_timeout", agentId: agent.id, executions: consumeTimeoutExecutions });
  checks.push(check({
    id: "gateway_unavailable",
    title: "Gateway outage or timeout fails closed",
    tool: "issue_refund",
    passed: outage.passed && timeout.passed && consumeTimeout.passed,
    expected: "Outage and timeout during invoke or approval consumption must invoke no executor",
    reproduction: "Run the bundled SDK against synthetic gateways that fail before approval or time out while consuming an already-issued approval.",
    remediation: "Keep sensitive execution exclusively after a verified one-time receipt. If the gateway is unavailable, do not fall back to direct tool execution.",
    observed: `outage=${outage.passed ? "blocked" : `${outage.code} / ${outage.executions} executions`}; invoke-timeout=${timeout.passed ? "blocked" : `${timeout.code} / ${timeout.executions} executions`}; consume-timeout=${consumeTimeout.passed ? "blocked" : `${consumeTimeout.code} / ${consumeTimeout.executions} executions`}`, 
    evidence: {
      outage: { code: outage.code, executions: outage.executions },
      invokeTimeout: { code: timeout.code, executions: timeout.executions },
      consumeTimeout: { code: consumeTimeout.code, executions: consumeTimeout.executions },
    },
  }));

  const validExecutions = { count: 0 };
  const valid = await verifySdkBehavior({ mode: "valid", agentId: agent.id, executions: validExecutions });
  checks.push(check({
    id: "valid_approved_call",
    title: "A valid approved call reaches the synthetic executor once",
    tool: "issue_refund",
    passed: valid.passed,
    expected: "Valid signed approval is consumed before one synthetic executor call",
    reproduction: "Pass a correctly signed synthetic approval through the bundled SDK to a no-op executor.",
    remediation: "No action required for this check. Continue validating the deployed customer executor separately in Staging.",
    observed: valid.passed ? "AUTHORIZED_ONCE / one synthetic execution" : `${valid.executions} executions / ${valid.consumeAttempts} consume attempts`, 
    evidence: { syntheticExecutorCalls: valid.executions, consumeAttempts: valid.consumeAttempts },
  }));

  const failed = checks.filter((item) => item.status === "failed").length;
  const allowedNames = allowedToolIds;
  return {
    id: `verify-${randomUUID()}`,
    status: failed === 0 ? "passed" : "failed",
    verifierVersion,
    testedAt: now.toISOString(),
    scope: {
      agentId: agent.id,
      agentName: agent.name,
      policy: {
        name: effectivePolicy.name ?? "Storefront refunds",
        maxAmount: effectivePolicy.maxAmount,
        maxAgeDays: effectivePolicy.maxAgeDays,
        currency: effectivePolicy.currency ?? "USD",
      },
      contractVersion: Number(contract?.version ?? 0),
      allowedToolIds: allowedNames,
      environment: "AGENTGUARD_SYNTHETIC_CONFORMANCE",
    },
    summary: {
      passed: checks.length - failed,
      failed,
      total: checks.length,
      customerEndpointCalls: 0,
      externalToolCalls: 0,
      financialSideEffects: 0,
    },
    checks,
    notTested: [
      "Customer application source code and alternate direct-to-tool routes.",
      "The deployed SDK version and configuration inside the customer's process.",
      "Live external provider behavior, business database writes, and production availability/latency.",
    "A separately deployed multi-API-replica test; this run checks concurrent atomic consumption against the shared PostgreSQL database.",
    ],
    limitations: [
      "This is an AgentGuard control-plane and bundled SDK conformance run using synthetic requests and no-op executors; it is not an independent audit of the customer's application.",
      "A customer backend can still bypass an external gateway if it executes raw model Tool Calls through another route. Verify the customer's own executor in an isolated Staging harness before Production.",
      "A passing result is not a security certification or a guarantee against all attacks.",
    ],
    fingerprint: enforcementVerificationFingerprint({ agent, policy, contract }),
  };
}
