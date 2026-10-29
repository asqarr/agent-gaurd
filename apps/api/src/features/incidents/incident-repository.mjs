import { randomUUID } from "node:crypto";
import { withTransaction } from "../../core/db.mjs";
import { incidentTitle } from "./domain.mjs";
import { appendWorkspaceActivitySafely } from "../activity/activity-repository.mjs";

function mapIncident(row) {
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name ?? null,
    eventType: row.event_type,
    severity: row.severity,
    title: row.title,
    message: row.message,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    metadata: row.metadata ?? {},
    status: row.status,
    readAt: row.read_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

export async function createIncidentNotification({
  workspaceId,
  agentId = null,
  agentName = null,
  eventType,
  severity,
  title = incidentTitle(eventType, agentName ?? "Agent"),
  message,
  dedupeKey,
  resourceType = null,
  resourceId = null,
  metadata = {},
}) {
  const notificationId = `incident-${randomUUID()}`;
  const result = await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO incident_notifications
       (id, workspace_id, agent_id, event_type, severity, title, message, dedupe_key, resource_type, resource_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (workspace_id, dedupe_key) WHERE status='open' DO NOTHING
       RETURNING *`,
      [
        notificationId,
        workspaceId,
        agentId,
        eventType,
        severity,
        title,
        message,
        dedupeKey,
        resourceType,
        resourceId,
        JSON.stringify(metadata ?? {}),
      ],
    );

    if (inserted.rowCount > 0) {
      await client.query(
        `INSERT INTO incident_webhook_deliveries (id, workspace_id, notification_id, webhook_id)
         SELECT $1 || '-' || w.id, $2, $1, w.id
         FROM alert_webhooks w
         WHERE w.workspace_id=$2 AND w.enabled=TRUE
           AND (w.event_types @> '["*"]'::jsonb OR w.event_types @> jsonb_build_array($3::text))
         ON CONFLICT (notification_id, webhook_id) DO NOTHING`,
        [notificationId, workspaceId, eventType],
      );
    }

    const current = inserted.rows[0] ?? (await client.query(
      `SELECT n.*, a.name AS agent_name
       FROM incident_notifications n
       LEFT JOIN agents a ON a.id=n.agent_id
       WHERE n.workspace_id=$1 AND n.dedupe_key=$2 AND n.status='open'`,
      [workspaceId, dedupeKey],
    )).rows[0];
    return {
      incident: mapIncident(current ?? { ...inserted.rows[0], agent_name: agentName }),
      created: inserted.rowCount > 0,
    };
  });

  if (result.created) {
    const activityType = eventType === "sentinel_drift"
      ? "sentinel.drift_detected"
      : eventType === "agent_quarantined"
        ? "agent.quarantined"
        : eventType === "scan_failed"
          ? "scan.failed"
          : eventType === "runtime_block"
            ? null
            : "incident.opened";
    if (activityType) {
      await appendWorkspaceActivitySafely({
        workspaceId,
        agentId,
        agentName,
        eventType: activityType,
        resourceType: activityType === "incident.opened" ? "incident" : resourceType,
        resourceId: activityType === "incident.opened" ? result.incident?.id : resourceId,
        metadata: {
          incidentType: eventType,
          incidentSeverity: severity,
          driftSeverity: eventType === "sentinel_drift" ? severity : undefined,
          changeCount: eventType === "sentinel_drift" ? metadata?.changes?.length : undefined,
        },
      });
    }
  }
  return result.incident;
}
