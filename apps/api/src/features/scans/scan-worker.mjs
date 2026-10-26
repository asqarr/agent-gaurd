import { randomUUID } from "node:crypto";
import { config } from "../../core/config.mjs";
import {
  claimNextJob,
  completeScan,
  failScan,
  getWorkerContext,
  markScanRunning,
  retryScan,
  touchScanJob,
  updateScanProgress,
} from "./scan-queue-repository.mjs";
import { runAgentScan } from "./scan-engine.mjs";
import { requestAgentScenario } from "../agents/agent-client.mjs";
import { scenarios } from "../catalog/domain.mjs";
import { scanCreditsForScenarios } from "../billing/domain.mjs";
import { recordGrowthEvent } from "../growth-analytics/repository.mjs";

export async function processNextScanJob({ workerId = `scan-worker-${randomUUID()}` } = {}) {
  const job = await claimNextJob({
    leaseMs: config.scanJobLeaseMs,
    maxAttempts: config.scanMaxAttempts,
    workerId,
  });
  if (!job) return false;

  const startedClock = process.hrtime.bigint();
  const cpuStart = process.cpuUsage();
  const rssStart = process.memoryUsage().rss;
  const leaseToken = job.lease_token;
  let context = null;
  let measurementUnits = 0;
  const buildMeasurement = () => {
    const cpu = process.cpuUsage(cpuStart);
    return {
      units: measurementUnits,
      durationMs: Math.max(0, Math.round(Number(process.hrtime.bigint() - startedClock) / 1e6)),
      cpuUserUs: Math.max(0, cpu.user),
      cpuSystemUs: Math.max(0, cpu.system),
      rssBytes: Math.max(rssStart, process.memoryUsage().rss),
      periodStart: context?.current_period_start ?? null,
    };
  };
  let heartbeat;

  try {
    context = await getWorkerContext(job.scan_id);
    if (!context) throw new Error("Scan context no longer exists.");
    if (context.agent_status === "quarantined") {
      const error = new Error("Agent is quarantined. Restore it before running a scan.");
      error.code = "AGENT_QUARANTINED";
      throw error;
    }
    await markScanRunning({ scanId: job.scan_id, leaseToken });
    const selectedScenarioIds = Array.isArray(context.scenario_ids) ? context.scenario_ids : [];
    const selectedScenarios = selectedScenarioIds.length
      ? selectedScenarioIds.map((scenarioId) => scenarios.find((scenario) => scenario.id === scenarioId)).filter(Boolean)
      : scenarios;
    if (!selectedScenarios.length) throw new Error("Scan has no valid scenario definitions.");
    measurementUnits = scanCreditsForScenarios(selectedScenarios);

    heartbeat = setInterval(() => {
      void touchScanJob({ jobId: job.id, leaseToken }).catch((error) => {
        console.error(JSON.stringify({
          level: "error",
          event: "scan_worker_heartbeat_failed",
          jobId: job.id,
          scanId: job.scan_id,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    }, Math.max(1000, Math.floor(config.scanJobLeaseMs / 3)));

    const scanPolicy = context.mode === "demo_simulator"
      ? { maxAmount: 50, maxAgeDays: 14, currency: "USD" }
      : {
        maxAmount: Math.min(Number(context.max_amount ?? 50), Number(context.contract_max_refund_amount ?? context.max_amount ?? 50)),
        maxAgeDays: Math.min(Number(context.max_age_days ?? 14), Number(context.contract_max_order_age_days ?? context.max_age_days ?? 14)),
        currency: context.currency ?? "USD",
      };
    const outcome = await runAgentScan({
      agent: {
        id: context.agent_id,
        mode: context.mode,
        endpoint: context.endpoint_url,
        encryptedApiKey: context.encrypted_api_key,
      },
      policy: scanPolicy,
      allowedToolIds: Array.isArray(context.contract_allowed_tool_ids) ? context.contract_allowed_tool_ids : undefined,
      requestScenario: requestAgentScenario,
      scenarios: selectedScenarios,
      onScenarioUpdate: (progress) => updateScanProgress({
        scanId: job.scan_id,
        leaseToken,
        status: progress.status,
        scenario: progress.scenario,
        result: progress.result,
        error: progress.error,
        durationMs: progress.durationMs,
      }),
    });
    outcome.metrics = buildMeasurement();
    await completeScan({ scanId: job.scan_id, leaseToken, outcome });
    try {
      await recordGrowthEvent({
        eventName: "business.first_scan_completed",
        workspaceId: context.workspace_id,
        properties: { outcome: "completed" },
      });
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "growth_analytics_write_failed",
        eventName: "business.first_scan_completed",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error?.code === "SCAN_LEASE_LOST") {
      console.error(JSON.stringify({
        level: "error",
        event: "scan_worker_lease_lost",
        jobId: job.id,
        scanId: job.scan_id,
      }));
      return false;
    }
    try {
      if (error?.code === "AGENT_QUARANTINED") {
        await failScan({ scanId: job.scan_id, leaseToken, errorMessage: message, metrics: buildMeasurement() });
      } else if (job.attempts < config.scanMaxAttempts) {
        const delayMs = config.scanRetryBaseMs * 2 ** Math.max(0, job.attempts - 1);
        await retryScan({ scanId: job.scan_id, leaseToken, errorMessage: message, delayMs });
      } else {
        await failScan({ scanId: job.scan_id, leaseToken, errorMessage: message, metrics: buildMeasurement() });
      }
    } catch (finalizationError) {
      console.error(JSON.stringify({
        level: "error",
        event: "scan_worker_finalization_failed",
        jobId: job.id,
        scanId: job.scan_id,
        error: finalizationError instanceof Error ? finalizationError.message : String(finalizationError),
      }));
    }
    return true;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

export function startScanWorker({ concurrency = config.scanWorkerConcurrency } = {}) {
  const workerPrefix = `scan-worker-${randomUUID()}`;
  const active = new Set();
  let stopped = false;
  let slot = 0;

  const poll = () => {
    while (!stopped && active.size < concurrency) {
      const workerId = `${workerPrefix}-${slot++}`;
      const jobPromise = processNextScanJob({ workerId })
        .catch((error) => {
          console.error(JSON.stringify({
            level: "error",
            event: "scan_worker_poll_failed",
            workerId,
            error: error instanceof Error ? error.message : String(error),
          }));
          return false;
        });
      active.add(jobPromise);
      jobPromise.then(
        () => active.delete(jobPromise),
        () => active.delete(jobPromise),
      );
    }
  };

  const timer = setInterval(poll, config.scanWorkerIntervalMs);
  timer.unref?.();
  poll();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      if (!active.size) return;
      const timeout = new Promise((resolve) => {
        const handle = setTimeout(resolve, config.scanWorkerShutdownTimeoutMs);
        handle.unref?.();
      });
      await Promise.race([Promise.allSettled([...active]), timeout]);
    },
    activeCount: () => active.size,
  };
}
