import { config } from "../../core/config.mjs";
import * as repository from "../../infrastructure/repository.mjs";

let running = false;

export async function processSentinelChecks() {
  if (running) return false;
  running = true;
  try {
    const targets = await repository.listSentinelTargets();
    await Promise.all(
      targets.map((target) => repository.checkSentinel(target)),
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
