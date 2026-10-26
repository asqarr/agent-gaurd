import { useEffect, useState } from "react";
import { Icon } from "../../shared/ui/Icon";
import type { AttackPathResult, Scan, ScanProgress, ScanRemediation, SecurityDemoProof } from "../../shared/types/api";

type ScanResult = NonNullable<Scan["results"]>[number];

function wasBlockedSafely(result: ScanResult) {
  return result.guard?.decision === "BLOCK" && result.guard.execution === "NOT_EXECUTED";
}

function resultTone(result: ScanResult) {
  return result.status === "ERROR"
    ? "warning"
    : result.status === "FAIL" && !wasBlockedSafely(result)
      ? "danger"
      : "safe";
}

function resultLabel(result: ScanResult) {
  if (result.status === "ERROR") return "Error";
  if (wasBlockedSafely(result)) return "Blocked safely";
  return result.status === "PASS" ? "Passed" : "Finding";
}

function ThreatReplay({ results }: { results: ScanResult[] }) {
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const active = results[activeIndex] ?? results[0];

  useEffect(() => {
    if (!playing || results.length < 2) return undefined;
    const timer = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % results.length);
    }, 2800);
    return () => window.clearInterval(timer);
  }, [playing, results.length]);

  useEffect(() => {
    setActiveIndex(0);
    setPlaying(false);
  }, [results]);

  if (!results.length) return null;

  function launch() {
    setOpen(true);
    setPlaying(true);
    setActiveIndex(0);
  }

  return (
    <div className={`threat-replay ${open ? "threat-replay--open" : ""}`}>
      {!open ? (
        <button type="button" className="threat-replay__launch" onClick={launch}>
          <span className="threat-replay__launch-icon"><Icon name="activity" size={17} /></span>
          <span>
            <strong>Replay attack path</strong>
            <small>Watch the agent proposal move through the policy guard</small>
          </span>
          <Icon name="arrow" size={15} />
        </button>
      ) : (
        <>
          <div className="threat-replay__header">
            <div>
              <span className="eyebrow eyebrow--cyan">THREAT REPLAY</span>
              <h3>See exactly where the guard intervened.</h3>
              <p>Evidence playback · scenario {activeIndex + 1} of {results.length}</p>
            </div>
            <div className="threat-replay__controls">
              <button type="button" className="button button--subtle" onClick={() => setPlaying((current) => !current)}>
                {playing ? "Pause replay" : "Resume replay"}
              </button>
              <button type="button" className="more-button" onClick={() => { setOpen(false); setPlaying(false); }} aria-label="Close threat replay">Ã—</button>
            </div>
          </div>
          <div className="threat-replay__rail" aria-label="Replay scenarios">
            {results.map((result, index) => (
              <button
                type="button"
                key={result.scenarioId}
                className={`threat-replay__node ${index === activeIndex ? "threat-replay__node--active" : ""} threat-replay__node--${resultTone(result)}`}
                onClick={() => { setActiveIndex(index); setPlaying(false); }}
                aria-label={`Replay ${result.title}`}
              >
                <i>{index + 1}</i>
                <span>{result.title}</span>
              </button>
            ))}
          </div>
          <div className={`threat-replay__scene threat-replay__scene--${resultTone(active)}`}>
            <div className="threat-replay__scene-heading">
              <div>
                <span>{active.category}</span>
                <strong>{active.title}</strong>
              </div>
              <b>{resultLabel(active)}</b>
            </div>
            <div className="threat-replay__stages">
              <div className="threat-replay__stage threat-replay__stage--input">
                <span>01 · INPUT</span>
                <strong>{active.expected}</strong>
              </div>
              <div className="threat-replay__connector" />
              <div className="threat-replay__stage threat-replay__stage--proposal">
                <span>02 · AGENT PROPOSAL</span>
                <strong>{active.observed || "No tool call proposed"}</strong>
                {active.call ? <small>{active.call.name} · {JSON.stringify(active.call.arguments)}</small> : null}
              </div>
              <div className="threat-replay__connector" />
              <div className="threat-replay__stage threat-replay__stage--policy">
                <span>03 · POLICY GUARD</span>
                <strong>{active.guard?.decision ?? "NOT EVALUATED"}</strong>
                {active.reasons[0] ? <small>{active.reasons[0]}</small> : null}
              </div>
              <div className="threat-replay__connector" />
              <div className="threat-replay__stage threat-replay__stage--outcome">
                <span>04 · OUTCOME</span>
                <strong>{active.guard?.execution ?? "NO EXECUTION"}</strong>
                <small>{wasBlockedSafely(active) ? "Unsafe proposal stopped before execution" : active.status === "PASS" ? "Agent stayed within policy" : active.status === "FAIL" ? "Unsafe behavior reached the decision boundary" : "Scenario needs review"}</small>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatDuration(durationMs: number | null) {
  return durationMs == null ? "—" : `${(durationMs / 1000).toFixed(1)}s`;
}

function RemediationCard({
  remediation,
  onRetest,
}: {
  remediation: ScanRemediation;
  onRetest?: (scenarioId: string) => void;
}) {
  const isProtected = remediation.status === "protected";
  return (
    <div className={`scan-remediation scan-remediation--${isProtected ? "protected" : remediation.severity}`}>
      <div className="scan-remediation__top">
        <div>
          <span className="eyebrow eyebrow--cyan">{isProtected ? "CONTROL CONFIRMED" : "REMEDIATION INTELLIGENCE"}</span>
          <h5>{remediation.title}</h5>
        </div>
        <div className="scan-remediation__badges"><b>{remediation.priority}</b><b>{remediation.confidence} confidence</b></div>
      </div>
      <p className="scan-remediation__summary">{remediation.summary}</p>
      <div className="scan-remediation__impact"><span>Root cause</span><strong>{remediation.rootCause}</strong><small>{remediation.businessImpact}</small></div>
      <div className="scan-remediation__actions">
        {remediation.recommendations.map((item) => <article key={item.id}><div><b>{item.priority} · {item.title}</b><span>{item.action}</span></div><small><strong>Implementation:</strong> {item.implementation}<br /><strong>Verify:</strong> {item.verify}</small></article>)}
      </div>
      <div className="scan-remediation__acceptance"><span>Acceptance criteria</span><ul>{remediation.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul></div>
      {onRetest ? <button type="button" className="button button--subtle scan-remediation__retest" onClick={() => onRetest(remediation.retest.scenarioId)}><Icon name="activity" size={14} />{remediation.retest.label}</button> : null}
    </div>
  );
}

function AttackPathEvidence({ paths }: { paths: AttackPathResult[] }) {
  if (!paths.length) return null;
  const protectedCount = paths.filter((path) => path.status === "protected").length;
  return (
    <div className="scan-attack-paths">
      <div className="scan-attack-paths__heading"><span className="eyebrow eyebrow--cyan">CHAIN VERIFICATION</span><span>{protectedCount}/{paths.length} protected</span></div>
      <div className="scan-attack-paths__grid">
        {paths.map((path) => (
          <div className={`scan-attack-path scan-attack-path--${path.status}`} key={path.id}>
            <div><strong>{path.title}</strong><span>{path.status === "incomplete" ? "INCOMPLETE" : path.status.toUpperCase()}</span></div>
            <small>{path.steps.filter((step) => step.status === "PASS").length}/{path.steps.length} steps passed · {path.coverage?.evaluated ?? path.steps.filter((step) => step.status !== "PENDING").length}/{path.coverage?.required ?? path.steps.length} evaluated</small>
            {path.status === "incomplete" ? <p>This chain is only partially covered by the selected plan or scan. It is not evidence that the agent passed.</p> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ScanEvidencePanel({
  scan,
  onClose,
  onRetest,
}: {
  scan: Scan;
  onClose: () => void;
  onRetest?: (scenarioId: string) => void;
}) {
  const results = scan.results ?? [];
  const testedScenarioCount = scan.scenarioCount ?? results.length;
  const fullSuite = testedScenarioCount >= 12;
  const statusLabel =
    scan.status === "completed"
      ? "Evidence persisted"
      : scan.status === "failed"
        ? "Scan failed"
        : "Evidence pending";

  return (
    <section className="scan-evidence" aria-live="polite">
      <div className="scan-evidence__header">
        <div>
          <span className="eyebrow eyebrow--cyan">SCAN EVIDENCE</span>
          <h3>{scan.agentName ?? scan.agentId}</h3>
          <p>
            {statusLabel} · {formatDateTime(scan.createdAt)}
          </p>
        </div>
        <div className="scan-evidence__header-actions">
          {scan.status === "completed" ? (
            <button
              type="button"
              className="button button--subtle"
              onClick={() => window.open(`/api/scans/${encodeURIComponent(scan.id)}/report`, "_blank", "noopener,noreferrer")}
            >
              Share report
            </button>
          ) : null}
        </div>
        <button
          type="button"
          className="more-button"
          onClick={onClose}
          aria-label="Close scan evidence"
        >
          ×
        </button>
      </div>

      {scan.safetyWarning ? (
        <div className={`scan-safety-notice scan-safety-notice--${scan.safetyStatus === "unsafe" ? "danger" : "warning"}`}>
          <Icon name="shield" size={16} />
          <div><strong>{scan.safetyStatus === "unsafe" ? "Unsafe execution reported" : "Endpoint execution is not provable"}</strong><span>{scan.safetyWarning}</span></div>
        </div>
      ) : null}

      <div className="scan-evidence__summary">
        <div>
          <span>Score</span>
          <strong
            className={
              scan.score != null && scan.score > 85
                ? "score-good"
                : "score-warn"
            }
          >
            {scan.score ?? "—"}
            <small>/100</small>
          </strong>
        </div>
        <div>
          <span>Passed</span>
          <strong>{scan.passed}</strong>
        </div>
        <div>
          <span>Findings</span>
          <strong className={scan.failed ? "finding-count" : "table-value"}>
            {scan.failed}
          </strong>
        </div>
        <div>
          <span>Blocked</span>
          <strong>{scan.blocked}</strong>
        </div>
        <div>
          <span>Duration</span>
          <strong>{formatDuration(scan.durationMs)}</strong>
        </div>
        <div>
          <span>Coverage</span>
          <strong>{testedScenarioCount}<small>/12</small></strong>
        </div>
      </div>
      <div className="scan-evidence__score-note" role="note"><Icon name="activity" size={13} /><span>This is a control score for the selected evidence, not a guarantee of complete agent security. {fullSuite ? "The full 12-scenario suite was evaluated." : `Only ${testedScenarioCount}/12 scenarios were evaluated; advanced chains may remain incomplete.`}</span></div>
      <div className="scan-evidence__legend" role="note">
        <span><i className="scan-legend-dot scan-legend-dot--safe" />Passed = expected outcome observed</span>
        <span><i className="scan-legend-dot scan-legend-dot--blocked" />Blocked safely = proposal stopped before execution</span>
        <span><i className="scan-legend-dot scan-legend-dot--finding" />Finding = unsafe proposal was not blocked</span>
      </div>

      {scan.remediationSummary ? <div className="scan-remediation-summary">
        <div className="scan-remediation-summary__heading"><div><span className="eyebrow eyebrow--cyan">REMEDIATION QUEUE</span><strong>{scan.remediationSummary.open ? `${scan.remediationSummary.open} action${scan.remediationSummary.open === 1 ? "" : "s"} require attention` : "All tested controls are protected"}</strong></div><span>{scan.remediationSummary.p0 ? `${scan.remediationSummary.p0} P0` : "No P0"}</span></div>
        <div className="scan-remediation-summary__metrics"><div><span>Protected</span><b>{scan.remediationSummary.protected}/{scan.remediationSummary.total}</b></div><div><span>Critical</span><b>{scan.remediationSummary.critical}</b></div><div><span>High</span><b>{scan.remediationSummary.high}</b></div><div><span>Top priority</span><b>{scan.remediationSummary.topActions[0]?.scenarioId ?? "—"}</b></div></div>
      </div> : null}

      <AttackPathEvidence paths={scan.attackPaths ?? []} />

      {scan.error ? (
        <div className="scan-evidence__error">
          <strong>Worker error</strong>
          <span>{scan.error}</span>
        </div>
      ) : null}
      {scan.status !== "completed" && !scan.error ? (
        <div className="scan-evidence__empty">
          <Icon name="clock" size={16} />
          <span>
            Scenario evidence will appear after the worker reaches a terminal
            state.
          </span>
        </div>
      ) : null}

      <ThreatReplay results={results} />

      {results.length ? (
        <div className="evidence-list">
          {results.map((result) => (
            <article
              className={`evidence-card evidence-card--${result.status.toLowerCase()}`}
              key={result.scenarioId}
            >
              <div className="evidence-card__heading">
                <div>
                  <span className="evidence-card__category">
                    {result.category}
                  </span>
                  <h4>{result.title}</h4>
                </div>
                <span
                  className={`evidence-status evidence-status--${result.status.toLowerCase()} evidence-status--${resultTone(result)}`}
                >
                  <i />
                  {resultLabel(result)}
                </span>
              </div>
              <div className="evidence-card__grid">
                <div>
                  <span>Expected</span>
                  <strong>{result.expected}</strong>
                </div>
                <div>
                  <span>Observed</span>
                  <strong>{result.observed || "No tool call"}</strong>
                </div>
                <div>
                  <span>Policy decision</span>
                  <strong>{result.guard?.decision ?? "Not evaluated"}</strong>
                </div>
                <div>
                  <span>Execution</span>
                  <strong>{result.guard?.execution ?? "Not executed"}</strong>
                </div>
              </div>
              {result.reasons.length ? (
                <div className="evidence-reasons">
                  <span>Decision reasons</span>
                  <ul>
                    {result.reasons.map((reason, index) => (
                      <li key={`${result.scenarioId}-reason-${index}`}>{reason}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {result.call ? (
                <div className="evidence-call">
                  <div>
                    <span>Proposed tool call</span>
                    <strong>{result.call.name}</strong>
                  </div>
                  <pre>{JSON.stringify(result.call.arguments, null, 2)}</pre>
                </div>
              ) : null}
              {result.remediation ? <RemediationCard remediation={result.remediation} onRetest={onRetest} /> : null}
            </article>
          ))}
        </div>
      ) : scan.status === "completed" ? (
        <div className="scan-evidence__empty">
          <Icon name="shield" size={16} />
          <span>This scan completed without persisted scenario rows.</span>
        </div>
      ) : null}
    </section>
  );
}

export function LiveScanPanel({
  scan,
  demoProof,
  onClose,
}: {
  scan: Scan;
  demoProof?: SecurityDemoProof | null;
  onClose: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const progress = scan.progress ?? [];
  const terminalStatuses = new Set(["passed", "blocked", "failed", "error"]);
  const completedCount = progress.filter((item) => terminalStatuses.has(item.status)).length;
  const total = scan.scenarioCount ?? progress.length;
  const percent = scan.status === "completed"
    ? 100
    : total > 0
      ? Math.round((completedCount / total) * 100)
      : 0;
  const current = progress.find((item) => item.status === "running");
  const elapsedMs = scan.durationMs ?? Math.max(
    0,
    now - new Date(scan.startedAt ?? scan.createdAt).getTime(),
  );
  const terminal = scan.status === "completed" || scan.status === "failed";

  useEffect(() => {
    if (terminal) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [terminal]);

  const statusText = scan.status === "queued"
    ? "Waiting for the scan worker"
    : scan.status === "failed"
      ? "Scan stopped with an error"
      : scan.status === "completed"
        ? "All security scenarios evaluated"
        : current
          ? `Testing ${current.title}`
          : "Preparing security scenarios";

  return (
    <section className={`live-scan-panel live-scan-panel--${scan.status}`} aria-live="polite">
      <div className="live-scan-panel__topline">
        <div className="live-scan-panel__title">
          <span className="live-scan-orb"><i /></span>
          <div>
            <span className="eyebrow eyebrow--cyan">LIVE SECURITY SCAN</span>
            <h2>{scan.agentName ?? scan.agentId}</h2>
            <p>{statusText}</p>
          </div>
        </div>
        <button type="button" className="more-button" onClick={onClose} aria-label="Close live scan panel">
          ×
        </button>
      </div>
      <div className="live-scan-panel__metrics">
        <div>
          <span>Progress</span>
          <strong>{completedCount}/{total || "—"}</strong>
        </div>
        <div>
          <span>Elapsed</span>
          <strong>{formatDuration(elapsedMs)}</strong>
        </div>
        <div>
          <span>Current state</span>
          <strong>{scan.status === "running" ? "Analyzing" : scan.status[0].toUpperCase() + scan.status.slice(1)}</strong>
        </div>
      </div>
      <div className="live-scan-progress" aria-label={`Scan ${percent}% complete`}>
        <span style={{ width: `${Math.max(scan.status === "queued" ? 3 : percent, 3)}%` }} />
      </div>
      {demoProof ? (
        <section className="gateway-proof" aria-label="Gateway security proof">
          <div className="gateway-proof__heading">
            <div>
              <span className="eyebrow eyebrow--cyan">PRE-EXECUTION GATEWAY PROOF</span>
              <h3>${String(demoProof.attemptedToolCall.arguments.amount)} refund blocked before execution</h3>
              <p>Same Runtime Firewall · synthetic order · no customer endpoint was called</p>
            </div>
            <strong className="gateway-proof__badge">{demoProof.guard.decision}</strong>
          </div>
          <div className="gateway-proof__grid">
            <div><span>Policy ceiling</span><strong>{demoProof.policy.currency} {demoProof.policy.maxAmount}</strong></div>
            <div><span>Proposed tool</span><strong>{demoProof.attemptedToolCall.name}</strong></div>
            <div><span>Execution</span><strong>{demoProof.guard.execution}</strong></div>
            <div><span>Side effect</span><strong>{demoProof.evidence.sideEffectExecuted ? "Detected" : "None"}</strong></div>
          </div>
          <div className="gateway-proof__evidence">
            <div><span>Evidence ID</span><code>{demoProof.id}</code></div>
            <div><span>Request</span><code>{demoProof.requestId}</code></div>
            <div><span>Reason</span><b>{demoProof.guard.reasons[0] ?? "Policy denied the action."}</b></div>
          </div>
          <div className="gateway-proof__actions">
            {terminal ? (
              <button type="button" className="button button--primary" onClick={() => window.open(`/api/scans/${encodeURIComponent(scan.id)}/report`, "_blank", "noopener,noreferrer")}>
                Open evidence report <Icon name="arrow" size={14} />
              </button>
            ) : <span>Evidence report unlocks when the five scenarios complete.</span>}
            <span>Refund executor was never reached.</span>
          </div>
        </section>
      ) : null}
      <div className="live-scan-steps">
        {progress.map((item) => (
          <LiveScanStep key={item.scenarioId} item={item} />
        ))}
      </div>
      {scan.error ? <div className="live-scan-error"><strong>Worker error</strong><span>{scan.error}</span></div> : null}
      {terminal ? <div className="live-scan-panel__footer">The complete evidence is available in the Scans view.</div> : null}
    </section>
  );
}

export function LiveScanStep({ item }: { item: ScanProgress }) {
  const label = item.status === "running"
    ? "Testing"
    : item.status === "passed"
      ? "Passed"
      : item.status === "blocked"
        ? "Blocked safely"
        : item.status === "failed"
          ? "Finding"
          : item.status === "error"
            ? "Error"
            : "Queued";
  return (
    <div className={`live-scan-step live-scan-step--${item.status}`}>
      <span className="live-scan-step__marker">{item.status === "running" ? <i /> : item.status === "passed" ? "✓" : item.status === "blocked" ? "!" : item.status === "failed" || item.status === "error" ? "×" : item.ordinal + 1}</span>
      <div>
        <strong>{item.title}</strong>
        <span>{item.category}</span>
      </div>
      <em>{label}</em>
      {item.durationMs != null ? <small>{formatDuration(item.durationMs)}</small> : null}
    </div>
  );
}


