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
} from "../../infrastructure/repository.mjs";
import { runAgentScan } from "./scan-engine.mjs";
import { requestAgentScenario } from "../agents/agent-client.mjs";
import { scenarios } from "../catalog/domain.mjs";
import { scanCreditsForScenarios } from "../billing/domain.mjs";
import { recordGrowthEvent } from "../growth-analytics/repository.mjs";

let processing = false;

export async function processNextScanJob() {
  if (processing) return false;
  const job = await claimNextJob(config.scanJobLeaseMs, config.scanMaxAttempts);
  if (!job) return false;

  processing = true;
  const startedClock = process.hrtime.bigint();
  const cpuStart = process.cpuUsage();
  const rssStart = process.memoryUsage().rss;
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
    await markScanRunning(job.scan_id);
    const selectedScenarioIds = Array.isArray(context.scenario_ids)
      ? context.scenario_ids
      : [];
    const selectedScenarios = selectedScenarioIds.length
      ? selectedScenarioIds
        .map((scenarioId) => scenarios.find((scenario) => scenario.id === scenarioId))
        .filter(Boolean)
      : scenarios;
    if (!selectedScenarios.length) {
      throw new Error("Scan has no valid scenario definitions.");
    }
    measurementUnits = scanCreditsForScenarios(selectedScenarios);
    heartbeat = setInterval(
      () => {
        touchScanJob(job.id).catch((error) =>
          console.error("Scan job heartbeat error:", error),
        );
      },
      Math.max(1000, Math.floor(config.scanJobLeaseMs / 3)),
    );

    const scanPolicy = context.mode === "demo_simulator"
      ? { maxAmount: 50, maxAgeDays: 14, currency: "USD" }
      : {
        maxAmount: Math.min(
          Number(context.max_amount ?? 50),
          Number(context.contract_max_refund_amount ?? context.max_amount ?? 50),
        ),
        maxAgeDays: Math.min(
          Number(context.max_age_days ?? 14),
          Number(context.contract_max_order_age_days ?? context.max_age_days ?? 14),
        ),
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
      allowedToolIds: Array.isArray(context.contract_allowed_tool_ids)
        ? context.contract_allowed_tool_ids
        : undefined,
      requestScenario: requestAgentScenario,
      scenarios: selectedScenarios,
      onScenarioUpdate: (progress) =>
        updateScanProgress({
          scanId: job.scan_id,
          status: progress.status,
          scenario: progress.scenario,
          result: progress.result,
          error: progress.error,
          durationMs: progress.durationMs,
        }),
    });
    outcome.metrics = buildMeasurement();
    await completeScan(job.scan_id, outcome);
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
    if (error?.code === "AGENT_QUARANTINED") {
      await failScan(job.scan_id, message, buildMeasurement());
    } else if (job.attempts < config.scanMaxAttempts) {
      const delayMs =
        config.scanRetryBaseMs * 2 ** Math.max(0, job.attempts - 1);
      await retryScan(job.scan_id, message, delayMs);
    } else {
      await failScan(job.scan_id, message, buildMeasurement());
    }
    return true;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    processing = false;
  }
}

export function startScanWorker() {
  const timer = setInterval(() => {
    processNextScanJob().catch((error) =>
      console.error("Scan worker error:", error),
    );
  }, config.scanWorkerIntervalMs);
  timer.unref?.();
  processNextScanJob().catch((error) =>
    console.error("Initial scan worker error:", error),
  );
  return timer;
}
