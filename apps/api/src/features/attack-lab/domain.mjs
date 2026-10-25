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

function createContext(now, orderId = order.id) {
  return normalizeExecutionContext({
    actorId: "demo-customer-042",
    tenantId: "demo-merchant",
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

function baseResult({ scenarioId, requestId, call, now, decision, execution, reasons, steps, extra = {} }) {
  return {
    id: requestId,
    scenarioId,
    title: scenarioTitles[scenarioId],
    decision,
    execution,
    reasons,
    toolCall: call,
    policy: {
      name: policy.name,
      maxAmount: policy.maxAmount,
      currency: policy.currency,
      maxOrderAgeDays: policy.maxAgeDays,
    },
    steps,
    evidence: {
      requestId,
      orderId: order.id,
      observedAt: now.toISOString(),
      environment: "SYNTHETIC_SANDBOX",
      customerEndpointCalled: false,
      externalToolCalls: 0,
      financialSideEffects: 0,
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
