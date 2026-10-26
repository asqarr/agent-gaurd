import { query } from "../../core/db.mjs";
import { getRequestMetrics } from "../../core/observability.mjs";
import { config } from "../../core/config.mjs";

function number(value) {
  return Number(value ?? 0);
}

function buildAlerts({ queue, scans, reconciliation, payments, api, security }) {
  const alerts = [];
  if (queue.staleWorkers > 0) alerts.push({ severity: "critical", code: "STALE_SCAN_WORKER", message: `${queue.staleWorkers} scan job(s) have stale worker leases.` });
  if (queue.failed > 0) alerts.push({ severity: "critical", code: "FAILED_SCAN_QUEUE", message: `${queue.failed} scan job(s) are failed and need inspection.` });
  if (queue.queued > 10) alerts.push({ severity: "warning", code: "SCAN_QUEUE_BACKLOG", message: `${queue.queued} scan job(s) are waiting in the queue.` });
  if (reconciliation.failedRuns > 0) alerts.push({ severity: "critical", code: "RECONCILIATION_FAILURE", message: `${reconciliation.failedRuns} payment reconciliation run(s) failed in the selected window.` });
  if (payments.openExceptions > 0) alerts.push({ severity: "warning", code: "PAYMENT_EXCEPTIONS", message: `${payments.openExceptions} payment exception(s) are awaiting an operator decision.` });
  if (api.requests >= 20 && api.fiveXxRate >= 0.05) alerts.push({ severity: "critical", code: "API_5XX_RATE", message: `API 5xx rate is ${(api.fiveXxRate * 100).toFixed(1)}% in this process.` });
  if (scans.p95DurationMs > 30_000) alerts.push({ severity: "warning", code: "SLOW_SCANS", message: `The p95 scan duration is ${(scans.p95DurationMs / 1000).toFixed(1)} seconds.` });
  if (security.adminsWithoutMfa > 0) alerts.push({ severity: "warning", code: "ADMIN_MFA_MISSING", message: `${security.adminsWithoutMfa} owner/admin account(s) do not have TOTP MFA enabled.` });
  return alerts;
}

export async function getOperationalObservability({ windowMinutes = 60 } = {}) {
  const safeWindow = Math.max(5, Math.min(Number(windowMinutes) || 60, 1440));
  const [queueResult, scansResult, reconciliationResult, paymentsResult, securityResult] = await Promise.all([
    query(`SELECT
      COUNT(*) FILTER (WHERE status='queued') AS queued,
      COUNT(*) FILTER (WHERE status='running') AS running,
      COUNT(*) FILTER (WHERE status='failed') AS failed,
      COUNT(*) FILTER (WHERE status='running' AND COALESCE(heartbeat_at, locked_at) < NOW() - ($1::double precision * INTERVAL '1 millisecond')) AS stale_workers,
      COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE status='queued'))) * 1000, 0) AS oldest_queued_age_ms
      FROM scan_jobs`, [config.scanJobLeaseMs]),
    query(`SELECT
      COUNT(*) FILTER (WHERE status='completed') AS completed,
      COUNT(*) FILTER (WHERE status='failed') AS failed,
      COALESCE(AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 0) AS average_duration_ms,
      COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 0) AS p95_duration_ms,
      COALESCE(MAX(duration_ms), 0) AS max_duration_ms
      FROM scans WHERE created_at >= NOW() - ($1::double precision * INTERVAL '1 minute')`, [safeWindow]),
    query(`SELECT
      COUNT(*) AS runs,
      COUNT(*) FILTER (WHERE status='failed') AS failed_runs,
      COALESCE(SUM(scanned_count), 0) AS scanned,
      COALESCE(SUM(completed_count), 0) AS completed,
      COALESCE(SUM(exception_count), 0) AS exceptions,
      COALESCE(AVG(EXTRACT(EPOCH FROM (COALESCE(finished_at, NOW()) - started_at)) * 1000), 0) AS average_duration_ms,
      MAX(finished_at) AS last_finished_at
      FROM billing_reconciliation_runs
      WHERE started_at >= NOW() - ($1::double precision * INTERVAL '1 minute')`, [safeWindow]),
    query(`SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status IN ('open','assigned','refund_required')) AS open_exceptions,
      COUNT(*) FILTER (WHERE reason='underpaid') AS underpaid,
      COUNT(*) FILTER (WHERE reason='unmatched_order') AS unmatched,
      COUNT(*) FILTER (WHERE reason='late_payment') AS late,
      COUNT(*) FILTER (WHERE reason='overpaid') AS overpaid
      FROM billing_payment_exceptions
      WHERE detected_at >= NOW() - ($1::double precision * INTERVAL '1 minute')`, [safeWindow]),
    query(`SELECT COUNT(DISTINCT u.id) FILTER (WHERE m.role IN ('owner','admin') AND COALESCE(u.mfa_enabled, FALSE)=FALSE) AS admins_without_mfa
      FROM memberships m JOIN users u ON u.id=m.user_id`),
  ]);
  const queue = {
    queued: number(queueResult.rows[0]?.queued),
    running: number(queueResult.rows[0]?.running),
    failed: number(queueResult.rows[0]?.failed),
    staleWorkers: number(queueResult.rows[0]?.stale_workers),
    oldestQueuedAgeMs: number(queueResult.rows[0]?.oldest_queued_age_ms),
  };
  const scans = {
    completed: number(scansResult.rows[0]?.completed),
    failed: number(scansResult.rows[0]?.failed),
    averageDurationMs: number(scansResult.rows[0]?.average_duration_ms),
    p95DurationMs: number(scansResult.rows[0]?.p95_duration_ms),
    maxDurationMs: number(scansResult.rows[0]?.max_duration_ms),
  };
  const reconciliation = {
    runs: number(reconciliationResult.rows[0]?.runs),
    failedRuns: number(reconciliationResult.rows[0]?.failed_runs),
    scanned: number(reconciliationResult.rows[0]?.scanned),
    completed: number(reconciliationResult.rows[0]?.completed),
    exceptions: number(reconciliationResult.rows[0]?.exceptions),
    averageDurationMs: number(reconciliationResult.rows[0]?.average_duration_ms),
    lastFinishedAt: reconciliationResult.rows[0]?.last_finished_at ?? null,
  };
  const payments = {
    total: number(paymentsResult.rows[0]?.total),
    openExceptions: number(paymentsResult.rows[0]?.open_exceptions),
    underpaid: number(paymentsResult.rows[0]?.underpaid),
    unmatched: number(paymentsResult.rows[0]?.unmatched),
    late: number(paymentsResult.rows[0]?.late),
    overpaid: number(paymentsResult.rows[0]?.overpaid),
  };
  const security = { adminsWithoutMfa: number(securityResult.rows[0]?.admins_without_mfa) };
  const api = getRequestMetrics();
  return { collectedAt: new Date().toISOString(), windowMinutes: safeWindow, queue, scans, reconciliation, payments, security, api, alerts: buildAlerts({ queue, scans, reconciliation, payments, api, security }) };
}
