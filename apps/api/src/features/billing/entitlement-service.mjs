import * as repository from "../../infrastructure/repository.mjs";

const planLabels = Object.freeze({
  free: "Explorer",
  builder: "Builder",
  team: "Pro",
  agency: "Agency",
});

const entitlementMinimumPlans = Object.freeze({
  runtimeFirewall: "builder",
  incidentCenter: "builder",
  exportReports: "builder",
  autopilot: "team",
  sentinel: "team",
  alertWebhooks: "team",
  maxWebhooks: "team",
});

function nextPlanFor(currentPlan) {
  const order = ["free", "builder", "team", "agency"];
  const index = order.indexOf(currentPlan);
  if (index < 0) return "builder";
  return order[Math.min(order.length - 1, index + 1)] ?? "builder";
}

export function planLimitMetadata({ code, entitlement, currentPlan }) {
  let requiredPlan = entitlementMinimumPlans[entitlement];
  if (!requiredPlan && code === "SCENARIO_PLAN_REQUIRED") requiredPlan = "builder";
  if (!requiredPlan && code === "SUBSCRIPTION_REQUIRED") requiredPlan = "builder";
  if (!requiredPlan && ["SCAN_QUOTA_EXCEEDED", "RUNTIME_QUOTA_EXCEEDED", "AGENT_LIMIT_REACHED"].includes(code)) {
    requiredPlan = nextPlanFor(currentPlan);
  }
  return {
    currentPlan,
    requiredPlan,
    requiredPlanName: requiredPlan ? planLabels[requiredPlan] : undefined,
    nextActions: code === "RUNTIME_QUOTA_EXCEEDED"
      ? ["upgrade_plan", "purchase_runtime_addon"]
      : code === "SCAN_QUOTA_EXCEEDED"
        ? ["upgrade_plan", "purchase_scan_addon"]
        : ["upgrade_plan"],
  };
}

export async function planLimitResponse(req, res, error, extra = {}) {
  const workspaceId = extra.workspaceId ?? req.auth?.workspaceId;
  const { workspaceId: _workspaceId, ...responseExtra } = extra;
  const billing = workspaceId ? await repository.getBillingState(workspaceId).catch(() => null) : null;
  const metadata = planLimitMetadata({
    code: error?.code,
    entitlement: responseExtra.entitlement ?? error?.entitlement,
    currentPlan: billing?.plan?.id,
  });
  return res.status(402).json({
    error: error?.message ?? "This operation requires a higher plan.",
    code: error?.code ?? "PLAN_UPGRADE_REQUIRED",
    ...responseExtra,
    ...metadata,
  });
}

export async function requireEntitlement(req, res, entitlement, message) {
  const billing = await repository.getBillingState(req.auth.workspaceId);
  if (!billing.entitlements.active || !billing.entitlements[entitlement]) {
    res.status(402).json({
      error: message,
      code: "PLAN_UPGRADE_REQUIRED",
      entitlement,
      ...planLimitMetadata({ code: "PLAN_UPGRADE_REQUIRED", entitlement, currentPlan: billing.plan.id }),
    });
    return null;
  }
  return billing;
}
