import { useEffect, useState } from "react";
import type { Agent, RuntimeEvent, RuntimeHealth } from "../../shared/types/api";
import { Icon } from "../../shared/ui/Icon";
import { getBillingState } from "../billing/billing.api";
import { getRuntimeHealth } from "./agents.api";

const statusCopy: Record<RuntimeHealth["observationStatus"], { label: string; message: string }> = {
  disabled: {
    label: "FIREWALL OFF",
    message: "Runtime Firewall is disabled. Historical records are shown for context; no current protection is implied.",
  },
  no_data: {
    label: "NO OBSERVED DATA",
    message: "No admitted Runtime invocations were recorded in this period. Latency and availability cannot be estimated.",
  },
  quota_limited: {
    label: "QUOTA LIMITED",
    message: "Requests were rejected before execution because Runtime capacity was unavailable. These are separated from technical failures.",
  },
  no_recent_traffic: {
    label: "NO RECENT TRAFFIC",
    message: "Older observations exist, but no Runtime event was recorded in the last 15 minutes. This dashboard does not probe uptime.",
  },
  degraded: {
    label: "ERRORS OBSERVED",
    message: "Technical failures were observed in this period. Review the safe error codes below; sensitive upstream details are not stored.",
  },
  observed: {
    label: "TRAFFIC OBSERVED",
    message: "Runtime decisions were observed in this period. This is request telemetry, not a proactive health check or uptime guarantee.",
  },
};

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatLatency(value: number | null) {
  return value === null ? "—" : `${value} ms`;
}

function RuntimeTraceDetails({ event }: { event: RuntimeEvent }) {
  if (!event.traceId || !event.traceSpans?.length) return null;
  return (
    <details className="runtime-trace">
      <summary>
        <span>View execution trace</span>
        <code>{event.traceId.slice(0, 16)}...</code>
        <small>{event.traceSpans.length} spans</small>
      </summary>
      <ol className="runtime-trace__timeline">
        {event.traceSpans.map((span) => (
          <li className={`runtime-trace__step runtime-trace__step--${span.outcome}`} key={span.spanId}>
            <i />
            <div>
              <div className="runtime-trace__step-heading">
                <strong>{span.name.replace(/^agentguard\./, "").replaceAll(".", " / ")}</strong>
                <time>{span.durationMs} ms</time>
              </div>
              <span>{span.stage.replaceAll("_", " ")} · {span.outcome.replaceAll("_", " ")}{span.decision ? ` · ${span.decision}` : ""}</span>
            </div>
          </li>
        ))}
      </ol>
      <p className="runtime-trace__disclaimer">The trace ends at the one-time approval boundary. The tool executor runs inside your application and is not observed by AgentGuard.</p>
    </details>
  );
}

export function RuntimeShield({
  agent,
  events,
  token,
  busy,
  error,
  onEnable,
  onDisable,
  onUpgrade,
}: {
  agent: Agent;
  events: RuntimeEvent[];
  token: string;
  busy: boolean;
  error: string;
  onEnable: () => void;
  onDisable: () => void;
  onUpgrade: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [runtimeAllowed, setRuntimeAllowed] = useState<boolean | null>(null);
  const [healthWindow, setHealthWindow] = useState<"24h" | "7d">("24h");
  const [healthSnapshot, setHealthSnapshot] = useState<{ agentId: string; window: string; value: RuntimeHealth } | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const hasEndpoint = Boolean(agent.endpoint);
  const canEnable = hasEndpoint && agent.status !== "quarantined";
  const health = healthSnapshot?.agentId === agent.id && healthSnapshot.window === healthWindow
    ? healthSnapshot.value
    : null;

  useEffect(() => {
    let active = true;
    getBillingState()
      .then((billing) => {
        if (active) setRuntimeAllowed(billing.entitlements.runtimeFirewall);
      })
      .catch(() => {
        if (active) setRuntimeAllowed(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (runtimeAllowed !== true) return;
    let active = true;
    const load = async () => {
      if (active && !health) setHealthLoading(true);
      try {
        const value = await getRuntimeHealth(agent.id, healthWindow);
        if (active) {
          setHealthSnapshot({ agentId: agent.id, window: healthWindow, value });
          setHealthError("");
        }
      } catch (loadError) {
        if (active) setHealthError(loadError instanceof Error ? loadError.message : "Could not load Runtime telemetry.");
      } finally {
        if (active) setHealthLoading(false);
      }
    };
    void load();
    const interval = window.setInterval(() => { void load(); }, 60_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [agent.id, healthWindow, refreshKey, runtimeAllowed, agent.runtimeEnabled]);

  async function copyToken() {
    if (!token) return;
    await navigator.clipboard?.writeText(token);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  if (runtimeAllowed !== true) {
    return (
      <section className="runtime-shield runtime-shield--locked">
        <div className="runtime-shield__heading">
          <div className="runtime-shield__title">
            <span className="runtime-shield__icon"><Icon name="lock" size={15} /></span>
            <div>
              <span className="eyebrow">RUNTIME FIREWALL</span>
              <strong>{runtimeAllowed === null ? "Checking plan access…" : "Production protection is locked"}</strong>
            </div>
          </div>
          <span className="runtime-shield__status"><i /> BUILDER+</span>
        </div>
        <p className="runtime-shield__description">Upgrade to Builder to block unsafe tool calls in real time, before they reach customer systems.</p>
        {runtimeAllowed === false ? (
          <button type="button" className="runtime-shield__enable" onClick={onUpgrade}>
            <Icon name="arrow" size={14} /> View plans and unlock
          </button>
        ) : null}
      </section>
    );
  }

  const status = health ? statusCopy[health.observationStatus] : null;
  return (
    <section className={`runtime-shield ${agent.runtimeEnabled ? "runtime-shield--enabled" : ""}`}>
      <div className="runtime-shield__heading">
        <div className="runtime-shield__title">
          <span className="runtime-shield__icon"><Icon name="shield" size={15} /></span>
          <div>
            <span className="eyebrow">RUNTIME FIREWALL</span>
            <strong>{agent.runtimeEnabled ? "Live protection active" : "Protect production traffic"}</strong>
          </div>
        </div>
        <span className={`runtime-shield__status ${agent.runtimeEnabled ? "runtime-shield__status--on" : ""}`}>
          <i /> {agent.runtimeEnabled ? "ENABLED" : "OFF"}
        </span>
      </div>
      <p className="runtime-shield__description">Tool calls returned by the configured endpoint are checked before the SDK can execute them.</p>

      {agent.runtimeEnabled ? (
        <>
          <div className="runtime-health">
            <div className="runtime-health__heading">
              <div>
                <span className="runtime-health__eyebrow">OBSERVED FIREWALL HEALTH</span>
                <strong>Runtime traffic &amp; latency</strong>
              </div>
              <div className="runtime-health__controls" aria-label="Telemetry time range">
                <button type="button" className={healthWindow === "24h" ? "is-active" : ""} onClick={() => setHealthWindow("24h")}>24h</button>
                <button type="button" className={healthWindow === "7d" ? "is-active" : ""} onClick={() => setHealthWindow("7d")}>7d</button>
                <button type="button" className="runtime-health__refresh" onClick={() => setRefreshKey((value) => value + 1)} disabled={healthLoading} aria-label="Refresh telemetry">{healthLoading ? "…" : "Refresh"}</button>
              </div>
            </div>
            {health ? (
              <>
                <div className={`runtime-health__status runtime-health__status--${health.observationStatus}`}>
                  <i /> <strong>{status?.label}</strong>
                  <span>{health.sampleCount.toLocaleString()} observed invocation{health.sampleCount === 1 ? "" : "s"} · {health.window}</span>
                </div>
                <p className="runtime-health__message">{status?.message}</p>
                <div className="runtime-health__metrics">
                  <div><span>ALLOW</span><strong>{health.allowCount.toLocaleString()}</strong></div>
                  <div><span>POLICY BLOCK</span><strong>{health.blockCount.toLocaleString()}</strong></div>
                  <div className={health.errorCount > 0 ? "has-errors" : ""}><span>TECHNICAL ERRORS</span><strong>{health.errorCount.toLocaleString()}</strong></div>
                  <div><span>QUOTA REJECTS</span><strong>{health.quotaRejectedCount.toLocaleString()}</strong></div>
                  <div><span>LATENCY p50</span><strong>{formatLatency(health.p50Ms)}</strong></div>
                  <div><span>LATENCY p95</span><strong>{formatLatency(health.p95Ms)}</strong></div>
                  <div><span>ERROR RATE*</span><strong>{health.sampleCount ? `${health.errorRatePercent}%` : "—"}</strong></div>
                  <div><span>DECISIONS RECORDED</span><strong>{health.decisionCount.toLocaleString()}</strong></div>
                </div>
                <div className="runtime-health__footnotes">
                  <span>Last decision: {formatDate(health.lastDecisionAt)}</span>
                  <span>Last technical error: {formatDate(health.lastErrorAt)}</span>
                </div>
                <small className="runtime-health__disclaimer">*Errors ÷ (decisions + errors); quota rejects excluded. Latency includes customer-endpoint response and gateway decision processing; it is not pure Firewall compute time. Percentiles are descriptive only; sample size is shown above. No synthetic uptime probes are run.</small>
                {health.recentIssues.length ? (
                  <div className="runtime-health__issues">
                    <span className="runtime-health__eyebrow">RECENT ERRORS &amp; QUOTA REJECTIONS</span>
                    {health.recentIssues.slice(0, 4).map((issue, index) => (
                      <div className="runtime-health__issue" key={`${issue.createdAt}-${index}`}>
                        <i className={issue.outcome === "error" ? "is-error" : "is-quota"} />
                        <strong>{issue.errorCode ?? (issue.outcome === "quota" ? "QUOTA_REJECTED" : "RUNTIME_ERROR")}</strong>
                        <span>{issue.failureStage ?? "—"}</span>
                        <time>{formatDate(issue.createdAt)}</time>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="runtime-health__updated">Observed at {formatDate(health.observedAt)}</div>
              </>
            ) : (
              <div className="runtime-health__empty" role="status">
                {healthLoading ? "Loading observed Runtime telemetry…" : healthError || "Telemetry is not available yet."}
              </div>
            )}
            {healthError && health ? <div className="runtime-health__load-error">Refresh failed; showing the last successful sample. {healthError}</div> : null}
          </div>

          <div className="runtime-shield__stats">
            <div><strong>{agent.runtimeBlockedCount ?? 0}</strong><span>policy blocks total</span></div>
            <div><strong>{events.length}</strong><span>recent recorded events</span></div>
            <div><strong>fail-closed</strong><span>SDK enforcement</span></div>
          </div>
          <div className="runtime-shield__snippet">
            <div className="runtime-shield__sdk-note">
              <strong>SDK enforcement contract</strong>
              <code>npm install @agentguard/sdk</code>
              <pre>{`const guard = createAgentGuardClient({
  baseUrl: "https://your-agentguard-host",
  agentId: "${agent.id}",
  token: process.env.AGENTGUARD_TOKEN,
});
await guard.execute({
  input,
  executionContext: { actorId, tenantId, orderId, issuedAt: new Date().toISOString() },
  tools: { issue_refund: refundTool },
});`}</pre>
              <small>Only execute calls returned by the SDK. It fails closed when the Gateway is unavailable, approval expires, or arguments change.</small>
            </div>
            <div className="runtime-shield__snippet-head">
              <span>GATEWAY CONTRACT</span>
              <button type="button" onClick={copyToken} disabled={!token}>{copied ? "Copied" : "Copy token"}</button>
            </div>
            <code>POST /api/runtime/agents/{agent.id}/invoke</code>
            <code>Authorization: Bearer {token || "token hidden · rotate to reveal"}</code>
          </div>
          {events.length ? (
            <div className="runtime-shield__events">
              <span className="runtime-shield__events-label">RECENT RECORDED EVENTS</span>
              {events.slice(0, 4).map((event) => {
                const outcome = event.outcome ?? "decision";
                const isError = outcome === "error";
                const isQuota = outcome === "quota";
                const label = isError ? (event.errorCode ?? "ERROR") : isQuota ? "QUOTA" : event.decision;
                const tone = isError ? "runtime-event__decision--error" : isQuota ? "runtime-event__decision--quota" : event.decision === "BLOCK" ? "runtime-event__decision--block" : "runtime-event__decision--allow";
                return (
                  <div className="runtime-event__group" key={event.id}>
                    <div className="runtime-event">
                      <i className={isError ? "runtime-event__dot--error" : isQuota ? "runtime-event__dot--quota" : event.decision === "BLOCK" ? "runtime-event__dot--block" : "runtime-event__dot--allow"} />
                      <span>{event.toolName}</span>
                      <strong className={tone}>{label}</strong>
                      <small>{event.latencyMs}ms</small>
                    </div>
                    <RuntimeTraceDetails event={event} />
                  </div>
                );
              })}
            </div>
          ) : null}
          <div className="runtime-shield__actions">
            <button type="button" className="button button--subtle" onClick={onEnable} disabled={busy}>{busy ? "Rotating…" : "Rotate token"}</button>
            <button type="button" className="runtime-shield__disable" onClick={onDisable} disabled={busy}>Disable firewall</button>
          </div>
        </>
      ) : (
        <>
          <div className="runtime-health runtime-health--inactive">
            <div className="runtime-health__eyebrow">FIREWALL OBSERVATION</div>
            {health ? (
              <>
                <div className="runtime-health__status runtime-health__status--disabled">
                  <i /> <strong>FIREWALL DISABLED</strong>
                  <span>{health.sampleCount.toLocaleString()} historical invocation{health.sampleCount === 1 ? "" : "s"} · {health.window}</span>
                </div>
                <p className="runtime-health__message">Historical telemetry is retained for context, but protection is currently off. Past traffic does not imply current enforcement or uptime.</p>
                <div className="runtime-health__metrics runtime-health__metrics--inactive">
                  <div><span>LAST DECISION</span><strong>{formatDate(health.lastDecisionAt)}</strong></div>
                  <div><span>LAST ERROR</span><strong>{formatDate(health.lastErrorAt)}</strong></div>
                  <div><span>p95 OBSERVED</span><strong>{formatLatency(health.p95Ms)}</strong></div>
                  <div><span>ERRORS</span><strong>{health.errorCount.toLocaleString()}</strong></div>
                </div>
              </>
            ) : (
              <div className="runtime-health__empty">{healthLoading ? "Loading historical telemetry…" : healthError || "No historical Runtime telemetry is available for this period."}</div>
            )}
          </div>
          <button type="button" className="runtime-shield__enable" onClick={onEnable} disabled={busy || !canEnable}>
            <Icon name="lock" size={14} />
            {busy ? "Provisioning secure gateway…" : agent.status === "quarantined" ? "Restore the agent first" : hasEndpoint ? "Enable live protection" : "Connect an endpoint first"}
            {canEnable ? <Icon name="arrow" size={13} /> : null}
          </button>
        </>
      )}
      {error ? <div className="runtime-shield__error">{error}</div> : null}
    </section>
  );
}
