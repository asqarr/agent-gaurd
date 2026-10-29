import { useEffect, useMemo, useRef, useState } from "react";
import { getRuntimeEvent, quarantineAgent, restoreAgent } from "../agents/agents.api";
import { resolveIncident, getIncident } from "../incidents/incidents.api";
import { getScan } from "../scans/scans.api";
import { getSentinelDriftEvent } from "../sentinel/sentinel.api";
import type {
  Agent,
  Incident,
  RuntimeEvent,
  Scan,
  SentinelDriftEvent,
  SessionUser,
  WorkspaceActivity,
} from "../../shared/types/api";
import { Icon } from "../../shared/ui/Icon";

type EvidenceState =
  | { status: "loading" }
  | { status: "ready"; scan?: Scan; runtime?: RuntimeEvent; incident?: Incident; drift?: SentinelDriftEvent; unavailableReason?: string }
  | { status: "error"; message: string };

function linkedScanId(event: WorkspaceActivity) {
  if (event.resourceType === "scan") return event.resourceId;
  if (event.resourceType === "scan_scenario" && event.resourceId) {
    const separator = event.resourceId.indexOf(":");
    return separator > 0 ? event.resourceId.slice(0, separator) : null;
  }
  return null;
}

function linkedScenarioId(event: WorkspaceActivity) {
  if (typeof event.metadata.scenarioId === "string") return event.metadata.scenarioId;
  if (event.resourceType === "scan_scenario" && event.resourceId) {
    const separator = event.resourceId.indexOf(":");
    return separator > 0 ? event.resourceId.slice(separator + 1) : null;
  }
  return null;
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) return "Not recorded";
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp)
    : "Time unavailable";
}

function eventIcon(event: WorkspaceActivity) {
  if (event.category === "scan") return "scan";
  if (event.category === "runtime") return "activity";
  if (event.category === "sentinel") return "shield";
  if (event.category === "incident") return "bell";
  return "sparkle";
}

function ScanEvidence({ scan, event }: { scan: Scan; event: WorkspaceActivity }) {
  const scenarioId = linkedScenarioId(event);
  const result = scenarioId ? scan.results?.find((item) => item.scenarioId === scenarioId) : undefined;
  const copilot = result?.copilotGuidance;
  const guidance = copilot?.guidance;
  return (
    <>
      <section className="activity-detail__section">
        <div className="activity-detail__section-heading"><span className="eyebrow eyebrow--cyan">SCAN SNAPSHOT</span><span className={`activity-detail__pill activity-detail__pill--${scan.status}`}>{scan.status.replaceAll("_", " ")}</span></div>
        <div className="activity-detail__metrics">
          <div><span>Score</span><strong>{scan.score == null ? "Not scored" : `${scan.score}/100`}</strong></div>
          <div><span>Passed</span><strong>{scan.passed}</strong></div>
          <div><span>Findings</span><strong>{scan.failed}</strong></div>
          <div><span>Inconclusive</span><strong>{scan.inconclusive ?? 0}</strong></div>
        </div>
        <dl className="activity-detail__facts">
          <div><dt>Started</dt><dd>{formatTimestamp(scan.startedAt ?? scan.createdAt)}</dd></div>
          <div><dt>Finished</dt><dd>{formatTimestamp(scan.finishedAt)}</dd></div>
          <div><dt>Trigger</dt><dd>{scan.trigger}</dd></div>
          <div><dt>Execution mode</dt><dd>{scan.executionMode ?? "Not recorded"}</dd></div>
        </dl>
        {scan.safetyWarning ? <div className="activity-detail__notice activity-detail__notice--warning"><Icon name="shield" size={15} /><span>{scan.safetyWarning}</span></div> : null}
        {scan.error ? <div className="activity-detail__notice activity-detail__notice--error"><Icon name="activity" size={15} /><span>{scan.error}</span></div> : null}
      </section>

      {result ? (
        <section className="activity-detail__section">
          <span className="eyebrow eyebrow--cyan">SCENARIO EVIDENCE</span>
          <h3>{result.title}</h3>
          <div className="activity-detail__facts activity-detail__facts--stacked">
            <div><dt>Verdict</dt><dd>{result.verdict ?? result.status}</dd></div>
            <div><dt>Expected</dt><dd>{result.expected}</dd></div>
            <div><dt>Observed</dt><dd>{result.observed || "No agent response recorded"}</dd></div>
            <div><dt>Policy decision</dt><dd>{result.guard ? `${result.guard.decision} · ${result.guard.execution}` : "Not evaluated"}</dd></div>
            <div><dt>Execution safety</dt><dd>{result.executionSafety ?? "Unknown"}</dd></div>
          </div>
          {result.reasons.length ? <ul className="activity-detail__reason-list">{result.reasons.slice(0, 8).map((reason, index) => <li key={`${index}-${reason}`}>{reason}</li>)}</ul> : null}
          {result.remediation && result.remediation.status !== "protected" ? (
            <div className="activity-detail__recommendation">
              <span className="eyebrow">REMEDIATION REVIEW</span>
              <strong>{result.remediation.rootCause}</strong>
              <p>{result.remediation.summary}</p>
              {result.remediation.recommendations.slice(0, 4).map((item) => <article key={item.id}><b>{item.priority} · {item.title}</b><span>{item.action}</span></article>)}
            </div>
          ) : null}
        </section>
      ) : null}

      {event.category === "copilot" ? (
        <section className="activity-detail__section">
          <span className="eyebrow eyebrow--cyan">COPILOT GUIDANCE</span>
          {guidance ? (
            <>
              <div className="activity-detail__advisory">Advisory plan · {copilot?.model ?? "model unavailable"} · {formatTimestamp(copilot?.generatedAt)}</div>
              <p>{guidance.summary}</p>
              <div className="activity-detail__recommendation"><span className="eyebrow">LIKELY ROOT CAUSE</span><strong>{guidance.rootCause}</strong></div>
              <ol className="activity-detail__plan">{guidance.fixPlan.map((step, index) => <li key={`${index}-${step.title}`}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{step.title}</strong><p>{step.rationale}</p><pre>{step.implementation}</pre><small>Verify: {step.verify}</small></div></li>)}</ol>
              {guidance.acceptanceCriteria.length ? <div className="activity-detail__criteria"><span className="eyebrow">ACCEPTANCE CRITERIA</span><ul>{guidance.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul></div> : null}
              {guidance.caveats.length ? <div className="activity-detail__notice activity-detail__notice--warning"><Icon name="activity" size={15} /><span>{guidance.caveats.join(" ")}</span></div> : null}
              <p className="activity-detail__advisory">The plan has not been applied. Review it and make code or policy changes explicitly.</p>
            </>
          ) : <p>The scan record is available, but it does not contain a saved Copilot plan for this scenario.</p>}
        </section>
      ) : null}
    </>
  );
}

function RuntimeEvidence({ runtime }: { runtime: RuntimeEvent }) {
  const outcomeLabel = runtime.outcome === "error"
    ? "Technical error"
    : runtime.outcome === "quota"
      ? "Quota rejected"
      : runtime.decision === "BLOCK" ? "Policy blocked" : runtime.decision === "ALLOW" ? "Policy allowed" : "Decision unavailable";
  const decisionTone = runtime.outcome === "error"
    ? "error"
    : runtime.outcome === "quota" || runtime.decision === "BLOCK"
      ? "warning"
      : "allow";
  return (
    <>
      <section className="activity-detail__section">
        <span className="eyebrow eyebrow--cyan">RUNTIME DECISION</span>
        <div className={`activity-detail__decision activity-detail__decision--${decisionTone}`}>
          <strong>{outcomeLabel}</strong>
          <span>{runtime.toolName} · {runtime.latencyMs} ms</span>
        </div>
        <dl className="activity-detail__facts">
          <div><dt>Recorded</dt><dd>{formatTimestamp(runtime.createdAt)}</dd></div>
          <div><dt>Failure stage</dt><dd>{runtime.failureStage ?? "None"}</dd></div>
          <div><dt>Error code</dt><dd>{runtime.errorCode ?? "None"}</dd></div>
          <div><dt>Trace</dt><dd>{runtime.traceId ?? "Not recorded"}</dd></div>
        </dl>
        {runtime.reasons.length ? <ul className="activity-detail__reason-list">{runtime.reasons.slice(0, 8).map((reason, index) => <li key={`${index}-${reason}`}>{reason}</li>)}</ul> : null}
      </section>
      {runtime.traceSpans?.length ? (
        <section className="activity-detail__section">
          <span className="eyebrow eyebrow--cyan">REQUEST TRACE</span>
          <ol className="activity-detail__trace">{runtime.traceSpans.slice(0, 64).map((span) => <li key={span.spanId}><i /><div><div><strong>{span.name}</strong><time>{span.durationMs} ms</time></div><span>{span.stage.replaceAll("_", " ")} · {span.outcome.replaceAll("_", " ")}{span.decision ? ` · ${span.decision}` : ""}</span>{span.toolCount !== undefined ? <small>{span.toolCount} tool call{span.toolCount === 1 ? "" : "s"}</small> : null}</div></li>)}</ol>
          <p className="activity-detail__advisory">The trace explains AgentGuard's observed decision path. It does not prove that a customer application completed a side effect.</p>
        </section>
      ) : <section className="activity-detail__section"><span className="eyebrow eyebrow--cyan">REQUEST TRACE</span><p>No trace spans were recorded for this request.</p></section>}
    </>
  );
}

function IncidentEvidence({ incident }: { incident: Incident }) {
  return (
    <section className="activity-detail__section">
      <div className="activity-detail__section-heading"><span className="eyebrow eyebrow--cyan">INCIDENT RECORD</span><span className={`activity-detail__pill activity-detail__pill--${incident.status}`}>{incident.status}</span></div>
      <div className={`activity-detail__decision activity-detail__decision--${incident.severity === "critical" || incident.severity === "high" ? "error" : "warning"}`}><strong>{incident.title}</strong><span>{incident.severity.toUpperCase()} · {incident.eventType.replaceAll("_", " ")}</span></div>
      <p>{incident.message}</p>
      <dl className="activity-detail__facts">
        <div><dt>Opened</dt><dd>{formatTimestamp(incident.createdAt)}</dd></div>
        <div><dt>Resolved</dt><dd>{formatTimestamp(incident.resolvedAt)}</dd></div>
        <div><dt>Resource</dt><dd>{incident.resourceType ?? "Workspace"}{incident.resourceId ? ` · ${incident.resourceId}` : ""}</dd></div>
      </dl>
    </section>
  );
}

function SentinelEvidence({ drift }: { drift: SentinelDriftEvent }) {
  return (
    <section className="activity-detail__section">
      <div className="activity-detail__section-heading"><span className="eyebrow eyebrow--cyan">SENTINEL DRIFT RECORD</span><span className={`activity-detail__pill activity-detail__pill--${drift.status}`}>{drift.status}</span></div>
      <div className={`activity-detail__decision activity-detail__decision--${drift.severity === "critical" || drift.severity === "high" ? "error" : "warning"}`}><strong>{drift.severity.toUpperCase()} drift</strong><span>{drift.changes.length} recorded change{drift.changes.length === 1 ? "" : "s"}</span></div>
      <dl className="activity-detail__facts">
        <div><dt>Detected</dt><dd>{formatTimestamp(drift.detectedAt)}</dd></div>
        <div><dt>Resolved</dt><dd>{formatTimestamp(drift.resolvedAt)}</dd></div>
        <div><dt>Baseline</dt><dd>{drift.baselineId ?? "No baseline recorded"}</dd></div>
        <div><dt>Fingerprint</dt><dd>{drift.fingerprint}</dd></div>
      </dl>
      {drift.changes.length ? <ol className="activity-detail__changes">{drift.changes.map((change) => <li key={change.id}><div><strong>{change.field}</strong><span>{change.severity.toUpperCase()}</span></div><p>{change.impact}</p></li>)}</ol> : <p>No individual change details were stored for this event.</p>}
    </section>
  );
}

export function ActivityEventDetails({
  event,
  agents,
  authUser,
  onClose,
  onNavigate,
  onAgentUpdated,
}: {
  event: WorkspaceActivity;
  agents: Agent[];
  authUser: SessionUser;
  onClose: () => void;
  onNavigate: (page: string, event?: WorkspaceActivity) => void;
  onAgentUpdated: (agent: Agent) => void;
}) {
  const [evidence, setEvidence] = useState<EvidenceState>({ status: "loading" });
  const [pendingAction, setPendingAction] = useState<"resolve" | "quarantine" | "restore" | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const [quarantineReason, setQuarantineReason] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const actionBusyRef = useRef(actionBusy);
  const canManage = authUser.role === "owner" || authUser.role === "admin";
  const linkedAgent = useMemo(() => agents.find((agent) => agent.id === event.agentId), [agents, event.agentId]);
  const scanId = linkedScanId(event);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { actionBusyRef.current = actionBusy; }, [actionBusy]);

  useEffect(() => {
    let active = true;
    setEvidence({ status: "loading" });
    const load = async () => {
      try {
        if (scanId) {
          const scan = await getScan(scanId);
          if (active) setEvidence({ status: "ready", scan });
          return;
        }
        if (event.category === "runtime" && event.agentId && event.resourceId) {
          const runtime = await getRuntimeEvent(event.agentId, event.resourceId);
          if (active) setEvidence({ status: "ready", runtime });
          return;
        }
        if (event.category === "incident" && event.resourceType === "incident" && event.resourceId) {
          const incident = await getIncident(event.resourceId);
          if (active) setEvidence({ status: "ready", incident });
          return;
        }
        if (event.category === "sentinel" && event.resourceType === "sentinel_event" && event.resourceId) {
          const drift = await getSentinelDriftEvent(event.resourceId);
          if (active) setEvidence({ status: "ready", drift });
          return;
        }
        if (active) setEvidence({ status: "ready", unavailableReason: "This event has no linked evidence record." });
      } catch (caught) {
        if (active) setEvidence({ status: "error", message: caught instanceof Error ? caught.message : "Linked evidence could not be loaded." });
      }
    };
    void load();
    return () => { active = false; };
  }, [event.id, event.category, event.agentId, event.resourceId, event.resourceType, scanId]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    function handleKeyDown(keyboardEvent: KeyboardEvent) {
      if (keyboardEvent.key === "Escape" && !actionBusyRef.current) {
        onCloseRef.current();
        return;
      }
      if (keyboardEvent.key === "Tab") {
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        );
        if (!focusable?.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (keyboardEvent.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
          keyboardEvent.preventDefault();
          last.focus();
        } else if (!keyboardEvent.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
          keyboardEvent.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  async function performAction() {
    if (!pendingAction || actionBusy) return;
    setActionBusy(true);
    setActionError("");
    setActionNotice("");
    try {
      if (pendingAction === "resolve") {
        if (!event.resourceId) throw new Error("This incident has no resolvable record.");
        await resolveIncident(event.resourceId);
        setEvidence((current) => current.status === "ready" && current.incident
          ? { ...current, incident: { ...current.incident, status: "resolved", resolvedAt: new Date().toISOString() } }
          : current);
        setActionNotice("Incident resolved. The action was recorded in the workspace feed.");
      } else if (pendingAction === "quarantine") {
        if (!event.agentId) throw new Error("This event is not linked to an agent.");
        const agent = await quarantineAgent(event.agentId, quarantineReason.trim());
        onAgentUpdated(agent);
        setActionNotice("Agent quarantined. New scans and Runtime invocations are blocked.");
      } else {
        if (!event.agentId) throw new Error("This event is not linked to an agent.");
        const agent = await restoreAgent(event.agentId);
        onAgentUpdated(agent);
        setActionNotice("Agent restored. The owner or admin action was recorded.");
      }
      setPendingAction(null);
      setQuarantineReason("");
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "The requested security action failed.");
    } finally {
      setActionBusy(false);
    }
  }

  const incidentCanResolve = evidence.status === "ready" && evidence.incident?.status === "open";
  const showQuarantineAction = Boolean(linkedAgent && linkedAgent.status !== "quarantined" && event.severity !== "info" && event.severity !== "success");
  const showRestoreAction = linkedAgent?.status === "quarantined";

  return (
    <div className="activity-detail-backdrop" role="presentation" onMouseDown={(mouseEvent) => {
      if (mouseEvent.target === mouseEvent.currentTarget && !actionBusy) onClose();
    }}>
      <aside ref={dialogRef} className="activity-detail" role="dialog" aria-modal="true" aria-labelledby="activity-detail-title" aria-describedby="activity-detail-description" tabIndex={-1}>
        <header className="activity-detail__header">
          <div className={`activity-detail__icon activity-detail__icon--${event.category}`}><Icon name={eventIcon(event)} size={17} /></div>
          <div className="activity-detail__heading">
            <span className="eyebrow eyebrow--cyan">EVENT INVESTIGATION</span>
            <h2 id="activity-detail-title">{event.title}</h2>
            <span>{event.category.replaceAll("_", " ")} · {formatTimestamp(event.createdAt)}</span>
          </div>
          <span className={`activity-detail__pill activity-detail__pill--${event.severity}`}>{event.severity}</span>
          <button ref={closeButtonRef} type="button" className="more-button" onClick={onClose} aria-label="Close event details">×</button>
        </header>

        <div className="activity-detail__content">
          <section className="activity-detail__summary">
            <span className="eyebrow">WHAT HAPPENED</span>
            <p id="activity-detail-description">{event.explanation}</p>
            <div className="activity-detail__chips">
              {event.agentName ? <span><Icon name="bot" size={12} />{event.agentName}</span> : null}
              {typeof event.metadata.scenarioOrdinal === "number" && typeof event.metadata.scenarioTotal === "number" ? <span>Scenario {event.metadata.scenarioOrdinal}/{event.metadata.scenarioTotal}</span> : null}
              {typeof event.metadata.score === "number" ? <span>Score {event.metadata.score}/100</span> : null}
              {typeof event.metadata.traceId === "string" ? <span>Trace {event.metadata.traceId}</span> : null}
            </div>
          </section>

          {evidence.status === "loading" ? <div className="activity-detail__loading" role="status"><span className="activity-detail__spinner" />Loading workspace-scoped evidence…</div> : null}
          {evidence.status === "error" ? <div className="activity-detail__notice activity-detail__notice--error" role="alert"><Icon name="activity" size={15} /><span>{evidence.message}</span></div> : null}
          {evidence.status === "ready" && evidence.scan ? <ScanEvidence scan={evidence.scan} event={event} /> : null}
          {evidence.status === "ready" && evidence.runtime ? <RuntimeEvidence runtime={evidence.runtime} /> : null}
          {evidence.status === "ready" && evidence.incident ? <IncidentEvidence incident={evidence.incident} /> : null}
          {evidence.status === "ready" && evidence.drift ? <SentinelEvidence drift={evidence.drift} /> : null}
          {evidence.status === "ready" && evidence.unavailableReason ? <section className="activity-detail__section"><p>{evidence.unavailableReason}</p></section> : null}

          {actionError ? <div className="activity-detail__notice activity-detail__notice--error" role="alert"><Icon name="activity" size={15} /><span>{actionError}</span></div> : null}
          {actionNotice ? <div className="activity-detail__notice" role="status"><Icon name="shield" size={15} /><span>{actionNotice}</span></div> : null}

          {pendingAction ? (
            <section className={`activity-detail__confirm activity-detail__confirm--${pendingAction === "quarantine" ? "danger" : "warning"}`}>
              <strong>{pendingAction === "quarantine" ? "Confirm agent quarantine" : pendingAction === "restore" ? "Confirm agent restore" : "Confirm incident resolution"}</strong>
              <p>{pendingAction === "quarantine" ? "New scans and Runtime invocations will be blocked until an owner or admin restores this agent." : pendingAction === "restore" ? "This allows the agent to receive new scans and Runtime invocations again." : "The incident will be marked resolved. This does not change the agent policy or remove its evidence."}</p>
              {pendingAction === "quarantine" ? <label>Reason<input value={quarantineReason} onChange={(changeEvent) => setQuarantineReason(changeEvent.target.value)} maxLength={240} required /></label> : null}
              <div><button type="button" className="button button--subtle" onClick={() => setPendingAction(null)} disabled={actionBusy}>Cancel</button><button type="button" className={`button ${pendingAction === "quarantine" ? "dialog__confirm--danger" : "button--primary"}`} onClick={() => void performAction()} disabled={actionBusy || (pendingAction === "quarantine" && !quarantineReason.trim())}>{actionBusy ? "Applying…" : pendingAction === "quarantine" ? "Quarantine agent" : pendingAction === "restore" ? "Restore agent" : "Resolve incident"}</button></div>
            </section>
          ) : null}

          <section className="activity-detail__actions">
            <span className="eyebrow">NEXT ACTIONS</span>
            <div className="activity-detail__action-buttons">
              {scanId ? <button type="button" className="button button--subtle" onClick={() => onNavigate("Scans", event)}><Icon name="scan" size={14} />Open full scan evidence</button> : null}
              {event.agentId ? <button type="button" className="button button--subtle" onClick={() => onNavigate("Agents", event)}><Icon name="bot" size={14} />Open agent</button> : null}
              {event.category === "sentinel" ? <button type="button" className="button button--subtle" onClick={() => onNavigate("Sentinel", event)}><Icon name="shield" size={14} />Open Sentinel</button> : null}
              {event.category === "incident" ? <button type="button" className="button button--subtle" onClick={() => onNavigate("Incidents", event)}><Icon name="bell" size={14} />Open Incident Center</button> : null}
              {canManage && incidentCanResolve && !pendingAction ? <button type="button" className="button button--subtle" onClick={() => setPendingAction("resolve")}><Icon name="shield" size={14} />Resolve incident</button> : null}
              {canManage && showQuarantineAction && !pendingAction ? <button type="button" className="button button--danger" onClick={() => { setQuarantineReason(`Security response to: ${event.title}`.slice(0, 240)); setPendingAction("quarantine"); }}><Icon name="lock" size={14} />Quarantine agent</button> : null}
              {canManage && showRestoreAction && !pendingAction ? <button type="button" className="button button--subtle" onClick={() => setPendingAction("restore")}><Icon name="unlock" size={14} />Restore agent</button> : null}
            </div>
            {!canManage && ((incidentCanResolve) || showQuarantineAction || showRestoreAction) ? <p className="activity-detail__permission">Only workspace owners and admins can resolve incidents or change an agent's quarantine state.</p> : null}
            {event.category === "copilot" ? <p className="activity-detail__advisory">Copilot guidance is review-only. It never applies code or changes policy automatically.</p> : null}
          </section>
        </div>
      </aside>
    </div>
  );
}
