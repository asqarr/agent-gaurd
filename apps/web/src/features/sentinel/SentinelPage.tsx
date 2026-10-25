import { useEffect, useMemo, useState } from "react";
import {
  checkAllSentinel,
  checkSentinel,
  createSentinelBaseline,
  getSentinelOverview,
  updateSentinelSettings,
} from "./sentinel.api";
import type { Agent, SentinelChange, SentinelOverview, SentinelSeverity, SentinelState } from "../../shared/types/api";
import { Icon } from "../../shared/ui/Icon";

function severityLabel(value: SentinelSeverity) {
  return value === "none" ? "Clean" : value.charAt(0).toUpperCase() + value.slice(1);
}

function displayValue(value: unknown) {
  if (value === null || value === undefined) return "Not configured";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatDate(value: string | null) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function ChangeRow({ change }: { change: SentinelChange }) {
  return (
    <div className={`sentinel-change sentinel-change--${change.severity}`}>
      <div className="sentinel-change__marker"><Icon name={change.severity === "critical" ? "activity" : "shield"} size={14} /></div>
      <div className="sentinel-change__copy">
        <div className="sentinel-change__topline">
          <strong>{change.field}</strong>
          <span>{severityLabel(change.severity)}</span>
        </div>
        <div className="sentinel-change__values">
          <code>{displayValue(change.from)}</code><Icon name="arrow" size={12} /><code>{displayValue(change.to)}</code>
        </div>
        <p>{change.impact}</p>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return <div className={`sentinel-summary-card ${tone ? `sentinel-summary-card--${tone}` : ""}`}><span>{label}</span><strong>{value}</strong></div>;
}

export function SentinelPage({
  agents,
  selectedAgentId,
  onSelectAgent,
}: {
  agents: Agent[];
  selectedAgentId: string;
  onSelectAgent: (id: string) => void;
}) {
  const [overview, setOverview] = useState<SentinelOverview | null>(null);
  const [agentId, setAgentId] = useState(selectedAgentId || agents[0]?.id || "");
  const [busy, setBusy] = useState<"load" | "check" | "baseline" | "settings" | "all" | "">("load");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const selected = useMemo(
    () => overview?.agents.find((agent) => agent.agentId === agentId) ?? overview?.agents[0] ?? null,
    [agentId, overview],
  );

  useEffect(() => {
    if (!agentId && agents[0]) {
      setAgentId(agents[0].id);
      onSelectAgent(agents[0].id);
    }
  }, [agentId, agents, onSelectAgent]);

  useEffect(() => {
    let cancelled = false;
    setBusy("load");
    getSentinelOverview()
      .then((next) => {
        if (!cancelled) {
          setOverview(next);
          if (!agentId && next.agents[0]) {
            setAgentId(next.agents[0].agentId);
            onSelectAgent(next.agents[0].agentId);
          }
        }
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Sentinel could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setBusy("");
      });
    return () => { cancelled = true; };
  }, []);

  function chooseAgent(value: string) {
    setAgentId(value);
    onSelectAgent(value);
    setError("");
    setNotice("");
  }

  function replaceState(next: SentinelState) {
    setOverview((current) => current
      ? { ...current, agents: current.agents.map((item) => item.agentId === next.agentId ? next : item) }
      : current);
  }

  async function runCheck() {
    if (!selected || busy) return;
    setBusy("check");
    setError("");
    setNotice("");
    try {
      replaceState(await checkSentinel(selected.agentId));
      setNotice("Sentinel checked the live configuration and stored the result.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sentinel check failed.");
    } finally {
      setBusy("");
    }
  }

  async function runCheckAll() {
    if (busy) return;
    setBusy("all");
    setError("");
    setNotice("");
    try {
      setOverview(await checkAllSentinel());
      setNotice("Every connected agent was checked against its approved baseline.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The workspace check failed.");
    } finally {
      setBusy("");
    }
  }

  async function establishBaseline() {
    if (!selected || busy) return;
    setBusy("baseline");
    setError("");
    setNotice("");
    try {
      replaceState(await createSentinelBaseline(selected.agentId));
      setNotice("Trusted baseline saved. Future configuration drift will be surfaced here.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The baseline could not be saved.");
    } finally {
      setBusy("");
    }
  }

  async function changeSetting(key: "enabled" | "autoQuarantine", value: boolean) {
    if (!selected || busy) return;
    const settings = { ...selected.settings, [key]: value };
    setBusy("settings");
    setError("");
    try {
      replaceState(await updateSentinelSettings(selected.agentId, settings));
      setNotice(key === "autoQuarantine"
        ? value ? "Critical drift will now quarantine the agent automatically." : "Automatic quarantine is disabled."
        : value ? "Continuous protection is enabled." : "Sentinel monitoring is paused for this agent.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sentinel settings could not be updated.");
    } finally {
      setBusy("");
    }
  }

  if (!agents.length) {
    return (
      <section className="workspace-view sentinel-page">
        <div className="sentinel-empty panel"><div className="sentinel-empty__orb"><Icon name="shield" size={30} /></div><span className="eyebrow eyebrow--cyan">CONTINUOUS PROTECTION</span><h2>Connect an agent to activate Sentinel</h2><p>Sentinel watches the approved configuration of every agent and catches dangerous drift before it becomes a production incident.</p></div>
      </section>
    );
  }

  const summary = overview?.summary ?? { totalAgents: agents.length, protected: 0, drifted: 0, unbaselined: agents.length, disabled: 0, openDrifts: 0 };
  const isLoading = busy === "load" || !overview;

  return (
    <section className="workspace-view sentinel-page">
      <div className="workspace-view__heading sentinel-page__heading">
        <div>
          <span className="eyebrow eyebrow--cyan">AGENTGUARD SENTINEL</span>
          <h2>Catch drift before it becomes an incident.</h2>
          <p>Lock an agent’s approved security posture into a privacy-safe fingerprint, then detect risky changes before they reach customers.</p>
        </div>
        <button type="button" className="button button--primary" onClick={() => void runCheckAll()} disabled={Boolean(busy) || isLoading}><Icon name="activity" size={16} /> {busy === "all" ? "Checking workspace…" : "Check all agents"} <Icon name="arrow" size={15} /></button>
      </div>

      <div className="sentinel-summary">
        <SummaryCard label="Agents covered" value={summary.totalAgents} />
        <SummaryCard label="Protected" value={summary.protected} tone="safe" />
        <SummaryCard label="Needs review" value={summary.drifted} tone="critical" />
        <SummaryCard label="Open drift events" value={summary.openDrifts} tone={summary.openDrifts ? "warning" : "safe"} />
      </div>

      {error ? <div className="sentinel-message sentinel-message--error"><Icon name="activity" size={15} /><span>{error}</span><button type="button" className="text-button" onClick={() => setError("")}>Dismiss</button></div> : null}
      {notice ? <div className="sentinel-message sentinel-message--success"><Icon name="shield" size={15} /><span>{notice}</span><button type="button" className="text-button" onClick={() => setNotice("")}>Dismiss</button></div> : null}

      <div className="sentinel-toolbar panel">
        <label className="sentinel-agent-select"><span>Agent under watch</span><select value={selected?.agentId ?? agentId} onChange={(event) => chooseAgent(event.target.value)}>{(overview?.agents.length ? overview.agents : agents.map((agent) => ({ agentId: agent.id, agentName: agent.name } as SentinelState))).map((agent) => <option key={agent.agentId} value={agent.agentId}>{agent.agentName}</option>)}</select></label>
        <div className="sentinel-toolbar__legend"><span><i className="is-safe" />Protected means no observed drift</span><span><i className="is-alert" />Drift means review before trust</span></div>
      </div>

      {selected ? (
        <div className="sentinel-layout">
          <section className={`sentinel-posture panel sentinel-posture--${selected.status}`}>
            <div className="sentinel-posture__topline"><div className="sentinel-status"><i /><span>{selected.status === "protected" ? "Baseline protected" : selected.status === "drifted" ? "Security drift detected" : selected.status === "disabled" ? "Monitoring paused" : "Baseline required"}</span>{selected.agentStatus === "quarantined" ? <em>Agent quarantined</em> : null}</div><span className={`sentinel-severity sentinel-severity--${selected.severity}`}>{severityLabel(selected.severity)}</span></div>
            <h3>{selected.agentName}</h3>
            <p>{selected.status === "protected" ? "The current agent configuration matches the trusted security contract." : selected.status === "drifted" ? "The live configuration no longer matches the trusted contract. Review each change before accepting it." : selected.status === "disabled" ? "Sentinel is paused for this agent. Enable monitoring to resume drift checks." : "Create a baseline after reviewing this agent’s model, tools, endpoint posture, and policy."}</p>
            <div className="sentinel-posture__facts"><div><span>Last check</span><strong>{formatDate(selected.lastCheckedAt)}</strong></div><div><span>Baseline created</span><strong>{formatDate(selected.baseline?.createdAt ?? null)}</strong></div><div><span>Current fingerprint</span><code>{selected.currentFingerprint.slice(0, 16)}…</code></div></div>
            <div className="sentinel-posture__actions">
              <button type="button" className="button button--primary" onClick={() => void (selected.baseline ? runCheck() : establishBaseline())} disabled={Boolean(busy) || (Boolean(selected.baseline) && !selected.settings.enabled)}>{busy === "baseline" ? "Saving baseline…" : busy === "check" ? "Checking…" : selected.baseline ? "Check now" : "Create trusted baseline"}<Icon name="arrow" size={15} /></button>
              {selected.baseline ? <button type="button" className="button button--subtle" onClick={() => void establishBaseline()} disabled={Boolean(busy)}>Accept current as new baseline</button> : null}
            </div>
          </section>

          <section className="sentinel-controls panel">
            <span className="eyebrow eyebrow--cyan">RESPONSE CONTROLS</span>
            <h3>Make drift actionable.</h3>
            <p>Keep monitoring on for visibility. Enable auto-quarantine only when your team wants critical changes stopped immediately.</p>
            <label className="sentinel-toggle"><span><strong>Sentinel monitoring</strong><small>Compare every check with the trusted baseline.</small></span><input type="checkbox" checked={selected.settings.enabled} onChange={(event) => void changeSetting("enabled", event.target.checked)} disabled={Boolean(busy)} /><i /></label>
            <label className="sentinel-toggle sentinel-toggle--danger"><span><strong>Auto-quarantine critical drift</strong><small>Move the agent to quarantine when a critical change is detected.</small></span><input type="checkbox" checked={selected.settings.autoQuarantine} onChange={(event) => void changeSetting("autoQuarantine", event.target.checked)} disabled={Boolean(busy)} /><i /></label>
            <div className="sentinel-controls__note"><Icon name="lock" size={14} /><span>Sentinel stores only a fingerprint and structured change evidence. Secrets and raw endpoint URLs never enter the baseline.</span></div>
          </section>
        </div>
      ) : <div className="sentinel-loading panel">Loading Sentinel posture…</div>}

      {selected?.changes.length ? <section className="sentinel-changes panel"><div className="sentinel-section-heading"><div><span className="eyebrow eyebrow--cyan">EVIDENCE LEDGER</span><h3>What changed</h3><p>Every difference is explained in security language so your team can decide quickly.</p></div><span className="sentinel-change-count">{selected.changes.length} change{selected.changes.length === 1 ? "" : "s"}</span></div><div className="sentinel-change-list">{selected.changes.map((change) => <ChangeRow key={change.id} change={change} />)}</div></section> : null}

      {selected?.status === "protected" ? <section className="sentinel-protected-banner"><div className="sentinel-protected-banner__icon"><Icon name="shield" size={19} /></div><div><strong>Protected posture confirmed</strong><span>Configuration, tool surface, and policy still match the approved baseline.</span></div><small>Fingerprint verified</small></section> : null}
    </section>
  );
}
