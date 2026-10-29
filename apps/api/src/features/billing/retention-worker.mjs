import { config } from "../../core/config.mjs";
import { withAdvisoryLock } from "../../core/db.mjs";
import { captureUsageStorageSnapshots, purgeExpiredEvidence } from "../../infrastructure/repository.mjs";
import { purgeExpiredGrowthEvents } from "../growth-analytics/repository.mjs";

let running = false;

async function runEvidenceRetention() {
  const result = await purgeExpiredEvidence();
  let deletedGrowthEvents = 0;
  try {
    deletedGrowthEvents = await purgeExpiredGrowthEvents();
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "growth_analytics_retention_failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  let storage;
  try {
    storage = await captureUsageStorageSnapshots();
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "usage_storage_snapshot_failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  if (result.deletedScans > 0) {
    console.log(JSON.stringify({
      event: "evidence.retention_purged",
      deletedScans: result.deletedScans,
      candidates: result.candidates,
      durationMs: result.durationMs,
    }));
  }
  if (deletedGrowthEvents > 0) {
    console.log(JSON.stringify({ event: "growth_analytics.retention_purged", deleted: deletedGrowthEvents }));
  }
  return { ...result, deletedGrowthEvents, storage };
}

export async function processEvidenceRetention() {
  if (running) return null;
  running = true;
  try {
    const result = await withAdvisoryLock("agentguard:evidence-retention", runEvidenceRetention);
    return result.acquired ? result.value : null;
  } finally {
    running = false;
  }
}

export function startRetentionWorker() {
  const timer = setInterval(() => {
    processEvidenceRetention().catch((error) => console.error("Evidence retention worker error:", error));
  }, config.retentionWorkerIntervalMs);
  timer.unref?.();
  processEvidenceRetention().catch((error) => console.error("Initial evidence retention error:", error));
  return timer;
}
