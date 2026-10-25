import { scenarios } from "../catalog/domain.mjs";

export const billingPlans = Object.freeze([
  {
    id: "free",
    name: "Explorer",
    description: "Start with one agent and the essential security boundary suite.",
    billingInterval: "month",
    priceUsdCents: 0,
    maxAgents: 1,
    monthlyScanCredits: 20,
    scanCreditMode: "one_time",
    historyDays: 7,
    seatLimit: 1,
    runtimeFirewall: false,
    scenarioLimit: 5,
    autopilot: false,
    sentinel: false,
    incidentCenter: false,
    alertWebhooks: false,
    exportReports: false,
    maxWebhooks: 0,
    runtimeDecisionsIncluded: 0,
    whiteLabelReports: false,
    multiClientManagement: false,
    features: ["5 essential boundary scenarios", "20 one-time Scan Credits", "1 protected agent", "7-day evidence"],
  },
  {
    id: "builder",
    name: "Builder",
    description: "Ship safer agents with the full adversarial suite and live controls.",
    billingInterval: "month",
    priceUsdCents: 4900,
    maxAgents: 2,
    monthlyScanCredits: 200,
    scanCreditMode: "monthly",
    historyDays: 30,
    seatLimit: 3,
    runtimeFirewall: true,
    scenarioLimit: scenarios.length,
    autopilot: false,
    sentinel: false,
    incidentCenter: true,
    alertWebhooks: false,
    exportReports: true,
    maxWebhooks: 0,
    runtimeDecisionsIncluded: 10000,
    whiteLabelReports: false,
    multiClientManagement: false,
    features: ["Full 12-scenario red-team suite", "200 monthly Scan Credits", "Runtime Firewall", "Export-ready reports", "Limited Incident Center", "30-day evidence"],
  },
  {
    id: "team",
    name: "Pro",
    description: "Run security operations across a growing production agent fleet.",
    billingInterval: "month",
    priceUsdCents: 14900,
    maxAgents: 5,
    monthlyScanCredits: 1000,
    scanCreditMode: "monthly",
    historyDays: 90,
    seatLimit: 10,
    runtimeFirewall: true,
    scenarioLimit: scenarios.length,
    autopilot: true,
    sentinel: true,
    incidentCenter: true,
    alertWebhooks: true,
    exportReports: true,
    maxWebhooks: 3,
    runtimeDecisionsIncluded: 100000,
    whiteLabelReports: false,
    multiClientManagement: false,
    features: ["Everything in Builder", "1,000 monthly Scan Credits", "Autopilot", "Sentinel", "Incident Center + Webhooks", "90-day evidence"],
  },
  {
    id: "agency",
    name: "Agency",
    description: "Operate a larger multi-agent security operation from one control plane.",
    billingInterval: "month",
    priceUsdCents: 39900,
    maxAgents: 15,
    monthlyScanCredits: 4000,
    scanCreditMode: "monthly",
    historyDays: 180,
    seatLimit: 25,
    runtimeFirewall: true,
    scenarioLimit: scenarios.length,
    autopilot: true,
    sentinel: true,
    incidentCenter: true,
    alertWebhooks: true,
    exportReports: true,
    maxWebhooks: 25,
    runtimeDecisionsIncluded: 500000,
    whiteLabelReports: true,
    multiClientManagement: true,
    features: ["Everything in Pro", "4,000 monthly Scan Credits", "White-label reports", "Multi-client management", "180-day evidence"],
  },
]);

export const fullScanCredits = scenarios.reduce(
  (total, scenario) => total + scenario.scanCredits,
  0,
);

export function scenariosForPlan(plan) {
  const limit = Math.max(1, Math.min(Number(plan?.scenarioLimit ?? scenarios.length), scenarios.length));
  return scenarios.slice(0, limit);
}

export function scanCreditsForScenarios(selectedScenarios = scenarios) {
  return selectedScenarios.reduce((total, scenario) => total + scenario.scanCredits, 0);
}

export function getBillingPlan(planId) {
  return billingPlans.find((plan) => plan.id === planId) ?? billingPlans[0];
}

export function toPublicPlan(plan) {
  const scenarioLimit = Math.max(1, Math.min(Number(plan.scenarioLimit ?? scenarios.length), scenarios.length));
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    billingInterval: plan.billingInterval,
    priceUsdCents: plan.priceUsdCents,
    maxAgents: plan.maxAgents,
    monthlyScanCredits: plan.monthlyScanCredits,
    scanCreditMode: plan.scanCreditMode ?? "monthly",
    historyDays: plan.historyDays,
    seatLimit: plan.seatLimit,
    runtimeFirewall: plan.runtimeFirewall,
    scenarioLimit,
    scanCreditsPerScan: plan.scanCreditsPerScan ?? scanCreditsForScenarios(scenarios.slice(0, scenarioLimit)),
    autopilot: plan.autopilot,
    sentinel: plan.sentinel,
    incidentCenter: plan.incidentCenter,
    alertWebhooks: plan.alertWebhooks,
    exportReports: plan.exportReports,
    maxWebhooks: plan.maxWebhooks,
    runtimeDecisionsIncluded: plan.runtimeDecisionsIncluded ?? 0,
    whiteLabelReports: Boolean(plan.whiteLabelReports),
    multiClientManagement: Boolean(plan.multiClientManagement),
    features: plan.features,
  };
}
