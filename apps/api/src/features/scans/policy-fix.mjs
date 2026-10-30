import { defaultOrders } from "../policies/policy-guard.mjs";
import { scenarios } from "../catalog/domain.mjs";

function minorUnits(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const text = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

function amountFix({ scan, result, scenario, policy }) {
  if (!["amount_limit", "above_boundary"].includes(scenario.id)) return null;
  if (result.call?.name !== "issue_refund") return null;
  const amount = minorUnits(result.call.arguments?.amount);
  const current = minorUnits(policy.maxAmount);
  if (amount === null || current === null || current < amount || amount <= 1) return null;
  const proposed = (amount - 1) / 100;
  return {
    id: `${scan.id}:${scenario.id}:maxAmount`,
    scanId: scan.id,
    scenarioId: scenario.id,
    policyId: policy.id,
    expectedPolicyVersion: Number(policy.version),
    field: "maxAmount",
    label: "Maximum refund amount",
    currentValue: current / 100,
    proposedValue: proposed,
    evidenceValue: amount / 100,
    currency: policy.currency,
    title: `Block the ${policy.currency} ${(amount / 100).toFixed(2)} proposal`,
    rationale: `The saved scan evidence shows this amount passed the policy guard. A ceiling one cent lower blocks this exact test while keeping the change as narrow as the evidence supports.`,
  };
}

function ageFix({ scan, result, scenario, policy }) {
  if (scenario.id !== "expired_order" || result.call?.name !== "issue_refund") return null;
  const orderId = result.call.arguments?.order_id;
  if (orderId !== scenario.orderId) return null;
  const trustedOrder = defaultOrders[orderId];
  const current = Number(policy.maxAgeDays);
  if (!trustedOrder || !Number.isInteger(current) || current < trustedOrder.ageDays) return null;
  const proposed = trustedOrder.ageDays - 1;
  if (proposed < 1 || proposed >= current) return null;
  return {
    id: `${scan.id}:${scenario.id}:maxAgeDays`,
    scanId: scan.id,
    scenarioId: scenario.id,
    policyId: policy.id,
    expectedPolicyVersion: Number(policy.version),
    field: "maxAgeDays",
    label: "Trusted purchase window",
    currentValue: current,
    proposedValue: proposed,
    evidenceValue: trustedOrder.ageDays,
    currency: policy.currency,
    title: `Reject orders older than ${proposed} days`,
    rationale: `The saved scan used trusted order ${orderId}, which is ${trustedOrder.ageDays} days old. A ${proposed}-day window blocks that exact case.`,
  };
}

export function buildPolicyFixProposal({ scan, result, policy = scan?.policySnapshot?.policy } = {}) {
  if (
    !scan ||
    !result ||
    !policy ||
    scan.status !== "completed" ||
    scan.safetyStatus !== "safe" ||
    result.verdict !== "VULNERABLE" ||
    result.guard?.decision !== "ALLOW" ||
    result.executionSafety !== "safe" ||
    !policy.id ||
    !Number.isInteger(Number(policy.version)) ||
    Number(policy.version) < 1
  ) return null;

  const scenario = scenarios.find((item) => item.id === result.scenarioId);
  if (!scenario || scenario.expected !== "block") return null;
  const context = { scan, result, scenario, policy };
  const proposal = amountFix(context) ?? ageFix(context);
  return proposal
    ? {
        ...proposal,
        scope: "workspace",
        executionMode: result.executionMode ?? scan.executionMode ?? "unknown",
        warning: "This changes the workspace policy for all agents that use this Gateway policy. It does not edit the customer agent's source code.",
      }
    : null;
}
