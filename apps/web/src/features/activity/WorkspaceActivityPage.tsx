import type { WorkspaceActivity } from "../../shared/types/api";
import type { ActivityConnection } from "./useWorkspaceActivity";
import { Icon } from "../../shared/ui/Icon";

function relativeTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Time unavailable";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function categoryIcon(category: WorkspaceActivity["category"]) {
  if (category === "scan") return "scan";
  if (category === "runtime") return "activity";
  if (category === "sentinel") return "shield";
  if (category === "incident") return "bell";
  return "sparkle";
}

export function WorkspaceActivityPage({
  events,
  connection,
  historyNotice,
  hasMore,
  loadingOlder,
  onLoadOlder,
  onInspectEvent,
  onNavigate,
}: {
  events: WorkspaceActivity[];
  connection: ActivityConnection;
  historyNotice: string;
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onInspectEvent: (event: WorkspaceActivity) => void;
  onNavigate: (page: string, event?: WorkspaceActivity) => void;
}) {
  const connected = connection === "live";
  return (
    <section className="workspace-view activity-page">
      <div className="workspace-view__heading activity-page__heading">
        <div>
          <span className="eyebrow eyebrow--cyan">WORKSPACE ACTIVITY</span>
          <h2>Security, as it happens.</h2>
          <p>Live scan progress, Runtime decisions, Sentinel changes and security guidance with a plain-language explanation of each event.</p>
        </div>
        <div className={`activity-live-status activity-live-status--${connection}`}>
          <i />
          <div><strong>{connected ? "LIVE" : connection === "reconnecting" ? "RECONNECTING" : connection === "connecting" ? "CONNECTING" : "OFFLINE"}</strong><span>{connected ? "Receiving workspace events" : "Restoring the live stream"}</span></div>
        </div>
      </div>

      <div className="activity-page__context"><Icon name="activity" size={15} /><span>Every entry is based on a persisted workspace event. Explanations use deterministic security rules; no activity is simulated.</span></div>
      {historyNotice ? <div className="activity-history-notice" role="status">{historyNotice}</div> : null}

      {events.length ? (
        <ol className="activity-feed" aria-live="polite" aria-relevant="additions">
          {events.map((event) => (
            <li className={`activity-card activity-card--${event.severity}`} key={event.id}>
              <div className={`activity-card__icon activity-card__icon--${event.category}`}><Icon name={categoryIcon(event.category)} size={16} /></div>
              <div className="activity-card__body">
                <div className="activity-card__topline">
                  <span className="activity-card__category">{event.category.replaceAll("_", " ")}</span>
                  <time title={new Date(event.createdAt).toLocaleString()}>{relativeTime(event.createdAt)}</time>
                </div>
                <h3>{event.title}</h3>
                <p>{event.explanation}</p>
                <div className="activity-card__footer">
                  {event.agentName ? <span>{event.agentName}</span> : null}
                  {typeof event.metadata.scenarioOrdinal === "number" && typeof event.metadata.scenarioTotal === "number" ? <span>Scenario {event.metadata.scenarioOrdinal}/{event.metadata.scenarioTotal}</span> : null}
                  {typeof event.metadata.toolCount === "number" ? <span>{event.metadata.toolCount} tool call{event.metadata.toolCount === 1 ? "" : "s"}</span> : null}
                  {typeof event.metadata.score === "number" ? <span>Score {event.metadata.score}/100</span> : null}
                  {typeof event.metadata.traceId === "string" ? <code>Trace {event.metadata.traceId.slice(0, 12)}…</code> : null}
                  <button type="button" aria-haspopup="dialog" aria-label={`Investigate ${event.title}`} onClick={() => onInspectEvent(event)}>Investigate event <Icon name="arrow" size={12} /></button>
                </div>
              </div>
              <span className="activity-card__severity">{event.severity}</span>
            </li>
          ))}
        </ol>
      ) : (
        <div className="activity-empty">
          <span><Icon name="activity" size={21} /></span>
          <strong>Waiting for real workspace activity</strong>
          <p>Start a scan or enable Runtime protection. New persisted security events will appear here automatically.</p>
          <button type="button" className="button button--subtle" onClick={() => onNavigate("Scans")}>View scans <Icon name="arrow" size={14} /></button>
        </div>
      )}

      {events.length && hasMore ? <button type="button" className="activity-load-more" onClick={onLoadOlder} disabled={loadingOlder}>{loadingOlder ? "Loading older activity…" : "Load older activity"}</button> : null}
      {!hasMore && events.length ? <div className="activity-feed__end">You’re up to date with retained workspace activity.</div> : null}
    </section>
  );
}
