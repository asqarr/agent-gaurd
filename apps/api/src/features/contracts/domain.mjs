export function normalizeSecurityContract(input, { agentToolIds = [], policy = {} } = {}) {
  const configuredTools = new Set(Array.isArray(agentToolIds) ? agentToolIds : []);
  const requestedTools = Array.isArray(input?.allowedToolIds)
    ? [...new Set(input.allowedToolIds.filter((id) => typeof id === "string"))]
    : [...configuredTools];
  const allowedToolIds = requestedTools.filter((id) => configuredTools.has(id));
  const policyMaxRefundAmount = Number(policy.maxAmount ?? 50);
  const policyMaxOrderAgeDays = Number(policy.maxAgeDays ?? 14);
  const requestedRefundAmount = Number(input?.maxRefundAmount ?? policyMaxRefundAmount);
  const requestedOrderAgeDays = Number(input?.maxOrderAgeDays ?? policyMaxOrderAgeDays);
  const maxRefundAmount = Math.min(requestedRefundAmount, policyMaxRefundAmount);
  const maxOrderAgeDays = Math.min(requestedOrderAgeDays, policyMaxOrderAgeDays);

  if (!allowedToolIds.length) {
    const error = new Error("A security contract must allow at least one configured tool.");
    error.code = "INVALID_SECURITY_CONTRACT";
    throw error;
  }
  if (!Number.isFinite(maxRefundAmount) || maxRefundAmount <= 0 || maxRefundAmount > 1000000) {
    const error = new Error("Maximum refund amount must be between 0 and 1,000,000.");
    error.code = "INVALID_SECURITY_CONTRACT";
    throw error;
  }
  if (!Number.isInteger(maxOrderAgeDays) || maxOrderAgeDays < 0 || maxOrderAgeDays > 36500) {
    const error = new Error("Maximum order age must be an integer between 0 and 36,500 days.");
    error.code = "INVALID_SECURITY_CONTRACT";
    throw error;
  }

  return {
    allowedToolIds,
    maxRefundAmount,
    maxOrderAgeDays,
    notes: typeof input?.notes === "string" ? input.notes.trim().slice(0, 500) : "",
  };
}

export function defaultSecurityContract({ agentToolIds = [], policy = {} } = {}) {
  return {
    version: 0,
    status: "derived",
    allowedToolIds: [...agentToolIds],
    maxRefundAmount: Number(policy.maxAmount ?? 50),
    maxOrderAgeDays: Number(policy.maxAgeDays ?? 14),
    notes: "Derived from the agent tool allowlist and workspace policy.",
  };
}

function uniqueStrings(values) {
  return [...new Set(Array.isArray(values) ? values.filter((value) => typeof value === "string") : [])];
}

function compareNumericBoundary(label, before, after, unit = "") {
  const previous = Number(before);
  const next = Number(after);
  if (!Number.isFinite(previous) || !Number.isFinite(next) || previous === next) return null;
  return {
    field: label,
    before: previous,
    after: next,
    delta: next - previous,
    unit,
    direction: next > previous ? "widened" : "narrowed",
  };
}

export function compareSecurityContracts(before, after) {
  if (!before || !after) {
    return {
      status: "baseline_missing",
      risk: "unknown",
      addedTools: [],
      removedTools: [],
      boundaryChanges: [],
      notesChanged: false,
      warnings: ["A previous contract version is required before security drift can be confirmed."],
    };
  }

  const beforeTools = new Set(uniqueStrings(before.allowedToolIds));
  const afterTools = new Set(uniqueStrings(after.allowedToolIds));
  const addedTools = [...afterTools].filter((toolId) => !beforeTools.has(toolId));
  const removedTools = [...beforeTools].filter((toolId) => !afterTools.has(toolId));
  const boundaryChanges = [
    compareNumericBoundary("maxRefundAmount", before.maxRefundAmount, after.maxRefundAmount, "currency"),
    compareNumericBoundary("maxOrderAgeDays", before.maxOrderAgeDays, after.maxOrderAgeDays, "days"),
  ].filter(Boolean);
  const widened = addedTools.length > 0 || boundaryChanges.some((change) => change.direction === "widened");
  const narrowed = removedTools.length > 0 || boundaryChanges.some((change) => change.direction === "narrowed");
  const warnings = [];
  if (addedTools.length) warnings.push(`${addedTools.length} tool boundary${addedTools.length === 1 ? "" : "ies"} widened.`);
  if (boundaryChanges.some((change) => change.field === "maxRefundAmount" && change.direction === "widened")) {
    warnings.push("The maximum refund ceiling increased.");
  }
  if (boundaryChanges.some((change) => change.field === "maxOrderAgeDays" && change.direction === "widened")) {
    warnings.push("The maximum order age increased.");
  }

  return {
    status: widened ? "weakened" : narrowed ? "hardened" : "unchanged",
    risk: widened ? "high" : narrowed ? "low" : "none",
    addedTools,
    removedTools,
    boundaryChanges,
    notesChanged: String(before.notes ?? "") !== String(after.notes ?? ""),
    warnings,
  };
}

function scanSummary(scan) {
  if (!scan) return null;
  return {
    id: scan.id,
    contractVersion: Number(scan.contractVersion ?? 0),
    status: scan.status,
    score: scan.score ?? null,
    passed: Number(scan.passed ?? 0),
    failed: Number(scan.failed ?? 0),
    blocked: Number(scan.blocked ?? 0),
    createdAt: scan.createdAt ?? null,
  };
}

export function compareScanEvidence(beforeScan, afterScan) {
  const beforeResults = new Map((beforeScan?.results ?? []).map((result) => [result.scenarioId, result]));
  const afterResults = new Map((afterScan?.results ?? []).map((result) => [result.scenarioId, result]));
  const scenarioIds = [...new Set([...beforeResults.keys(), ...afterResults.keys()])];
  const scenarioChanges = scenarioIds.map((scenarioId) => {
    const before = beforeResults.get(scenarioId)?.status ?? null;
    const after = afterResults.get(scenarioId)?.status ?? null;
    let status = "unverified";
    if (before && after) {
      if (before === after) status = "unchanged";
      else if (before === "PASS" && after !== "PASS") status = "regressed";
      else if (before !== "PASS" && after === "PASS") status = "fixed";
      else status = "changed";
    }
    return { scenarioId, before, after, status };
  });

  const beforePaths = new Map((beforeScan?.attackPaths ?? []).map((path) => [path.id, path]));
  const afterPaths = new Map((afterScan?.attackPaths ?? []).map((path) => [path.id, path]));
  const pathIds = [...new Set([...beforePaths.keys(), ...afterPaths.keys()])];
  const attackPathChanges = pathIds.map((pathId) => {
    const before = beforePaths.get(pathId)?.status ?? null;
    const after = afterPaths.get(pathId)?.status ?? null;
    let status = "unverified";
    if (before && after) {
      if (before === after) status = "unchanged";
      else if (before === "protected" && after !== "protected") status = "regressed";
      else if (before !== "protected" && after === "protected") status = "fixed";
      else status = "changed";
    }
    return { pathId, before, after, status };
  });

  const changes = [...scenarioChanges, ...attackPathChanges];
  const regressedCount = changes.filter((change) => change.status === "regressed").length;
  const fixedCount = changes.filter((change) => change.status === "fixed").length;
  const unknownCount = changes.filter((change) => change.status === "unverified").length;
  const compared = Boolean(beforeScan && afterScan);

  return {
    status: compared ? "compared" : afterScan ? "baseline_missing" : "pending",
    verdict: !compared ? "unknown" : regressedCount ? "regressed" : fixedCount ? "improved" : "unchanged",
    beforeScan: scanSummary(beforeScan),
    afterScan: scanSummary(afterScan),
    scenarioChanges,
    attackPathChanges,
    regressedCount,
    fixedCount,
    unchangedCount: changes.filter((change) => change.status === "unchanged").length,
    unknownCount,
    scoreDelta: beforeScan?.score != null && afterScan?.score != null ? Number(afterScan.score) - Number(beforeScan.score) : null,
  };
}
