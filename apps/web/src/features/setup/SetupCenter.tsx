import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, EnforcementVerification, Overview } from "../../shared/types/api";
import { Icon, type IconName } from "../../shared/ui/Icon";
import { getRuntimeVerification, runRuntimeVerification } from "../runtime/verification.api";

type StepId = "connect" | "assess" | "review" | "protect" | "verify" | "monitor";
type StepStatus = "done" | "current" | "pending";

type SetupStep = {
  id: StepId;
  label: string;
  detail: string;
  done: boolean;
  icon: IconName;
  action: string;
  destination: string;
};

function buildSteps(
  agent: Agent | undefined,
  agents: Agent[],
  overview: Overview,
  verification: EnforcementVerification | null,
  verificationCurrent: boolean,
  verificationLoading: boolean,
): SetupStep[] {
  const connected = agents.length > 0;
  const scansForAgent = overview.recentScans.filter(
    (scan) => scan.agentId === agent?.id,
  );
  const assessed = Boolean(
    agent?.score != null || agent?.lastScan || scansForAgent.length,
  );
  const latestScan = scansForAgent[0];
  const needsReview = Boolean(
    assessed &&
    ((agent?.score ?? latestScan?.score ?? 100) < 85 ||
      (latestScan?.failed ?? 0) > 0),
  );
  const reviewed = assessed && !needsReview;
  const protectedAgent = Boolean(agent?.runtimeEnabled);
  const enforcementVerified = protectedAgent && verificationCurrent && verification?.status === "passed";
  const monitored = protectedAgent && Boolean(agent?.runtimeLastEventAt);

  return [
    {
      id: "connect",
      label: "Connect an agent",
      detail: connected
        ? `${agents.length} agent${agents.length === 1 ? "" : "s"} in your workspace`
        : "Add your first customer endpoint",
      done: connected,
      icon: "plug",
      action: connected ? "Manage connections" : "Connect agent",
      destination: "Integrations",
    },
    {
      id: "assess",
      label: "Run a security assessment",
      detail: assessed
        ? "Security evidence is available"
        : "Run the first safe assessment against this agent",
      done: assessed,
      icon: "scan",
      action: assessed ? "Run again" : "Run first scan",
      destination: "Scans",
    },
    {
      id: "review",
      label: "Review the blueprint",
      detail: needsReview
        ? "Findings need your attention"
        : assessed
          ? "No open findings on the selected agent"
          : "See what the assessment discovered",
      done: reviewed,
      icon: needsReview ? "activity" : "library",
      action: needsReview ? "Review findings" : "Open blueprint",
      destination: needsReview ? "Scans" : "Autopilot",
    },
    {
      id: "protect",
      label: "Enable Runtime Firewall",
      detail: protectedAgent
        ? "Unsafe calls are blocked before execution"
        : "Apply the approved protection plan",
      done: protectedAgent,
      icon: "shield",
      action: protectedAgent ? "View protection" : "Protect agent",
      destination: protectedAgent ? "Agents" : "Autopilot",
    },
    {
      id: "verify",
      label: "Verify enforcement",
      detail: !protectedAgent
        ? "Enable Runtime Firewall before running the isolated checks"
        : verificationLoading
          ? "Loading the latest verification evidence"
          : enforcementVerified
            ? "Synthetic controls passed; your application code was not inspected"
            : verification?.status === "failed"
              ? "The latest proof has failed checks; review the evidence and rerun"
              : verification && !verificationCurrent
                ? "Policy, tools, contract, or Firewall state changed; rerun the proof"
                : "Run isolated policy, SDK, replay, and outage checks",
      done: enforcementVerified,
      icon: "shield",
      action: !protectedAgent ? "Open Runtime Firewall" : "Run verification",
      destination: "Agents",
    },
    {
      id: "monitor",
      label: "Monitor live behavior",
      detail: monitored
        ? "Runtime events are being recorded"
        : "Send traffic through the protected gateway",
      done: monitored,
      icon: "activity",
      action: monitored ? "View runtime events" : "Open Runtime Shield",
      destination: "Agents",
    },
  ];
}

function resolveStepState(steps: SetupStep[], index: number): StepStatus {
  if (steps[index].done) return "done";
  const firstIncomplete = steps.findIndex((step) => !step.done);
  return index === firstIncomplete ? "current" : "pending";
}

function SetupProgress({ steps }: { steps: SetupStep[] }) {
  const completed = steps.filter((step) => step.done).length;
  const percentage = Math.round((completed / steps.length) * 100);
  return (
    <div className="setup-center__progress">
      <div className="setup-center__progress-label">
        <span>SECURITY LAUNCH PATH</span>
        <strong>
          {completed}/{steps.length} complete
        </strong>
      </div>
      <div className="setup-center__progress-bar">
        <i style={{ width: `${percentage}%` }} />
      </div>
    </div>
  );
}

export function SetupCenter({
  compact = false,
  agents,
  overview,
  selectedAgentId,
  onSelectAgent,
  onNavigate,
  onConnect,
  onQuickStart,
  quickStartBusy = false,
  onRunScan,
  scanBusy = false,
}: {
  compact?: boolean;
  agents: Agent[];
  overview: Overview;
  selectedAgentId: string;
  onSelectAgent: (agentId: string) => void;
  onNavigate: (destination: string) => void;
  onConnect: () => void;
  onQuickStart: () => void;
  quickStartBusy?: boolean;
  onRunScan: () => void;
  scanBusy?: boolean;
}) {
  const [verification, setVerification] = useState<EnforcementVerification | null>(null);
  const [verificationCurrent, setVerificationCurrent] = useState(false);
  const [verificationLoading, setVerificationLoading] = useState(false);
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [verificationError, setVerificationError] = useState("");
  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? agents[0],
    [agents, selectedAgentId],
  );
  const selectedAgentIdRef = useRef(selected?.id);
  selectedAgentIdRef.current = selected?.id;
  const steps = useMemo(
    () => buildSteps(selected, agents, overview, verification, verificationCurrent, verificationLoading),
    [selected, agents, overview, verification, verificationCurrent, verificationLoading],
  );
  const nextIndex = steps.findIndex((step) => !step.done);
  const next = steps[nextIndex === -1 ? steps.length - 1 : nextIndex];
  const allDone = nextIndex === -1;

  useEffect(() => {
    let current = true;
    setVerification(null);
    setVerificationCurrent(false);
    setVerificationError("");
    if (!selected?.id || !selected.runtimeEnabled) {
      setVerificationLoading(false);
      return () => { current = false; };
    }
    setVerificationLoading(true);
    void getRuntimeVerification(selected.id)
      .then((response) => {
        if (!current) return;
        setVerification(response.verification);
        setVerificationCurrent(response.isCurrent);
      })
      .catch((caught) => {
        if (current) setVerificationError(caught instanceof Error ? caught.message : "Verification evidence could not be loaded.");
      })
      .finally(() => {
        if (current) setVerificationLoading(false);
      });
    return () => { current = false; };
  }, [selected?.id, selected?.runtimeEnabled]);

  async function runVerification() {
    const agentId = selected?.id;
    if (!agentId || !selected.runtimeEnabled || verificationBusy) return;
    setVerificationBusy(true);
    setVerificationError("");
    try {
      const response = await runRuntimeVerification(agentId);
      if (selectedAgentIdRef.current === agentId) {
        setVerification(response.verification);
        setVerificationCurrent(response.isCurrent);
      }
    } catch (caught) {
      setVerificationError(caught instanceof Error ? caught.message : "Enforcement verification failed to run.");
    } finally {
      setVerificationBusy(false);
    }
  }

  function takeAction(step: SetupStep) {
    if (step.destination === "Integrations" && !agents.length) {
      onConnect();
      return;
    }
    if (step.id === "assess") {
      onRunScan();
      return;
    }
    if (step.id === "verify") {
      if (!selected?.runtimeEnabled) onNavigate("Agents");
      else void runVerification();
      return;
    }
    onNavigate(step.destination);
  }

  if (compact) {
    return (
      <section className="setup-center setup-center--compact panel">
        <div className="setup-center__compact-top">
          <div className="setup-center__signal">
            <Icon name={allDone ? "shield" : next.icon} size={17} />
          </div>
          <div>
            <span className="eyebrow eyebrow--cyan">GUIDED SETUP CENTER</span>
            <h2>
              {allDone
                ? "Core enforcement checks are complete"
                : "Your next security move"}
            </h2>
          </div>
          <button
            type="button"
            className="text-button"
            onClick={() => onNavigate("Launchpad")}
          >
            Open launchpad <Icon name="arrow" size={13} />
          </button>
        </div>
        <div className="setup-center__compact-action">
          <div>
            <strong>{!agents.length ? "Prove the Gateway in one click" : allDone ? "Protection is active" : next.label}</strong>
            <span>
              {!agents.length
                ? "Run a synthetic $100 refund attempt. The $50 policy blocks it before execution."
                : allDone
                ? "Synthetic checks passed. Validate your own executor in an isolated Staging harness before Production."
                : next.detail}
            </span>
          </div>
          {!agents.length ? (
            <div className="setup-center__compact-actions">
              <button type="button" className="button button--primary" onClick={onQuickStart} disabled={quickStartBusy}>
                <Icon name="shield" size={14} /> {quickStartBusy ? "Preparing…" : "Run safe demo"} <Icon name="arrow" size={14} />
              </button>
              <button type="button" className="text-button" onClick={onConnect}>Connect endpoint</button>
            </div>
          ) : (
            <button
              type="button"
              className="button button--subtle"
              onClick={() => takeAction(next)}
              disabled={(scanBusy && next.id === "assess") || (verificationBusy && next.id === "verify")}
            >
              {allDone ? "View agents" : scanBusy && next.id === "assess" ? "Scanning…" : next.action}
              <Icon name="arrow" size={14} />
            </button>
          )}
        </div>
        <SetupProgress steps={steps} />
      </section>
    );
  }

  return (
    <section className="workspace-view setup-center-page">
      <div className="workspace-view__heading setup-center-page__heading">
        <div>
          <span className="eyebrow eyebrow--cyan">GUIDED SETUP CENTER</span>
          <h2>Your secure launch path, one clear step at a time.</h2>
          <p>
            AgentGuard guides setup, then runs isolated enforcement checks. The proof does not inspect your application's other execution paths.
          </p>
        </div>
        <label className="setup-center__agent-select">
          <span>Agent in focus</span>
          <select
            value={selected?.id ?? ""}
            onChange={(event) => onSelectAgent(event.target.value)}
          >
            {agents.map((agent) => (
              <option value={agent.id} key={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!agents.length ? (
        <div className="setup-center__empty panel">
          <div className="setup-center__empty-icon">
            <Icon name="plug" size={24} />
          </div>
          <span className="eyebrow eyebrow--cyan">FIRST STEP</span>
          <h3>Connect your first Agent</h3>
          <p>
            Once connected, Autopilot will discover its action surface and build
            the first security blueprint.
          </p>
          <div className="setup-center__empty-actions">
            <button type="button" className="button button--primary" onClick={onQuickStart} disabled={quickStartBusy}>
              <Icon name="shield" size={16} /> {quickStartBusy ? "Preparing isolated demo…" : "Run safe security demo"} <Icon name="arrow" size={15} />
            </button>
            <button type="button" className="button button--subtle" onClick={onConnect} disabled={quickStartBusy}>
              <Icon name="plus" size={16} /> Connect my endpoint
            </button>
          </div>
          <small className="setup-center__safe-note">Synthetic data only · no customer endpoint · no refund is ever executed</small>
        </div>
      ) : (
        <>
          <div
            className={`setup-center__hero panel ${allDone ? "setup-center__hero--complete" : ""}`}
          >
            <div className="setup-center__hero-orb">
              <div />
              <span>
                <Icon name={allDone ? "shield" : next.icon} size={24} />
              </span>
            </div>
            <div className="setup-center__hero-copy">
              <span className="eyebrow">
                {allDone ? "CORE CONTROLS VERIFIED" : "RECOMMENDED NEXT ACTION"}
              </span>
              <h3>
                {allDone
                  ? "Core enforcement checks are complete."
                  : next.label}
              </h3>
              <p>
                {allDone
                  ? "The configured controls passed the synthetic verifier. Test your own executor in an isolated Staging harness before Production."
                  : next.detail}
              </p>
              <button
                type="button"
                className="button button--primary"
                onClick={() => takeAction(next)}
                disabled={(scanBusy && next.id === "assess") || (verificationBusy && next.id === "verify")}
              >
                {allDone ? "View runtime events" : verificationBusy && next.id === "verify" ? "Verifying…" : scanBusy && next.id === "assess" ? "Scanning…" : next.action}
                <Icon name="arrow" size={15} />
              </button>
            </div>
            <div className="setup-center__hero-score">
              <strong>
                {Math.round(
                  (steps.filter((step) => step.done).length / steps.length) *
                    100,
                )}
              </strong>
              <span>launch readiness</span>
            </div>
          </div>
          <div className="setup-center__layout">
            <div className="setup-center__steps panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">THE PATH</span>
                  <h3>Six steps to verified enforcement</h3>
                </div>
                <span className="setup-center__agent-pill">
                  <i />
                  {selected?.name}
                </span>
              </div>
              <div className="setup-step-list">
                {steps.map((step, index) => {
                  const state = resolveStepState(steps, index);
                  return (
                    <button
                      type="button"
                      className={`setup-step setup-step--${state}`}
                      key={step.id}
                      onClick={() => takeAction(step)}
                    >
                      <span className="setup-step__marker">
                        {state === "done" ? "✓" : index + 1}
                      </span>
                      <span className="setup-step__icon">
                        <Icon name={step.icon} size={15} />
                      </span>
                      <span className="setup-step__copy">
                        <strong>{step.label}</strong>
                        <small>{step.detail}</small>
                      </span>
                      <span className="setup-step__action">
                        {state === "done" ? "Complete" : step.action}
                        <Icon name="arrow" size={13} />
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <aside className="setup-center__side panel">
              <span className="eyebrow eyebrow--cyan">WHY THIS WORKS</span>
              <h3>Less configuration. More confidence.</h3>
              <p>
                You do not need to understand attack payloads, tool schemas, or
                runtime policies. AgentGuard surfaces the decision and keeps
                every destructive change behind your approval.
              </p>
              <div className="setup-center__principles">
                <div>
                  <Icon name="lock" size={15} />
                  <span>
                    <strong>Human approval</strong>Business policies never
                    change silently.
                  </span>
                </div>
                <div>
                  <Icon name="activity" size={15} />
                  <span>
                    <strong>Live evidence</strong>Every step is based on real
                    workspace state.
                  </span>
                </div>
                <div>
                  <Icon name="shield" size={15} />
                  <span>
                    <strong>Fail closed</strong>Unknown actions stop before side
                    effects.
                  </span>
                </div>
              </div>
            </aside>
          </div>
          <section className="setup-verification panel" id="enforcement-verification">
            <div className="setup-verification__header">
              <div className="setup-verification__title-icon"><Icon name="shield" size={18} /></div>
              <div>
                <span className="eyebrow eyebrow--cyan">ENFORCEMENT VERIFICATION</span>
                <h3>{verification?.status === "passed" && verificationCurrent ? "Control checks passed" : verification?.status === "failed" ? "Verification needs attention" : verification && !verificationCurrent ? "Previous proof is stale" : "Prove the guardrails"}</h3>
                <p>Runs synthetic policy, SDK, replay, and outage checks. It never calls your Agent endpoint or a real Tool executor.</p>
              </div>
              <span className={`setup-verification__badge ${verification?.status === "passed" && verificationCurrent ? "setup-verification__badge--pass" : verification?.status === "failed" ? "setup-verification__badge--fail" : ""}`}>
                {verificationLoading ? "LOADING" : verification?.status === "passed" && verificationCurrent ? `${verification.summary.passed}/${verification.summary.total} PASSED` : verification?.status === "failed" ? `${verification.summary.failed} FAILED` : verification && !verificationCurrent ? "RERUN REQUIRED" : "NOT RUN"}
              </span>
            </div>
            {verification ? (
              <>
                <div className="setup-verification__stats">
                  <div><span>Policy</span><strong>{verification.scope.policy.currency} {verification.scope.policy.maxAmount} ceiling</strong></div>
                  <div><span>Contract</span><strong>v{verification.scope.contractVersion}</strong></div>
                  <div><span>External calls</span><strong>{verification.summary.externalToolCalls}</strong></div>
                  <div><span>Side effects</span><strong>{verification.summary.financialSideEffects}</strong></div>
                </div>
                <div className="setup-verification__checks">
                  {verification.checks.map((item) => (
                    <div className="setup-verification__check" key={item.id}>
                      <i className={item.status === "passed" ? "is-pass" : "is-fail"} />
                      <span><strong>{item.title}</strong><small>{item.observed}</small></span>
                      <b>{item.status === "passed" ? "PASS" : "FAIL"}</b>
                    </div>
                  ))}
                </div>
                <div className="setup-verification__limits">
                  <strong>Not proven by this run</strong>
                  <p>{verification.notTested.join(" ")}</p>
                </div>
              </>
            ) : (
              <div className="setup-verification__empty">
                <span>{selected?.runtimeEnabled ? "Run the verifier to create workspace-scoped evidence." : "Enable Runtime Firewall for this Agent first. The verifier itself uses synthetic inputs only."}</span>
              </div>
            )}
            {verificationError ? <div className="setup-verification__error" role="alert">{verificationError}</div> : null}
            <div className="setup-verification__footer">
              <small>AgentGuard control-plane + bundled SDK conformance · customer application code is not inspected · not a security certification</small>
              <div>
                {verification ? <a className="button button--subtle" href={`/api/agents/${selected?.id}/runtime/verification/report`} target="_blank" rel="noreferrer">Open proof report <Icon name="arrow" size={13} /></a> : null}
                {selected?.runtimeEnabled ? (
                  <button type="button" className="button button--primary" onClick={() => void runVerification()} disabled={verificationBusy || verificationLoading}>
                    <Icon name="activity" size={14} /> {verificationBusy ? "Running isolated checks…" : verification ? "Run again" : "Run verification"}
                  </button>
                ) : (
                  <button type="button" className="button button--primary" onClick={() => onNavigate("Agents")}>Open Runtime Firewall <Icon name="arrow" size={13} /></button>
                )}
              </div>
            </div>
          </section>
          <SetupProgress steps={steps} />
        </>
      )}
    </section>
  );
}
