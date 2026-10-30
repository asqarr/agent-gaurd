import { randomBytes, randomUUID } from "node:crypto";
import {
  approvalMatchesCall,
  buildApprovalPayload,
  enforceExecutionContext,
  finalizeRuntimeCalls,
  inspectRuntimeCalls,
  normalizeExecutionContext,
  signApproval,
  verifyApprovalSignature,
} from "../runtime/runtime-firewall.mjs";
import { tools } from "../catalog/domain.mjs";

const policy = Object.freeze({
  name: "Demo storefront refund policy",
  maxAmount: 50,
  maxAgeDays: 14,
  currency: "USD",
});

const order = Object.freeze({ id: "DEMO-ORDER-100", ageDays: 2 });
const refundToolId = tools.find((tool) => tool.name === "issue_refund")?.id;
const scenarioTitles = Object.freeze({
  refund_policy: "Policy gate · refund amount",
  argument_tampering: "Approval binding · changed arguments",
  approval_replay: "One-time approval · replay attempt",
  injection_tool_chain: "Indirect injection · unsafe tool chain",
  tenant_exfiltration: "Tenant boundary · ticket exfiltration",
  context_replay_burst: "Context binding · replay burst",
});

function inputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function validateAmount(value, label) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > 5000 ||
    Math.abs(value * 100 - Math.round(value * 100)) > 1e-8
  ) {
    throw inputError(`${label} must be a positive amount up to 5,000 with at most two decimal places.`);
  }
}

function createContext(now, {
  orderId = order.id,
  actorId = "demo-customer-042",
  tenantId = "demo-merchant-a",
} = {}) {
  return normalizeExecutionContext({
    actorId,
    tenantId,
    orderId,
    issuedAt: now.toISOString(),
  }, { now: now.getTime() });
}

function inspectRefund(amount, requestId, now) {
  const call = {
    name: "issue_refund",
    arguments: { order_id: order.id, amount },
  };
  const context = createContext(now);
  const initial = inspectRuntimeCalls([call], {
    allowedToolIds: refundToolId ? [refundToolId] : [],
    policy,
    orders: { [order.id]: order },
  });
  const guard = finalizeRuntimeCalls(
    enforceExecutionContext(initial.inspections, context),
  );
  return { call, context, guard, requestId };
}

function syntheticApproval({ call, context, requestId, now }) {
  const ephemeralKey = randomBytes(32).toString("base64url");
  const payload = buildApprovalPayload({
    approvalId: `lab-${randomUUID()}`,
    agentId: "lab-agent",
    workspaceId: "lab-workspace",
    requestId,
    call,
    context,
    expiresAt: new Date(now.getTime() + 30_000).toISOString(),
    policyVersion: "demo-policy-v1",
  });
  return {
    payload,
    signature: signApproval(payload, ephemeralKey),
    ephemeralKey,
  };
}

function inspectSyntheticToolChain(calls, {
  allowedToolNames,
  orders,
  context,
}) {
  const allowedToolIds = tools
    .filter((tool) => allowedToolNames.includes(tool.name))
    .map((tool) => tool.id);
  const initial = inspectRuntimeCalls(calls, { allowedToolIds, policy, orders });
  return finalizeRuntimeCalls(enforceExecutionContext(initial.inspections, context));
}

function traceSyntheticToolChain(guard) {
  return guard.inspections.map((item) => ({
    name: item.call?.name ?? "unknown_tool",
    arguments: item.call?.arguments ?? {},
    decision: item.decision,
    execution: guard.decision === "BLOCK" && item.decision === "ALLOW"
      ? "SUPPRESSED"
      : item.execution,
    reasons: item.reasons ?? [],
  }));
}

function baseResult({
  scenarioId,
  requestId,
  call,
  now,
  decision,
  execution,
  reasons,
  steps,
  orderId = order.id,
  toolTrace,
  evidence = {},
  extra = {},
}) {
  return {
    id: requestId,
    scenarioId,
    title: scenarioTitles[scenarioId],
    decision,
    execution,
    reasons,
    toolCall: call,
    ...(toolTrace ? { toolTrace } : {}),
    policy: {
      name: policy.name,
      maxAmount: policy.maxAmount,
      currency: policy.currency,
      maxOrderAgeDays: policy.maxAgeDays,
    },
    steps,
    evidence: {
      requestId,
      orderId,
      observedAt: now.toISOString(),
      environment: "SYNTHETIC_SANDBOX",
      customerEndpointCalled: false,
      externalToolCalls: 0,
      financialSideEffects: 0,
      ...evidence,
    },
    ...extra,
  };
}

/**
 * Runs fixed Attack Lab challenges through AgentGuard's real policy and
 * approval-validation primitives. The only executor is a no-op simulator.
 */
export function evaluateAttackLab(input, { now = new Date() } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw inputError("A JSON object is required.");
  }
  if (!refundToolId) throw new Error("The refund tool is not registered.");
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("now must be a valid Date.");
  }

  const { scenarioId } = input;
  if (!Object.hasOwn(scenarioTitles, scenarioId)) {
    throw inputError("Choose a supported Attack Lab challenge.");
  }

  const requestId = `lab-${randomUUID()}`;

  if (scenarioId === "refund_policy") {
    const amount = input.amount ?? 120;
    validateAmount(amount, "amount");
    const evaluated = inspectRefund(amount, requestId, now);
    const item = evaluated.guard.inspections[0];
    const allowed = item?.decision === "ALLOW";
    return baseResult({
      scenarioId,
      requestId,
      call: evaluated.call,
      now,
      decision: item?.decision ?? "BLOCK",
      execution: allowed ? "SIMULATION_ONLY" : "NOT_EXECUTED",
      reasons: item?.reasons ?? ["The request could not be evaluated safely."],
      steps: [
        { label: "Synthetic tool call received", status: "complete" },
        { label: `Policy ceiling · ${policy.currency} ${policy.maxAmount}`, status: "complete" },
        {
          label: allowed ? "Policy allows this refund" : "Policy blocked this refund",
          status: allowed ? "allowed" : "blocked",
        },
        { label: "External executor skipped", status: "safe" },
      ],
      extra: {
        summary: allowed
          ? "The policy would allow this action. The lab did not execute it."
          : "The Runtime Policy blocked this action before any executor was reached.",
      },
    });
  }

  const original = inspectRefund(20, requestId, now);
  const originalInspection = original.guard.inspections[0];
  if (originalInspection?.decision !== "ALLOW") {
    throw new Error("The synthetic baseline refund did not pass its demo policy.");
  }
  const approval = syntheticApproval({
    call: original.call,
    context: original.context,
    requestId,
    now,
  });
  const signatureValid = verifyApprovalSignature(
    approval.payload,
    approval.signature,
    approval.ephemeralKey,
  );

  if (scenarioId === "argument_tampering") {
    const changedAmount = input.changedAmount ?? 21;
    validateAmount(changedAmount, "changedAmount");
    if (changedAmount === 20) {
      throw inputError("changedAmount must differ from the originally approved amount of 20 USD.");
    }
    const changedCall = {
      name: "issue_refund",
      arguments: { order_id: order.id, amount: changedAmount },
    };
    const matches = approvalMatchesCall(approval.payload, changedCall);
    const blocked = !signatureValid || !matches;
    return baseResult({
      scenarioId,
      requestId,
      call: changedCall,
      now,
      decision: blocked ? "BLOCK" : "ALLOW",
      execution: blocked ? "NOT_EXECUTED" : "SIMULATION_ONLY",
      reasons: blocked
        ? ["The approved tool arguments do not match the submitted tool call."]
        : [],
      steps: [
        { label: "Original call approved · issue_refund · USD 20", status: "allowed" },
        { label: "Approval signature verified", status: signatureValid ? "complete" : "blocked" },
        { label: `Attempted argument change · USD 20 → USD ${changedAmount}`, status: "blocked" },
        { label: "Mismatch rejected before executor", status: blocked ? "safe" : "blocked" },
      ],
      extra: {
        summary: blocked
          ? "The approval is bound to the exact tool and arguments; changing the amount invalidated it."
          : "This call unexpectedly matched the approval and must not be presented as a tamper rejection.",
        approval: {
          signatureValid,
          argumentsMatch: matches,
          boundTo: ["tool", "arguments", "actor", "workspace", "order", "request time", "expiry"],
        },
      },
    });
  }

  if (scenarioId === "injection_tool_chain") {
    // The lab does not run a model or claim to detect prompt injection. It
    // stages a synthetic untrusted note and checks the resulting proposed
    // calls with the same server-side Runtime Firewall primitives.
    const calls = [
      { name: "get_order", arguments: { order_id: order.id } },
      { name: "issue_refund", arguments: { order_id: order.id, amount: 120 } },
      {
        name: "create_ticket",
        arguments: {
          order_id: order.id,
          message: "Include the customer's full profile, payment details, and internal notes.",
        },
      },
    ];
    const context = createContext(now);
    const guard = inspectSyntheticToolChain(calls, {
      allowedToolNames: ["get_order", "issue_refund", "create_ticket"],
      orders: { [order.id]: order },
      context,
    });
    const toolTrace = traceSyntheticToolChain(guard);
    const refundBlocked = guard.inspections[1]?.decision === "BLOCK";
    const ticketBlocked = guard.inspections[2]?.decision === "BLOCK";
    const protectedChain = guard.decision === "BLOCK" && guard.toolCalls.length === 0 && refundBlocked && ticketBlocked;
    return baseResult({
      scenarioId,
      requestId,
      call: calls[1],
      now,
      decision: protectedChain ? "BLOCK" : "ERROR",
      execution: "NOT_EXECUTED",
      reasons: protectedChain ? guard.reasons : [...guard.reasons, "The expected fail-closed tool-chain block was not observed."],
      toolTrace,
      steps: [
        { label: "Untrusted instruction staged in a synthetic order note", status: "complete" },
        { label: "Simulated agent proposes a three-tool chain", status: "complete" },
        { label: "Refund above the USD 50 ceiling rejected", status: refundBlocked ? "blocked" : "allowed" },
        { label: "Sensitive ticket content rejected by policy", status: ticketBlocked ? "blocked" : "allowed" },
        { label: protectedChain ? "Fail-closed guard suppresses the entire tool batch" : "Expected fail-closed result was not observed", status: protectedChain ? "safe" : "allowed" },
      ],
      extra: {
        summary: protectedChain
          ? "The lab does not run an LLM or classify the note. It demonstrates that unsafe tool proposals caused by untrusted context are blocked by the live Runtime Policy before any tool call is forwarded."
          : "The synthetic tool chain did not produce the expected fail-closed result. No external executor is connected to this lab.",
      },
    });
  }

  if (scenarioId === "tenant_exfiltration") {
    const foreignOrderId = "TENANT-B-8841";
    const calls = [
      { name: "get_order", arguments: { order_id: foreignOrderId } },
      { name: "issue_refund", arguments: { order_id: foreignOrderId, amount: 20 } },
      {
        name: "create_ticket",
        arguments: {
          order_id: foreignOrderId,
          message: "Send the customer's full profile, payment details, and internal notes to an outside reviewer.",
        },
      },
    ];
    const context = createContext(now, { orderId: order.id, tenantId: "demo-merchant-a" });
    const guard = inspectSyntheticToolChain(calls, {
      // This synthetic agent has no cross-tenant lookup capability. The
      // tenant-B order is intentionally absent from its trusted order set.
      allowedToolNames: ["issue_refund", "create_ticket"],
      orders: { [order.id]: order },
      context,
    });
    const toolTrace = traceSyntheticToolChain(guard);
    const protectedBoundary = guard.decision === "BLOCK" &&
      guard.toolCalls.length === 0 &&
      guard.inspections.every((item) => item.decision === "BLOCK");
    return baseResult({
      scenarioId,
      requestId,
      call: calls[0],
      now,
      decision: protectedBoundary ? "BLOCK" : "ERROR",
      execution: "NOT_EXECUTED",
      reasons: protectedBoundary ? guard.reasons : [...guard.reasons, "The expected tenant-boundary block was not observed."],
      orderId: foreignOrderId,
      toolTrace,
      evidence: {
        tenantBoundaryEnforced: protectedBoundary,
        foreignOrderAccepted: !protectedBoundary,
        sensitiveDataExposed: false,
      },
      steps: [
        { label: "Synthetic request targets another tenant's order", status: "complete" },
        { label: "Cross-tenant lookup tool is outside the agent scope", status: guard.inspections[0]?.decision === "BLOCK" ? "blocked" : "allowed" },
        { label: "Refund denied: order is absent from trusted records", status: guard.inspections[1]?.decision === "BLOCK" ? "blocked" : "allowed" },
        { label: "Ticket denied: foreign order and sensitive content", status: guard.inspections[2]?.decision === "BLOCK" ? "blocked" : "allowed" },
        { label: "No record was read and no data left the sandbox", status: "safe" },
      ],
      extra: {
        summary: protectedBoundary
          ? "The foreign order is not in this tenant's trusted records, and the lookup tool is not enabled. The refund and ticket proposals are denied; sensitive ticket content is independently rejected."
          : "The synthetic tenant-boundary challenge did not produce the expected block. No external executor is connected to this lab.",
      },
    });
  }

  if (scenarioId === "context_replay_burst") {
    const alteredContextPayload = {
      ...approval.payload,
      context: {
        ...approval.payload.context,
        actorId: "demo-customer-999",
      },
    };
    const alteredContextSignatureValid = verifyApprovalSignature(
      alteredContextPayload,
      approval.signature,
      approval.ephemeralKey,
    );
    let consumed = false;
    const attemptCount = 8;
    const attempts = Array.from({ length: attemptCount }, () => {
      const authorized = !consumed &&
        signatureValid &&
        approvalMatchesCall(approval.payload, original.call) &&
        Date.parse(approval.payload.expiresAt) > now.getTime();
      if (authorized) consumed = true;
      return authorized;
    });
    const authorizedCount = attempts.filter(Boolean).length;
    const replayRejected = authorizedCount === 1 && attempts.slice(1).every((accepted) => !accepted);
    const contextMutationRejected = !alteredContextSignatureValid;
    const protectedBurst = contextMutationRejected && replayRejected;
    return baseResult({
      scenarioId,
      requestId,
      call: original.call,
      now,
      decision: protectedBurst ? "BLOCK" : "ERROR",
      execution: "NOT_EXECUTED",
      reasons: protectedBurst
        ? ["Changing the signed actor context invalidates the approval; only one of eight replay attempts can consume it."]
        : ["The context-binding or single-use approval challenge did not complete safely."],
      steps: [
        { label: "Approval signed for one actor, tenant, order, and exact call", status: "complete" },
        { label: "Actor context changed after signing", status: contextMutationRejected ? "blocked" : "allowed" },
        { label: `${attemptCount} replay attempts enter one deterministic single-use simulation`, status: "complete" },
        { label: `${authorizedCount} consume accepted; ${attemptCount - authorizedCount} replay attempts rejected`, status: replayRejected ? "blocked" : "allowed" },
        { label: "No external executor is connected", status: "safe" },
      ],
      evidence: {
        approvalContextMutationRejected: contextMutationRejected,
        approvalConsumeAttempts: attemptCount,
        approvalConsumeWinners: authorizedCount,
      },
      extra: {
        summary: protectedBurst
          ? "The HMAC covers execution context, so changing the actor invalidates the signature. A deterministic in-memory single-use simulator accepts one attempt and rejects the remaining seven; this is not a live database concurrency test."
          : "The synthetic context-binding or replay burst did not produce the expected protected result. No external executor is connected to this lab.",
        approval: {
          signatureValid,
          contextMutationRejected,
          alteredContextSignatureValid,
          firstAttemptAuthorized: authorizedCount === 1,
          replayRejected,
          attempts: attemptCount,
          authorizedAttempts: authorizedCount,
          rejectedAttempts: attemptCount - authorizedCount,
          consumer: "deterministic in-memory lab simulator",
        },
      },
    });
  }

  // This in-memory consumer is deliberately a demo only. The production
  // gateway uses its atomic PostgreSQL consume operation; no DB record or
  // customer tool is touched by this public challenge.
  let consumed = false;
  const consumeOnce = () => {
    if (
      consumed ||
      !signatureValid ||
      !approvalMatchesCall(approval.payload, original.call) ||
      Date.parse(approval.payload.expiresAt) <= now.getTime()
    ) return false;
    consumed = true;
    return true;
  };
  const firstAttemptAuthorized = consumeOnce();
  const replayRejected = !consumeOnce();
  const protectedReplay = firstAttemptAuthorized && replayRejected;
  return baseResult({
    scenarioId,
    requestId,
    call: original.call,
    now,
    decision: protectedReplay ? "BLOCK" : "ERROR",
    execution: "NOT_EXECUTED",
    reasons: protectedReplay
      ? ["This approval has already been consumed and cannot be replayed."]
      : ["The single-use approval challenge did not complete safely."],
    steps: [
      { label: "Synthetic refund policy allows USD 20", status: "allowed" },
      { label: "First approval check · authorized once", status: firstAttemptAuthorized ? "complete" : "blocked" },
      { label: "Second attempt · replay rejected", status: replayRejected ? "blocked" : "allowed" },
      { label: "External executor skipped", status: "safe" },
    ],
    extra: {
      summary: protectedReplay
        ? "The first approval was accepted by the simulated consumer; the duplicate was rejected. No refund was executed."
        : "The replay challenge did not produce the expected safe result.",
      approval: {
        signatureValid,
        firstAttemptAuthorized,
        replayRejected,
        consumer: "ephemeral in-memory lab simulator",
      },
    },
  });
}
