import { randomInt, randomUUID } from "node:crypto";
import { query, withTransaction } from "../core/db.mjs";
import { config } from "../core/config.mjs";
import { decryptSecret, encryptSecret } from "../core/secrets.mjs";
import { evaluateAttackPaths, scenarios, toolDetails } from "../features/catalog/domain.mjs";
import {
  fullScanCredits,
  scanCreditsForScenarios,
  scenariosForPlan,
  toPublicPlan,
} from "../features/billing/domain.mjs";
import { normalizeVerifiedCryptoPayment } from "../features/billing/payment-provider.mjs";
import { atomicToUsdt, usdtCentsToAtomic, usdtToAtomic } from "../features/billing/tron-payment.mjs";
import { assessmentPhase, buildSecurityBlueprint } from "../features/autopilot/domain.mjs";
import {
  buildSentinelSnapshot,
  compareSentinelSnapshots,
  fingerprintSentinelSnapshot,
  sentinelStatus,
} from "../features/sentinel/domain.mjs";
import { retryDelayMs } from "../features/incidents/domain.mjs";
import {
  compareScanEvidence,
  compareSecurityContracts,
  defaultSecurityContract,
  normalizeSecurityContract,
} from "../features/contracts/domain.mjs";
import { quickstartScenarioIds } from "../features/quickstart/domain.mjs";
import { createIncidentNotification } from "../features/incidents/incident-repository.mjs";
import { currentUsagePeriodStart, insertUsageMeasurement } from "../features/billing/usage-repository.mjs";
import { buildRemediation, buildRemediationSummary } from "../features/reports/remediation.mjs";
import { SCAN_CATALOG_VERSION } from "../features/scans/scan-verdict.mjs";
export { recordUsageMeasurement } from "../features/billing/usage-repository.mjs";

function mapAgent(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    environment: row.environment,
    provider: row.provider,
    model: row.model,
    mode: row.mode,
    status: row.status,
    endpoint: row.endpoint_url,
    apiKeyConfigured: Boolean(row.encrypted_api_key),
    quarantinedAt: row.quarantined_at,
    quarantineReason: row.quarantine_reason,
    isQuarantined: row.status === "quarantined",
    runtimeEnabled: Boolean(row.runtime_enabled),
    runtimeBlockedCount: Number(row.runtime_blocked_count ?? 0),
    runtimeLastEventAt: row.runtime_last_event_at,
    sentinelEnabled: row.sentinel_enabled !== false,
    sentinelAutoQuarantine: Boolean(row.sentinel_auto_quarantine),
    sentinelLastCheckedAt: row.sentinel_last_checked_at,
    lastScan: row.last_scan_at,
    score: row.score,
    tools: row.tools ?? [],
  };
}

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

function mapAuditEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    actorType: row.actor_type,
    actor: row.actor_name || row.actor_email
      ? { name: row.actor_name ?? null, email: row.actor_email ?? null }
      : null,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    requestId: row.request_id,
    ipAddress: row.ip_address,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

function mapAlertWebhook(row) {
  if (!row) return null;
  let hostname = "Protected endpoint";
  try {
    hostname = new URL(decryptSecret(row.encrypted_url)).host;
  } catch {
    // Keep the endpoint opaque if an old or rotated secret cannot be opened.
  }
  return {
    id: row.id,
    name: row.name,
    endpointHost: hostname,
    eventTypes: row.event_types ?? ["*"],
    enabled: Boolean(row.enabled),
    failureCount: Number(row.failure_count ?? 0),
    lastError: row.last_error,
    lastDeliveredAt: row.last_delivered_at,
    createdAt: row.created_at,
  };
}

function mapScan(row) {
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    status: row.status,
    score: row.score,
    passed: row.passed,
    failed: row.failed,
    blocked: row.blocked,
    simulated: row.simulated,
    inconclusive: Number(row.inconclusive ?? 0),
    refused: Number(row.refused ?? 0),
    proposed: Number(row.proposed ?? 0),
    durationMs: row.duration_ms,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    trigger: row.trigger,
    executionMode: row.execution_mode ?? "simulation",
    safetyStatus: row.safety_status ?? "safe",
    safetyWarning: row.safety_warning ?? null,
    contractVersion: Number(row.contract_version ?? 0),
    policyVersion: Number(row.policy_version ?? 0),
    policySnapshot: row.policy_snapshot ?? null,
    catalogVersion: row.catalog_version ?? SCAN_CATALOG_VERSION,
    promptVersion: row.prompt_version ?? "prompt-v1",
    verdict: row.verdict ?? "pending",
    scenarioCount: Array.isArray(row.scenario_ids) ? row.scenario_ids.length : undefined,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function mapScanProgress(row) {
  return {
    scenarioId: row.scenario_id,
    ordinal: row.ordinal,
    title: row.title,
    category: row.category,
    expected: row.expected,
    status: row.status,
    observed: row.observed,
    guard: row.guard_decision
      ? { decision: row.guard_decision, execution: row.execution }
      : null,
    verdict: row.verdict ?? null,
    agentBehavior: row.agent_behavior ?? null,
    executionSafety: row.execution_safety ?? null,
    executionMode: row.execution_mode ?? null,
    source: row.source ?? null,
    requestId: row.request_id ?? null,
    reasons: row.reasons ?? [],
    call: row.tool_call,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
  };
}

const agentSelect = `
  SELECT a.*,
    COALESCE(array_agg(at.tool_id) FILTER (WHERE at.tool_id IS NOT NULL), '{}') AS tools
  FROM agents a
  LEFT JOIN agent_tools at ON at.agent_id = a.id
`;

function billingPeriodBounds(date = new Date()) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { start, end };
}

function billingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function mapBillingPlan(row) {
  if (!row) return null;
  return toPublicPlan({
    id: row.plan_id ?? row.id,
    name: row.plan_name ?? row.name,
    description: row.plan_description ?? row.description,
    billingInterval: row.billing_interval,
    priceUsdCents: Number(row.price_usd_cents),
    maxAgents: Number(row.max_agents),
    monthlyScanCredits: Number(row.monthly_scan_credits),
    scanCreditMode: row.scan_credit_mode ?? "monthly",
    historyDays: Number(row.history_days),
    seatLimit: Number(row.seat_limit),
    runtimeFirewall: Boolean(row.runtime_firewall),
    scenarioLimit: Number(row.scenario_limit ?? scenarios.length),
    scanCreditsPerScan: scanCreditsForScenarios(scenarios.slice(0, Number(row.scenario_limit ?? scenarios.length))),
    autopilot: Boolean(row.autopilot),
    sentinel: Boolean(row.sentinel),
    incidentCenter: Boolean(row.incident_center),
    alertWebhooks: Boolean(row.alert_webhooks),
    exportReports: Boolean(row.export_reports),
    maxWebhooks: Number(row.max_webhooks ?? 0),
    runtimeDecisionsIncluded: Number(row.runtime_decisions_included ?? 0),
    whiteLabelReports: Boolean(row.white_label_reports),
    multiClientManagement: Boolean(row.multi_client_management),
    features: row.features ?? [],
  });
}

async function ensureWorkspaceSubscription(client, workspaceId) {
  const existing = await client.query(
    `SELECT s.*, p.name AS plan_name, p.description AS plan_description,
            p.billing_interval, p.price_usd_cents, p.max_agents,
            p.monthly_scan_credits, p.history_days, p.seat_limit,
            p.runtime_firewall, p.scenario_limit, p.autopilot, p.sentinel,
            p.incident_center, p.alert_webhooks, p.export_reports,
            p.max_webhooks, p.runtime_decisions_included, p.scan_credit_mode,
            p.white_label_reports, p.multi_client_management, p.features
     FROM workspace_subscriptions s
     JOIN subscription_plans p ON p.id=s.plan_id
     WHERE s.workspace_id=$1
     FOR UPDATE OF s`,
    [workspaceId],
  );
  if (existing.rowCount > 0) return existing.rows[0];

  const { start, end } = billingPeriodBounds();
  const inserted = await client.query(
    `INSERT INTO workspace_subscriptions
       (id, workspace_id, plan_id, status, billing_provider, current_period_start, current_period_end)
     VALUES ($1,$2,'free','active','internal',$3,$4)
     RETURNING id`,
    [`subscription-${workspaceId}`, workspaceId, start, end],
  );
  const result = await client.query(
    `SELECT s.*, p.name AS plan_name, p.description AS plan_description,
            p.billing_interval, p.price_usd_cents, p.max_agents,
            p.monthly_scan_credits, p.history_days, p.seat_limit,
            p.runtime_firewall, p.scenario_limit, p.autopilot, p.sentinel,
            p.incident_center, p.alert_webhooks, p.export_reports,
            p.max_webhooks, p.runtime_decisions_included, p.scan_credit_mode,
            p.white_label_reports, p.multi_client_management, p.features
     FROM workspace_subscriptions s
     JOIN subscription_plans p ON p.id=s.plan_id
     WHERE s.id=$1
     FOR UPDATE OF s`,
    [inserted.rows[0].id],
  );
  return result.rows[0];
}

async function lockBillingState(client, workspaceId) {
  let subscription = await ensureWorkspaceSubscription(client, workspaceId);
  const now = new Date();
  let expiryFallback = null;
  if (new Date(subscription.current_period_end) <= now) {
    if (subscription.plan_id !== "free") {
      const { start, end } = billingPeriodBounds(now);
      expiryFallback = {
        fromPlanId: subscription.plan_id,
        fromPlanName: subscription.plan_name,
        at: now.toISOString(),
      };
      const metadata = {
        ...(subscription.metadata && typeof subscription.metadata === "object" ? subscription.metadata : {}),
        lastExpiryFallback: expiryFallback,
      };
      await client.query(
        `UPDATE workspace_subscriptions
         SET plan_id='free', status='active', billing_provider='internal',
             provider_customer_id=NULL, provider_subscription_id=NULL,
             current_period_start=$2, current_period_end=$3,
             renewal_mode='manual', pending_plan_id=NULL,
             pending_plan_effective_at=NULL, cancel_at_period_end=FALSE,
             metadata=$4::jsonb, updated_at=NOW()
         WHERE id=$1`,
        [subscription.id, start, end, JSON.stringify(metadata)],
      );
    } else {
      const { start, end } = billingPeriodBounds(now);
      await client.query(
        `UPDATE workspace_subscriptions
         SET status='active', current_period_start=$2, current_period_end=$3,
             updated_at=NOW()
         WHERE id=$1`,
        [subscription.id, start, end],
      );
    }
    subscription = await ensureWorkspaceSubscription(client, workspaceId);
  }

  await client.query(
    `INSERT INTO usage_periods
       (id, workspace_id, subscription_id, period_start, period_end)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (workspace_id, period_start) DO NOTHING`,
    [
      `usage-${workspaceId}-${new Date(subscription.current_period_start).toISOString().slice(0, 7).replace("-", "")}`,
      workspaceId,
      subscription.id,
      subscription.current_period_start,
      subscription.current_period_end,
    ],
  );
  const usage = await client.query(
    `SELECT * FROM usage_periods
     WHERE workspace_id=$1 AND period_start=$2
     FOR UPDATE`,
    [workspaceId, subscription.current_period_start],
  );
  const usageRow = usage.rows[0];
  const active =
    ["trialing", "active", "canceled"].includes(subscription.status) &&
    new Date(subscription.current_period_end) > now;
  return {
    subscription,
    plan: mapBillingPlan(subscription),
    usage: usageRow,
    active,
    expiryFallback,
  };
}

function mapBillingState(state) {
  const balances = state.addonBalances ?? {
    scanCredits: 0,
    runtimeDecisions: 0,
    agentSlots: 0,
  };
  const used = state.plan.scanCreditMode === "one_time"
    ? Number(state.subscription.one_time_scan_credits_used ?? 0)
    : Number(state.usage?.scan_credits_used ?? 0);
  const included = state.active ? state.plan.monthlyScanCredits : 0;
  const runtimeUsed = Number(state.usage?.runtime_decisions_used ?? 0);
  const runtimeIncluded = state.active ? state.plan.runtimeDecisionsIncluded : 0;
  const scanRemaining = Math.max(0, included - used);
  const runtimeRemaining = Math.max(0, runtimeIncluded - runtimeUsed);
  const alerts = [
    ...quotaAlerts({ used, included, resource: "scan_credits", addonRemaining: balances.scanCredits }),
    ...quotaAlerts({ used: runtimeUsed, included: runtimeIncluded, resource: "runtime_decisions", addonRemaining: balances.runtimeDecisions }),
  ];
  return {
    plan: state.plan,
    subscription: {
      id: state.subscription.id,
      planId: state.subscription.plan_id,
      status: state.subscription.status,
      billingProvider: state.subscription.billing_provider,
      providerCustomerId: state.subscription.provider_customer_id,
      providerSubscriptionId: state.subscription.provider_subscription_id,
      currentPeriodStart: state.subscription.current_period_start,
      currentPeriodEnd: state.subscription.current_period_end,
      cancelAtPeriodEnd: state.subscription.cancel_at_period_end,
      renewalMode: state.subscription.renewal_mode ?? "manual",
      pendingPlanId: state.subscription.pending_plan_id ?? null,
      pendingPlanEffectiveAt: state.subscription.pending_plan_effective_at ?? null,
      lastExpiryFallback: state.expiryFallback ?? state.subscription.metadata?.lastExpiryFallback ?? null,
    },
    usage: {
      periodStart: state.usage?.period_start ?? state.subscription.current_period_start,
      periodEnd: state.usage?.period_end ?? state.subscription.current_period_end,
      scanCreditsUsed: used,
      scanCreditsIncluded: included,
      scanCreditsRemaining: scanRemaining,
      scanCreditAddonsRemaining: balances.scanCredits,
      totalScanCreditsRemaining: scanRemaining + balances.scanCredits,
      fullScanCredits,
      runtimeDecisionsUsed: runtimeUsed,
      runtimeDecisionsIncluded: runtimeIncluded,
      runtimeDecisionsRemaining: runtimeRemaining,
      runtimeDecisionAddonsRemaining: balances.runtimeDecisions,
      totalRuntimeDecisionsRemaining: runtimeRemaining + balances.runtimeDecisions,
      alerts,
    },
    entitlements: {
      active: state.active,
      maxAgents: state.active ? state.plan.maxAgents + balances.agentSlots : 0,
      runtimeFirewall: state.active && state.plan.runtimeFirewall,
      scenarioLimit: state.active ? state.plan.scenarioLimit : 0,
      fullScenarioSuite: state.active && state.plan.scenarioLimit >= scenarios.length,
      autopilot: state.active && state.plan.autopilot,
      sentinel: state.active && state.plan.sentinel,
      incidentCenter: state.active && state.plan.incidentCenter,
      alertWebhooks: state.active && state.plan.alertWebhooks,
      exportReports: state.active && state.plan.exportReports,
      maxWebhooks: state.active ? state.plan.maxWebhooks : 0,
      historyDays: state.active ? state.plan.historyDays : 0,
      seatLimit: state.active ? state.plan.seatLimit : 0,
      runtimeDecisionsIncluded: state.active ? state.plan.runtimeDecisionsIncluded : 0,
      agentAddons: balances.agentSlots,
      whiteLabelReports: state.active && state.plan.whiteLabelReports,
      multiClientManagement: state.active && state.plan.multiClientManagement,
    },
  };
}

function quotaAlerts({ used, included, resource, addonRemaining }) {
  if (!included || used < included * 0.7) return [];
  const isRuntime = resource === "runtime_decisions";
  const label = isRuntime ? "Runtime Decisions" : "Scan Credits";
  return [70, 90, 100]
    .filter((threshold) => used >= included * (threshold / 100))
    .map((threshold) => ({
      resource,
      threshold,
      severity: threshold === 100 ? "critical" : threshold === 90 ? "warning" : "notice",
      message: threshold < 100
        ? `${label} usage reached ${threshold}%.${isRuntime ? " Runtime requests remain fail-closed and sensitive Tools still require policy approval." : " Review the next scan before the allowance is exhausted."}`
        : addonRemaining > 0
          ? `${label} included quota is exhausted; extra purchased capacity will be used.${isRuntime ? " Sensitive Tools still require policy approval." : ""}`
          : isRuntime
            ? "Runtime Decisions quota is exhausted. The Gateway returns 402 and executes no sensitive Tool until you upgrade or purchase extra capacity."
            : "Scan Credits quota is exhausted. Upgrade or purchase extra capacity to continue.",
      addonRemaining,
    }));
}

async function getAddonBalances(client, workspaceId) {
  const result = await client.query(
    `SELECT kind, COALESCE(SUM(units_remaining), 0) AS remaining
     FROM billing_addon_purchases
     WHERE workspace_id=$1 AND status='active' AND units_remaining > 0
       AND (expires_at IS NULL OR expires_at > NOW())
     GROUP BY kind`,
    [workspaceId],
  );
  const balances = { scanCredits: 0, runtimeDecisions: 0, agentSlots: 0 };
  for (const row of result.rows) {
    if (row.kind === "scan_credits") balances.scanCredits = Number(row.remaining);
    if (row.kind === "runtime_decisions") balances.runtimeDecisions = Number(row.remaining);
    if (row.kind === "agent_slot") balances.agentSlots = Number(row.remaining);
  }
  return balances;
}

function roundUsd(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

export async function getUsageEconomics(workspaceId) {
  const billing = await getBillingState(workspaceId);
  const [aggregate, snapshot, retention] = await Promise.all([
    query(
      `SELECT
         COALESCE(SUM(units) FILTER (WHERE kind='scan'), 0)::bigint AS scan_credits,
         COALESCE(SUM(units) FILTER (WHERE kind='runtime_decision'), 0)::bigint AS runtime_decisions,
         COUNT(*)::int AS operations,
         COALESCE(SUM(duration_ms), 0)::bigint AS duration_ms,
         COALESCE(SUM(cpu_user_us + cpu_system_us), 0)::bigint AS cpu_us,
         COALESCE(SUM(duration_ms) FILTER (WHERE kind='scan'), 0)::bigint AS scan_duration_ms,
         COALESCE(SUM(duration_ms) FILTER (WHERE kind='runtime_decision'), 0)::bigint AS runtime_duration_ms,
         COALESCE(SUM(cpu_user_us + cpu_system_us) FILTER (WHERE kind='scan'), 0)::bigint AS scan_cpu_us,
         COALESCE(SUM(cpu_user_us + cpu_system_us) FILTER (WHERE kind='runtime_decision'), 0)::bigint AS runtime_cpu_us,
         COALESCE(AVG(duration_ms), 0)::double precision AS average_duration_ms,
         COALESCE(MAX(duration_ms), 0)::int AS max_duration_ms
       FROM usage_measurements
       WHERE workspace_id=$1 AND period_start=$2`,
      [workspaceId, billing.usage.periodStart],
    ),
    query(
      `SELECT captured_at, database_size_bytes, logical_bytes, scans_bytes,
              scan_results_bytes, scan_progress_bytes, runtime_events_bytes,
              measurements_bytes
       FROM usage_storage_snapshots
       WHERE workspace_id=$1
       ORDER BY captured_at DESC
       LIMIT 1`,
      [workspaceId],
    ),
    query(
      `SELECT finished_at, candidates, deleted_scans, duration_ms, status
       FROM evidence_retention_runs
       ORDER BY finished_at DESC
       LIMIT 1`,
    ),
  ]);
  const row = aggregate.rows[0] ?? {};
  const storage = snapshot.rows[0] ?? null;
  const cpuMs = Number(row.cpu_us ?? 0) / 1000;
  const logicalBytes = Number(storage?.logical_bytes ?? 0);
  const computeUsd = (cpuMs / 3600000) * config.usageCostModel.cpuUsdPerHour;
  const storageUsd = (logicalBytes / (1024 ** 3)) * config.usageCostModel.storageUsdPerGbMonth;
  const scanCredits = Number(row.scan_credits ?? 0);
  const runtimeDecisions = Number(row.runtime_decisions ?? 0);
  const normalizedCost = (units, targetUnits, totalDurationMs, totalCpuMs) => {
    if (!units) return { sampleUnits: 0, durationMs: 0, cpuMs: 0, estimatedComputeUsd: 0 };
    const multiplier = targetUnits / units;
    const normalizedCpuMs = totalCpuMs * multiplier;
    return {
      sampleUnits: units,
      durationMs: Math.round(totalDurationMs * multiplier),
      cpuMs: roundUsd(normalizedCpuMs),
      estimatedComputeUsd: roundUsd((normalizedCpuMs / 3600000) * config.usageCostModel.cpuUsdPerHour),
    };
  };
  const scanCpuMs = Number(row.scan_cpu_us ?? 0) / 1000;
  const runtimeCpuMs = Number(row.runtime_cpu_us ?? 0) / 1000;
  const cpuMeasurementAvailable = Number(row.operations ?? 0) === 0 || Number(row.cpu_us ?? 0) > 0;
  const hasMeasuredUsage = Number(row.operations ?? 0) > 0 || logicalBytes > 0;
  const costStatus = !config.usageCostModel.configuredEstimate
    ? "not_configured"
    : !hasMeasuredUsage
      ? "no_usage"
      : !cpuMeasurementAvailable
        ? "awaiting_measurement"
        : "estimated";
  return {
    period: {
      start: billing.usage.periodStart,
      end: billing.usage.periodEnd,
    },
    measurement: {
      scanCredits: Number(row.scan_credits ?? 0),
      runtimeDecisions: Number(row.runtime_decisions ?? 0),
      operations: Number(row.operations ?? 0),
      durationMs: Number(row.duration_ms ?? 0),
      cpuMs: roundUsd(cpuMs),
      averageDurationMs: roundUsd(row.average_duration_ms),
      maxDurationMs: Number(row.max_duration_ms ?? 0),
      cpuAvailable: cpuMeasurementAvailable,
    },
    unitEconomics: {
      per1000ScanCredits: normalizedCost(
        scanCredits,
        1000,
        Number(row.scan_duration_ms ?? 0),
        scanCpuMs,
      ),
      per10000RuntimeDecisions: normalizedCost(
        runtimeDecisions,
        10000,
        Number(row.runtime_duration_ms ?? 0),
        runtimeCpuMs,
      ),
    },
    storage: storage
      ? {
          capturedAt: storage.captured_at,
          databaseSizeBytes: Number(storage.database_size_bytes ?? 0),
          logicalBytes,
          scansBytes: Number(storage.scans_bytes ?? 0),
          scanResultsBytes: Number(storage.scan_results_bytes ?? 0),
          scanProgressBytes: Number(storage.scan_progress_bytes ?? 0),
          runtimeEventsBytes: Number(storage.runtime_events_bytes ?? 0),
          measurementsBytes: Number(storage.measurements_bytes ?? 0),
        }
      : null,
    costModel: {
      cpuUsdPerHour: config.usageCostModel.cpuUsdPerHour,
      storageUsdPerGbMonth: config.usageCostModel.storageUsdPerGbMonth,
      configuredEstimate: config.usageCostModel.configuredEstimate,
      cpuMeasurementAvailable,
      status: costStatus,
    },
    estimatedCostUsd: {
      compute: roundUsd(computeUsd),
      storageMonthlyRunRate: roundUsd(storageUsd),
      total: roundUsd(computeUsd + storageUsd),
    },
    retention: retention.rows[0]
      ? {
          lastRunAt: retention.rows[0].finished_at,
          candidates: Number(retention.rows[0].candidates ?? 0),
          deletedScans: Number(retention.rows[0].deleted_scans ?? 0),
          durationMs: Number(retention.rows[0].duration_ms ?? 0),
          status: retention.rows[0].status,
        }
      : null,
  };
}

export async function captureUsageStorageSnapshots() {
  return withTransaction(async (client) => {
    const database = await client.query(
      `SELECT
         pg_database_size(current_database())::bigint AS database_size_bytes,
         pg_total_relation_size('scans'::regclass)::bigint AS scans_table_bytes,
         pg_total_relation_size('scan_results'::regclass)::bigint AS scan_results_table_bytes,
         pg_total_relation_size('scan_progress'::regclass)::bigint AS scan_progress_table_bytes,
         pg_total_relation_size('runtime_events'::regclass)::bigint AS runtime_events_table_bytes,
         pg_total_relation_size('usage_measurements'::regclass)::bigint AS measurements_table_bytes`,
    );
    const size = database.rows[0];
    const workspaces = await client.query(
      `SELECT w.id,
        COALESCE((SELECT SUM(pg_column_size(s))::bigint FROM scans s WHERE s.workspace_id=w.id),0)::bigint AS scans_bytes,
        COALESCE((SELECT SUM(pg_column_size(sr))::bigint FROM scan_results sr JOIN scans s ON s.id=sr.scan_id WHERE s.workspace_id=w.id),0)::bigint AS scan_results_bytes,
        COALESCE((SELECT SUM(pg_column_size(sp))::bigint FROM scan_progress sp JOIN scans s ON s.id=sp.scan_id WHERE s.workspace_id=w.id),0)::bigint AS scan_progress_bytes,
        COALESCE((SELECT SUM(pg_column_size(re))::bigint FROM runtime_events re WHERE re.workspace_id=w.id),0)::bigint AS runtime_events_bytes,
        COALESCE((SELECT SUM(pg_column_size(um))::bigint FROM usage_measurements um WHERE um.workspace_id=w.id),0)::bigint AS measurements_bytes
       FROM workspaces w
       ORDER BY w.id`,
    );
    for (const row of workspaces.rows) {
      const logicalBytes = [
        row.scans_bytes,
        row.scan_results_bytes,
        row.scan_progress_bytes,
        row.runtime_events_bytes,
        row.measurements_bytes,
      ].reduce((total, value) => total + Number(value ?? 0), 0);
      await client.query(
        `INSERT INTO usage_storage_snapshots
           (id, workspace_id, database_size_bytes, logical_bytes, scans_bytes,
            scan_results_bytes, scan_progress_bytes, runtime_events_bytes, measurements_bytes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          `storage-${randomUUID()}`,
          row.id,
          Number(size.database_size_bytes ?? 0),
          logicalBytes,
          Number(row.scans_bytes ?? 0),
          Number(row.scan_results_bytes ?? 0),
          Number(row.scan_progress_bytes ?? 0),
          Number(row.runtime_events_bytes ?? 0),
          Number(row.measurements_bytes ?? 0),
        ],
      );
    }
    await client.query(
      `DELETE FROM usage_storage_snapshots
       WHERE captured_at < NOW() - ($1::double precision * INTERVAL '1 day')`,
      [config.usageCostModel.snapshotRetentionDays],
    );
    return {
      workspaces: workspaces.rowCount,
      databaseSizeBytes: Number(size.database_size_bytes ?? 0),
    };
  });
}

export async function getBillingState(workspaceId) {
  return withTransaction(async (client) => {
    const state = await lockBillingState(client, workspaceId);
    state.addonBalances = await getAddonBalances(client, workspaceId);
    return mapBillingState(state);
  });
}

export async function reserveRuntimeDecision(workspaceId) {
  return withTransaction(async (client) => {
    const state = await lockBillingState(client, workspaceId);
    const included = state.active ? state.plan.runtimeDecisionsIncluded : 0;
    const used = Number(state.usage?.runtime_decisions_used ?? 0);
    if (!state.active) {
      throw billingError("SUBSCRIPTION_REQUIRED", "Your subscription is not active. Runtime traffic is blocked.");
    }
    let nextUsed = used;
    let addonUsed = 0;
    if (used < included) {
      const result = await client.query(
        `UPDATE usage_periods
         SET runtime_decisions_used=runtime_decisions_used+1, updated_at=NOW()
         WHERE workspace_id=$1 AND period_start=$2
         RETURNING runtime_decisions_used`,
        [workspaceId, state.subscription.current_period_start],
      );
      nextUsed = Number(result.rows[0]?.runtime_decisions_used ?? used + 1);
    } else {
      addonUsed = await consumeAddonUnits(client, workspaceId, "runtime_decisions", 1);
      if (!addonUsed) {
        throw billingError("RUNTIME_QUOTA_EXCEEDED", `${state.plan.name} runtime decision quota has been reached. Upgrade your plan or purchase extra Runtime Decisions.`);
      }
    }
    const addonBalances = await getAddonBalances(client, workspaceId);
    return {
      used: nextUsed,
      included,
      periodStart: state.subscription.current_period_start,
      periodEnd: state.subscription.current_period_end,
      remaining: Math.max(0, included - nextUsed),
      addonUsed,
      addonRemaining: addonBalances.runtimeDecisions,
      alerts: quotaAlerts({ used: nextUsed, included, resource: "runtime_decisions", addonRemaining: addonBalances.runtimeDecisions }),
    };
  });
}

async function consumeAddonUnits(client, workspaceId, kind, units) {
  let remaining = Number(units);
  if (!Number.isInteger(remaining) || remaining <= 0) return 0;
  const result = await client.query(
    `SELECT id, units_remaining
     FROM billing_addon_purchases
     WHERE workspace_id=$1 AND kind=$2 AND status='active' AND units_remaining > 0
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY created_at ASC
     FOR UPDATE`,
    [workspaceId, kind],
  );
  const available = result.rows.reduce((sum, row) => sum + Number(row.units_remaining), 0);
  if (available < remaining) return 0;
  for (const row of result.rows) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(row.units_remaining));
    await client.query(
      `UPDATE billing_addon_purchases
       SET units_remaining=units_remaining-$2,
           status=CASE WHEN units_remaining-$2=0 THEN 'consumed' ELSE status END,
           updated_at=NOW()
       WHERE id=$1`,
      [row.id, take],
    );
    remaining -= take;
  }
  return Number(units);
}

export async function listBillingPlans() {
  const result = await query(
    "SELECT * FROM subscription_plans WHERE active=TRUE ORDER BY price_usd_cents, id",
  );
  return result.rows.map((row) =>
    mapBillingPlan({ ...row, plan_id: row.id }),
  );
}

function mapBillingAddon(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    units: Number(row.units),
    priceUsdCents: Number(row.price_usd_cents),
    billingInterval: row.billing_interval,
    includedHours: Number(row.included_hours ?? 0),
    overagePolicy: row.overage_policy ?? "",
    serviceScope: row.service_scope ?? "",
    deliveryWindow: row.delivery_window ?? "",
    acceptanceTerms: row.acceptance_terms ?? "",
  };
}

function mapServiceOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    addonId: row.addon_id,
    addonName: row.addon_name,
    kind: row.kind,
    status: row.status,
    targetAgentId: row.target_agent_id,
    targetAgentName: row.target_agent_name ?? null,
    scope: row.scope,
    deliveryWindow: row.delivery_window,
    acceptanceTerms: row.acceptance_terms,
    includedHours: Number(row.included_hours ?? 0),
    overagePolicy: row.overage_policy ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
    acceptedAt: row.accepted_at,
  };
}

export async function listBillingAddons() {
  const result = await query(
    "SELECT * FROM billing_addon_catalog WHERE active=TRUE ORDER BY kind, price_usd_cents, id",
  );
  return result.rows.map(mapBillingAddon);
}

export async function listBillingServiceOrders(workspaceId) {
  const result = await query(
    `SELECT so.*, a.name AS addon_name, a.kind,
            ag.name AS target_agent_name
     FROM billing_service_orders so
     JOIN billing_addon_catalog a ON a.id=so.addon_id
     LEFT JOIN agents ag ON ag.id=so.target_agent_id
     WHERE so.workspace_id=$1
     ORDER BY so.created_at DESC
     LIMIT 50`,
    [workspaceId],
  );
  return result.rows.map(mapServiceOrder);
}

export async function schedulePlanChange({ workspaceId, planId }) {
  return withTransaction(async (client) => {
    const state = await lockBillingState(client, workspaceId);
    const target = await client.query(
      "SELECT id FROM subscription_plans WHERE id=$1 AND active=TRUE",
      [planId],
    );
    if (!target.rowCount) throw billingError("PLAN_NOT_FOUND", "The selected plan is not available.");
    if (state.subscription.plan_id === planId) {
      throw billingError("PLAN_ALREADY_ACTIVE", "This plan is already active.");
    }
    const rank = { free: 0, builder: 1, team: 2, agency: 3 };
    if ((rank[planId] ?? 0) >= (rank[state.subscription.plan_id] ?? 0)) {
      throw billingError("PLAN_CHANGE_REQUIRES_PAYMENT", "An upgrade requires a verified payment checkout.");
    }
    if (!state.active || state.subscription.plan_id === "free") {
      throw billingError("PLAN_CHANGE_REQUIRES_PAYMENT", "This plan change requires a new verified payment.");
    }
    const result = await client.query(
      `UPDATE workspace_subscriptions
       SET pending_plan_id=$2,
           pending_plan_effective_at=current_period_end,
           updated_at=NOW()
       WHERE workspace_id=$1
       RETURNING pending_plan_effective_at`,
      [workspaceId, planId],
    );
    return {
      planId,
      effectiveAt: result.rows[0].pending_plan_effective_at,
      currentPlanId: state.subscription.plan_id,
    };
  });
}

export async function cancelScheduledPlanChange({ workspaceId }) {
  const result = await query(
    `UPDATE workspace_subscriptions
     SET pending_plan_id=NULL, pending_plan_effective_at=NULL, updated_at=NOW()
     WHERE workspace_id=$1`,
    [workspaceId],
  );
  return result.rowCount > 0;
}

function mapCheckoutSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    planId: row.plan_id,
    checkoutType: row.checkout_type ?? "plan",
    addonId: row.addon_id ?? null,
    provider: row.provider,
    status: row.status,
    providerCheckoutId: row.provider_checkout_id,
    amountUsdCents: row.amount_usd_cents,
    paymentAmountAtomic: row.payment_amount_atomic === null || row.payment_amount_atomic === undefined
      ? null
      : String(row.payment_amount_atomic),
    paymentAmountUsdt: row.payment_amount_atomic === null || row.payment_amount_atomic === undefined
      ? null
      : atomicToUsdt(String(row.payment_amount_atomic)),
    quoteAmount: row.quote_amount,
    quoteCurrency: row.quote_currency,
    network: row.network,
    payAddress: row.pay_address,
    expiresAt: row.expires_at,
    providerUrl: row.metadata?.providerUrl ?? null,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBillingPayment(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    checkoutSessionId: row.checkout_session_id,
    checkoutType: row.checkout_type ?? null,
    planId: row.plan_id ?? null,
    planName: row.plan_name ?? row.checkout_plan_name ?? null,
    addonId: row.addon_id ?? null,
    addonName: row.addon_name ?? row.checkout_addon_name ?? null,
    provider: row.provider,
    providerPaymentId: row.provider_payment_id,
    status: row.status,
    amount: row.amount,
    netAmount: row.net_amount,
    currency: row.currency,
    network: row.network,
    walletAddress: row.wallet_address,
    txHash: row.tx_hash,
    confirmations: Number(row.confirmations ?? 0),
    paidAt: row.paid_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPaymentException(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    checkoutSessionId: row.checkout_session_id,
    provider: row.provider,
    network: row.network,
    txHash: row.tx_hash,
    providerPaymentId: row.provider_payment_id,
    senderAddress: row.sender_address,
    recipientAddress: row.recipient_address,
    tokenContract: row.token_contract,
    amountAtomic: row.amount_atomic === null || row.amount_atomic === undefined ? null : String(row.amount_atomic),
    amountUsdt: row.amount_usdt === null || row.amount_usdt === undefined ? null : String(row.amount_usdt),
    decimals: Number(row.decimals ?? 6),
    detectedAt: row.detected_at,
    transferTimestamp: row.transfer_timestamp,
    reason: row.reason,
    status: row.status,
    resolutionNote: row.resolution_note,
    resolvedByUserId: row.resolved_by_user_id,
    resolvedAt: row.resolved_at,
    rawPayload: row.raw_payload ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBillingPayout(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    providerPayoutId: row.provider_payout_id,
    status: row.status,
    amount: row.amount,
    fee: row.fee,
    netAmount: row.net_amount,
    currency: row.currency,
    network: row.network,
    toAddress: row.to_address,
    idempotencyKey: row.idempotency_key,
    description: row.description,
    sourcePaymentIds: row.source_payment_ids ?? [],
    txHash: row.tx_hash,
    errorReason: row.error_reason,
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

async function uniqueTronPaymentAmountAtomic(client, priceUsdCents) {
  const base = BigInt(usdtCentsToAtomic(priceUsdCents));
  // The six-decimal suffix is deliberately visible to the payer. It binds an
  // on-chain transfer to one checkout even when many customers buy the same
  // plan at the same time. A recent historical quote is also reserved for the
  // full TRON lookback window, so a late transfer cannot be confused with a
  // newer checkout after the active-checkout index stops covering the row.
  const lookbackMs = Math.max(60_000, Number(config.tron.maxLookbackMs) || 30 * 24 * 60 * 60 * 1000);
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = (base + BigInt(randomInt(1, 1_000_000))).toString();
    const collision = await client.query(
      `SELECT 1
       FROM billing_checkout_sessions
       WHERE provider='tron-p2p'
         AND payment_amount_atomic=$1
         AND (
           status IN ('waiting','awaiting_payment','confirming')
           OR COALESCE(expires_at, created_at) >= NOW() - ($2::bigint * INTERVAL '1 millisecond')
         )
       LIMIT 1`,
      [candidate, lookbackMs],
    );
    if (!collision.rowCount) return candidate;
  }
  throw billingError("CHECKOUT_QUOTE_UNAVAILABLE", "A unique TRON payment quote could not be created. Try again.");
}

// Direct checkout creation never changes entitlements. A verified on-chain event
// must later call applyVerifiedCryptoPayment inside a PostgreSQL transaction.
export async function createCheckoutSession({
  workspaceId,
  planId = null,
  addonId = null,
  checkoutType = "plan",
  provider,
  idempotencyKey,
  providerCheckoutId = null,
  status = "awaiting_payment",
  quoteAmount = null,
  quoteCurrency = null,
  network = null,
  payAddress = null,
  expiresAt = null,
  metadata = {},
}) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await withTransaction(async (client) => {
        const existing = await client.query(
          `SELECT * FROM billing_checkout_sessions
           WHERE workspace_id=$1 AND idempotency_key=$2`,
          [workspaceId, idempotencyKey],
        );
        if (existing.rowCount > 0) return mapCheckoutSession(existing.rows[0]);
        let priceUsdCents;
        if (checkoutType === "addon") {
          const addon = await client.query(
            "SELECT * FROM billing_addon_catalog WHERE id=$1 AND active=TRUE",
            [addonId],
          );
          if (!addon.rowCount) throw billingError("ADDON_NOT_FOUND", "The selected add-on is not available.");
          priceUsdCents = Number(addon.rows[0].price_usd_cents);
        } else {
          const plan = await client.query(
            "SELECT * FROM subscription_plans WHERE id=$1 AND active=TRUE",
            [planId],
          );
          if (!plan.rowCount) throw billingError("PLAN_NOT_FOUND", "The selected plan is not available.");
          if (Number(plan.rows[0].price_usd_cents) <= 0) {
            throw billingError("FREE_PLAN_CHECKOUT", "The free plan does not require checkout.");
          }
          priceUsdCents = Number(plan.rows[0].price_usd_cents);
        }
        const paymentAmountAtomic = provider === "tron-p2p"
          ? await uniqueTronPaymentAmountAtomic(client, priceUsdCents)
          : null;
        const paymentAmountUsdt = paymentAmountAtomic ? atomicToUsdt(paymentAmountAtomic) : quoteAmount;
        const result = await client.query(
          `INSERT INTO billing_checkout_sessions
             (id, workspace_id, plan_id, checkout_type, addon_id, provider, status, provider_checkout_id,
              amount_usd_cents, payment_amount_atomic, quote_amount, quote_currency, network, pay_address,
              idempotency_key, expires_at, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           RETURNING *`,
          [
            `checkout-${randomUUID()}`,
            workspaceId,
            planId,
            checkoutType,
            addonId,
            provider,
            status,
            providerCheckoutId,
            priceUsdCents,
            paymentAmountAtomic,
            paymentAmountUsdt,
            quoteCurrency,
            network,
            payAddress,
            idempotencyKey,
            expiresAt,
            JSON.stringify(metadata),
          ],
        );
        return mapCheckoutSession(result.rows[0]);
      });
    } catch (error) {
      if (error?.code === "23505") {
        const constraint = String(error?.constraint ?? "");
        // Concurrent retries may race before either transaction can observe
        // the idempotency row. Retry the read path so both callers receive
        // the same checkout instead of exposing a database 500.
        if (constraint.includes("tron_quote") || constraint.includes("workspace_id_idempotency_key")) continue;
      }
      throw error;
    }
  }
  throw billingError("CHECKOUT_QUOTE_UNAVAILABLE", "A unique TRON payment quote could not be created. Try again.");
}

export async function getCheckoutSessionByIdempotency({ workspaceId, idempotencyKey }) {
  const result = await query(
    `SELECT * FROM billing_checkout_sessions
     WHERE workspace_id=$1 AND idempotency_key=$2`,
    [workspaceId, idempotencyKey],
  );
  return mapCheckoutSession(result.rows[0]);
}

export async function attachCheckoutProvider({
  workspaceId,
  checkoutSessionId,
  providerCheckoutId,
  providerUrl,
  quoteAmount,
  quoteCurrency,
  network,
  payAddress,
  expiresAt,
  metadata = {},
}) {
  const result = await query(
    `UPDATE billing_checkout_sessions
     SET provider_checkout_id=$3,
         quote_amount=$4,
         quote_currency=$5,
         network=$6,
         pay_address=$7,
         expires_at=$8,
         metadata=COALESCE(metadata, '{}'::jsonb) || $9::jsonb,
         updated_at=NOW()
     WHERE id=$1 AND workspace_id=$2
     RETURNING *`,
    [
      checkoutSessionId,
      workspaceId,
      providerCheckoutId,
      quoteAmount,
      quoteCurrency,
      network,
      payAddress,
      expiresAt,
      JSON.stringify({ ...metadata, providerUrl }),
    ],
  );
  return mapCheckoutSession(result.rows[0]);
}

export async function getCheckoutSession({ workspaceId, checkoutSessionId }) {
  const result = await query(
    `SELECT * FROM billing_checkout_sessions
     WHERE id=$1 AND workspace_id=$2`,
    [checkoutSessionId, workspaceId],
  );
  return mapCheckoutSession(result.rows[0]);
}

async function applyVerifiedCryptoPaymentInTransaction(client, input, {
  paymentProvider = null,
  confirmedCheckoutStatus = "paid",
  allowLatePayment = false,
} = {}) {
  const event = normalizeVerifiedCryptoPayment(input);
  const persistedProvider = paymentProvider ?? event.provider;
    const checkout = await client.query(
      `SELECT * FROM billing_checkout_sessions
       WHERE id=$1 OR provider_checkout_id=$2
       ORDER BY created_at DESC LIMIT 1
       FOR UPDATE`,
      [event.checkoutSessionId, event.providerCheckoutId],
    );
    if (!checkout.rowCount) {
      throw billingError("CHECKOUT_NOT_FOUND", "The checkout session for this payment was not found.");
    }
    const session = checkout.rows[0];
    if (event.paymentTimestamp) {
      const paymentTime = new Date(event.paymentTimestamp);
      const createdAt = new Date(session.created_at);
      const expiresAt = session.expires_at ? new Date(session.expires_at) : null;
      if (Number.isNaN(paymentTime.getTime())
        || paymentTime < createdAt
        || (!allowLatePayment && expiresAt && paymentTime > expiresAt)
        || paymentTime > new Date(Date.now() + 5 * 60 * 1000)) {
        throw billingError("PAYMENT_TIME_INVALID", "The blockchain payment is outside the checkout time window.");
      }
    }
    const expectedAtomic = session.payment_amount_atomic === null || session.payment_amount_atomic === undefined
      ? usdtCentsToAtomic(Number(session.amount_usd_cents))
      : String(session.payment_amount_atomic);
    if (event.status === "confirmed") {
      let receivedAtomic;
      try {
        receivedAtomic = usdtToAtomic(event.amount);
      } catch {
        throw billingError("PAYMENT_AMOUNT_MISMATCH", "The received payment amount is invalid.");
      }
      if (receivedAtomic !== expectedAtomic) {
        throw billingError("PAYMENT_AMOUNT_MISMATCH", "The received payment amount does not match this checkout quote.");
      }
    }
    if (event.txHash) {
      const hashResult = await client.query(
        `SELECT * FROM billing_payments
         WHERE network=$1 AND tx_hash=$2
         FOR UPDATE`,
        [event.network, event.txHash],
      );
      if (hashResult.rowCount && hashResult.rows[0].checkout_session_id !== session.id) {
        throw billingError("PAYMENT_REPLAY", "This blockchain transaction has already been used for another checkout.");
      }
      if (hashResult.rowCount && hashResult.rows[0].status === "confirmed") {
        return {
          paymentId: hashResult.rows[0].id,
          checkoutSessionId: session.id,
          workspaceId: session.workspace_id,
          status: event.status,
          duplicate: true,
        };
      }
    }
    if (event.status === "confirmed" && ["paid", "completed"].includes(session.status)) {
      throw billingError("PAYMENT_REPLAY", "This checkout has already been settled by another blockchain transaction.");
    }
    const paymentInsert = await client.query(
      `INSERT INTO billing_payments
         (id, workspace_id, subscription_id, checkout_session_id, provider,
          provider_payment_id, status, amount, net_amount, currency, network, wallet_address,
          tx_hash, confirmations, raw_payload, paid_at)
       VALUES ($1,$2,(SELECT id FROM workspace_subscriptions WHERE workspace_id=$2),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
          COALESCE($15::timestamptz, CASE WHEN $6='confirmed' THEN NOW() ELSE NULL END))
       ON CONFLICT (provider, provider_payment_id) DO NOTHING
       RETURNING *`,
      [
        `payment-${randomUUID()}`,
        session.workspace_id,
        session.id,
        persistedProvider,
        event.providerPaymentId,
        event.status,
        event.amount,
        event.netAmount,
        event.currency,
        event.network,
        event.walletAddress,
        event.txHash,
        event.confirmations,
        JSON.stringify(event.rawPayload),
        event.paymentTimestamp,
      ],
    );
    let payment;
    let alreadyConfirmed = false;
    if (paymentInsert.rowCount > 0) {
      payment = paymentInsert.rows[0];
    } else {
      const existingPayment = await client.query(
        `SELECT * FROM billing_payments
         WHERE provider=$1 AND provider_payment_id=$2
         FOR UPDATE`,
        [persistedProvider, event.providerPaymentId],
      );
      if (!existingPayment.rowCount) {
        throw billingError("PAYMENT_NOT_FOUND", "The payment could not be persisted safely.");
      }
      alreadyConfirmed = existingPayment.rows[0].status === "confirmed";
      const updatedPayment = await client.query(
        `UPDATE billing_payments
         SET status=CASE
             WHEN status='confirmed' AND $2 <> 'confirmed' THEN status
             ELSE $2
           END,
           amount=$3, net_amount=COALESCE($4, net_amount), currency=$5,
           network=$6, wallet_address=$7, tx_hash=$8, confirmations=$9,
           raw_payload=$10::jsonb,
           paid_at=COALESCE(paid_at, CASE WHEN $2='confirmed' THEN NOW() ELSE NULL END),
           updated_at=NOW()
         WHERE id=$1
         RETURNING *`,
        [
          existingPayment.rows[0].id,
          event.status,
          event.amount,
          event.netAmount,
          event.currency,
          event.network,
          event.walletAddress,
          event.txHash,
          event.confirmations,
          JSON.stringify(event.rawPayload),
        ],
      );
      payment = updatedPayment.rows[0];
    }
    const checkoutStatus = event.status === "confirmed"
      ? confirmedCheckoutStatus
      : event.status === "confirming"
        ? "confirming"
        : event.status === "pending"
          ? "awaiting_payment"
          : event.status === "refunded"
            ? "canceled"
            : event.status;
    await client.query(
      `UPDATE billing_checkout_sessions
       SET status=CASE WHEN status IN ('paid','completed') AND $2 NOT IN ('paid','completed') THEN status ELSE $2 END,
           updated_at=NOW()
       WHERE id=$1`,
      [session.id, checkoutStatus],
    );
    if (event.status === "confirmed" && alreadyConfirmed) {
      return {
        paymentId: payment.id,
        checkoutSessionId: session.id,
        workspaceId: session.workspace_id,
        status: event.status,
        duplicate: true,
      };
    }
    if (event.status === "confirmed") {
      if (session.checkout_type === "addon") {
        const addon = await client.query(
          "SELECT * FROM billing_addon_catalog WHERE id=$1 AND active=TRUE",
          [session.addon_id],
        );
        if (!addon.rowCount) throw billingError("ADDON_NOT_FOUND", "The purchased add-on is no longer available.");
        const subscription = await client.query(
          "SELECT current_period_end FROM workspace_subscriptions WHERE workspace_id=$1 FOR UPDATE",
          [session.workspace_id],
        );
        const metadata = session.metadata ?? {};
        let expiresAt = null;
        if (addon.rows[0].billing_interval === "month") {
          const base = new Date(subscription.rows[0]?.current_period_end ?? Date.now());
          expiresAt = base > new Date() ? base : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        }
        const purchaseResult = await client.query(
          `INSERT INTO billing_addon_purchases
             (id, workspace_id, checkout_session_id, addon_id, kind, units_total, units_remaining, expires_at, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8)
           ON CONFLICT (checkout_session_id) DO UPDATE SET updated_at=NOW()
           RETURNING id`,
          [
            `addon-purchase-${randomUUID()}`,
            session.workspace_id,
            session.id,
            addon.rows[0].id,
            addon.rows[0].kind,
            Number(addon.rows[0].units),
            expiresAt,
            JSON.stringify(metadata),
          ],
        );
        if (["security_audit", "support"].includes(addon.rows[0].kind)) {
          await client.query(
            `INSERT INTO billing_service_orders
               (id, workspace_id, checkout_session_id, addon_purchase_id, addon_id,
                target_agent_id, status, scope, delivery_window, acceptance_terms,
                included_hours, overage_policy, metadata)
             VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$10,$11,$12)
             ON CONFLICT (checkout_session_id) DO NOTHING`,
            [
              `service-order-${randomUUID()}`,
              session.workspace_id,
              session.id,
              purchaseResult.rows[0]?.id ?? null,
              addon.rows[0].id,
              metadata.targetAgentId ?? null,
              addon.rows[0].service_scope ?? "",
              addon.rows[0].delivery_window ?? "",
              addon.rows[0].acceptance_terms ?? "",
              Number(addon.rows[0].included_hours ?? 0),
              addon.rows[0].overage_policy ?? "",
              JSON.stringify({
                serviceAcknowledged: metadata.serviceAcknowledged === true,
                purchasedAt: new Date().toISOString(),
              }),
            ],
          );
        }
      } else {
        const subscriptionResult = await client.query(
          `SELECT s.*, p.name AS current_plan_name
           FROM workspace_subscriptions s
           JOIN subscription_plans p ON p.id=s.plan_id
           WHERE s.workspace_id=$1
           FOR UPDATE`,
          [session.workspace_id],
        );
        const subscription = subscriptionResult.rows[0];
        const now = new Date();
        const ranks = { free: 0, builder: 1, team: 2, agency: 3 };
        const targetRank = ranks[session.plan_id] ?? 0;
        const currentRank = ranks[subscription?.plan_id] ?? 0;
        const currentActive = subscription && new Date(subscription.current_period_end) > now && ["active", "trialing", "canceled"].includes(subscription.status);
        if (currentActive && targetRank < currentRank) {
          await client.query(
            `UPDATE workspace_subscriptions
             SET pending_plan_id=$2, pending_plan_effective_at=current_period_end,
                 updated_at=NOW()
             WHERE workspace_id=$1`,
            [session.workspace_id, session.plan_id],
          );
        } else {
          const start = currentActive && session.plan_id === subscription.plan_id
            ? new Date(subscription.current_period_start)
            : now;
          const end = currentActive && session.plan_id === subscription.plan_id
            ? new Date(new Date(subscription.current_period_end).setUTCMonth(new Date(subscription.current_period_end).getUTCMonth() + 1))
            : new Date(new Date(now).setUTCMonth(now.getUTCMonth() + 1));
          await client.query(
            `UPDATE workspace_subscriptions
             SET plan_id=$2, status='active', billing_provider=$5,
                 current_period_start=$3, current_period_end=$4,
                 renewal_mode='manual', pending_plan_id=NULL,
                 pending_plan_effective_at=NULL, cancel_at_period_end=FALSE,
                 metadata=COALESCE(metadata, '{}'::jsonb) - 'lastExpiryFallback',
                 updated_at=NOW()
             WHERE workspace_id=$1`,
            [session.workspace_id, session.plan_id, start, end, persistedProvider],
          );
          await client.query(
            `INSERT INTO usage_periods
               (id, workspace_id, subscription_id, period_start, period_end)
             SELECT $1, s.workspace_id, s.id, s.current_period_start, s.current_period_end
             FROM workspace_subscriptions s WHERE s.workspace_id=$2
             ON CONFLICT (workspace_id, period_start) DO NOTHING`,
            [`usage-${session.workspace_id}-${start.toISOString()}`, session.workspace_id],
          );
        }
      }
    }
    return {
      paymentId: payment.id,
      checkoutSessionId: session.id,
      workspaceId: session.workspace_id,
      status: event.status,
    };
}

export async function applyVerifiedCryptoPayment(input, options = {}) {
  return withTransaction((client) => applyVerifiedCryptoPaymentInTransaction(client, input, options));
}

export async function listBillingPaymentHistory({ workspaceId, limit = 50 } = {}) {
  const result = await query(
    `SELECT p.*, c.checkout_type, c.plan_id, c.addon_id,
            sp.name AS checkout_plan_name,
            ba.name AS checkout_addon_name
     FROM billing_payments p
     LEFT JOIN billing_checkout_sessions c ON c.id=p.checkout_session_id
     LEFT JOIN subscription_plans sp ON sp.id=c.plan_id
     LEFT JOIN billing_addon_catalog ba ON ba.id=c.addon_id
     WHERE p.workspace_id=$1
     ORDER BY COALESCE(p.paid_at, p.created_at) DESC
     LIMIT $2`,
    [workspaceId, Math.max(1, Math.min(Number(limit) || 50, 100))],
  );
  return result.rows.map(mapBillingPayment);
}

export async function recordPaymentException({
  workspaceId = null,
  checkoutSessionId = null,
  provider = "tron-p2p",
  network = "TRON",
  txHash,
  providerPaymentId = null,
  senderAddress = null,
  recipientAddress = null,
  tokenContract = null,
  amountAtomic,
  amountUsdt,
  decimals = 6,
  detectedAt = null,
  transferTimestamp = null,
  reason = "manual_review",
  status = "open",
  rawPayload = {},
} = {}) {
  if (!txHash || !amountAtomic || !amountUsdt) {
    throw billingError("PAYMENT_EXCEPTION_INVALID", "A payment exception requires a transaction hash and amount.");
  }
  const result = await query(
    `INSERT INTO billing_payment_exceptions
       (id, workspace_id, checkout_session_id, provider, network, tx_hash,
        provider_payment_id, sender_address, recipient_address, token_contract,
        amount_atomic, amount_usdt, decimals, detected_at, transfer_timestamp,
        reason, status, raw_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
             COALESCE($14::timestamptz, NOW()),$15,$16,$17,$18::jsonb)
     ON CONFLICT (provider, network, tx_hash) DO UPDATE SET
       workspace_id=COALESCE(billing_payment_exceptions.workspace_id, EXCLUDED.workspace_id),
       checkout_session_id=COALESCE(billing_payment_exceptions.checkout_session_id, EXCLUDED.checkout_session_id),
       provider_payment_id=COALESCE(billing_payment_exceptions.provider_payment_id, EXCLUDED.provider_payment_id),
       reason=CASE
         WHEN billing_payment_exceptions.status IN ('resolved','refunded','ignored') THEN billing_payment_exceptions.reason
         ELSE EXCLUDED.reason
       END,
       raw_payload=EXCLUDED.raw_payload,
       updated_at=NOW()
     RETURNING *`,
    [
      `payment-exception-${randomUUID()}`,
      workspaceId,
      checkoutSessionId,
      provider,
      network,
      String(txHash).toLowerCase(),
      providerPaymentId,
      senderAddress,
      recipientAddress,
      tokenContract,
      String(amountAtomic),
      String(amountUsdt),
      decimals,
      detectedAt,
      transferTimestamp,
      reason,
      status,
      JSON.stringify(rawPayload ?? {}),
    ],
  );
  return mapPaymentException(result.rows[0]);
}

export async function listPaymentExceptions({ workspaceId, status = null, limit = 50 } = {}) {
  const result = await query(
    `SELECT e.*, c.plan_id AS checkout_plan_id, c.addon_id AS checkout_addon_id
     FROM billing_payment_exceptions e
     LEFT JOIN billing_checkout_sessions c ON c.id=e.checkout_session_id
     WHERE e.workspace_id=$1
       AND ($2::text IS NULL OR e.status=$2)
     ORDER BY e.created_at DESC
     LIMIT $3`,
    [workspaceId, status, Math.max(1, Math.min(Number(limit) || 50, 100))],
  );
  return result.rows.map(mapPaymentException);
}

export async function getPaymentException({ workspaceId, exceptionId }) {
  const result = await query(
    `SELECT * FROM billing_payment_exceptions
     WHERE id=$1 AND workspace_id=$2`,
    [exceptionId, workspaceId],
  );
  return mapPaymentException(result.rows[0]);
}

export async function resolvePaymentException({
  workspaceId,
  exceptionId,
  actorUserId,
  status,
  note = null,
}) {
  const allowed = new Set(["refund_required", "resolved", "ignored", "refunded"]);
  if (!allowed.has(status)) throw billingError("PAYMENT_EXCEPTION_STATUS_INVALID", "The payment exception status is not supported.");
  return withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT * FROM billing_payment_exceptions
       WHERE id=$1 AND workspace_id=$2
       FOR UPDATE`,
      [exceptionId, workspaceId],
    );
    if (!existing.rowCount) return null;
    if (["resolved", "refunded", "ignored"].includes(existing.rows[0].status) && status !== existing.rows[0].status) {
      throw billingError("PAYMENT_EXCEPTION_CLOSED", "This payment exception has already been closed.");
    }
    const result = await client.query(
      `UPDATE billing_payment_exceptions
       SET status=$3, resolution_note=$4, resolved_by_user_id=$5,
           resolved_at=CASE WHEN $3 IN ('resolved','refunded','ignored') THEN NOW() ELSE NULL END,
           updated_at=NOW()
       WHERE id=$1 AND workspace_id=$2
       RETURNING *`,
      [exceptionId, workspaceId, status, note ? String(note).slice(0, 1000) : null, actorUserId ?? null],
    );
    return mapPaymentException(result.rows[0]);
  });
}

export async function attachPaymentExceptionToCheckout({
  workspaceId,
  exceptionId,
  checkoutSessionId,
  actorUserId,
  expectedRecipient,
  expectedContract,
  note = null,
}) {
  return withTransaction(async (client) => {
    const exceptionResult = await client.query(
      `SELECT * FROM billing_payment_exceptions
       WHERE id=$1 AND workspace_id=$2
       FOR UPDATE`,
      [exceptionId, workspaceId],
    );
    if (!exceptionResult.rowCount) return null;
    const exception = exceptionResult.rows[0];
    if (["resolved", "refunded", "ignored"].includes(exception.status)) {
      throw billingError("PAYMENT_EXCEPTION_CLOSED", "This payment exception has already been closed.");
    }
    const checkoutResult = await client.query(
      `SELECT * FROM billing_checkout_sessions
       WHERE id=$1 AND workspace_id=$2 AND provider='tron-p2p'
       FOR UPDATE`,
      [checkoutSessionId, workspaceId],
    );
    if (!checkoutResult.rowCount) throw billingError("CHECKOUT_NOT_FOUND", "The checkout session was not found.");
    const checkout = checkoutResult.rows[0];
    if (!["waiting", "awaiting_payment", "confirming", "expired"].includes(checkout.status)) {
      throw billingError("CHECKOUT_NOT_ATTACHABLE", "This checkout cannot accept a manually attached payment.");
    }
    if (expectedRecipient && exception.recipient_address !== expectedRecipient) {
      throw billingError("PAYMENT_RECIPIENT_MISMATCH", "The payment recipient does not match the AgentGuard wallet.");
    }
    if (exception.network !== "TRON" || exception.decimals !== 6) {
      throw billingError("PAYMENT_TOKEN_MISMATCH", "The payment is not a USDT-TRC20 transfer.");
    }
    if (expectedContract && exception.token_contract !== expectedContract) {
      throw billingError("PAYMENT_TOKEN_MISMATCH", "The payment token contract does not match USDT-TRC20.");
    }
    const expectedAtomic = checkout.payment_amount_atomic === null || checkout.payment_amount_atomic === undefined
      ? usdtCentsToAtomic(Number(checkout.amount_usd_cents))
      : String(checkout.payment_amount_atomic);
    if (String(exception.amount_atomic) !== expectedAtomic) {
      throw billingError("PAYMENT_AMOUNT_MISMATCH", "The exception amount does not match the selected checkout quote.");
    }
    const event = {
      provider: "crypto",
      providerPaymentId: exception.provider_payment_id ?? exception.tx_hash,
      checkoutSessionId: checkout.id,
      providerCheckoutId: exception.tx_hash,
      status: "confirmed",
      amount: String(exception.amount_usdt),
      netAmount: String(exception.amount_usdt),
      currency: "USDT",
      network: exception.network,
      walletAddress: exception.recipient_address ?? expectedRecipient ?? checkout.pay_address,
      txHash: exception.tx_hash,
      confirmations: 1,
      paymentTimestamp: exception.transfer_timestamp,
      rawPayload: exception.raw_payload ?? {},
    };
    const payment = await applyVerifiedCryptoPaymentInTransaction(client, event, {
      paymentProvider: "tron-p2p",
      confirmedCheckoutStatus: "completed",
      allowLatePayment: true,
    });
    const updated = await client.query(
      `UPDATE billing_payment_exceptions
       SET checkout_session_id=$3, status='resolved', resolution_note=$4,
           resolved_by_user_id=$5, resolved_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND workspace_id=$2
       RETURNING *`,
      [exceptionId, workspaceId, checkout.id, note ? String(note).slice(0, 1000) : "Manually attached to checkout.", actorUserId ?? null],
    );
    return { payment, exception: mapPaymentException(updated.rows[0]) };
  });
}

export async function queueAutomaticPayout({ minimumAmount, toAddress, provider = "tron-p2p" }) {
  return withTransaction(async (client) => {
    const candidates = await client.query(
      `SELECT id, COALESCE(net_amount, amount) AS payout_amount
       FROM billing_payments
       WHERE status='confirmed' AND payout_id IS NULL
         AND currency='USDT' AND network='TRON'
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED`,
    );
    if (!candidates.rowCount) return null;
    const amount = candidates.rows.reduce(
      (total, row) => total + Number(row.payout_amount ?? 0),
      0,
    );
    if (!Number.isFinite(amount) || amount < Number(minimumAmount)) return null;
    const paymentIds = candidates.rows.map((row) => row.id);
    const id = `payout-${randomUUID()}`;
    const idempotencyKey = `agentguard-${id}`;
    const inserted = await client.query(
      `INSERT INTO billing_payouts
      (id, provider, status, amount, currency, network, to_address, idempotency_key,
          description, source_payment_ids)
       VALUES ($1,$2,'queued',$3,'USDT','TRON',$4,$5,$6,$7::jsonb)
       RETURNING *`,
      [
        id,
        provider,
        amount.toFixed(12).replace(/0+$/, "").replace(/\.$/, ""),
        toAddress,
        idempotencyKey,
        "AgentGuard automatic settlement",
        JSON.stringify(paymentIds),
      ],
    );
    await client.query(
      `UPDATE billing_payments SET payout_id=$1, updated_at=NOW()
       WHERE id = ANY($2::text[]) AND payout_id IS NULL`,
      [id, paymentIds],
    );
    return mapBillingPayout(inserted.rows[0]);
  });
}

export async function claimNextPayout(leaseMs = 120000, maxAttempts = 5) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `SELECT * FROM billing_payouts
       WHERE status IN ('queued','processing')
         AND attempts < $1
         AND next_attempt_at <= NOW()
         AND (locked_until IS NULL OR locked_until < NOW())
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [maxAttempts],
    );
    if (!result.rowCount) return null;
    const payout = await client.query(
      `UPDATE billing_payouts
       SET status='processing', attempts=attempts+1,
           locked_until=NOW() + ($2 * INTERVAL '1 millisecond'), updated_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [result.rows[0].id, leaseMs],
    );
    return mapBillingPayout(payout.rows[0]);
  });
}

export async function attachPayoutProvider({
  payoutId,
  providerPayoutId,
  status,
  amount,
  fee,
  netAmount,
  txHash,
  rawPayload,
}) {
  const result = await query(
    `UPDATE billing_payouts
     SET provider_payout_id=$2,
         status=CASE WHEN status='completed' AND $3 <> 'completed' THEN status ELSE $3 END,
         amount=COALESCE($4, amount),
         fee=$5, net_amount=$6, tx_hash=$7, raw_payload=$8::jsonb,
         locked_until=NULL, next_attempt_at=NOW(), updated_at=NOW(),
         completed_at=CASE WHEN $3='completed' THEN NOW() ELSE completed_at END
     WHERE id=$1
     RETURNING *`,
    [payoutId, providerPayoutId, status, amount, fee, netAmount, txHash, JSON.stringify(rawPayload ?? {})],
  );
  return mapBillingPayout(result.rows[0]);
}

export async function failPayout({ payoutId, errorReason, retryDelayMs = 60000, permanent = false }) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE billing_payouts
       SET status=CASE WHEN $3 THEN 'failed' ELSE 'queued' END,
           error_reason=$2,
           next_attempt_at=NOW() + ($4 * INTERVAL '1 millisecond'),
           locked_until=NULL, updated_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [payoutId, String(errorReason ?? "Payout failed").slice(0, 500), permanent, retryDelayMs],
    );
    if (!result.rowCount) return null;
    if (permanent) {
      await client.query(
        "UPDATE billing_payments SET payout_id=NULL, updated_at=NOW() WHERE payout_id=$1",
        [payoutId],
      );
    }
    return mapBillingPayout(result.rows[0]);
  });
}

export async function applyVerifiedPayoutWebhook(event) {
  if (!event || event.kind !== "payout" || !event.providerPayoutId) {
    throw billingError("INVALID_PAYOUT_EVENT", "A verified payout event is required.");
  }
  const result = await query(
    `UPDATE billing_payouts
     SET provider_payout_id=COALESCE(provider_payout_id, $1),
         status=CASE WHEN status='completed' AND $2 <> 'completed' THEN status ELSE $2 END,
         fee=COALESCE($3, fee), net_amount=COALESCE($4, net_amount),
         tx_hash=COALESCE($5, tx_hash), error_reason=$6, raw_payload=$7::jsonb,
         locked_until=NULL, updated_at=NOW(),
         completed_at=CASE WHEN $2='completed' THEN NOW() ELSE completed_at END
     WHERE provider=$9 AND (provider_payout_id=$1 OR id=$8 OR idempotency_key=$8)
     RETURNING *`,
    [
      event.providerPayoutId,
      event.status,
      event.fee,
      event.netAmount,
      event.txHash,
      event.errorReason,
      JSON.stringify(event.rawPayload ?? {}),
      event.idempotencyKey ?? "",
      event.provider ?? "tron-p2p",
    ],
  );
  if (!result.rowCount) throw billingError("PAYOUT_NOT_FOUND", "The payout for this event was not found.");
  return mapBillingPayout(result.rows[0]);
}

export async function listBillingPayouts(limit = 50) {
  const result = await query(
    "SELECT * FROM billing_payouts ORDER BY created_at DESC LIMIT $1",
    [Math.min(100, Math.max(1, Number(limit) || 50))],
  );
  return result.rows.map(mapBillingPayout);
}

async function reserveScanCredits(client, {
  workspaceId,
  scanId,
  selectedScenarios = scenarios,
  billingState = null,
}) {
  const state = billingState ?? await lockBillingState(client, workspaceId);
  const scanCredits = scanCreditsForScenarios(selectedScenarios);
  if (!state.active) {
    throw billingError(
      "SUBSCRIPTION_REQUIRED",
      "Your subscription is not active. Renew it before running a scan.",
    );
  }
  const used = state.plan.scanCreditMode === "one_time"
    ? Number(state.subscription.one_time_scan_credits_used ?? 0)
    : Number(state.usage.scan_credits_used);
  const included = state.plan.monthlyScanCredits;
  const includedAvailable = Math.max(0, included - used);
  const includedToUse = Math.min(scanCredits, includedAvailable);
  const addonToUse = scanCredits - includedToUse;
  if (addonToUse > 0) {
    const addonBalances = await getAddonBalances(client, workspaceId);
    if (addonBalances.scanCredits < addonToUse) {
      throw billingError(
        "SCAN_QUOTA_EXCEEDED",
        `This scan needs ${scanCredits} credits, but only ${includedAvailable + addonBalances.scanCredits} remain. Upgrade or purchase extra Scan Credits to continue.`,
      );
    }
  }
  const ledger = await client.query(
    `INSERT INTO usage_ledger
       (id, workspace_id, subscription_id, period_start, kind, units, reference_type, reference_id, idempotency_key, metadata)
     VALUES ($1,$2,$3,$4,'scan_credits',$5,'scan',$6,$7,$8)
     ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [
      `usage-entry-${scanId}`,
      workspaceId,
      state.subscription.id,
      state.subscription.current_period_start,
      scanCredits,
      scanId,
      `scan:${scanId}`,
      JSON.stringify({ scanCredits, scenarioCount: selectedScenarios.length }),
    ],
  );
  if (ledger.rowCount > 0) {
    if (state.plan.scanCreditMode === "one_time") {
      await client.query(
        `UPDATE workspace_subscriptions
         SET one_time_scan_credits_used=one_time_scan_credits_used+$2, updated_at=NOW()
         WHERE id=$1`,
        [state.subscription.id, includedToUse],
      );
    } else if (includedToUse > 0) {
      await client.query(
        `UPDATE usage_periods
         SET scan_credits_used=scan_credits_used+$2, updated_at=NOW()
         WHERE id=$1`,
        [state.usage.id, includedToUse],
      );
    }
    if (addonToUse > 0) {
      await consumeAddonUnits(client, workspaceId, "scan_credits", addonToUse);
    }
  }
  const addonBalances = await getAddonBalances(client, workspaceId);
  const nextUsed = used + includedToUse;
  return {
    creditsUsed: scanCredits,
    scanCreditsRemaining: Math.max(0, included - nextUsed),
    scanCreditsIncluded: included,
    scanCreditAddonsUsed: addonToUse,
    scanCreditAddonsRemaining: addonBalances.scanCredits,
    totalScanCreditsRemaining: Math.max(0, included - nextUsed) + addonBalances.scanCredits,
    alerts: quotaAlerts({ used: nextUsed, included, resource: "scan_credits", addonRemaining: addonBalances.scanCredits }),
  };
}

export async function findUserByEmail(email) {
  const result = await query(
    `SELECT u.*, m.workspace_id, m.role, w.name AS workspace_name
     FROM users u JOIN memberships m ON m.user_id = u.id
     JOIN workspaces w ON w.id = m.workspace_id
     WHERE LOWER(u.email) = LOWER($1) ORDER BY m.created_at LIMIT 1`,
    [email],
  );
  return result.rows[0] ?? null;
}

export async function findUserById(userId) {
  const result = await query(
    `SELECT u.*, m.workspace_id, m.role, w.name AS workspace_name
     FROM users u JOIN memberships m ON m.user_id = u.id
     JOIN workspaces w ON w.id = m.workspace_id
     WHERE u.id = $1 ORDER BY m.created_at LIMIT 1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function createRefreshSession({
  sessionId,
  userId,
  tokenHash,
  sessionVersion,
  expiresAt,
  userAgent,
  ipAddress,
}) {
  await query(
    `INSERT INTO auth_refresh_sessions
       (id, user_id, token_hash, session_version, expires_at, user_agent, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [sessionId, userId, tokenHash, sessionVersion, expiresAt, userAgent, ipAddress],
  );
}

export async function rotateRefreshSession({
  tokenHash,
  nextSessionId,
  nextTokenHash,
  nextExpiresAt,
  userAgent,
  ipAddress,
}) {
  return withTransaction(async (client) => {
    const current = await client.query(
      `SELECT s.*, u.email, u.name, u.session_version AS current_session_version,
              m.workspace_id, m.role, w.name AS workspace_name
       FROM auth_refresh_sessions s
       JOIN users u ON u.id = s.user_id
       JOIN memberships m ON m.user_id = u.id
       JOIN workspaces w ON w.id = m.workspace_id
       WHERE s.token_hash=$1
         AND s.revoked_at IS NULL
         AND s.expires_at > NOW()
         AND s.session_version = u.session_version
       ORDER BY m.created_at
       LIMIT 1
       FOR UPDATE OF s`,
      [tokenHash],
    );
    const session = current.rows[0];
    if (!session) return null;

    await client.query(
      `UPDATE auth_refresh_sessions
       SET revoked_at=NOW(), last_used_at=NOW()
       WHERE id=$1`,
      [session.id],
    );
    await client.query(
      `INSERT INTO auth_refresh_sessions
         (id, user_id, token_hash, session_version, expires_at, user_agent, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        nextSessionId,
        session.user_id,
        nextTokenHash,
        session.current_session_version,
        nextExpiresAt,
        userAgent,
        ipAddress,
      ],
    );
    return session;
  });
}

export async function revokeRefreshSession(tokenHash) {
  await query(
    `UPDATE auth_refresh_sessions
     SET revoked_at=COALESCE(revoked_at, NOW()), last_used_at=NOW()
     WHERE token_hash=$1`,
    [tokenHash],
  );
}

function mapWorkspaceMember(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    joinedAt: row.joined_at,
  };
}

export async function getWorkspaceSettings({ userId, workspaceId }) {
  const [userResult, workspaceResult, membersResult] = await Promise.all([
    query(
      `SELECT u.id, u.email, u.name, u.password_changed_at, u.email_verified_at, u.mfa_enabled,
              m.workspace_id, m.role, w.name AS workspace_name
       FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.workspace_id = $2
       JOIN workspaces w ON w.id = m.workspace_id
       WHERE u.id = $1`,
      [userId, workspaceId],
    ),
    query(
      `SELECT w.id, w.name, w.created_at,
              (SELECT COUNT(*)::int FROM memberships m WHERE m.workspace_id = w.id) AS member_count,
              (SELECT COUNT(*)::int FROM agents a WHERE a.workspace_id = w.id) AS agent_count
       FROM workspaces w
       WHERE w.id = $1`,
      [workspaceId],
    ),
    query(
      `SELECT u.id, u.name, u.email, m.role, m.created_at AS joined_at
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = $1
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                m.created_at ASC`,
      [workspaceId],
    ),
  ]);

  const user = userResult.rows[0];
  const workspace = workspaceResult.rows[0];
  if (!user || !workspace) return null;
  const passwordChangedAt = user.password_changed_at &&
    Number.isFinite(new Date(user.password_changed_at).getTime()) &&
    new Date(user.password_changed_at).getTime() > 0
    ? user.password_changed_at
    : null;

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      workspaceId: user.workspace_id,
      workspaceName: user.workspace_name,
      role: user.role,
    },
    workspace: {
      id: workspace.id,
      name: workspace.name,
      createdAt: workspace.created_at,
      memberCount: Number(workspace.member_count),
      agentCount: Number(workspace.agent_count),
    },
    members: membersResult.rows.map(mapWorkspaceMember),
    security: {
      passwordChangedAt,
      emailVerified: Boolean(user.email_verified_at),
      mfaEnabled: Boolean(user.mfa_enabled),
      sessionDurationDays: 30,
      accessTokenDurationDays: 7,
      sessionStorage: "httpOnly_cookie",
    },
  };
}

export async function updateUserProfile({ userId, name }) {
  await query(
    `UPDATE users
     SET name = $2, updated_at = NOW()
     WHERE id = $1`,
    [userId, name],
  );
  return findUserById(userId);
}

export async function updateWorkspaceName({ workspaceId, name }) {
  await query(
    `UPDATE workspaces
     SET name = $2
     WHERE id = $1`,
    [workspaceId, name],
  );
}

export async function deleteWorkspace({ workspaceId }) {
  const result = await query(
    "DELETE FROM workspaces WHERE id=$1 RETURNING id",
    [workspaceId],
  );
  return Boolean(result.rowCount);
}

export async function updateUserPassword({ userId, passwordHash }) {
  await query(
    `UPDATE users
     SET password_hash = $2, password_changed_at = NOW(),
         session_version = session_version + 1, updated_at = NOW()
     WHERE id = $1`,
    [userId, passwordHash],
  );
  return findUserById(userId);
}

export async function createAuthActionToken({ id, userId, purpose, tokenHash, expiresAt }) {
  await query(
    `INSERT INTO auth_action_tokens (id, user_id, purpose, token_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, userId, purpose, tokenHash, expiresAt],
  );
}

export async function getAuthActionToken({ tokenHash, purpose }) {
  const result = await query(
    `SELECT t.*, u.email, u.name
     FROM auth_action_tokens t JOIN users u ON u.id=t.user_id
     WHERE t.token_hash=$1 AND t.purpose=$2 AND t.consumed_at IS NULL AND t.expires_at > NOW()`,
    [tokenHash, purpose],
  );
  return result.rows[0] ?? null;
}

export async function consumeAuthActionToken({ tokenHash, purpose }) {
  const result = await query(
    `UPDATE auth_action_tokens SET consumed_at=NOW()
     WHERE token_hash=$1 AND purpose=$2 AND consumed_at IS NULL AND expires_at > NOW()
     RETURNING user_id`,
    [tokenHash, purpose],
  );
  return result.rows[0]?.user_id ?? null;
}

export async function markEmailVerified(userId) {
  const result = await query(
    `UPDATE users SET email_verified_at=COALESCE(email_verified_at, NOW()), updated_at=NOW()
     WHERE id=$1 RETURNING id, email_verified_at`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function updateUserMfa({ userId, enabled, encryptedSecret = null }) {
  const result = await query(
    `UPDATE users SET mfa_enabled=$2, encrypted_mfa_secret=$3, updated_at=NOW()
     WHERE id=$1 RETURNING id, mfa_enabled`,
    [userId, enabled, encryptedSecret],
  );
  return result.rows[0] ?? null;
}

export async function registerUser({
  email,
  name,
  passwordHash,
  workspaceName,
  emailVerified = false,
}) {
  return withTransaction(async (client) => {
    const existing = await client.query(
      "SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)",
      [email],
    );
    if (existing.rowCount > 0) {
      const error = new Error("An account with this email already exists.");
      error.code = "EMAIL_EXISTS";
      throw error;
    }

    const userId = `user-${randomUUID()}`;
    const workspaceId = `workspace-${randomUUID()}`;
    await client.query(
      "INSERT INTO users (id, email, name, password_hash, email_verified_at) VALUES ($1, $2, $3, $4, $5)",
      [userId, email.toLowerCase(), name, passwordHash, emailVerified ? new Date() : null],
    );
    await client.query("INSERT INTO workspaces (id, name) VALUES ($1, $2)", [
      workspaceId,
      workspaceName,
    ]);
    await client.query(
      "INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')",
      [userId, workspaceId],
    );
    const policyId = `policy-${randomUUID()}`;
    await client.query(
      "INSERT INTO policies (id, workspace_id, name) VALUES ($1, $2, $3)",
      [policyId, workspaceId, "Storefront refunds"],
    );
    await client.query(
      `INSERT INTO policy_revisions
       (id, policy_id, workspace_id, version, name, max_amount, max_age_days, currency, enforcement)
       SELECT 'policy-revision-' || id || '-1', id, workspace_id, version, name, max_amount, max_age_days, currency, enforcement
       FROM policies WHERE id=$1
       ON CONFLICT (policy_id, version) DO NOTHING`,
      [policyId],
    );
    const { start, end } = billingPeriodBounds();
    await client.query(
      `INSERT INTO workspace_subscriptions
         (id, workspace_id, plan_id, status, billing_provider, current_period_start, current_period_end)
       VALUES ($1,$2,'free','active','internal',$3,$4)`,
      [`subscription-${workspaceId}`, workspaceId, start, end],
    );
    await client.query(
      `INSERT INTO usage_periods
         (id, workspace_id, subscription_id, period_start, period_end)
       VALUES ($1,$2,$3,$4,$5)`,
      [`usage-${workspaceId}-${start.toISOString().slice(0, 7).replace("-", "")}`, workspaceId, `subscription-${workspaceId}`, start, end],
    );

    return {
      id: userId,
      email: email.toLowerCase(),
      name,
      workspaceId,
      workspaceName,
      role: "owner",
      sessionVersion: 0,
    };
  });
}

export async function listAgents(workspaceId) {
  const result = await query(
    `${agentSelect} WHERE a.workspace_id = $1 GROUP BY a.id ORDER BY a.created_at DESC`,
    [workspaceId],
  );
  return result.rows.map(mapAgent);
}

export async function recordAuditEvent({
  workspaceId,
  actorUserId = null,
  actorType = "user",
  action,
  resourceType = null,
  resourceId = null,
  requestId = null,
  ipAddress = null,
  metadata = {},
}) {
  if (!workspaceId || !action) return null;
  const result = await query(
    `INSERT INTO audit_events
       (id, workspace_id, actor_user_id, actor_type, action, resource_type, resource_id, request_id, ip_address, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      `audit-${randomUUID()}`,
      workspaceId,
      actorUserId,
      actorType,
      action,
      resourceType,
      resourceId,
      requestId,
      ipAddress,
      JSON.stringify(metadata ?? {}),
    ],
  );
  return mapAuditEvent(result.rows[0]);
}

export async function listAuditEvents({ workspaceId, limit = 100 }) {
  const safeLimit = Math.min(250, Math.max(1, Number(limit) || 100));
  const result = await query(
    `SELECT e.*, u.name AS actor_name, u.email AS actor_email
     FROM audit_events e
     LEFT JOIN users u ON u.id=e.actor_user_id
     WHERE e.workspace_id=$1
     ORDER BY e.created_at DESC
     LIMIT $2`,
    [workspaceId, safeLimit],
  );
  return result.rows.map(mapAuditEvent);
}

export async function listIncidents({ workspaceId, status = "open", limit = 50 }) {
  const safeStatus = ["open", "resolved", "all"].includes(status) ? status : "open";
  const result = await query(
    `SELECT n.*, a.name AS agent_name
     FROM incident_notifications n
     LEFT JOIN agents a ON a.id=n.agent_id
     WHERE n.workspace_id=$1 AND ($2='all' OR n.status=$2)
     ORDER BY n.created_at DESC LIMIT $3`,
    [workspaceId, safeStatus, Math.min(100, Math.max(1, Number(limit) || 50))],
  );
  return result.rows.map(mapIncident);
}

export async function getIncidentSummary(workspaceId) {
  const [counts, incidents] = await Promise.all([
    query(
      `SELECT
         COUNT(*) FILTER (WHERE status='open')::int AS open_count,
         COUNT(*) FILTER (WHERE status='open' AND read_at IS NULL)::int AS unread_count,
         COUNT(*) FILTER (WHERE status='open' AND severity='critical')::int AS critical_count
       FROM incident_notifications WHERE workspace_id=$1`,
      [workspaceId],
    ),
    listIncidents({ workspaceId, status: "open", limit: 12 }),
  ]);
  const row = counts.rows[0] ?? {};
  return {
    summary: {
      open: Number(row.open_count ?? 0),
      unread: Number(row.unread_count ?? 0),
      critical: Number(row.critical_count ?? 0),
    },
    incidents,
  };
}

export async function markIncidentRead({ workspaceId, incidentId }) {
  const result = await query(
    `UPDATE incident_notifications SET read_at=COALESCE(read_at, NOW())
     WHERE id=$1 AND workspace_id=$2 RETURNING id`,
    [incidentId, workspaceId],
  );
  return Boolean(result.rowCount);
}

export async function resolveIncident({ workspaceId, incidentId }) {
  const result = await query(
    `UPDATE incident_notifications
     SET status='resolved', resolved_at=COALESCE(resolved_at, NOW()), read_at=COALESCE(read_at, NOW())
     WHERE id=$1 AND workspace_id=$2 AND status='open'
     RETURNING id`,
    [incidentId, workspaceId],
  );
  return Boolean(result.rowCount);
}

export async function resolveIncidentsForAgent({ workspaceId, agentId, eventType }) {
  const result = await query(
    `UPDATE incident_notifications
     SET status='resolved', resolved_at=COALESCE(resolved_at, NOW()), read_at=COALESCE(read_at, NOW())
     WHERE workspace_id=$1 AND agent_id=$2 AND event_type=$3 AND status='open'
     RETURNING id`,
    [workspaceId, agentId, eventType],
  );
  return result.rowCount;
}

export async function listAlertWebhooks(workspaceId) {
  const result = await query(
    `SELECT * FROM alert_webhooks WHERE workspace_id=$1 ORDER BY created_at DESC`,
    [workspaceId],
  );
  return result.rows.map(mapAlertWebhook);
}

export async function createAlertWebhook({ workspaceId, name, url, secret, eventTypes }) {
  const result = await query(
    `INSERT INTO alert_webhooks (id, workspace_id, name, encrypted_url, encrypted_secret, event_types)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [
      `webhook-${randomUUID()}`,
      workspaceId,
      name,
      encryptSecret(url),
      encryptSecret(secret),
      JSON.stringify(eventTypes?.length ? eventTypes : ["*"]),
    ],
  );
  return mapAlertWebhook(result.rows[0]);
}

export async function getAlertWebhook({ workspaceId, webhookId }) {
  const result = await query(
    `SELECT * FROM alert_webhooks WHERE id=$1 AND workspace_id=$2`,
    [webhookId, workspaceId],
  );
  const row = result.rows[0];
  return row
    ? { ...row, url: decryptSecret(row.encrypted_url), secret: decryptSecret(row.encrypted_secret) }
    : null;
}

export async function updateAlertWebhook({ workspaceId, webhookId, name, enabled, eventTypes }) {
  const result = await query(
    `UPDATE alert_webhooks
     SET name=$3, enabled=$4, event_types=$5, updated_at=NOW()
     WHERE id=$1 AND workspace_id=$2 RETURNING *`,
    [webhookId, workspaceId, name, enabled, JSON.stringify(eventTypes?.length ? eventTypes : ["*"])],
  );
  return mapAlertWebhook(result.rows[0]);
}

export async function deleteAlertWebhook({ workspaceId, webhookId }) {
  const result = await query(
    `DELETE FROM alert_webhooks WHERE id=$1 AND workspace_id=$2 RETURNING id`,
    [webhookId, workspaceId],
  );
  return Boolean(result.rowCount);
}

export async function claimNextIncidentDelivery() {
  return withTransaction(async (client) => {
    const result = await client.query(
      `SELECT d.*, w.encrypted_url, w.encrypted_secret,
              n.agent_id, n.event_type, n.severity, n.title, n.message,
              n.resource_type, n.resource_id, n.metadata, n.created_at,
              a.name AS agent_name
       FROM incident_webhook_deliveries d
       JOIN alert_webhooks w ON w.id=d.webhook_id AND w.enabled=TRUE
       JOIN incident_notifications n ON n.id=d.notification_id
       LEFT JOIN agents a ON a.id=n.agent_id
       WHERE (d.status='pending' AND d.next_attempt_at <= NOW())
          OR (d.status='processing' AND d.locked_at < NOW() - INTERVAL '5 minutes')
       ORDER BY d.next_attempt_at ASC
       FOR UPDATE OF d SKIP LOCKED LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row) return null;
    const updated = await client.query(
      `UPDATE incident_webhook_deliveries
       SET status='processing', locked_at=NOW(), attempts=attempts+1
       WHERE id=$1 RETURNING attempts`,
      [row.id],
    );
    return { ...row, attempts: updated.rows[0].attempts };
  });
}

export async function completeIncidentDelivery({ deliveryId, webhookId }) {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE incident_webhook_deliveries
       SET status='delivered', delivered_at=NOW(), locked_at=NULL, last_error=NULL
       WHERE id=$1`,
      [deliveryId],
    );
    await client.query(
      `UPDATE alert_webhooks
       SET failure_count=0, last_error=NULL, last_delivered_at=NOW(), updated_at=NOW()
       WHERE id=$1`,
      [webhookId],
    );
  });
}

export async function failIncidentDelivery({ deliveryId, webhookId, attempts, error }) {
  const permanentlyFailed = attempts >= 5;
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE incident_webhook_deliveries
       SET status=$2, next_attempt_at=NOW() + ($3::double precision * INTERVAL '1 millisecond'),
           locked_at=NULL, last_error=$4
       WHERE id=$1`,
      [deliveryId, permanentlyFailed ? "failed" : "pending", permanentlyFailed ? 0 : retryDelayMs(attempts), String(error).slice(0, 500)],
    );
    await client.query(
      `UPDATE alert_webhooks
       SET failure_count=failure_count+1, last_error=$2, updated_at=NOW()
       WHERE id=$1`,
      [webhookId, String(error).slice(0, 500)],
    );
  });
}

export async function getAgent(agentId, workspaceId) {
  const result = await query(
    `${agentSelect} WHERE a.id = $1 AND a.workspace_id = $2 GROUP BY a.id`,
    [agentId, workspaceId],
  );
  return mapAgent(result.rows[0]);
}

function mapSecurityContract(row) {
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    version: Number(row.version),
    status: row.status,
    allowedToolIds: row.allowed_tool_ids ?? [],
    maxRefundAmount: Number(row.max_refund_amount),
    maxOrderAgeDays: Number(row.max_order_age_days),
    notes: row.notes ?? "",
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getSecurityContract({ workspaceId, agentId }) {
  const [agent, currentPolicy, result] = await Promise.all([
    getAgent(agentId, workspaceId),
    getPolicy(workspaceId),
    query(
      `SELECT * FROM agent_security_contracts
       WHERE workspace_id=$1 AND agent_id=$2 AND status='active'`,
      [workspaceId, agentId],
    ),
  ]);
  if (!agent) return null;
  return result.rows[0]
    ? mapSecurityContract(result.rows[0])
    : {
        agentId,
        ...defaultSecurityContract({ agentToolIds: agent.tools, policy: currentPolicy }),
        createdBy: null,
        createdAt: null,
        updatedAt: null,
      };
}

async function getSecurityContractVersion({ workspaceId, agentId, version }) {
  const result = await query(
    `SELECT id, agent_id, version, 'historical' AS status, allowed_tool_ids,
            max_refund_amount, max_order_age_days, notes, created_by, created_at,
            created_at AS updated_at
     FROM agent_security_contract_versions
     WHERE workspace_id=$1 AND agent_id=$2 AND version=$3`,
    [workspaceId, agentId, version],
  );
  return mapSecurityContract(result.rows[0]);
}

export async function getSecurityContractComparison({ workspaceId, agentId }) {
  const [current, historyResult, agent, currentPolicy] = await Promise.all([
    getSecurityContract({ workspaceId, agentId }),
    query(
      `SELECT id, agent_id, version, 'historical' AS status, allowed_tool_ids,
              max_refund_amount, max_order_age_days, notes, created_by, created_at,
              created_at AS updated_at
       FROM agent_security_contract_versions
       WHERE workspace_id=$1 AND agent_id=$2
       ORDER BY version DESC
       LIMIT 20`,
      [workspaceId, agentId],
    ),
    getAgent(agentId, workspaceId),
    getPolicy(workspaceId),
  ]);
  if (!current) return null;

  const history = historyResult.rows.map(mapSecurityContract);
  const after = history.find((item) => item.version === current.version) ?? current;
  let before = history.find((item) => item.version === current.version - 1) ?? null;
  if (!before && current.version > 0 && agent) {
    before = {
      id: null,
      agentId,
      ...defaultSecurityContract({ agentToolIds: agent.tools, policy: currentPolicy }),
      createdBy: null,
      createdAt: null,
      updatedAt: null,
    };
  }
  const scanRows = await query(
    `SELECT DISTINCT ON (contract_version) id, contract_version
     FROM scans
     WHERE workspace_id=$1 AND agent_id=$2 AND status='completed'
       AND contract_version = ANY($3::int[])
     ORDER BY contract_version, created_at DESC`,
    [workspaceId, agentId, [before?.version, after?.version].filter((version) => Number.isInteger(version))],
  );
  const scanIds = new Map(scanRows.rows.map((row) => [Number(row.contract_version), row.id]));
  const [beforeScan, afterScan] = await Promise.all([
    before?.version != null && scanIds.has(before.version) ? getScan(scanIds.get(before.version), workspaceId) : null,
    after?.version != null && scanIds.has(after.version) ? getScan(scanIds.get(after.version), workspaceId) : null,
  ]);

  return {
    agentId,
    fromVersion: before?.version ?? null,
    toVersion: after?.version ?? null,
    before,
    after,
    contractDiff: compareSecurityContracts(before, after),
    evidence: compareScanEvidence(beforeScan, afterScan),
    history: history.map((item) => ({
      version: item.version,
      createdAt: item.createdAt,
      hasScan: scanIds.has(item.version),
    })),
  };
}

export async function updateSecurityContract({ workspaceId, agentId, userId, contract }) {
  const saved = await withTransaction(async (client) => {
    const agentResult = await client.query(
      `SELECT a.id, a.workspace_id
       FROM agents a
       WHERE a.id=$1 AND a.workspace_id=$2
       FOR UPDATE`,
      [agentId, workspaceId],
    );
    if (!agentResult.rowCount) return null;
    const toolResult = await client.query(
      "SELECT COALESCE(array_agg(tool_id), '{}') AS tools FROM agent_tools WHERE agent_id=$1",
      [agentId],
    );
    const currentPolicyResult = await client.query(
      "SELECT max_amount, max_age_days FROM policies WHERE workspace_id=$1 ORDER BY created_at LIMIT 1",
      [workspaceId],
    );
    const currentPolicy = currentPolicyResult.rows[0] ?? { max_amount: 50, max_age_days: 14 };
    const normalized = normalizeSecurityContract(contract, {
      agentToolIds: toolResult.rows[0].tools,
      policy: {
        maxAmount: Number(currentPolicy.max_amount),
        maxAgeDays: Number(currentPolicy.max_age_days),
      },
    });
    const existing = await client.query(
      "SELECT version FROM agent_security_contracts WHERE agent_id=$1 FOR UPDATE",
      [agentId],
    );
    const version = Number(existing.rows[0]?.version ?? 0) + 1;
    const id = existing.rowCount ? undefined : `contract-${randomUUID()}`;
    await client.query(
      `INSERT INTO agent_security_contracts
       (id, workspace_id, agent_id, version, status, allowed_tool_ids, max_refund_amount, max_order_age_days, notes, created_by)
       VALUES (COALESCE($1, 'contract-' || $3), $2, $3, $4, 'active', $5::jsonb, $6, $7, $8, $9)
       ON CONFLICT (agent_id) DO UPDATE SET
         version=EXCLUDED.version,
         status='active',
         allowed_tool_ids=EXCLUDED.allowed_tool_ids,
         max_refund_amount=EXCLUDED.max_refund_amount,
         max_order_age_days=EXCLUDED.max_order_age_days,
         notes=EXCLUDED.notes,
         created_by=EXCLUDED.created_by,
         updated_at=NOW()`,
      [
        id,
        workspaceId,
        agentId,
        version,
        JSON.stringify(normalized.allowedToolIds),
        normalized.maxRefundAmount,
        normalized.maxOrderAgeDays,
        normalized.notes,
        userId,
      ],
    );
    await client.query(
      `INSERT INTO agent_security_contract_versions
       (id, workspace_id, agent_id, version, allowed_tool_ids, max_refund_amount, max_order_age_days, notes, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)
       ON CONFLICT (agent_id, version) DO NOTHING`,
      [
        `contract-version-${agentId}-${version}`,
        workspaceId,
        agentId,
        version,
        JSON.stringify(normalized.allowedToolIds),
        normalized.maxRefundAmount,
        normalized.maxOrderAgeDays,
        normalized.notes,
        userId,
      ],
    );
    return version;
  });
  if (saved === null) return null;
  return getSecurityContract({ workspaceId, agentId });
}

function mapSentinelBaseline(row) {
  if (!row) return null;
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    snapshot: row.snapshot,
    source: row.source,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function mapSentinelEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    baselineId: row.baseline_id,
    fingerprint: row.current_fingerprint,
    severity: row.severity,
    status: row.status,
    changes: row.changes ?? [],
    detectedAt: row.detected_at,
    resolvedAt: row.resolved_at,
  };
}

async function getSentinelSnapshot({ workspaceId, agentId }) {
  const agent = await getAgent(agentId, workspaceId);
  if (!agent) return null;
  const currentPolicy = await getPolicy(workspaceId);
  const snapshot = buildSentinelSnapshot({
    agent,
    policy: currentPolicy,
    tools: toolDetails(agent.tools),
  });
  return {
    agent,
    policy: currentPolicy,
    snapshot,
    fingerprint: fingerprintSentinelSnapshot(snapshot),
  };
}

export async function getSentinelAgentState({ workspaceId, agentId }) {
  const current = await getSentinelSnapshot({ workspaceId, agentId });
  if (!current) return null;

  const [baselineResult, eventResult] = await Promise.all([
    query(
      `SELECT * FROM sentinel_baselines
       WHERE workspace_id=$1 AND agent_id=$2 AND superseded_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [workspaceId, agentId],
    ),
    query(
      `SELECT * FROM sentinel_drift_events
       WHERE workspace_id=$1 AND agent_id=$2 AND status='open'
       ORDER BY detected_at DESC LIMIT 1`,
      [workspaceId, agentId],
    ),
  ]);

  const baseline = mapSentinelBaseline(baselineResult.rows[0]);
  const drift = baseline
    ? compareSentinelSnapshots(baseline.snapshot, current.snapshot)
    : { drifted: false, severity: "none", changes: [] };

  return {
    agentId: current.agent.id,
    agentName: current.agent.name,
    agentStatus: current.agent.status,
    status: sentinelStatus({ baseline, drift, enabled: current.agent.sentinelEnabled }),
    severity: drift.severity,
    baseline: baseline
      ? {
          id: baseline.id,
          fingerprint: baseline.fingerprint,
          source: baseline.source,
          createdAt: baseline.createdAt,
          createdBy: baseline.createdBy,
        }
      : null,
    currentFingerprint: current.fingerprint,
    changes: drift.changes,
    lastCheckedAt: current.agent.sentinelLastCheckedAt ?? null,
    settings: {
      enabled: current.agent.sentinelEnabled,
      autoQuarantine: current.agent.sentinelAutoQuarantine,
    },
    openEvent: mapSentinelEvent(eventResult.rows[0]),
  };
}

export async function getSentinelOverview(workspaceId) {
  const agents = await listAgents(workspaceId);
  const states = await Promise.all(
    agents.map((agent) => getSentinelAgentState({ workspaceId, agentId: agent.id })),
  );
  const summary = states.reduce(
    (result, state) => {
      if (!state) return result;
      result.totalAgents += 1;
      result[state.status] += 1;
      if (state.openEvent) result.openDrifts += 1;
      return result;
    },
    { totalAgents: 0, protected: 0, drifted: 0, unbaselined: 0, disabled: 0, openDrifts: 0 },
  );
  return { summary, agents: states.filter(Boolean) };
}

export async function listSentinelTargets() {
  const result = await query(
    `SELECT id, workspace_id FROM agents
     WHERE sentinel_enabled=TRUE
     ORDER BY workspace_id, created_at`,
  );
  return result.rows.map((row) => ({ agentId: row.id, workspaceId: row.workspace_id }));
}

export async function createSentinelBaseline({ workspaceId, agentId, userId, source = "manual" }) {
  const current = await getSentinelSnapshot({ workspaceId, agentId });
  if (!current) return null;

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE sentinel_baselines SET superseded_at=NOW()
       WHERE workspace_id=$1 AND agent_id=$2 AND superseded_at IS NULL`,
      [workspaceId, agentId],
    );
    await client.query(
      `INSERT INTO sentinel_baselines
       (id, workspace_id, agent_id, created_by, fingerprint, snapshot, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        `sentinel-baseline-${randomUUID()}`,
        workspaceId,
        agentId,
        userId,
        current.fingerprint,
        JSON.stringify(current.snapshot),
        source,
      ],
    );
    await client.query(
      `UPDATE sentinel_drift_events
       SET status='resolved', resolved_at=NOW(), resolved_by=$3
       WHERE workspace_id=$1 AND agent_id=$2 AND status='open'`,
      [workspaceId, agentId, userId],
    );
    await client.query(
      `UPDATE agents SET sentinel_last_checked_at=NOW()
       WHERE id=$1 AND workspace_id=$2`,
      [agentId, workspaceId],
    );
  });

  await resolveIncidentsForAgent({ workspaceId, agentId, eventType: "sentinel_drift" });
  return getSentinelAgentState({ workspaceId, agentId });
}

export async function checkSentinel({ workspaceId, agentId }) {
  const current = await getSentinelSnapshot({ workspaceId, agentId });
  if (!current) return null;

  await withTransaction(async (client) => {
    const baselineResult = await client.query(
      `SELECT * FROM sentinel_baselines
       WHERE workspace_id=$1 AND agent_id=$2 AND superseded_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [workspaceId, agentId],
    );
    const baseline = mapSentinelBaseline(baselineResult.rows[0]);
    if (!current.agent.sentinelEnabled) return;
    const drift = baseline
      ? compareSentinelSnapshots(baseline.snapshot, current.snapshot)
      : { drifted: false, severity: "none", changes: [] };

    await client.query(
      `UPDATE agents SET sentinel_last_checked_at=NOW()
       WHERE id=$1 AND workspace_id=$2`,
      [agentId, workspaceId],
    );

    if (!baseline || !drift.drifted) {
      await client.query(
        `UPDATE sentinel_drift_events
         SET status='resolved', resolved_at=NOW()
         WHERE workspace_id=$1 AND agent_id=$2 AND status='open'`,
        [workspaceId, agentId],
      );
      return;
    }

    await client.query(
      `INSERT INTO sentinel_drift_events
       (id, workspace_id, agent_id, baseline_id, current_fingerprint, severity, changes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (agent_id, current_fingerprint) WHERE status='open'
       DO UPDATE SET severity=EXCLUDED.severity, changes=EXCLUDED.changes, detected_at=NOW()`,
      [
        `sentinel-event-${randomUUID()}`,
        workspaceId,
        agentId,
        baseline.id,
        current.fingerprint,
        drift.severity,
        JSON.stringify(drift.changes),
      ],
    );

    if (
      current.agent.sentinelAutoQuarantine &&
      drift.severity === "critical" &&
      current.agent.status !== "quarantined"
    ) {
      await client.query(
        `UPDATE agents
         SET status='quarantined', quarantined_at=NOW(),
             quarantine_reason='Sentinel detected critical security drift.'
         WHERE id=$1 AND workspace_id=$2 AND status <> 'quarantined'`,
        [agentId, workspaceId],
      );
    }
  });

  const state = await getSentinelAgentState({ workspaceId, agentId });
  if (!state || !current.agent.sentinelEnabled) return state;

  if (!state.baseline || !state.changes.length) {
    await resolveIncidentsForAgent({ workspaceId, agentId, eventType: "sentinel_drift" });
    return state;
  }

  await createIncidentNotification({
    workspaceId,
    agentId,
    agentName: state.agentName,
    eventType: "sentinel_drift",
    severity: state.severity === "none" ? "medium" : state.severity,
    message: `${state.changes.length} approved security surface change${state.changes.length === 1 ? "" : "s"} detected. Review the evidence before trusting this agent again.`,
    dedupeKey: `sentinel:${agentId}`,
    resourceType: "sentinel_event",
    resourceId: state.openEvent?.id ?? null,
    metadata: { fingerprint: state.currentFingerprint, changes: state.changes.slice(0, 10) },
  });

  if (state.agentStatus === "quarantined" && current.agent.status !== "quarantined") {
    await createIncidentNotification({
      workspaceId,
      agentId,
      agentName: state.agentName,
      eventType: "agent_quarantined",
      severity: "critical",
      message: "Sentinel automatically quarantined this agent after detecting critical security drift.",
      dedupeKey: `quarantine:${agentId}`,
      resourceType: "sentinel_event",
      resourceId: state.openEvent?.id ?? null,
      metadata: { reason: "critical_sentinel_drift", fingerprint: state.currentFingerprint },
    });
  }

  return state;
}

export async function updateSentinelSettings({ workspaceId, agentId, enabled, autoQuarantine }) {
  const result = await query(
    `UPDATE agents
     SET sentinel_enabled=$3, sentinel_auto_quarantine=$4
     WHERE id=$1 AND workspace_id=$2
     RETURNING id`,
    [agentId, workspaceId, enabled, autoQuarantine],
  );
  if (!result.rowCount) return null;
  return getSentinelAgentState({ workspaceId, agentId });
}

export async function getAgentSecret(agentId, workspaceId) {
  const result = await query(
    "SELECT encrypted_api_key FROM agents WHERE id=$1 AND workspace_id=$2",
    [agentId, workspaceId],
  );
  return result.rows[0]?.encrypted_api_key ?? null;
}

export async function getRuntimeAgentByToken(tokenHash) {
  const result = await query(
    `${agentSelect} WHERE a.runtime_token_hash = $1 GROUP BY a.id`,
    [tokenHash],
  );
  const agent = mapAgent(result.rows[0]);
  return agent ? { ...agent, workspaceId: result.rows[0].workspace_id } : null;
}

export async function getRuntimeAgentSecret(agentId) {
  const result = await query(
    "SELECT encrypted_api_key FROM agents WHERE id=$1 AND runtime_enabled=TRUE",
    [agentId],
  );
  return result.rows[0]?.encrypted_api_key ?? null;
}

export async function enableRuntimeFirewall({ workspaceId, agentId, tokenHash }) {
  const result = await query(
    `UPDATE agents
     SET runtime_enabled=TRUE, runtime_token_hash=$3, runtime_blocked_count=0, runtime_last_event_at=NULL
     WHERE id=$1 AND workspace_id=$2
     RETURNING id`,
    [agentId, workspaceId, tokenHash],
  );
  return Boolean(result.rowCount);
}

export async function disableRuntimeFirewall({ workspaceId, agentId }) {
  const result = await query(
    `UPDATE agents
     SET runtime_enabled=FALSE, runtime_token_hash=NULL
     WHERE id=$1 AND workspace_id=$2
     RETURNING id`,
    [agentId, workspaceId],
  );
  return Boolean(result.rowCount);
}

export async function listRuntimeEvents({ workspaceId, agentId, limit = 20 }) {
  const result = await query(
    `SELECT id, request_id, decision, tool_name, reasons, latency_ms,
            outcome, error_code, failure_stage, created_at
     FROM runtime_events
     WHERE workspace_id=$1 AND agent_id=$2
     ORDER BY created_at DESC
     LIMIT $3`,
    [workspaceId, agentId, limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    requestId: row.request_id,
    decision: row.decision,
    toolName: row.tool_name,
    reasons: row.reasons ?? [],
    latencyMs: row.latency_ms,
    outcome: row.outcome ?? "decision",
    errorCode: row.error_code,
    failureStage: row.failure_stage,
    createdAt: row.created_at,
  }));
}

export async function getRuntimeHealth({ workspaceId, agentId, windowHours }) {
  const result = await query(
    `SELECT
       COUNT(*) FILTER (WHERE outcome IN ('decision', 'error'))::int AS sample_count,
       COUNT(*) FILTER (WHERE outcome = 'decision')::int AS decision_count,
       COUNT(*) FILTER (WHERE outcome = 'decision' AND decision = 'ALLOW')::int AS allow_count,
       COUNT(*) FILTER (WHERE outcome = 'decision' AND decision = 'BLOCK')::int AS block_count,
       COUNT(*) FILTER (WHERE outcome = 'error')::int AS error_count,
       COUNT(*) FILTER (WHERE outcome = 'quota')::int AS quota_rejected_count,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)
         FILTER (WHERE outcome IN ('decision', 'error')) AS p50_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
         FILTER (WHERE outcome IN ('decision', 'error')) AS p95_ms,
       MAX(created_at) AS last_event_at,
       MAX(created_at) FILTER (WHERE outcome = 'decision') AS last_decision_at,
       MAX(created_at) FILTER (WHERE outcome = 'error') AS last_error_at
     FROM runtime_events
     WHERE workspace_id=$1 AND agent_id=$2
       AND created_at >= NOW() - ($3::int * INTERVAL '1 hour')`,
    [workspaceId, agentId, windowHours],
  );
  const row = result.rows[0] ?? {};
  const issueResult = await query(
    `SELECT outcome, error_code, failure_stage, latency_ms, created_at
     FROM runtime_events
     WHERE workspace_id=$1 AND agent_id=$2
       AND created_at >= NOW() - ($3::int * INTERVAL '1 hour')
       AND outcome IN ('error', 'quota')
     ORDER BY created_at DESC
     LIMIT 8`,
    [workspaceId, agentId, windowHours],
  );
  const count = (value) => Number(value ?? 0);
  return {
    sampleCount: count(row.sample_count),
    decisionCount: count(row.decision_count),
    allowCount: count(row.allow_count),
    blockCount: count(row.block_count),
    errorCount: count(row.error_count),
    quotaRejectedCount: count(row.quota_rejected_count),
    p50Ms: row.p50_ms === null ? null : Math.round(Number(row.p50_ms)),
    p95Ms: row.p95_ms === null ? null : Math.round(Number(row.p95_ms)),
    lastEventAt: row.last_event_at,
    lastDecisionAt: row.last_decision_at,
    lastErrorAt: row.last_error_at,
    recentIssues: issueResult.rows.map((issue) => ({
      outcome: issue.outcome,
      errorCode: issue.error_code,
      failureStage: issue.failure_stage,
      latencyMs: issue.latency_ms,
      createdAt: issue.created_at,
    })),
  };
}

export async function recordRuntimeEvent({
  workspaceId,
  agentId,
  requestId,
  decision,
  toolName,
  reasons,
  latencyMs,
  outcome = "decision",
  errorCode = null,
  failureStage = null,
}) {
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO runtime_events
       (id, workspace_id, agent_id, request_id, decision, tool_name, reasons,
        latency_ms, outcome, error_code, failure_stage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        `runtime-${randomUUID()}`,
        workspaceId,
        agentId,
        requestId,
        decision,
        toolName,
        JSON.stringify(reasons ?? []),
        latencyMs,
        outcome,
        errorCode,
        failureStage,
      ],
    );
    await client.query(
      `UPDATE agents
       SET runtime_last_event_at=NOW(), runtime_blocked_count=runtime_blocked_count+$3
       WHERE id=$1 AND workspace_id=$2`,
      [agentId, workspaceId, outcome === "decision" && decision === "BLOCK" ? 1 : 0],
    );
  });

  if (outcome === "decision" && decision === "BLOCK") {
    const agentResult = await query(
      "SELECT name FROM agents WHERE id=$1 AND workspace_id=$2",
      [agentId, workspaceId],
    );
    await createIncidentNotification({
      workspaceId,
      agentId,
      agentName: agentResult.rows[0]?.name,
      eventType: "runtime_block",
      severity: "high",
      message: `${toolName} was blocked by Runtime Firewall. Review the reasons before allowing this action.`,
      dedupeKey: `runtime:${agentId}:${toolName}`,
      resourceType: "runtime_event",
      resourceId: requestId,
      metadata: { toolName, reasons: reasons ?? [], latencyMs },
    });
  }
}

export async function createRuntimeApproval({
  id,
  workspaceId,
  agentId,
  requestId,
  toolName,
  payload,
  signature,
  expiresAt,
}) {
  const result = await query(
    `INSERT INTO runtime_approvals
       (id, workspace_id, agent_id, request_id, tool_name, payload, signature, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
     RETURNING id, workspace_id, agent_id, request_id, tool_name, payload, signature, expires_at, consumed_at`,
    [id, workspaceId, agentId, requestId, toolName, JSON.stringify(payload), signature, expiresAt],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        workspaceId: row.workspace_id,
        agentId: row.agent_id,
        requestId: row.request_id,
        toolName: row.tool_name,
        payload: row.payload,
        signature: row.signature,
        expiresAt: row.expires_at,
        consumedAt: row.consumed_at,
      }
    : null;
}

export async function getRuntimeApproval({ workspaceId, agentId, approvalId }) {
  const result = await query(
    `SELECT id, workspace_id, agent_id, request_id, tool_name, payload, signature, expires_at, consumed_at
     FROM runtime_approvals
     WHERE id=$1 AND workspace_id=$2 AND agent_id=$3`,
    [approvalId, workspaceId, agentId],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        workspaceId: row.workspace_id,
        agentId: row.agent_id,
        requestId: row.request_id,
        toolName: row.tool_name,
        payload: row.payload,
        signature: row.signature,
        expiresAt: row.expires_at,
        consumedAt: row.consumed_at,
      }
    : null;
}

export async function consumeRuntimeApproval({ workspaceId, agentId, approvalId }) {
  const result = await query(
    `UPDATE runtime_approvals
     SET consumed_at=NOW()
     WHERE id=$1 AND workspace_id=$2 AND agent_id=$3
       AND consumed_at IS NULL AND expires_at > NOW()
     RETURNING id, workspace_id, agent_id, request_id, tool_name, payload, signature, expires_at, consumed_at`,
    [approvalId, workspaceId, agentId],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        workspaceId: row.workspace_id,
        agentId: row.agent_id,
        requestId: row.request_id,
        toolName: row.tool_name,
        payload: row.payload,
        signature: row.signature,
        expiresAt: row.expires_at,
        consumedAt: row.consumed_at,
      }
    : null;
}

function mapRuntimeVerification(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    status: row.status,
    fingerprint: row.fingerprint,
    result: row.result,
    createdAt: row.created_at,
  };
}

export async function saveRuntimeVerification({ id, workspaceId, agentId, status, fingerprint, result }) {
  const saved = await query(
    `INSERT INTO runtime_verification_runs (id, workspace_id, agent_id, status, fingerprint, result)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT (workspace_id, agent_id) DO UPDATE
       SET id=EXCLUDED.id, workspace_id=EXCLUDED.workspace_id, status=EXCLUDED.status,
           fingerprint=EXCLUDED.fingerprint, result=EXCLUDED.result, created_at=NOW()
     RETURNING id, workspace_id, agent_id, status, fingerprint, result, created_at`,
    [id, workspaceId, agentId, status, fingerprint, JSON.stringify(result)],
  );
  return mapRuntimeVerification(saved.rows[0]);
}

export async function getRuntimeVerification({ workspaceId, agentId }) {
  const result = await query(
    `SELECT id, workspace_id, agent_id, status, fingerprint, result, created_at
     FROM runtime_verification_runs WHERE workspace_id=$1 AND agent_id=$2`,
    [workspaceId, agentId],
  );
  return mapRuntimeVerification(result.rows[0]);
}

export async function createAgent({ workspaceId, agent, toolIds }) {
  return withTransaction(async (client) => {
    const billing = await lockBillingState(client, workspaceId);
    if (!billing.active) {
      throw billingError(
        "SUBSCRIPTION_REQUIRED",
        "Your subscription is not active. Renew it before adding an agent.",
      );
    }
    const agentCount = await client.query(
      "SELECT COUNT(*)::int AS count FROM agents WHERE workspace_id=$1",
      [workspaceId],
    );
    const addonBalances = await getAddonBalances(client, workspaceId);
    const maxAgents = billing.plan.maxAgents + addonBalances.agentSlots;
    if (agentCount.rows[0].count >= maxAgents) {
      throw billingError(
        "AGENT_LIMIT_REACHED",
        `${billing.plan.name} allows up to ${maxAgents} agent${maxAgents === 1 ? "" : "s"}. Upgrade your plan or purchase an extra Agent slot.`,
      );
    }
    await client.query(
      `INSERT INTO agents (id, workspace_id, name, description, environment, provider, model, mode, status, endpoint_url, encrypted_api_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        agent.id,
        workspaceId,
        agent.name,
        agent.description,
        agent.environment,
        agent.provider,
        agent.model,
        agent.mode,
        agent.status,
        agent.endpoint,
        agent.encryptedApiKey,
      ],
    );
    for (const toolId of toolIds) {
      await client.query(
        "INSERT INTO agent_tools (id, agent_id, tool_id) VALUES ($1, $2, $3)",
        [`agent-tool-${randomUUID()}`, agent.id, toolId],
      );
    }
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      environment: agent.environment,
      provider: agent.provider,
      model: agent.model,
      mode: agent.mode,
      status: agent.status,
      endpoint: agent.endpoint,
      apiKeyConfigured: Boolean(agent.encryptedApiKey),
      runtimeEnabled: false,
      runtimeBlockedCount: 0,
      runtimeLastEventAt: null,
      lastScan: null,
      score: null,
      tools: toolIds,
    };
  });
}

export async function createQuickstartDemo({ workspaceId }) {
  const existing = await query(
    `SELECT id FROM agents
     WHERE workspace_id=$1 AND mode='demo_simulator'
     ORDER BY created_at ASC LIMIT 1`,
    [workspaceId],
  );
  const agent = existing.rows[0]
    ? await getAgent(existing.rows[0].id, workspaceId)
    : await createAgent({
      workspaceId,
      agent: {
        id: `agent-demo-${randomUUID()}`,
        name: "AgentGuard Security Demo",
        description: "An isolated synthetic agent for the 15-minute security proof.",
        environment: "Sandbox",
        provider: "AgentGuard Safe Simulator",
        model: "agentguard-demo-v1",
        mode: "demo_simulator",
        status: "connected",
        endpoint: null,
        encryptedApiKey: null,
      },
      toolIds: ["get_order", "issue_refund"],
    });

  const active = await query(
    `SELECT id FROM scans
     WHERE workspace_id=$1 AND agent_id=$2 AND trigger='Quickstart demo'
       AND status IN ('queued','running')
     ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, agent.id],
  );
  const scan = active.rows[0]
    ? await getScan(active.rows[0].id, workspaceId)
    : await enqueueScan({
      workspaceId,
      agentId: agent.id,
      trigger: "Quickstart demo",
      scenarioIds: quickstartScenarioIds,
    });
  return { agent, scan, reused: Boolean(existing.rows[0] || active.rows[0]) };
}

export async function updateAgent({ workspaceId, agentId, agent, toolIds, apiKeyMode = "keep" }) {
  return withTransaction(async (client) => {
    const params = [
      agentId,
      workspaceId,
      agent.name,
      agent.provider,
      agent.model,
      agent.environment,
      agent.endpoint,
    ];
    let apiKeyExpression = "encrypted_api_key=encrypted_api_key";
    if (apiKeyMode === "replace") {
      params.push(agent.encryptedApiKey);
      apiKeyExpression = `encrypted_api_key=$${params.length}`;
    } else if (apiKeyMode === "clear") {
      apiKeyExpression = "encrypted_api_key=NULL";
    }
    params.push(agent.status);
    const statusPlaceholder = `$${params.length}`;
    const result = await client.query(
      `UPDATE agents
       SET name=$3, provider=$4, model=$5, environment=$6, endpoint_url=$7, status=${statusPlaceholder}, ${apiKeyExpression}
       WHERE id=$1 AND workspace_id=$2
       RETURNING id`,
      params,
    );
    if (!result.rowCount) return null;

    await client.query("DELETE FROM agent_tools WHERE agent_id=$1", [agentId]);
    for (const toolId of toolIds) {
      await client.query(
        "INSERT INTO agent_tools (id, agent_id, tool_id) VALUES ($1, $2, $3)",
        [`agent-tool-${randomUUID()}`, agentId, toolId],
      );
    }

    const updated = await client.query(
      `${agentSelect} WHERE a.id=$1 AND a.workspace_id=$2 GROUP BY a.id`,
      [agentId, workspaceId],
    );
    return mapAgent(updated.rows[0]);
  });
}

export async function setAgentStatus({ workspaceId, agentId, status }) {
  const result = await query(
    "UPDATE agents SET status=$3 WHERE id=$1 AND workspace_id=$2 RETURNING id",
    [agentId, workspaceId, status],
  );
  return Boolean(result.rowCount);
}

export async function quarantineAgent({ workspaceId, agentId, reason }) {
  const result = await query(
    `UPDATE agents
     SET status='quarantined', quarantined_at=NOW(), quarantine_reason=$3
     WHERE id=$1 AND workspace_id=$2
     RETURNING id`,
    [agentId, workspaceId, reason],
  );
  return Boolean(result.rowCount);
}

export async function restoreAgent({ workspaceId, agentId }) {
  const result = await query(
    `UPDATE agents
     SET status='pending', quarantined_at=NULL, quarantine_reason=NULL
     WHERE id=$1 AND workspace_id=$2 AND status='quarantined'
     RETURNING id`,
    [agentId, workspaceId],
  );
  return Boolean(result.rowCount);
}

export async function deleteAgent(agentId, workspaceId) {
  const result = await query(
    "DELETE FROM agents WHERE id=$1 AND workspace_id=$2 RETURNING id",
    [agentId, workspaceId],
  );
  return Boolean(result.rowCount);
}

function mapAutopilotAssessment(row) {
  if (!row) return null;
  const scanStatus = row.scan_status ?? "queued";
  const status = row.applied_at
    ? "applied"
    : scanStatus === "completed"
      ? "completed"
      : scanStatus === "failed"
        ? "failed"
        : scanStatus === "running"
          ? "running"
          : "queued";
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    scanId: row.scan_id,
    status,
    connection: row.connection ?? {},
    appliedAt: row.applied_at,
    appliedBy: row.applied_by,
    createdAt: row.created_at,
  };
}

export async function createAutopilotAssessment({ workspaceId, agentId, connection }) {
  const existing = await query(
    `SELECT aa.*, a.name AS agent_name, s.status AS scan_status
     FROM autopilot_assessments aa
     JOIN agents a ON a.id=aa.agent_id
     JOIN scans s ON s.id=aa.scan_id
     WHERE aa.workspace_id=$1 AND aa.agent_id=$2 AND s.status IN ('queued','running')
     ORDER BY aa.created_at DESC LIMIT 1`,
    [workspaceId, agentId],
  );
  if (existing.rows[0]) {
    const current = await getAutopilotAssessment(existing.rows[0].id, workspaceId);
    return { assessment: current, reused: true };
  }

  const scan = await enqueueScan({
    workspaceId,
    agentId,
    trigger: "Autopilot assessment",
  });
  const assessmentId = `assessment-${randomUUID()}`;
  await query(
    `INSERT INTO autopilot_assessments
       (id, workspace_id, agent_id, scan_id, connection)
     VALUES ($1,$2,$3,$4,$5)`,
    [assessmentId, workspaceId, agentId, scan.id, JSON.stringify(connection ?? {})],
  );
  return { assessment: await getAutopilotAssessment(assessmentId, workspaceId), reused: false };
}

export async function getAutopilotAssessment(assessmentId, workspaceId) {
  const result = await query(
    `SELECT aa.*, a.name AS agent_name, s.status AS scan_status
     FROM autopilot_assessments aa
     JOIN agents a ON a.id=aa.agent_id
     JOIN scans s ON s.id=aa.scan_id
     WHERE aa.id=$1 AND aa.workspace_id=$2`,
    [assessmentId, workspaceId],
  );
  const assessment = mapAutopilotAssessment(result.rows[0]);
  if (!assessment) return null;
  const [scan, agent, currentPolicy] = await Promise.all([
    getScan(assessment.scanId, workspaceId),
    getAgent(assessment.agentId, workspaceId),
    getPolicy(workspaceId),
  ]);
  const blueprint = scan?.status === "completed"
    ? buildSecurityBlueprint({
        agent,
        scan,
        policy: currentPolicy,
        connection: assessment.connection,
      })
    : null;
  return {
    ...assessment,
    phase: assessmentPhase({ assessment, scan, blueprint }),
    scan,
    blueprint,
    agent: agent
      ? {
          id: agent.id,
          name: agent.name,
          runtimeEnabled: Boolean(agent.runtimeEnabled),
          status: agent.status,
        }
      : null,
  };
}

export async function applyAutopilotProtection({
  assessmentId,
  workspaceId,
  userId,
  tokenHash,
}) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `SELECT aa.id, aa.agent_id, aa.applied_at, s.status AS scan_status,
              a.runtime_enabled, a.status AS agent_status
       FROM autopilot_assessments aa
       JOIN scans s ON s.id=aa.scan_id
       JOIN agents a ON a.id=aa.agent_id
       WHERE aa.id=$1 AND aa.workspace_id=$2
       FOR UPDATE`,
      [assessmentId, workspaceId],
    );
    const row = result.rows[0];
    if (!row) {
      const error = new Error("Assessment not found.");
      error.code = "ASSESSMENT_NOT_FOUND";
      throw error;
    }
    if (row.agent_status === "quarantined") {
      const error = new Error("Restore the agent before applying protection.");
      error.code = "AGENT_QUARANTINED";
      throw error;
    }
    if (row.scan_status !== "completed") {
      const error = new Error("Wait for the assessment to finish before applying protection.");
      error.code = "ASSESSMENT_NOT_READY";
      throw error;
    }

    await client.query(
      `UPDATE agents
       SET runtime_enabled=TRUE,
           runtime_token_hash=COALESCE($3, runtime_token_hash),
           mode='protected'
       WHERE id=$1 AND workspace_id=$2`,
      [row.agent_id, workspaceId, tokenHash ?? null],
    );
    await client.query(
      `UPDATE autopilot_assessments
       SET applied_at=COALESCE(applied_at, NOW()), applied_by=COALESCE(applied_by, $3)
       WHERE id=$1 AND workspace_id=$2`,
      [assessmentId, workspaceId, userId],
    );
    return { agentId: row.agent_id, alreadyApplied: Boolean(row.applied_at || row.runtime_enabled) };
  });
}

export async function getPolicy(workspaceId) {
  const result = await query(
    "SELECT * FROM policies WHERE workspace_id = $1 ORDER BY created_at LIMIT 1",
    [workspaceId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    maxAmount: Number(row.max_amount),
    maxAgeDays: row.max_age_days,
    currency: row.currency,
    enforcement: row.enforcement,
    version: Number(row.version ?? 1),
  };
}

export async function updatePolicy({
  policyId,
  workspaceId,
  name,
  maxAmount,
  maxAgeDays,
  currency,
  changedBy = null,
}) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE policies
       SET name=$3, max_amount=$4, max_age_days=$5, currency=$6, version=version+1
       WHERE id=$1 AND workspace_id=$2
       RETURNING *`,
      [policyId, workspaceId, name, maxAmount, maxAgeDays, currency],
    );
    const row = result.rows[0];
    if (!row) return null;
    await client.query(
      `INSERT INTO policy_revisions
       (id, policy_id, workspace_id, version, name, max_amount, max_age_days, currency, enforcement, changed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (policy_id, version) DO NOTHING`,
      [
        `policy-revision-${row.id}-${row.version}`,
        row.id,
        workspaceId,
        row.version,
        row.name,
        row.max_amount,
        row.max_age_days,
        row.currency,
        row.enforcement,
        changedBy,
      ],
    );
    return {
      id: row.id,
      name: row.name,
      maxAmount: Number(row.max_amount),
      maxAgeDays: row.max_age_days,
      currency: row.currency,
      enforcement: row.enforcement,
      version: Number(row.version),
    };
  });
}

export async function listScans(workspaceId, limit = 50) {
  const result = await query(
    `SELECT s.*, a.name AS agent_name FROM scans s
     JOIN agents a ON a.id = s.agent_id
     WHERE s.workspace_id = $1 ORDER BY s.created_at DESC LIMIT $2`,
    [workspaceId, limit],
  );
  return result.rows.map(mapScan);
}

export async function purgeExpiredEvidence(limit = 500) {
  return withTransaction(async (client) => {
    const startedAt = new Date();
    const startedClock = process.hrtime.bigint();
    const candidates = await client.query(
      `SELECT s.id
       FROM scans s
       JOIN workspace_subscriptions ws ON ws.workspace_id=s.workspace_id
       JOIN subscription_plans p ON p.id=ws.plan_id
       WHERE s.status IN ('completed', 'failed')
         AND s.created_at < NOW() - (GREATEST(1, p.history_days)::double precision * INTERVAL '1 day')
       ORDER BY s.created_at ASC
       LIMIT $1
       FOR UPDATE OF s SKIP LOCKED`,
      [Math.min(5000, Math.max(1, Number(limit) || 500))],
    );
    if (!candidates.rowCount) {
      const finishedAt = new Date();
      const durationMs = Number(process.hrtime.bigint() - startedClock) / 1e6;
      const run = await client.query(
        `INSERT INTO evidence_retention_runs
           (id, started_at, finished_at, candidates, deleted_scans, duration_ms, status)
         VALUES ($1,$2,$3,0,0,$4,'completed')
         RETURNING id`,
        [`retention-${randomUUID()}`, startedAt, finishedAt, Math.round(durationMs)],
      );
      return { deletedScans: 0, candidates: 0, durationMs: Math.round(durationMs), retentionRunId: run.rows[0]?.id ?? null };
    }
    const ids = candidates.rows.map((row) => row.id);
    const deleted = await client.query(
      "DELETE FROM scans WHERE id = ANY($1::text[]) RETURNING id",
      [ids],
    );
    const finishedAt = new Date();
    const durationMs = Number(process.hrtime.bigint() - startedClock) / 1e6;
    const run = await client.query(
      `INSERT INTO evidence_retention_runs
         (id, started_at, finished_at, candidates, deleted_scans, duration_ms, status)
       VALUES ($1,$2,$3,$4,$5,$6,'completed')
       RETURNING id`,
      [
        `retention-${randomUUID()}`,
        startedAt,
        finishedAt,
        candidates.rowCount,
        deleted.rowCount,
        Math.round(durationMs),
      ],
    );
    return {
      deletedScans: deleted.rowCount,
      candidates: candidates.rowCount,
      durationMs: Math.round(durationMs),
      retentionRunId: run.rows[0]?.id ?? null,
    };
  });
}

export async function getScan(scanId, workspaceId) {
  const result = await query(
    `SELECT s.*, a.name AS agent_name FROM scans s JOIN agents a ON a.id = s.agent_id
     WHERE s.id = $1 AND s.workspace_id = $2`,
    [scanId, workspaceId],
  );
  const scan = mapScan(result.rows[0]);
  if (!scan) return null;
  const details = await query(
    "SELECT * FROM scan_results WHERE scan_id = $1 ORDER BY created_at",
    [scanId],
  );
  const workspacePolicy = scan.policySnapshot?.effective ?? await getPolicy(workspaceId);
  scan.results = details.rows.map((row) => {
    const result = {
      scenarioId: row.scenario_id,
      title: row.title,
      category: row.category,
      expected: row.expected,
      observed: row.observed,
      status: row.status,
      guard: row.guard_decision
        ? { decision: row.guard_decision, execution: row.execution }
        : null,
      verdict: row.verdict ?? (row.status === "PASS" ? "PROTECTED" : row.status === "FAIL" ? "VULNERABLE" : "INCONCLUSIVE"),
      agentBehavior: row.agent_behavior ?? null,
      executionSafety: row.execution_safety ?? null,
      executionMode: row.execution_mode ?? null,
      source: row.source ?? null,
      safetyWarning: row.safety_warning ?? null,
      requestId: row.request_id ?? null,
      attempt: Number(row.attempt ?? 1),
      durationMs: row.duration_ms ?? null,
      reasons: row.reasons,
      call: row.tool_call,
    };
    return { ...result, remediation: buildRemediation({ result, policy: workspacePolicy }) };
  });
  scan.remediationSummary = buildRemediationSummary(scan.results, workspacePolicy);
  scan.attackPaths = evaluateAttackPaths(scan.results);
  const progress = await query(
    "SELECT * FROM scan_progress WHERE scan_id = $1 ORDER BY ordinal",
    [scanId],
  );
  scan.progress = progress.rows.map(mapScanProgress);
  return scan;
}

export async function isFirstCompletedScan({ scanId, workspaceId }) {
  const result = await query(
    `SELECT COUNT(*)::int AS count
     FROM scans current_scan
     WHERE current_scan.workspace_id=$1
       AND current_scan.status='completed'
       AND current_scan.created_at <= (
         SELECT created_at FROM scans WHERE id=$2 AND workspace_id=$1
       )`,
    [workspaceId, scanId],
  );
  return Number(result.rows[0]?.count ?? 0) === 1;
}

export async function enqueueScan({ workspaceId, agentId, trigger, scenarioIds = null, contractVersion: requestedContractVersion = null }) {
  const scanId = `scan-${randomUUID()}`;
  const jobId = `job-${randomUUID()}`;
  let billingReservation;
  let selectedScenarios;
  let contractVersion = 0;
  let policySnapshot;
  await withTransaction(async (client) => {
    const billingState = await lockBillingState(client, workspaceId);
    const entitledScenarios = scenariosForPlan(billingState.plan);
    if (Array.isArray(scenarioIds) && scenarioIds.length) {
      const requestedIds = [...new Set(scenarioIds.filter((id) => typeof id === "string"))];
      const entitledById = new Map(entitledScenarios.map((scenario) => [scenario.id, scenario]));
      const unknownIds = requestedIds.filter((id) => !scenarios.some((scenario) => scenario.id === id));
      if (unknownIds.length) {
        throw billingError("SCENARIO_NOT_FOUND", "One or more attack-path scenarios do not exist.");
      }
      const lockedIds = requestedIds.filter((id) => !entitledById.has(id));
      if (lockedIds.length) {
        throw billingError("SCENARIO_PLAN_REQUIRED", "This attack path requires a plan with the full adversarial scenario suite.");
      }
      selectedScenarios = requestedIds.map((id) => entitledById.get(id));
    } else {
      selectedScenarios = entitledScenarios;
    }
    if (requestedContractVersion == null) {
      const contractResult = await client.query(
        "SELECT version FROM agent_security_contracts WHERE workspace_id=$1 AND agent_id=$2 AND status='active'",
        [workspaceId, agentId],
      );
      contractVersion = Number(contractResult.rows[0]?.version ?? 0);
    } else {
      contractVersion = Number(requestedContractVersion);
      if (!Number.isInteger(contractVersion) || contractVersion < 0) {
        const error = new Error("The requested contract version is invalid.");
        error.code = "CONTRACT_VERSION_NOT_FOUND";
        throw error;
      }
      if (contractVersion > 0) {
        const contractResult = await client.query(
          `SELECT 1 FROM agent_security_contract_versions
           WHERE workspace_id=$1 AND agent_id=$2 AND version=$3`,
          [workspaceId, agentId, contractVersion],
        );
        if (!contractResult.rowCount) {
          const error = new Error("The requested contract version does not exist.");
          error.code = "CONTRACT_VERSION_NOT_FOUND";
          throw error;
        }
      }
    }
    const policyResult = await client.query(
      `SELECT id, name, version, max_amount, max_age_days, currency, enforcement
       FROM policies WHERE workspace_id=$1 ORDER BY created_at LIMIT 1 FOR UPDATE`,
      [workspaceId],
    );
    const policyRow = policyResult.rows[0] ?? {
      id: "default-policy",
      name: "Storefront refunds",
      version: 0,
      max_amount: 50,
      max_age_days: 14,
      currency: "USD",
      enforcement: "block_and_log",
    };
    const contractResult = contractVersion > 0
      ? await client.query(
        `SELECT version, allowed_tool_ids, max_refund_amount, max_order_age_days, notes
         FROM agent_security_contract_versions
         WHERE workspace_id=$1 AND agent_id=$2 AND version=$3`,
        [workspaceId, agentId, contractVersion],
      )
      : { rows: [] };
    const contractRow = contractResult.rows[0] ?? null;
    const toolResult = await client.query(
      "SELECT COALESCE(array_agg(tool_id), '{}') AS tool_ids FROM agent_tools WHERE agent_id=$1",
      [agentId],
    );
    const configuredToolIds = toolResult.rows[0]?.tool_ids ?? [];
    policySnapshot = {
      policy: {
        id: policyRow.id,
        name: policyRow.name,
        version: Number(policyRow.version ?? 0),
        maxAmount: Number(policyRow.max_amount),
        maxAgeDays: Number(policyRow.max_age_days),
        currency: policyRow.currency,
        enforcement: policyRow.enforcement,
      },
      effective: {
        name: policyRow.name,
        maxAmount: Math.min(Number(policyRow.max_amount), Number(contractRow?.max_refund_amount ?? policyRow.max_amount)),
        maxAgeDays: Math.min(Number(policyRow.max_age_days), Number(contractRow?.max_order_age_days ?? policyRow.max_age_days)),
        currency: policyRow.currency,
        enforcement: policyRow.enforcement,
      },
      contract: contractRow
        ? {
            version: Number(contractRow.version),
            allowedToolIds: contractRow.allowed_tool_ids ?? [],
            maxRefundAmount: Number(contractRow.max_refund_amount),
            maxOrderAgeDays: Number(contractRow.max_order_age_days),
            notes: contractRow.notes ?? "",
          }
        : {
            version: 0,
            allowedToolIds: configuredToolIds,
            maxRefundAmount: Number(policyRow.max_amount),
            maxOrderAgeDays: Number(policyRow.max_age_days),
            notes: "Derived from the agent tool allowlist and workspace policy.",
          },
      capturedAt: new Date().toISOString(),
    };
    billingReservation = await reserveScanCredits(client, {
      workspaceId,
      scanId,
      selectedScenarios,
      billingState,
    });
    await client.query(
      `INSERT INTO scans
       (id, workspace_id, agent_id, status, trigger, scenario_ids, contract_version,
        policy_version, policy_snapshot, catalog_version, prompt_version, verdict)
       VALUES ($1, $2, $3, 'queued', $4, $5::jsonb, $6, $7, $8::jsonb, $9, $10, 'pending')`,
      [
        scanId,
        workspaceId,
        agentId,
        trigger,
        JSON.stringify(selectedScenarios.map((scenario) => scenario.id)),
        contractVersion,
        Number(policySnapshot.policy.version ?? 0),
        JSON.stringify(policySnapshot),
        SCAN_CATALOG_VERSION,
        "prompt-v1",
      ],
    );
    await client.query("INSERT INTO scan_jobs (id, scan_id) VALUES ($1, $2)", [
      jobId,
      scanId,
    ]);
    for (const [ordinal, scenario] of selectedScenarios.entries()) {
      await client.query(
        `INSERT INTO scan_progress (id, scan_id, ordinal, scenario_id, title, category, expected)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          `progress-${randomUUID()}`,
          scanId,
          ordinal,
          scenario.id,
          scenario.title,
          scenario.category,
          scenario.expected,
        ],
      );
    }
  });
  return {
    id: scanId,
    agentId,
    status: "queued",
    trigger,
    score: null,
    passed: 0,
    failed: 0,
    blocked: 0,
    simulated: 0,
    inconclusive: 0,
    refused: 0,
    proposed: 0,
    durationMs: null,
    createdAt: new Date().toISOString(),
    executionMode: "simulation",
    safetyStatus: "safe",
    safetyWarning: null,
    scenarioCount: selectedScenarios.length,
    contractVersion,
    policyVersion: Number(policySnapshot.policy.version ?? 0),
    policySnapshot,
    catalogVersion: SCAN_CATALOG_VERSION,
    promptVersion: "prompt-v1",
    verdict: "pending",
    progress: selectedScenarios.map((scenario, ordinal) => ({
      scenarioId: scenario.id,
      ordinal,
      title: scenario.title,
      category: scenario.category,
      expected: scenario.expected,
      status: "queued",
      observed: null,
      guard: null,
      reasons: [],
      call: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
    })),
    billing: billingReservation,
  };
}

export async function overview(workspaceId) {
  const [metrics, recent] = await Promise.all([
    query(
      `WITH latest_completed AS (
             SELECT DISTINCT ON (agent_id)
               agent_id, score, failed, passed, blocked, inconclusive, safety_status,
               COALESCE(NULLIF(jsonb_array_length(scenario_ids), 0), passed + failed) AS scenario_count
             FROM scans
             WHERE workspace_id=$1 AND status='completed'
             ORDER BY agent_id, created_at DESC
           )
           SELECT COALESCE(ROUND(AVG(CASE WHEN safety_status <> 'safe' THEN 0 ELSE score END))::int, 0) AS security_score,
             COALESCE(SUM(failed), 0)::int AS open_findings,
             COALESCE(SUM(inconclusive), 0)::int AS inconclusive_scenarios,
             COALESCE(COUNT(*) FILTER (WHERE safety_status <> 'safe'), 0)::int AS untrusted_agents,
             COALESCE(SUM(blocked), 0)::int AS protected_actions,
             COALESCE(SUM(passed), 0)::int AS passed_scenarios,
             COALESCE(SUM(scenario_count), 0)::int AS total_scenarios,
             COALESCE(SUM(scenario_count), 0)::int AS tested_scenarios,
             COALESCE(COUNT(*) FILTER (WHERE scenario_count >= $2), 0)::int AS full_suite_agents,
              (SELECT COUNT(*)::int
               FROM scans
               WHERE workspace_id=$1 AND status='completed' AND created_at >= DATE_TRUNC('month', NOW())) AS scans_this_month,
             COUNT(*)::int AS agents_scanned,
             (SELECT COUNT(*)::int FROM agents WHERE workspace_id=$1) AS total_agents,
              (SELECT COALESCE(SUM(blocked), 0)::int
               FROM scans
               WHERE workspace_id=$1 AND status='completed' AND created_at >= NOW() - INTERVAL '7 days') AS blocked_last_7_days
           FROM latest_completed
            `,
       [workspaceId, scenarios.length],
    ),
    listScans(workspaceId, 6),
  ]);
  const row = metrics.rows[0];
  const scenarioPassRate =
    row.total_scenarios > 0
      ? Math.round((row.passed_scenarios / row.total_scenarios) * 100)
      : 0;
  const agentCoverage =
    row.total_agents > 0
      ? Math.round((row.agents_scanned / row.total_agents) * 100)
      : 0;
  return {
    metrics: {
      securityScore: row.security_score,
      protectedActions: row.protected_actions,
      openFindings: row.open_findings,
      inconclusiveScenarios: row.inconclusive_scenarios,
      untrustedAgents: row.untrusted_agents,
      scansThisMonth: row.scans_this_month,
      scoreBasis: "latest_completed_scan_per_agent",
      testedScenarios: Number(row.tested_scenarios ?? 0),
      requiredScenarios: Number(row.agents_scanned ?? 0) * scenarios.length,
      fullSuiteAgents: Number(row.full_suite_agents ?? 0),
      scenarioCoveragePercent: Number(row.agents_scanned ?? 0) > 0
        ? Math.round((Number(row.tested_scenarios ?? 0) / (Number(row.agents_scanned ?? 0) * scenarios.length)) * 100)
        : 0,
    },
    posture: {
      scenarioPassRate,
      agentCoverage,
      blockedLast7Days: row.blocked_last_7_days,
    },
    recentScans: recent,
  };
}
