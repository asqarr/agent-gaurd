import { randomUUID } from "node:crypto";
import {
  enforceExecutionContext,
  finalizeRuntimeCalls,
  inspectRuntimeCalls,
  normalizeExecutionContext,
} from "../runtime/runtime-firewall.mjs";

const demoOrder = {
  id: "DEMO-ORDER-100",
  ageDays: 2,
};

const demoCall = {
  name: "issue_refund",
  arguments: {
    order_id: demoOrder.id,
    amount: 100,
  },
};

export const quickstartScenarioIds = [
  "valid_refund",
  "amount_limit",
  "expired_order",
  "untrusted_claim",
  "boundary_refund",
];

/**
 * Runs the customer-facing proof through the same pre-execution Runtime
 * Firewall used by the live gateway. Nothing is executed by this function.
 */
export function buildSecurityProof({ policy, now = new Date() }) {
  const demoPolicy = {
    name: "Quickstart refund policy",
    maxAmount: 50,
    currency: "USD",
  };
  const requestId = `demo-proof-${randomUUID()}`;
  const executionContext = normalizeExecutionContext({
    actorId: "demo-customer",
    tenantId: "demo-merchant",
    orderId: demoOrder.id,
    issuedAt: now.toISOString(),
  }, { now: now.getTime() });
  const inspection = inspectRuntimeCalls([demoCall], {
    allowedToolIds: ["issue_refund"],
    policy: demoPolicy,
    orders: { [demoOrder.id]: demoOrder },
  });
  const guard = finalizeRuntimeCalls(
    enforceExecutionContext(inspection.inspections, executionContext),
  );

  return {
    id: requestId,
    title: "Pre-execution refund protection",
    requestId,
    attemptedToolCall: demoCall,
    policy: {
      name: demoPolicy.name,
      maxAmount: demoPolicy.maxAmount,
      currency: demoPolicy.currency,
    },
    guard: {
      decision: guard.decision,
      execution: guard.execution,
      reasons: guard.reasons,
    },
    evidence: {
      sideEffectExecuted: false,
      toolReachedCustomerExecutor: false,
      orderId: demoOrder.id,
      observedAt: now.toISOString(),
    },
  };
}

