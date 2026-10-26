import { randomUUID } from "node:crypto";
import { query, withTransaction } from "../../core/db.mjs";
import { createIncidentNotification } from "../incidents/incident-repository.mjs";
import { currentUsagePeriodStart, insertUsageMeasurement } from "../billing/usage-repository.mjs";

function leaseLost() {
  const error = new Error("The scan worker lease is no longer valid.");
  error.code = "SCAN_LEASE_LOST";
  return error;
}

async function assertLease(client, scanId, leaseToken) {
  const result = await client.query(
    `SELECT j.id, j.lease_token, j.status, s.status AS scan_status
     FROM scan_jobs j
     JOIN scans s ON s.id=j.scan_id
     WHERE j.scan_id=$1
     FOR UPDATE OF j, s`,
    [scanId],
  );
  const row = result.rows[0];
  if (
    !row
    || row.status !== "running"
    || row.lease_token !== leaseToken
    || !["queued", "running"].includes(row.scan_status)
  ) {
    throw leaseLost();
  }
  return row;
}

export async function claimNextJob({ leaseMs = 300000, maxAttempts = 3, workerId = "scan-worker" } = {}) {
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE scans s
       SET status='failed', error='Worker lease expired after maximum attempts', finished_at=NOW()
       FROM scan_jobs j
       WHERE j.scan_id=s.id AND j.status='running' AND j.attempts >= $2
         AND COALESCE(j.heartbeat_at, j.locked_at) < NOW() - ($1::double precision * INTERVAL '1 millisecond')`,
      [leaseMs, maxAttempts],
    );
    await client.query(
      `UPDATE scans s
       SET status='queued', error='Worker lease expired; retrying', finished_at=NULL
       FROM scan_jobs j
       WHERE j.scan_id=s.id AND j.status='running' AND j.attempts < $2
         AND COALESCE(j.heartbeat_at, j.locked_at) < NOW() - ($1::double precision * INTERVAL '1 millisecond')`,
      [leaseMs, maxAttempts],
    );
    await client.query(
      `UPDATE scan_jobs
       SET status='failed', error='Worker lease expired after maximum attempts',
           completed_at=NOW(), lease_token=NULL, locked_by=NULL, locked_at=NULL, heartbeat_at=NULL
       WHERE status='running' AND attempts >= $2
         AND COALESCE(heartbeat_at, locked_at) < NOW() - ($1::double precision * INTERVAL '1 millisecond')`,
      [leaseMs, maxAttempts],
    );
    await client.query(
      `UPDATE scan_progress p
       SET status='error', error='Worker lease expired after maximum attempts', finished_at=NOW()
       WHERE p.scan_id IN (
         SELECT scan_id FROM scan_jobs
         WHERE status='failed' AND error='Worker lease expired after maximum attempts'
       ) AND p.status IN ('queued','running')`,
    );
    await client.query(
      `UPDATE scan_jobs
       SET status='queued', locked_at=NULL, available_at=NOW(),
           heartbeat_at=NULL, lease_token=NULL, locked_by=NULL,
           error='Worker lease expired; retrying'
       WHERE status='running' AND attempts < $2
         AND COALESCE(heartbeat_at, locked_at) < NOW() - ($1::double precision * INTERVAL '1 millisecond')`,
      [leaseMs, maxAttempts],
    );
    await client.query(
      `UPDATE scan_progress p
       SET status='queued', error=NULL, finished_at=NULL
       WHERE p.scan_id IN (
         SELECT scan_id FROM scan_jobs
         WHERE status='queued' AND error='Worker lease expired; retrying'
       ) AND p.status IN ('queued','running')`,
    );
    const leaseToken = randomUUID();
    const result = await client.query(
      `WITH next_job AS (
        SELECT id FROM scan_jobs
        WHERE status='queued' AND available_at <= NOW()
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE scan_jobs j
      SET status='running', attempts=j.attempts+1, locked_at=NOW(),
          heartbeat_at=NOW(), lease_token=$1, locked_by=$2
      FROM next_job
      WHERE j.id=next_job.id
      RETURNING j.id, j.scan_id, j.attempts, j.lease_token, j.locked_by`,
      [leaseToken, workerId],
    );
    return result.rows[0] ?? null;
  });
}

export async function touchScanJob({ jobId, leaseToken }) {
  const result = await query(
    `UPDATE scan_jobs
     SET locked_at=NOW(), heartbeat_at=NOW()
     WHERE id=$1 AND status='running' AND lease_token=$2
     RETURNING id`,
    [jobId, leaseToken],
  );
  if (!result.rowCount) throw leaseLost();
}

export async function getWorkerContext(scanId) {
  const result = await query(
    `SELECT s.*, a.name AS agent_name, a.endpoint_url, a.encrypted_api_key, a.mode,
            a.provider, a.model, a.environment, a.status AS agent_status,
            p.max_amount, p.max_age_days, p.currency, p.name AS policy_name,
            c.allowed_tool_ids AS contract_allowed_tool_ids,
            c.max_refund_amount AS contract_max_refund_amount,
            c.max_order_age_days AS contract_max_order_age_days
     FROM scans s JOIN agents a ON a.id=s.agent_id
     LEFT JOIN policies p ON p.workspace_id=s.workspace_id
     LEFT JOIN agent_security_contract_versions c
       ON c.agent_id=s.agent_id AND c.version=s.contract_version
     WHERE s.id=$1 ORDER BY p.created_at LIMIT 1`,
    [scanId],
  );
  return result.rows[0] ?? null;
}

export async function markScanRunning({ scanId, leaseToken }) {
  return withTransaction(async (client) => {
    await assertLease(client, scanId, leaseToken);
    await client.query(
      "UPDATE scans SET status='running', started_at=COALESCE(started_at, NOW()) WHERE id=$1",
      [scanId],
    );
  });
}

export async function updateScanProgress({ scanId, leaseToken, status, scenario, result, error, durationMs }) {
  await query(
    `UPDATE scan_progress p
     SET status=$3,
         observed=$4,
         guard_decision=$5,
         execution=$6,
         reasons=$7::jsonb,
         tool_call=$8::jsonb,
         error=$9,
         started_at=CASE WHEN $3='running' THEN COALESCE(p.started_at, NOW()) ELSE p.started_at END,
         finished_at=CASE WHEN $3 IN ('passed','blocked','failed','error') THEN NOW() ELSE p.finished_at END,
         duration_ms=CASE WHEN $3 IN ('passed','blocked','failed','error') THEN $10 ELSE p.duration_ms END
     WHERE p.scan_id=$1 AND p.scenario_id=$2
       AND EXISTS (
         SELECT 1 FROM scan_jobs j
         WHERE j.scan_id=$1 AND j.status='running' AND j.lease_token=$11
       )`,
    [
      scanId,
      scenario.id,
      status,
      result?.observed ?? null,
      result?.guard?.decision ?? null,
      result?.guard?.execution ?? null,
      JSON.stringify(result?.reasons ?? []),
      result?.call ? JSON.stringify(result.call) : null,
      error ?? null,
      durationMs ?? null,
      leaseToken,
    ],
  );
}

export async function completeScan({ scanId, leaseToken, outcome }) {
  await withTransaction(async (client) => {
    const job = await assertLease(client, scanId, leaseToken);
    const scanMeta = await client.query(
      "SELECT workspace_id FROM scans WHERE id=$1 FOR UPDATE",
      [scanId],
    );
    const workspaceId = scanMeta.rows[0]?.workspace_id;
    await client.query(
      `UPDATE scans SET status='completed', score=$2, passed=$3, failed=$4, blocked=$5,
       simulated=$6, duration_ms=$7, execution_mode=$8, safety_status=$9,
       safety_warning=$10, finished_at=NOW(), error=NULL WHERE id=$1`,
      [
        scanId,
        outcome.score,
        outcome.passed,
        outcome.failed,
        outcome.blocked,
        outcome.simulated,
        outcome.durationMs,
        outcome.executionMode ?? "simulation",
        outcome.safetyStatus ?? "safe",
        outcome.safetyWarning ?? null,
      ],
    );
    for (const result of outcome.results) {
      await client.query(
        `INSERT INTO scan_results (id, scan_id, scenario_id, title, category, expected, observed, status, guard_decision, execution, reasons, tool_call)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          `result-${randomUUID()}`,
          scanId,
          result.scenarioId,
          result.title,
          result.category,
          result.expected,
          result.observed,
          result.status,
          result.guard?.decision ?? null,
          result.guard?.execution ?? null,
          JSON.stringify(result.reasons ?? []),
          result.call ? JSON.stringify(result.call) : null,
        ],
      );
    }
    await client.query(
      `UPDATE scan_jobs
       SET status='completed', completed_at=NOW(), locked_at=NULL, heartbeat_at=NULL,
           lease_token=NULL, locked_by=NULL, error=NULL
       WHERE id=$1`,
      [job.id],
    );
    await client.query(
      "UPDATE agents SET score=$2, last_scan_at=NOW(), status='connected' WHERE id=$1",
      [outcome.agentId, outcome.score],
    );
    if (workspaceId && outcome.metrics?.units > 0) {
      await insertUsageMeasurement(client, {
        workspaceId,
        periodStart: await currentUsagePeriodStart(client, workspaceId, outcome.metrics.periodStart),
        kind: "scan",
        units: outcome.metrics.units,
        referenceType: "scan",
        referenceId: scanId,
        durationMs: outcome.metrics.durationMs,
        cpuUserUs: outcome.metrics.cpuUserUs,
        cpuSystemUs: outcome.metrics.cpuSystemUs,
        rssBytes: outcome.metrics.rssBytes,
        metadata: {
          scenarioCount: outcome.results.length,
          status: "completed",
          executionMode: outcome.executionMode ?? "simulation",
        },
      });
    }
  });

  if (outcome.failed > 0 || outcome.score < 70) {
    const scanContext = await query(
      `SELECT s.workspace_id, s.agent_id, a.name AS agent_name
       FROM scans s JOIN agents a ON a.id=s.agent_id WHERE s.id=$1`,
      [scanId],
    );
    const context = scanContext.rows[0];
    if (context) {
      await createIncidentNotification({
        workspaceId: context.workspace_id,
        agentId: context.agent_id,
        agentName: context.agent_name,
        eventType: "scan_finding",
        severity: outcome.score < 50 ? "critical" : outcome.failed >= 3 ? "high" : "medium",
        message: `${outcome.failed} scenario${outcome.failed === 1 ? "" : "s"} failed in the latest security scan (${outcome.score}/100). Review the evidence before trusting this agent.`,
        dedupeKey: `scan:${scanId}`,
        resourceType: "scan",
        resourceId: scanId,
        metadata: { score: outcome.score, passed: outcome.passed, failed: outcome.failed, blocked: outcome.blocked },
      });
    }
  }
}

export async function failScan({ scanId, leaseToken, errorMessage, metrics = null }) {
  await withTransaction(async (client) => {
    const job = await assertLease(client, scanId, leaseToken);
    const scanMeta = await client.query(
      "SELECT workspace_id FROM scans WHERE id=$1 FOR UPDATE",
      [scanId],
    );
    const workspaceId = scanMeta.rows[0]?.workspace_id;
    await client.query(
      "UPDATE scans SET status='failed', error=$2, finished_at=NOW() WHERE id=$1",
      [scanId, errorMessage],
    );
    await client.query(
      `UPDATE scan_jobs
       SET status='failed', error=$2, completed_at=NOW(), locked_at=NULL,
           heartbeat_at=NULL, lease_token=NULL, locked_by=NULL
       WHERE id=$1`,
      [job.id, errorMessage],
    );
    await client.query(
      `UPDATE scan_progress
       SET status='error', error=$2, finished_at=NOW()
       WHERE scan_id=$1 AND status IN ('queued','running')`,
      [scanId, errorMessage],
    );
    if (workspaceId && metrics?.units > 0) {
      await insertUsageMeasurement(client, {
        workspaceId,
        periodStart: await currentUsagePeriodStart(client, workspaceId, metrics.periodStart),
        kind: "scan",
        units: metrics.units,
        referenceType: "scan",
        referenceId: scanId,
        durationMs: metrics.durationMs,
        cpuUserUs: metrics.cpuUserUs,
        cpuSystemUs: metrics.cpuSystemUs,
        rssBytes: metrics.rssBytes,
        metadata: { status: "failed", error: String(errorMessage).slice(0, 500) },
      });
    }
  });

  const scanContext = await query(
    `SELECT s.workspace_id, s.agent_id, a.name AS agent_name
     FROM scans s JOIN agents a ON a.id=s.agent_id WHERE s.id=$1`,
    [scanId],
  );
  const context = scanContext.rows[0];
  if (context) {
    await createIncidentNotification({
      workspaceId: context.workspace_id,
      agentId: context.agent_id,
      agentName: context.agent_name,
      eventType: "scan_failed",
      severity: "high",
      message: `The security scan stopped before completion. ${String(errorMessage).slice(0, 280)}`,
      dedupeKey: `scan-failed:${scanId}`,
      resourceType: "scan",
      resourceId: scanId,
      metadata: { error: String(errorMessage).slice(0, 500) },
    });
  }
}

export async function retryScan({ scanId, leaseToken, errorMessage, delayMs }) {
  await withTransaction(async (client) => {
    const job = await assertLease(client, scanId, leaseToken);
    await client.query(
      "UPDATE scans SET status='queued', error=$2, finished_at=NULL WHERE id=$1",
      [scanId, errorMessage],
    );
    await client.query(
      `UPDATE scan_jobs
       SET status='queued', locked_at=NULL, heartbeat_at=NULL, lease_token=NULL,
           locked_by=NULL, available_at=NOW() + ($2::double precision * INTERVAL '1 millisecond'), error=$3
       WHERE id=$1`,
      [job.id, delayMs, errorMessage],
    );
    await client.query(
      `UPDATE scan_progress
       SET status='queued', observed=NULL, guard_decision=NULL, execution=NULL,
           reasons='[]'::jsonb, tool_call=NULL, error=NULL, started_at=NULL,
           finished_at=NULL, duration_ms=NULL
       WHERE scan_id=$1`,
      [scanId],
    );
  });
}
