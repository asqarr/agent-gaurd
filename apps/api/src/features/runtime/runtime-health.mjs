const RECENT_ACTIVITY_MS = 15 * 60 * 1000;

function dateMs(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export function summarizeRuntimeHealth({ metrics, runtimeEnabled, now = new Date() }) {
  const sampleCount = Number(metrics.sampleCount ?? 0);
  const decisionCount = Number(metrics.decisionCount ?? 0);
  const allowCount = Number(metrics.allowCount ?? 0);
  const blockCount = Number(metrics.blockCount ?? 0);
  const errorCount = Number(metrics.errorCount ?? 0);
  const quotaRejectedCount = Number(metrics.quotaRejectedCount ?? 0);
  const errorRatePercent = sampleCount > 0
    ? Math.round((errorCount / sampleCount) * 10000) / 100
    : 0;
  const lastEventMs = dateMs(metrics.lastEventAt);
  const lastDecisionMs = dateMs(metrics.lastDecisionAt);
  const lastErrorMs = dateMs(metrics.lastErrorAt);
  const nowMs = dateMs(now) ?? Date.now();

  let observationStatus = "observed";
  if (!runtimeEnabled) {
    observationStatus = "disabled";
  } else if (sampleCount === 0) {
    observationStatus = quotaRejectedCount > 0 ? "quota_limited" : "no_data";
  } else if (
    (lastErrorMs !== null && (lastDecisionMs === null || lastErrorMs >= lastDecisionMs)) ||
    errorRatePercent >= 5
  ) {
    observationStatus = "degraded";
  } else if (lastEventMs === null || nowMs - lastEventMs > RECENT_ACTIVITY_MS) {
    observationStatus = "no_recent_traffic";
  }

  return {
    ...metrics,
    sampleCount,
    decisionCount,
    allowCount,
    blockCount,
    errorCount,
    quotaRejectedCount,
    errorRatePercent,
    observationStatus,
    observedOnly: true,
  };
}
