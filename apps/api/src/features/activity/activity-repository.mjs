import { query } from "../../core/db.mjs";
import { createWorkspaceActivityRecord, mapWorkspaceActivityRow } from "./activity-domain.mjs";

const selectColumns = `stream_id AS id, workspace_id, agent_id, agent_name, event_type, category,
  severity, title, explanation, resource_type, resource_id, metadata, created_at`;

export async function appendWorkspaceActivity({ workspaceId, ...input }) {
  if (typeof workspaceId !== "string" || !workspaceId) return null;
  const event = createWorkspaceActivityRecord(input);
  const result = await query(
    `INSERT INTO workspace_activity_events
       (workspace_id, agent_id, agent_name, event_type, category, severity,
        title, explanation, resource_type, resource_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
     RETURNING ${selectColumns}`,
    [
      workspaceId,
      event.agentId,
      event.agentName,
      event.eventType,
      event.category,
      event.severity,
      event.title,
      event.explanation,
      event.resourceType,
      event.resourceId,
      JSON.stringify(event.metadata),
    ],
  );
  return mapWorkspaceActivityRow(result.rows[0]);
}

export async function appendWorkspaceActivitySafely(input) {
  try {
    return await appendWorkspaceActivity(input);
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "workspace_activity_write_failed",
      activityType: typeof input?.eventType === "string" ? input.eventType : "unknown",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    return null;
  }
}

export async function listWorkspaceActivity({ workspaceId, beforeId = null, limit = 50, eventTypes = null, historyDays = null }) {
  const result = await query(
    `SELECT ${selectColumns}
     FROM workspace_activity_events
     WHERE workspace_id=$1 AND ($2::bigint IS NULL OR stream_id < $2::bigint)
       AND ($4::text[] IS NULL OR event_type=ANY($4::text[]))
       AND ($5::integer IS NULL OR created_at >= NOW() - (GREATEST(1, $5)::double precision * INTERVAL '1 day'))
     ORDER BY stream_id DESC
     LIMIT $3`,
    [workspaceId, beforeId, limit, eventTypes, historyDays],
  );
  return result.rows.map(mapWorkspaceActivityRow);
}

export async function listWorkspaceActivityAfter({ workspaceId, afterId = "0", limit = 500, eventTypes = null, historyDays = null }) {
  const result = await query(
    `SELECT ${selectColumns}
     FROM workspace_activity_events
     WHERE workspace_id=$1 AND stream_id > $2::bigint
       AND ($4::text[] IS NULL OR event_type=ANY($4::text[]))
       AND ($5::integer IS NULL OR created_at >= NOW() - (GREATEST(1, $5)::double precision * INTERVAL '1 day'))
     ORDER BY stream_id ASC
     LIMIT $3`,
    [workspaceId, afterId, limit, eventTypes, historyDays],
  );
  return result.rows.map(mapWorkspaceActivityRow);
}

export async function getWorkspaceActivityBounds({ workspaceId, eventTypes = null, historyDays = null }) {
  const result = await query(
    `SELECT MIN(stream_id)::text AS oldest_id, MAX(stream_id)::text AS newest_id
     FROM workspace_activity_events
     WHERE workspace_id=$1
       AND ($2::text[] IS NULL OR event_type=ANY($2::text[]))
       AND ($3::integer IS NULL OR created_at >= NOW() - (GREATEST(1, $3)::double precision * INTERVAL '1 day'))`,
    [workspaceId, eventTypes, historyDays],
  );
  return {
    oldestId: result.rows[0]?.oldest_id ?? null,
    newestId: result.rows[0]?.newest_id ?? null,
  };
}
