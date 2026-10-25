import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  createAlertWebhook,
  deleteAlertWebhook,
  getAuditEvents,
  getAlertWebhooks,
  getIncidents,
  getIncidentSummary,
  markIncidentRead,
  resolveIncident,
  testAlertWebhook,
  updateAlertWebhook,
} from "./incidents.api";
import type { AlertWebhook, AuditEvent, Incident, IncidentEventType, IncidentSeverity, SessionUser } from "../../shared/types/api";
import { Icon } from "../../shared/ui/Icon";

const eventOptions: Array<{ id: IncidentEventType; label: string; detail: string }> = [
  { id: "sentinel_drift", label: "Sentinel drift", detail: "Configuration changes" },
  { id: "agent_quarantined", label: "Quarantine", detail: "Agent isolation" },
  { id: "scan_finding", label: "Scan findings", detail: "Failed scenarios" },
  { id: "scan_failed", label: "Scan failures", detail: "Worker or endpoint errors" },
  { id: "runtime_block", label: "Runtime blocks", detail: "Unsafe live actions" },
];

function formatDate(value: string | null) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function severityLabel(value: IncidentSeverity) {
  return value.toUpperCase();
}

function eventLabel(value: IncidentEventType) {
  return eventOptions.find((item) => item.id === value)?.label ?? value;
}

function auditLabel(value: string) {
  return value.replaceAll(".", " ").replaceAll("_", " ");
}

function IncidentRow({ incident, onRead, onResolve }: { incident: Incident; onRead: () => void; onResolve: () => void }) {
  return (
    <article className={`incident-row incident-row--${incident.severity} ${incident.readAt ? "" : "incident-row--unread"}`}>
      <div className="incident-row__marker"><Icon name={incident.severity === "critical" ? "activity" : incident.eventType === "runtime_block" ? "lock" : "shield"} size={15} /></div>
      <div className="incident-row__body">
        <div className="incident-row__heading"><div><span className={`incident-severity incident-severity--${incident.severity}`}>{severityLabel(incident.severity)}</span><span className="incident-event">{eventLabel(incident.eventType)}</span></div><time>{formatDate(incident.createdAt)}</time></div>
        <h3>{incident.title}</h3>
        <p>{incident.message}</p>
        <div className="incident-row__meta"><span>{incident.agentName ?? "Workspace event"}</span>{incident.resourceId ? <code>{incident.resourceId}</code> : null}</div>
        <div className="incident-row__actions">{!incident.readAt ? <button type="button" className="text-button" onClick={onRead}>Mark read</button> : null}{incident.status === "open" ? <button type="button" className="text-button incident-resolve" onClick={onResolve}>Resolve incident <Icon name="arrow" size={12} /></button> : <span className="incident-resolved">Resolved {formatDate(incident.resolvedAt)}</span>}</div>
      </div>
    </article>
  );
}

function WebhookCard({ webhook, busy, onChange, onTest, onDelete }: { webhook: AlertWebhook; busy: boolean; onChange: (next: AlertWebhook) => void; onTest: () => void; onDelete: () => void }) {
  return (
    <div className={`incident-webhook ${webhook.enabled ? "" : "incident-webhook--disabled"}`}>
      <div className="incident-webhook__top"><div className="incident-webhook__icon"><Icon name="plug" size={16} /></div><div><strong>{webhook.name}</strong><span>{webhook.endpointHost}</span></div><label className="incident-switch"><input type="checkbox" checked={webhook.enabled} onChange={(event) => onChange({ ...webhook, enabled: event.target.checked })} disabled={busy} /><i /></label></div>
      <div className="incident-webhook__events">{webhook.eventTypes.includes("*") ? "All security events" : webhook.eventTypes.map((item) => eventLabel(item as IncidentEventType)).join(" · ")}</div>
      <div className="incident-webhook__footer"><span>{webhook.lastDeliveredAt ? `Last delivered ${formatDate(webhook.lastDeliveredAt)}` : webhook.failureCount ? `${webhook.failureCount} delivery failures` : "No deliveries yet"}</span><div><button type="button" className="text-button" onClick={onTest} disabled={busy}>{busy ? "Testing…" : "Send test"}</button><button type="button" className="text-button incident-delete" onClick={onDelete} disabled={busy}>Remove</button></div></div>
      {webhook.lastError ? <small className="incident-webhook__error">{webhook.lastError}</small> : null}
    </div>
  );
}

export function IncidentCenterPage({ authUser }: { authUser: SessionUser }) {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [webhooks, setWebhooks] = useState<AlertWebhook[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [tab, setTab] = useState<"open" | "all">("open");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [summary, setSummary] = useState({ open: 0, unread: 0, critical: 0 });
  const [webhookName, setWebhookName] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [webhookEvents, setWebhookEvents] = useState<string[]>(["*"]);
  const [removeId, setRemoveId] = useState<string | null>(null);

  const canManage = ["owner", "admin"].includes(authUser.role);
  const visibleIncidents = useMemo(() => tab === "open" ? incidents.filter((incident) => incident.status === "open") : incidents, [incidents, tab]);

  async function load() {
    try {
      const [nextSummary, nextIncidents, nextWebhooks, nextAudit] = await Promise.all([
        getIncidentSummary(),
        getIncidents(tab),
        getAlertWebhooks(),
        canManage ? getAuditEvents() : Promise.resolve([]),
      ]);
      setSummary(nextSummary.summary);
      setIncidents(nextIncidents);
      setWebhooks(nextWebhooks);
      setAuditEvents(nextAudit);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Incident center could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30000);
    return () => window.clearInterval(timer);
  }, [tab]);

  async function perform(action: string, callback: () => Promise<void>, success: string) {
    setBusy(action);
    setError("");
    try {
      await callback();
      setNotice(success);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The incident action failed.");
    } finally {
      setBusy("");
    }
  }

  async function addWebhook(event: FormEvent) {
    event.preventDefault();
    await perform("create-webhook", async () => {
      await createAlertWebhook({ name: webhookName, url: webhookUrl, secret: webhookSecret, eventTypes: webhookEvents });
      setWebhookName(""); setWebhookUrl(""); setWebhookSecret(""); setWebhookEvents(["*"]);
    }, "Signed webhook added. New matching incidents will be delivered automatically.");
  }

  function toggleEvent(eventId: string) {
    setWebhookEvents((current) => {
      if (eventId === "*") return ["*"];
      const withoutAll = current.filter((item) => item !== "*");
      const next = withoutAll.includes(eventId) ? withoutAll.filter((item) => item !== eventId) : [...withoutAll, eventId];
      return next.length ? next : ["*"];
    });
  }

  return (
    <section className="workspace-view incident-page">
      <div className="workspace-view__heading incident-page__heading"><div><span className="eyebrow eyebrow--cyan">INCIDENT CENTER</span><h2>Every security signal. One calm response.</h2><p>See what needs attention, acknowledge it, and route critical events to the systems your team already uses.</p></div><div className="incident-page__score"><strong>{summary.unread}</strong><span>unread signals</span></div></div>

      {error ? <div className="incident-message incident-message--error"><Icon name="activity" size={15} /><span>{error}</span><button type="button" className="text-button" onClick={() => setError("")}>Dismiss</button></div> : null}
      {notice ? <div className="incident-message"><Icon name="shield" size={15} /><span>{notice}</span><button type="button" className="text-button" onClick={() => setNotice("")}>Dismiss</button></div> : null}

      <div className="incident-stats"><div><span>Open incidents</span><strong>{summary.open}</strong></div><div><span>Critical now</span><strong className={summary.critical ? "is-danger" : ""}>{summary.critical}</strong></div><div><span>Delivery posture</span><strong>{webhooks.filter((item) => item.enabled).length} routes</strong></div></div>

      <div className="incident-layout">
        <section className="incident-feed panel"><div className="incident-feed__heading"><div><span className="eyebrow eyebrow--cyan">LIVE SECURITY FEED</span><h3>Workspace incidents</h3></div><div className="incident-tabs"><button type="button" className={tab === "open" ? "is-active" : ""} onClick={() => setTab("open")}>Open</button><button type="button" className={tab === "all" ? "is-active" : ""} onClick={() => setTab("all")}>History</button></div></div>{loading ? <div className="incident-empty">Loading incident evidence…</div> : visibleIncidents.length ? <div className="incident-list">{visibleIncidents.map((incident) => <IncidentRow key={incident.id} incident={incident} onRead={() => void perform(`read-${incident.id}`, () => markIncidentRead(incident.id), "Incident marked as read.")} onResolve={() => void perform(`resolve-${incident.id}`, () => resolveIncident(incident.id), "Incident resolved.")} />)}</div> : <div className="incident-empty"><div className="incident-empty__orb"><Icon name="shield" size={25} /></div><strong>{tab === "open" ? "No open incidents" : "No incident history"}</strong><span>AgentGuard will surface real security events here. Nothing is being hidden.</span></div>}</section>

        <aside className="incident-side">
          <section className="incident-routing panel"><div className="incident-side__heading"><div><span className="eyebrow eyebrow--cyan">ALERT ROUTING</span><h3>Deliver critical signals.</h3></div><Icon name="bell" size={19} /></div><p>Webhooks are encrypted at rest, signed with HMAC-SHA256, retried up to five times, and never include API keys.</p>{webhooks.length ? <div className="incident-webhook-list">{webhooks.map((webhook) => <WebhookCard key={webhook.id} webhook={webhook} busy={busy === `test-${webhook.id}` || busy === `update-${webhook.id}`} onChange={(next) => void perform(`update-${webhook.id}`, async () => { const updated = await updateAlertWebhook(next); setWebhooks((current) => current.map((item) => item.id === updated.id ? updated : item)); }, "Webhook settings updated.")} onTest={() => void perform(`test-${webhook.id}`, () => testAlertWebhook(webhook.id), "Signed test delivered successfully.")} onDelete={() => setRemoveId(webhook.id)} />)}</div> : <div className="incident-routing__empty">No delivery routes yet.</div>}
            {removeId ? <div className="incident-remove"><span>Remove this webhook route?</span><div><button type="button" className="text-button" onClick={() => setRemoveId(null)}>Cancel</button><button type="button" className="text-button incident-delete" onClick={() => { const id = removeId; setRemoveId(null); void perform(`delete-${id}`, () => deleteAlertWebhook(id), "Webhook route removed."); }}>Remove route</button></div></div> : null}
          </section>

          {canManage ? <section className="incident-add-webhook panel"><span className="eyebrow eyebrow--cyan">NEW ROUTE</span><h3>Connect your alert stack.</h3><p>Use an HTTPS endpoint from your incident system. The signing secret lets your receiver verify every delivery.</p><form onSubmit={(event) => void addWebhook(event)}><label>Route name<input value={webhookName} onChange={(event) => setWebhookName(event.target.value)} placeholder="Security operations" required /></label><label>HTTPS endpoint<input type="url" value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} placeholder="https://hooks.example.com/agentguard" required /></label><label>Signing secret<input type="password" minLength={16} value={webhookSecret} onChange={(event) => setWebhookSecret(event.target.value)} placeholder="At least 16 characters" required /></label><div className="incident-event-picker"><span>Events to deliver</span><button type="button" className={webhookEvents.includes("*") ? "is-selected" : ""} onClick={() => toggleEvent("*")}>All events</button>{eventOptions.map((item) => <button type="button" key={item.id} className={webhookEvents.includes(item.id) ? "is-selected" : ""} onClick={() => toggleEvent(item.id)}>{item.label}</button>)}</div><button type="submit" className="button button--primary" disabled={Boolean(busy)}>{busy === "create-webhook" ? "Securing route…" : "Add signed route"}<Icon name="arrow" size={15} /></button></form></section> : null}
          {canManage ? <section className="incident-audit panel"><div className="incident-side__heading"><div><span className="eyebrow eyebrow--cyan">AUDIT TRAIL</span><h3>Who changed what.</h3></div><Icon name="activity" size={19} /></div><p>Workspace-scoped evidence for sensitive operator actions.</p>{auditEvents.length ? <div className="incident-audit__list">{auditEvents.map((event) => <div className="incident-audit__row" key={event.id}><div><strong>{auditLabel(event.action)}</strong><span>{event.actor?.name ?? event.actor?.email ?? event.actorType} Â· {event.resourceType ?? "workspace"}</span></div><time>{formatDate(event.createdAt)}</time></div>)}</div> : <div className="incident-routing__empty">No operator changes recorded yet.</div>}</section> : null}
        </aside>
      </div>
    </section>
  );
}
