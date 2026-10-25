import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  applyAutopilotProtection,
  getAutopilotAssessment,
  startAutopilotAssessment,
} from "./autopilot.api";
import type { Agent, AutopilotAssessment, AutopilotPhase } from "../../shared/types/api";
import { Icon } from "../../shared/ui/Icon";

const phases: Array<{ id: AutopilotPhase; label: string; detail: string }> = [
  { id: "connecting", label: "Connect", detail: "Verify the endpoint and credentials" },
  { id: "inventory", label: "Inventory", detail: "Map tools and side effects" },
  { id: "testing", label: "Challenge", detail: "Run adversarial security scenarios" },
  { id: "blueprint", label: "Blueprint", detail: "Build a protection plan" },
  { id: "protected", label: "Protected", detail: "Enforce the approved plan" },
];

function phaseIndex(phase: AutopilotPhase) {
  return phases.findIndex((item) => item.id === phase);
}

function riskClass(value: string) {
  return value === "critical" ? "critical" : value === "high" ? "high" : value === "medium" ? "medium" : "safe";
}

function formatLatency(value: number | null | undefined) {
  return value == null ? "—" : `${value}ms`;
}

function ApprovalDialog({
  assessment,
  busy,
  onClose,
  onConfirm,
}: {
  assessment: AutopilotAssessment;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const blueprint = assessment.blueprint;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <div className="dialog autopilot-approval" role="dialog" aria-modal="true" aria-labelledby="autopilot-approval-title">
        <div className="dialog__signal"><span /></div>
        <div className="dialog__copy">
          <span className="eyebrow">PROTECTION REVIEW</span>
          <h3 id="autopilot-approval-title">Protect {assessment.agentName}?</h3>
          <p>AgentGuard will enable the Runtime Firewall and keep unknown tool calls blocked. Your business policy values will not be changed.</p>
        </div>
        <div className="autopilot-approval__list">
          <div><Icon name="shield" size={15} /><span>Fail-closed tool authorization</span><strong>ON</strong></div>
          <div><Icon name="lock" size={15} /><span>Runtime Firewall</span><strong>ON</strong></div>
          <div><Icon name="activity" size={15} /><span>Critical findings requiring review</span><strong>{blueprint?.stats.criticalFindings ?? 0}</strong></div>
        </div>
        <div className="dialog__actions">
          <button type="button" className="button button--subtle" onClick={onClose} disabled={busy}>Keep reviewing</button>
          <button type="button" className="button button--primary" onClick={onConfirm} disabled={busy}>
            {busy ? "Applying protection…" : "Protect my agent"}
            {!busy ? <Icon name="arrow" size={15} /> : null}
          </button>
        </div>
      </div>
    </div>
  );
}

function AssessmentProgress({ assessment }: { assessment: AutopilotAssessment }) {
  const active = phaseIndex(assessment.phase);
  const current = phases[active] ?? phases[0];
  const scanProgress = assessment.scan?.progress ?? [];
  const completed = scanProgress.filter((item) => ["passed", "blocked", "failed", "error"].includes(item.status)).length;
  const total = scanProgress.length;
  const percentage = assessment.status === "completed" || assessment.status === "applied"
    ? 100
    : total
      ? Math.max(8, Math.round((completed / total) * 100))
      : Math.max(8, Math.round((active / (phases.length - 1)) * 100));

  return (
    <section className="autopilot-progress panel">
      <div className="autopilot-progress__heading">
        <div className="autopilot-pulse"><i /></div>
        <div>
          <span className="eyebrow eyebrow--cyan">AUTOPILOT IN PROGRESS</span>
          <h3>{current.label}: {current.detail}</h3>
          <p>{assessment.status === "running" ? "Synthetic requests are isolated from real customer side effects." : "Preparing the protection blueprint…"}</p>
        </div>
        <strong>{percentage}%</strong>
      </div>
      <div className="autopilot-progress__bar"><span style={{ width: `${percentage}%` }} /></div>
      <div className="autopilot-phase-list">
        {phases.map((item, index) => (
          <div className={`${index < active ? "is-complete" : index === active ? "is-active" : ""}`} key={item.id}>
            <span>{index < active ? "✓" : index + 1}</span>
            <strong>{item.label}</strong>
            <small>{item.detail}</small>
          </div>
        ))}
      </div>
      {assessment.scan?.progress?.length ? (
        <div className="autopilot-live-tests">
          {assessment.scan.progress.slice(-4).map((item) => (
            <div key={item.scenarioId} className={`autopilot-test-row autopilot-test-row--${item.status}`}>
              <i />
              <span>{item.title}</span>
              <small>{item.status === "running" ? "Testing" : item.status === "blocked" ? "Blocked safely" : item.status === "passed" ? "Passed" : item.status === "failed" ? "Finding" : item.status === "error" ? "Error" : "Queued"}</small>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function AutopilotPage({
  agents,
  selectedAgentId,
  onAgentUpdated,
  onConnect,
}: {
  agents: Agent[];
  selectedAgentId: string;
  onAgentUpdated: (agent: Agent) => void;
  onConnect: () => void;
}) {
  const [agentId, setAgentId] = useState(selectedAgentId || agents[0]?.id || "");
  const [assessment, setAssessment] = useState<AutopilotAssessment | null>(null);
  const [busy, setBusy] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [error, setError] = useState("");
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);

  const selected = useMemo(() => agents.find((agent) => agent.id === agentId) ?? agents[0], [agents, agentId]);

  useEffect(() => {
    if (!agentId && agents[0]) setAgentId(agents[0].id);
  }, [agentId, agents]);

  useEffect(() => {
    if (!assessment || ["completed", "applied", "failed"].includes(assessment.status)) return undefined;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void getAutopilotAssessment(assessment.id)
        .then((next) => {
          if (!cancelled) setAssessment(next);
        })
        .catch((caught) => {
          if (!cancelled) setError(caught instanceof Error ? caught.message : "Assessment status could not be refreshed.");
        });
    }, 900);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [assessment?.id, assessment?.status]);

  function chooseAgent(value: string) {
    setAgentId(value);
    setAssessment(null);
    setIssuedToken(null);
    setTokenCopied(false);
    setError("");
  }

  async function runAssessment() {
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    setAssessment(null);
    setIssuedToken(null);
    setTokenCopied(false);
    try {
      setAssessment(await startAutopilotAssessment(selected.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Autopilot could not start.");
    } finally {
      setBusy(false);
    }
  }

  async function applyProtection() {
    if (!assessment || applyBusy) return;
    setApplyBusy(true);
    setError("");
    try {
      const result = await applyAutopilotProtection(assessment.id);
      setAssessment(result.assessment);
      setIssuedToken(result.protection.token);
      setTokenCopied(false);
      onAgentUpdated(result.agent);
      setApprovalOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Protection could not be applied.");
    } finally {
      setApplyBusy(false);
    }
  }

  async function copyIssuedToken() {
    if (!issuedToken || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(issuedToken);
      setTokenCopied(true);
      window.setTimeout(() => setTokenCopied(false), 2200);
    } catch {
      setError("The token could not be copied. Select it manually and store it in your secret manager.");
    }
  }

  if (!agents.length) {
    return (
      <section className="workspace-view autopilot-page">
        <div className="autopilot-empty panel">
          <div className="autopilot-empty__orb"><Icon name="shield" size={28} /></div>
          <span className="eyebrow eyebrow--cyan">AGENT SECURITY AUTOPILOT</span>
          <h2>Connect an agent to start</h2>
          <p>AgentGuard will map its tools, challenge its boundaries, and build a protection plan you can approve.</p>
          <button type="button" className="button button--primary" onClick={onConnect}><Icon name="plus" size={16} /> Connect agent</button>
        </div>
      </section>
    );
  }

  const blueprint = assessment?.blueprint;
  const terminal = assessment && ["completed", "applied", "failed"].includes(assessment.status);

  return (
    <section className="workspace-view autopilot-page">
      <div className="workspace-view__heading autopilot-heading">
        <div>
          <span className="eyebrow eyebrow--cyan">AGENT SECURITY AUTOPILOT</span>
          <h2>Connect it. Understand it. Protect it.</h2>
          <p>One guided assessment turns your agent endpoint into a clear, reviewable security blueprint.</p>
        </div>
        <div className="autopilot-heading__controls">
          <label className="autopilot-agent-select"><span>Agent under review</span><select value={selected?.id ?? ""} onChange={(event) => chooseAgent(event.target.value)}>{agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></label>
          <button type="button" className="button button--primary" onClick={() => void runAssessment()} disabled={busy || selected?.status === "quarantined"}>
            <Icon name="activity" size={16} /> {busy ? "Starting…" : assessment && !terminal ? "Assessment running…" : "Make this agent safe"} <Icon name="arrow" size={16} />
          </button>
        </div>
      </div>

      {selected && !selected.endpoint ? <div className="autopilot-notice"><Icon name="activity" size={15} /><span>This development agent uses the safe local simulator. Add a customer endpoint for production evidence.</span><button type="button" className="text-button" onClick={onConnect}>Configure endpoint <Icon name="arrow" size={13} /></button></div> : null}
      {error ? <div className="autopilot-error"><Icon name="activity" size={15} /><span>{error}</span><button type="button" className="text-button" onClick={() => setError("")}>Dismiss</button></div> : null}
      {assessment && !terminal ? <AssessmentProgress assessment={assessment} /> : null}

      {!assessment ? (
        <div className="autopilot-launch panel">
          <div className="autopilot-launch__visual"><div className="autopilot-ring autopilot-ring--one" /><div className="autopilot-ring autopilot-ring--two" /><span><Icon name="shield" size={31} /></span></div>
          <div className="autopilot-launch__copy"><span className="eyebrow">ZERO-CONFIG HARDENING</span><h3>Let AgentGuard do the security work.</h3><p>We will test the real endpoint with isolated prompts, explain every finding in plain language, and show every change before anything is enforced.</p><div className="autopilot-launch__features"><span><i />Endpoint check</span><span><i />Tool inventory</span><span><i />Advanced attack suite</span><span><i />One-click protection</span></div></div>
        </div>
      ) : null}

      {assessment?.status === "failed" ? <div className="autopilot-failed panel"><Icon name="activity" size={18} /><div><strong>Assessment did not finish</strong><span>The customer endpoint returned an error during testing. No protection was changed.</span></div><button type="button" className="button button--subtle" onClick={() => void runAssessment()}>Run again <Icon name="arrow" size={14} /></button></div> : null}

      {blueprint ? (
        <>
          <div className="autopilot-score panel">
            <div className="autopilot-score__orb" style={{ "--score": `${blueprint.readinessScore * 3.6}deg` } as CSSProperties}><strong>{blueprint.readinessScore}</strong><span>/100 readiness</span></div>
            <div className="autopilot-score__copy"><span className="eyebrow eyebrow--cyan">SECURITY BLUEPRINT READY</span><h3>{blueprint.readinessLabel}</h3><p>{blueprint.summary}</p><div className="autopilot-score__meta"><span><strong>{blueprint.stats.passed}/{blueprint.stats.scenarios}</strong> scenarios passed</span><span><strong>{blueprint.stats.findings}</strong> findings</span><span><strong>{blueprint.stats.sideEffectTools}</strong> side-effect tools</span><span><strong>{formatLatency(blueprint.connection.latencyMs)}</strong> endpoint latency</span></div></div>
            <div className="autopilot-score__action">{assessment.status === "applied" ? <div className="autopilot-protected-badge"><Icon name="shield" size={18} /><strong>Protected</strong><span>Runtime Firewall is active</span></div> : <button type="button" className="button button--primary" onClick={() => setApprovalOpen(true)}><Icon name="lock" size={16} /> Review & protect <Icon name="arrow" size={15} /></button>}</div>
          </div>

          {issuedToken ? <div className="autopilot-token panel"><div><span className="eyebrow">RUNTIME TOKEN · COPY ONCE</span><strong>Your gateway token is ready</strong><p>Store this token in your server secret manager. It will not be shown again.</p></div><code>{issuedToken}</code><button type="button" className="button button--subtle" onClick={() => void copyIssuedToken()}>{tokenCopied ? "Copied" : "Copy token"}</button></div> : null}

          <div className="autopilot-grid">
            <section className="panel autopilot-blueprint-card"><div className="panel-heading"><div><span className="eyebrow">DISCOVERED SURFACE</span><h3>Tool inventory</h3></div><span className="autopilot-card-count">{blueprint.toolInventory.length} tools</span></div><div className="autopilot-tool-list">{blueprint.toolInventory.map((tool) => <div key={tool.id}><div className={`autopilot-tool-icon autopilot-tool-icon--${riskClass(tool.risk)}`}><Icon name={tool.sideEffect ? "activity" : "search"} size={14} /></div><div><strong>{tool.name}</strong><span>{tool.label} · {tool.posture}</span></div><em className={`autopilot-risk autopilot-risk--${riskClass(tool.risk)}`}>{tool.risk}</em></div>)}</div></section>
            <section className="panel autopilot-blueprint-card"><div className="panel-heading"><div><span className="eyebrow">RECOMMENDATIONS</span><h3>Protection plan</h3></div><span className="autopilot-card-count">{blueprint.recommendations.length} controls</span></div><div className="autopilot-recommendation-list">{blueprint.recommendations.map((recommendation) => <div key={recommendation.id}><span className={`autopilot-recommendation-dot autopilot-recommendation-dot--${riskClass(recommendation.severity)}`} /><div><strong>{recommendation.title}</strong><span>{recommendation.description}</span></div><em>{recommendation.status === "active" ? "Active" : recommendation.status === "review" ? "Review" : "Ready"}</em></div>)}</div></section>
          </div>

          {blueprint.findings.length ? <section className="panel autopilot-findings"><div className="panel-heading"><div><span className="eyebrow eyebrow--orange">WHAT NEEDS ATTENTION</span><h3>Findings with a clear next action</h3></div><span className="autopilot-card-count">{blueprint.findings.length} findings</span></div><div className="autopilot-finding-list">{blueprint.findings.map((finding) => <article key={finding.id}><div className={`autopilot-finding-severity autopilot-finding-severity--${riskClass(finding.severity)}`}><i />{finding.severity}</div><div><strong>{finding.title}</strong><span>{finding.impact}</span><small>Next: {finding.recommendation}</small></div></article>)}</div></section> : <div className="autopilot-success panel"><div className="autopilot-success__icon"><Icon name="shield" size={21} /></div><div><strong>No unsafe behavior observed</strong><span>The security suite passed. Runtime protection is still recommended before production traffic.</span></div></div>}
        </>
      ) : null}
      {approvalOpen && assessment ? <ApprovalDialog assessment={assessment} busy={applyBusy} onClose={() => setApprovalOpen(false)} onConfirm={() => void applyProtection()} /> : null}
    </section>
  );
}
