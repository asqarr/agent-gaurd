import { useEffect, useId } from "react";
import type { UpgradeRequest } from "../../shared/api/client";
import { Icon } from "../../shared/ui/Icon";

const planNames: Record<string, string> = {
  free: "Explorer",
  builder: "Builder",
  team: "Pro",
  agency: "Agency",
};

const entitlementCopy: Record<string, { label: string; requiredPlan: string; detail: string }> = {
  runtimeFirewall: {
    label: "Runtime Firewall",
    requiredPlan: "Explorer · 100 decisions/month",
    detail: "Start a one-agent live pilot. Builder raises the included Runtime allowance to 10,000 decisions/month.",
  },
  securityContracts: {
    label: "Security Contracts",
    requiredPlan: "Builder",
    detail: "Version tool boundaries and replay attack paths to verify that changes do not weaken the contract.",
  },
  enforcementVerification: {
    label: "Enforcement Verification",
    requiredPlan: "Builder",
    detail: "Run isolated policy, SDK, replay, and outage checks and retain a current proof for your Runtime Firewall.",
  },
  aiRemediationCopilot: {
    label: "AI Remediation Copilot",
    requiredPlan: "Pro",
    detail: "Generate a structured remediation plan from minimized scan evidence with your configured AI provider.",
  },
  autopilot: {
    label: "Autopilot",
    requiredPlan: "Pro",
    detail: "Turn scan evidence into a protection blueprint your team can apply.",
  },
  sentinel: {
    label: "Sentinel",
    requiredPlan: "Pro",
    detail: "Detect drift before a changed prompt, tool, or endpoint becomes an incident.",
  },
  incidentCenter: {
    label: "Incident Center",
    requiredPlan: "Builder",
    detail: "Centralize findings and operational response in one timeline.",
  },
  alertWebhooks: {
    label: "Signed alert routes",
    requiredPlan: "Pro",
    detail: "Deliver verifiable security events to your incident stack.",
  },
  maxWebhooks: {
    label: "Signed alert routes",
    requiredPlan: "Pro",
    detail: "Your current plan has reached its signed alert route allowance.",
  },
  exportReports: {
    label: "Export-ready reports",
    requiredPlan: "Builder",
    detail: "Package evidence for customers, audits, and security reviews.",
  },
};

function nextPlan(currentPlan?: string) {
  const order = ["free", "builder", "team", "agency"];
  const currentIndex = currentPlan ? order.indexOf(currentPlan) : -1;
  if (currentIndex < 0) return "Builder";
  return planNames[order[Math.min(order.length - 1, Math.max(0, currentIndex + 1))]] ?? "Builder";
}

function getCopy(request: UpgradeRequest) {
  const entitlement = request.entitlement ? entitlementCopy[request.entitlement] : undefined;
  if (entitlement) return entitlement;

  if (request.code === "RUNTIME_QUOTA_EXCEEDED") {
    return {
      label: "Runtime capacity",
      requiredPlan: request.requiredPlanName ?? nextPlan(request.currentPlan),
      detail: "Runtime is fail-closed: no sensitive tool call is executed while capacity is exhausted.",
    };
  }
  if (request.code === "SCAN_QUOTA_EXCEEDED") {
    return {
      label: "Scan capacity",
      requiredPlan: request.requiredPlanName ?? nextPlan(request.currentPlan),
      detail: "This scan needs more credits than remain in the workspace allowance.",
    };
  }
  if (request.code === "AGENT_LIMIT_REACHED") {
    return {
      label: "Agent capacity",
      requiredPlan: request.requiredPlanName ?? nextPlan(request.currentPlan),
      detail: "Your workspace has reached its connected-agent allowance.",
    };
  }
  if (request.code === "SCENARIO_PLAN_REQUIRED") {
    return {
      label: "Advanced attack scenarios",
      requiredPlan: request.requiredPlanName ?? "Builder",
      detail: "This attack path uses scenarios outside the current plan's coverage.",
    };
  }
  if (request.code === "SUBSCRIPTION_REQUIRED") {
    return {
      label: "Active subscription",
      requiredPlan: request.requiredPlanName ?? "Builder",
      detail: "This protected operation is paused until the workspace plan is renewed.",
    };
  }
  return {
    label: "Advanced security control",
    requiredPlan: request.requiredPlanName ?? request.requiredPlan ?? "Builder",
    detail: "This control is outside the current workspace entitlement.",
  };
}

function planIdForName(name: string) {
  return ({ Explorer: "free", Builder: "builder", Pro: "team", Agency: "agency" } as Record<string, string>)[name] ?? "builder";
}

function upgradeBenefits(requiredPlan: string) {
  const benefits = [
    "Block unsafe storefront tool calls before the customer executor runs",
    "Keep reproducible evidence and remediation guidance for every finding",
  ];
  if (["Builder", "Pro", "Agency"].includes(requiredPlan)) {
    benefits.unshift("Evaluate the complete 12-scenario red-team suite");
  }
  if (["Pro", "Agency"].includes(requiredPlan)) {
    benefits.push("Generate AI remediation plans and monitor drift across the agent fleet");
  }
  if (requiredPlan === "Agency") {
    benefits.push("Scale to 15 agents, 500,000 Runtime Decisions, and 25 signed alert routes");
  }
  return benefits;
}

export function UpgradePrompt({
  request,
  onClose,
  onUpgrade,
}: {
  request: UpgradeRequest;
  onClose: () => void;
  onUpgrade: (planId?: string) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const copy = getCopy(request);
  const currentPlan = planNames[request.currentPlan ?? ""] ?? request.currentPlan ?? "current plan";
  const hasAddonPath = request.nextActions?.includes("purchase_runtime_addon") || request.nextActions?.includes("purchase_scan_addon");

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="dialog-backdrop upgrade-prompt-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        className="dialog upgrade-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="upgrade-prompt__icon"><Icon name="lock" size={21} /></div>
        <div className="dialog__copy">
          <span className="eyebrow eyebrow--cyan">PLAN CONTROL</span>
          <h3 id={titleId}>{copy.label} needs more access</h3>
          <p id={descriptionId}>{copy.detail}</p>
        </div>
        <div className="upgrade-prompt__summary">
          <div><span>Current plan</span><strong>{currentPlan}</strong></div>
          <Icon name="arrow" size={15} />
          <div><span>Recommended</span><strong>{copy.requiredPlan}</strong></div>
        </div>
        <div className="upgrade-prompt__note">
          <Icon name="shield" size={15} />
          <span>{hasAddonPath ? "Upgrade for a larger recurring allowance, or purchase extra capacity from Plans." : "No data was lost and no protected action was executed. Review Plans to unlock this control."}</span>
        </div>
        <div className="upgrade-prompt__proof">
          <span>WHAT YOU BUY</span>
          <ul>{upgradeBenefits(copy.requiredPlan).map((benefit) => <li key={benefit}>{benefit}</li>)}</ul>
        </div>
        <div className="dialog__actions">
          <button type="button" className="button button--subtle" onClick={onClose}>Not now</button>
          <button type="button" className="button button--primary" onClick={() => onUpgrade(planIdForName(copy.requiredPlan))}>
            Unlock {copy.requiredPlan} with USDT <Icon name="arrow" size={15} />
          </button>
        </div>
      </section>
    </div>
  );
}
