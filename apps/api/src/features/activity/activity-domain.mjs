const eventTypes = new Set([
  "scan.queued",
  "scan.started",
  "scan.progress",
  "scan.completed",
  "scan.retry_scheduled",
  "scan.failed",
  "runtime.allowed",
  "runtime.blocked",
  "runtime.error",
  "runtime.quota_rejected",
  "runtime.approval_consumed",
  "sentinel.drift_detected",
  "agent.quarantined",
  "incident.opened",
  "incident.resolved",
  "copilot.generated",
]);

const incidentTypes = new Set([
  "sentinel_drift",
  "agent_quarantined",
  "scan_finding",
  "scan_failed",
  "runtime_block",
]);

function boundedText(value, maxLength = 120) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function safeInteger(value, { min = 0, max = 1000000 } = {}) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

function safeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    ? value
    : null;
}

function safeMetadata(eventType, metadata = {}) {
  const source = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
  switch (eventType) {
    case "scan.progress":
      return {
        ...(safeInteger(source.scenarioOrdinal, { min: 1, max: 10000 }) !== null ? { scenarioOrdinal: source.scenarioOrdinal } : {}),
        ...(safeInteger(source.scenarioTotal, { min: 1, max: 10000 }) !== null ? { scenarioTotal: source.scenarioTotal } : {}),
        ...(new Set(["passed", "blocked", "failed", "error"]).has(source.scenarioStatus) ? { scenarioStatus: source.scenarioStatus } : {}),
      };
    case "scan.completed":
      return Object.fromEntries([
        ["score", safeInteger(source.score, { max: 100 })],
        ["passed", safeInteger(source.passed)],
        ["failed", safeInteger(source.failed)],
        ["blocked", safeInteger(source.blocked)],
        ["inconclusive", safeInteger(source.inconclusive)],
        ["durationMs", safeInteger(source.durationMs, { max: 86400000 })],
      ].filter(([, value]) => value !== null));
    case "runtime.allowed":
    case "runtime.blocked":
      return {
        ...(safeInteger(source.toolCount, { max: 1000 }) !== null ? { toolCount: source.toolCount } : {}),
        ...(safeInteger(source.latencyMs, { max: 86400000 }) !== null ? { latencyMs: source.latencyMs } : {}),
        ...(safeId(source.traceId) ? { traceId: source.traceId } : {}),
      };
    case "runtime.approval_consumed":
      return safeId(source.traceId) ? { traceId: source.traceId } : {};
    case "runtime.error":
    case "runtime.quota_rejected":
      return {
        ...(new Set(["quota", "customer_endpoint", "policy", "approval_storage", "decision_persistence", "gateway"]).has(source.stage) ? { stage: source.stage } : {}),
        ...(safeInteger(source.latencyMs, { max: 86400000 }) !== null ? { latencyMs: source.latencyMs } : {}),
        ...(safeId(source.traceId) ? { traceId: source.traceId } : {}),
      };
    case "sentinel.drift_detected":
      return {
        ...(new Set(["low", "medium", "high", "critical"]).has(source.driftSeverity) ? { driftSeverity: source.driftSeverity } : {}),
        ...(safeInteger(source.changeCount, { min: 1, max: 1000 }) !== null ? { changeCount: source.changeCount } : {}),
      };
    case "incident.opened":
    case "incident.resolved":
      return {
        ...(incidentTypes.has(source.incidentType) ? { incidentType: source.incidentType } : {}),
        ...(new Set(["info", "low", "medium", "high", "critical"]).has(source.incidentSeverity) ? { incidentSeverity: source.incidentSeverity } : {}),
      };
    case "copilot.generated":
      return {
        ...(safeId(source.scenarioId) ? { scenarioId: source.scenarioId } : {}),
        ...(safeId(source.model) ? { model: source.model } : {}),
      };
    default:
      return {};
  }
}

function presentation(eventType, agentName, metadata) {
  const agent = boundedText(agentName, 80) ?? "Agent";
  const count = metadata.scenarioTotal ?? 0;
  switch (eventType) {
    case "scan.queued": return { category: "scan", severity: "info", title: "Security scan queued", explanation: `A security scan for ${agent} is waiting to start.` };
    case "scan.started": return { category: "scan", severity: "info", title: "Security scan started", explanation: `The security suite is now checking ${agent}.` };
    case "scan.progress": return {
      category: "scan",
      severity: metadata.scenarioStatus === "failed" || metadata.scenarioStatus === "error" ? "warning" : metadata.scenarioStatus === "blocked" ? "warning" : "info",
      title: `Scenario ${metadata.scenarioOrdinal ?? ""} of ${count} checked`.trim(),
      explanation: `A scan scenario finished with status: ${(metadata.scenarioStatus ?? "completed").replaceAll("_", " ")}.`,
    };
    case "scan.completed": {
      const needsReview = (metadata.failed ?? 0) > 0 || (metadata.inconclusive ?? 0) > 0;
      return {
        category: "scan",
        severity: needsReview ? "warning" : "success",
        title: "Security scan completed",
        explanation: `${agent}: ${metadata.passed ?? 0} passed, ${metadata.failed ?? 0} findings, ${metadata.inconclusive ?? 0} inconclusive${metadata.score !== undefined ? ` · score ${metadata.score}/100` : ""}. Review the evidence before changing policy.`,
      };
    }
    case "scan.retry_scheduled": return { category: "scan", severity: "warning", title: "Security scan retry scheduled", explanation: `A temporary scan failure occurred. AgentGuard will retry this scan automatically.` };
    case "scan.failed": return { category: "scan", severity: "critical", title: "Security scan did not complete", explanation: `The scan for ${agent} stopped before producing a complete result. Review scan status and retry when safe.` };
    case "runtime.allowed": return { category: "runtime", severity: "success", title: "Runtime policy allowed the request", explanation: `Policy allowed the request and issued a one-time approval to the customer SDK. Final tool execution occurs inside the customer SDK.` };
    case "runtime.blocked": return { category: "runtime", severity: "warning", title: "Runtime policy blocked the request", explanation: `Policy returned BLOCK, so AgentGuard issued no one-time approval for this request.` };
    case "runtime.error": return { category: "runtime", severity: "critical", title: "Runtime request failed", explanation: `A technical failure occurred during the ${String(metadata.stage ?? "gateway").replaceAll("_", " ")} stage. Sensitive upstream details are not included here.` };
    case "runtime.quota_rejected": return { category: "runtime", severity: "warning", title: "Runtime capacity reached", explanation: `The request was rejected before it was forwarded to the customer agent.` };
    case "runtime.approval_consumed": return { category: "runtime", severity: "info", title: "One-time approval consumed", explanation: `The customer SDK consumed an approval for one local tool-call attempt. AgentGuard cannot observe whether the customer application completed the side effect.` };
    case "sentinel.drift_detected": return { category: "sentinel", severity: metadata.driftSeverity === "critical" ? "critical" : "warning", title: "Sentinel detected configuration drift", explanation: `${metadata.changeCount ?? 1} change${metadata.changeCount === 1 ? "" : "s"} from the approved security baseline need review.` };
    case "agent.quarantined": return { category: "sentinel", severity: "critical", title: "Agent quarantined", explanation: `New scans and Runtime invocations are blocked for ${agent} until an owner or admin restores it.` };
    case "incident.opened": return { category: "incident", severity: metadata.incidentSeverity === "critical" || metadata.incidentSeverity === "high" ? "critical" : "warning", title: "Security incident opened", explanation: `${incidentDescription(metadata.incidentType)} Review it in Incident Center.` };
    case "incident.resolved": return { category: "incident", severity: "success", title: "Security incident resolved", explanation: `An open security incident for ${agent} was marked resolved.` };
    case "copilot.generated": return { category: "copilot", severity: "success", title: "AI remediation plan generated", explanation: `Copilot created a reviewable fix plan for ${agent}. The plan is advisory and was not applied automatically.` };
    default: throw new Error("Unsupported workspace activity event type.");
  }
}

function incidentDescription(type) {
  switch (type) {
    case "sentinel_drift": return "Sentinel detected changes from the approved security baseline.";
    case "agent_quarantined": return "The agent was quarantined after a critical security condition.";
    case "scan_finding": return "A completed scan recorded findings or inconclusive evidence.";
    case "scan_failed": return "A security scan stopped before completion.";
    default: return "A security condition needs review.";
  }
}

const resourceTypes = new Set(["scan", "scan_scenario", "runtime_event", "incident", "sentinel_event"]);

export function createWorkspaceActivityRecord(input) {
  if (!eventTypes.has(input?.eventType)) throw new Error("Unsupported workspace activity event type.");
  const metadata = safeMetadata(input.eventType, input.metadata);
  const display = presentation(input.eventType, input.agentName, metadata);
  return {
    eventType: input.eventType,
    category: display.category,
    severity: display.severity,
    title: display.title,
    explanation: display.explanation,
    agentId: safeId(input.agentId),
    agentName: boundedText(input.agentName, 80),
    resourceType: resourceTypes.has(input.resourceType) ? input.resourceType : null,
    resourceId: safeId(input.resourceId),
    metadata,
  };
}

export function mapWorkspaceActivityRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    type: row.event_type,
    category: row.category,
    severity: row.severity,
    title: row.title,
    explanation: row.explanation,
    agentId: row.agent_id,
    agentName: row.agent_name,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}
