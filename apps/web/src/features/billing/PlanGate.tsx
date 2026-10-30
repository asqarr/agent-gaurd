import { useEffect, useState, type ReactNode } from "react";
import { getBillingState } from "./billing.api";
import type { BillingState } from "../../shared/types/api";
import { Icon } from "../../shared/ui/Icon";

type GatedEntitlement =
  | "runtimeFirewall"
  | "securityContracts"
  | "aiRemediationCopilot"
  | "autopilot"
  | "sentinel"
  | "incidentCenter"
  | "alertWebhooks"
  | "exportReports";

const entitlementCopy: Record<GatedEntitlement, { label: string; description: string; requiredPlan: string; requiredPlanId: string }> = {
  runtimeFirewall: {
    label: "Runtime Firewall",
    description: "Run a capped live pilot and block unsafe tool calls before they reach your agent's tools.",
    requiredPlan: "Explorer (100 monthly decisions)",
    requiredPlanId: "free",
  },
  securityContracts: {
    label: "Security Contracts",
    description: "Set a versioned tool boundary and replay attack paths against it to catch regressions.",
    requiredPlan: "Builder",
    requiredPlanId: "builder",
  },
  aiRemediationCopilot: {
    label: "AI Remediation Copilot",
    description: "Turn scan evidence into a structured, reviewable remediation plan using your AI provider.",
    requiredPlan: "Pro",
    requiredPlanId: "team",
  },
  autopilot: {
    label: "Autopilot",
    description: "Turn scan evidence into a protection blueprint your team can apply.",
    requiredPlan: "Pro",
    requiredPlanId: "team",
  },
  sentinel: {
    label: "Sentinel",
    description: "Detect agent drift before a changed prompt, tool, or endpoint becomes an incident.",
    requiredPlan: "Pro",
    requiredPlanId: "team",
  },
  incidentCenter: {
    label: "Incident Center",
    description: "Centralize findings, quarantine events, and operational response in one timeline.",
    requiredPlan: "Builder",
    requiredPlanId: "builder",
  },
  alertWebhooks: {
    label: "Signed alert routes",
    description: "Deliver verifiable security events to your incident stack with signed webhooks.",
    requiredPlan: "Pro",
    requiredPlanId: "team",
  },
  exportReports: {
    label: "Export-ready reports",
    description: "Package evidence for customers, audits, and security reviews.",
    requiredPlan: "Builder",
    requiredPlanId: "builder",
  },
};

export function PlanGate({
  entitlement,
  onUpgrade,
  children,
}: {
  entitlement: GatedEntitlement;
  onUpgrade: (planId: string) => void;
  children: ReactNode;
}) {
  const [billing, setBilling] = useState<BillingState | null>(null);
  const [loading, setLoading] = useState(true);
  const copy = entitlementCopy[entitlement];

  useEffect(() => {
    let active = true;
    getBillingState()
      .then((state) => {
        if (active) setBilling(state);
      })
      .catch(() => {
        if (active) setBilling(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  if (loading) {
    return (
      <section className="workspace-view plan-gate plan-gate--loading" aria-live="polite">
        <div className="plan-gate__pulse" />
        <span>Checking workspace entitlements…</span>
      </section>
    );
  }

  if (billing?.entitlements[entitlement]) return <>{children}</>;

  return (
    <section className="workspace-view plan-gate">
      <div className="plan-gate__orb"><Icon name="lock" size={22} /></div>
      <span className="eyebrow eyebrow--cyan">PLAN CONTROL</span>
      <h2>{copy.label} is ready when your operation is.</h2>
      <p>{copy.description}</p>
      <div className="plan-gate__meta">
        <span><i /> Included from {copy.requiredPlan}</span>
        <span><i /> Current plan: {billing?.plan.name ?? "Explorer"}</span>
      </div>
      <button type="button" className="button button--primary" onClick={() => onUpgrade(copy.requiredPlanId)}>
        View advanced plans <Icon name="arrow" size={15} />
      </button>
    </section>
  );
}
