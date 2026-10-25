import { randomUUID } from "node:crypto";
import { query, withTransaction } from "../../core/db.mjs";
import { GROWTH_EVENT_NAMES } from "./domain.mjs";

const allowedNames = new Set(GROWTH_EVENT_NAMES);

export async function recordGrowthEvent({
  eventName,
  workspaceId = null,
  visitorHash = null,
  clientEventId = null,
  sourceKey = null,
  properties = {},
  attachPriorSessionEvents = false,
}) {
  if (!allowedNames.has(eventName)) throw new TypeError("Unknown growth event.");
  if (attachPriorSessionEvents && workspaceId && visitorHash) {
    return withTransaction(async (client) => {
      await client.query(
        `UPDATE growth_events
         SET workspace_id=$1
         WHERE visitor_hash=$2 AND workspace_id IS NULL
           AND created_at >= NOW() - INTERVAL '30 days'`,
        [workspaceId, visitorHash],
      );
      const result = await client.query(
        `INSERT INTO growth_events
           (id, event_name, workspace_id, visitor_hash, client_event_id, source_key, properties)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [`growth-${randomUUID()}`, eventName, workspaceId, visitorHash, clientEventId, sourceKey, JSON.stringify(properties)],
      );
      return result.rowCount > 0;
    });
  }

  const result = await query(
    `INSERT INTO growth_events
       (id, event_name, workspace_id, visitor_hash, client_event_id, source_key, properties)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [`growth-${randomUUID()}`, eventName, workspaceId, visitorHash, clientEventId, sourceKey, JSON.stringify(properties)],
  );
  return result.rowCount > 0;
}

export async function purgeExpiredGrowthEvents({ limit = 5000 } = {}) {
  const safeLimit = Math.max(1, Math.min(10000, Number.parseInt(limit, 10) || 5000));
  const result = await query(
    `WITH expired AS (
       SELECT id FROM growth_events
       WHERE created_at < NOW() - INTERVAL '180 days'
       ORDER BY created_at ASC
       LIMIT $1
     )
     DELETE FROM growth_events e USING expired
     WHERE e.id=expired.id`,
    [safeLimit],
  );
  return result.rowCount;
}
