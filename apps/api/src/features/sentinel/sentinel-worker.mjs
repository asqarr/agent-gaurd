import { config } from "../../core/config.mjs";
import * as repository from "../../infrastructure/repository.mjs";

let running = false;

export async function mapConcurrent(items, concurrency, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const safeConcurrency = Number.isSafeInteger(concurrency) && concurrency > 0 ? concurrency : 1;
  const workerCount = Math.min(items.length, safeConcurrency);
  const settled = await Promise.allSettled(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await callback(items[index], index);
    }
  }));
  const failure = settled.find((entry) => entry.status === "rejected");
  if (failure) throw failure.reason;
  return results;
}

export async function processSentinelChecks() {
  if (running) return false;
  running = true;
  try {
    const targets = await repository.claimSentinelTargets(config.sentinelWorkerBatchSize);
    await mapConcurrent(
      targets,
      config.sentinelWorkerConcurrency,
      (target) => repository.checkSentinel(target),
    );
    return targets.length > 0;
  } finally {
    running = false;
  }
}

export function startSentinelWorker() {
  const timer = setInterval(() => {
    processSentinelChecks().catch((error) =>
      console.error("Sentinel worker error:", error),
    );
  }, config.sentinelWorkerIntervalMs);
  timer.unref?.();
  processSentinelChecks().catch((error) =>
    console.error("Initial Sentinel check error:", error),
  );
  return timer;
}
