import { useEffect, useState, type ReactNode } from "react";
import { getBillingState } from "./billing.api";
import type { BillingState } from "../../shared/types/api";
import { Icon } from "../../shared/ui/Icon";

type GatedEntitlement =
  | "runtimeFirewall"
  | "autopilot"
  | "sentinel"
  | "incidentCenter"
  | "alertWebhooks"
  | "exportReports";

const entitlementCopy: Record<GatedEntitlement, { label: string; description: string; requiredPlan: string }> = {
  runtimeFirewall: {
    label: "Runtime Firewall",
    description: "Block unsafe tool calls before they reach production systems.",
    requiredPlan: "Builder",
  },
  autopilot: {
    label: "Autopilot",
    description: "Turn scan evidence into a protection blueprint your team can apply.",
    requiredPlan: "Pro",
  },
  sentinel: {
    label: "Sentinel",
    description: "Detect agent drift before a changed prompt, tool, or endpoint becomes an incident.",
    requiredPlan: "Pro",
  },
  incidentCenter: {
    label: "Incident Center",
    description: "Centralize findings, quarantine events, and operational response in one timeline.",
    requiredPlan: "Builder",
  },
  alertWebhooks: {
    label: "Signed alert routes",
    description: "Deliver verifiable security events to your incident stack with signed webhooks.",
    requiredPlan: "Pro",
  },
  exportReports: {
    label: "Export-ready reports",
    description: "Package evidence for customers, audits, and security reviews.",
    requiredPlan: "Builder",
  },
};

export function PlanGate({
  entitlement,
  onUpgrade,
  children,
}: {
  entitlement: GatedEntitlement;
  onUpgrade: () => void;
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
      <button type="button" className="button button--primary" onClick={onUpgrade}>
        View advanced plans <Icon name="arrow" size={15} />
      </button>
    </section>
  );
}
