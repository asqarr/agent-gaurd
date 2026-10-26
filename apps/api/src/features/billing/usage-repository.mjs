import { randomUUID } from "node:crypto";
import { query, withTransaction } from "../../core/db.mjs";

function safeMetricInteger(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

export async function currentUsagePeriodStart(client, workspaceId, requestedPeriodStart) {
  if (requestedPeriodStart) {
    const parsed = new Date(requestedPeriodStart);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const result = await client.query(
    `SELECT current_period_start
     FROM workspace_subscriptions
     WHERE workspace_id=$1`,
    [workspaceId],
  );
  return result.rows[0]?.current_period_start ?? new Date();
}

// This function accepts a transaction client so scan/runtime persistence and
// metering commit atomically. It deliberately lives outside the large legacy
// repository facade to keep usage accounting a bounded domain.
export async function insertUsageMeasurement(client, {
  workspaceId,
  periodStart,
  kind,
  units,
  referenceType,
  referenceId,
  durationMs = 0,
  cpuUserUs = 0,
  cpuSystemUs = 0,
  rssBytes = 0,
  metadata = {},
}) {
  const safeUnits = safeMetricInteger(units);
  if (!workspaceId || !referenceId || !["scan", "runtime_decision"].includes(kind) || safeUnits <= 0) {
    return null;
  }
  const result = await client.query(
    `INSERT INTO usage_measurements
       (id, workspace_id, period_start, kind, units, reference_type, reference_id,
        duration_ms, cpu_user_us, cpu_system_us, rss_bytes, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (workspace_id, kind, reference_id) DO UPDATE
       SET period_start=EXCLUDED.period_start,
           units=EXCLUDED.units,
           duration_ms=EXCLUDED.duration_ms,
           cpu_user_us=EXCLUDED.cpu_user_us,
           cpu_system_us=EXCLUDED.cpu_system_us,
           rss_bytes=EXCLUDED.rss_bytes,
           metadata=EXCLUDED.metadata
     RETURNING id`,
    [
      `measurement-${kind}-${randomUUID()}`,
      workspaceId,
      periodStart,
      kind,
      safeUnits,
      String(referenceType ?? kind).slice(0, 80),
      String(referenceId).slice(0, 180),
      safeMetricInteger(durationMs),
      safeMetricInteger(cpuUserUs),
      safeMetricInteger(cpuSystemUs),
      safeMetricInteger(rssBytes),
      JSON.stringify(metadata ?? {}),
    ],
  );
  return result.rows[0]?.id ?? null;
}

export async function recordUsageMeasurement(input) {
  return withTransaction(async (client) => {
    const periodStart = await currentUsagePeriodStart(
      client,
      input.workspaceId,
      input.periodStart,
    );
    return insertUsageMeasurement(client, { ...input, periodStart });
  });
}

export async function getUsageMeasurementHealth(workspaceId) {
  const result = await query(
    `SELECT COUNT(*)::int AS measurements,
            MAX(created_at) AS last_measurement_at
     FROM usage_measurements
     WHERE workspace_id=$1`,
    [workspaceId],
  );
  return {
    measurements: Number(result.rows[0]?.measurements ?? 0),
    lastMeasurementAt: result.rows[0]?.last_measurement_at ?? null,
  };
}
