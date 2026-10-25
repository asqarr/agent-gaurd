import { createHash } from "node:crypto";

const severityRank = Object.freeze({ low: 1, medium: 2, high: 3, critical: 4 });

function maxSeverity(current, next) {
  return severityRank[next] > severityRank[current] ? next : current;
}

function normalizeTool(tool) {
  if (typeof tool === "string") return { id: tool, risk: "unknown", sideEffect: false };
  return {
    id: tool.id,
    risk: tool.risk ?? "unknown",
    sideEffect: Boolean(tool.sideEffect),
  };
}

export function buildSentinelSnapshot({ agent, policy, tools = [] }) {
  const normalizedTools = (tools.length ? tools : agent.tools ?? [])
    .map(normalizeTool)
    .filter((tool) => tool.id)
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    version: 1,
    agent: {
      provider: agent.provider ?? "",
      model: agent.model ?? "",
      environment: agent.environment ?? "",
      endpointConfigured: Boolean(agent.endpoint),
    },
    tools: normalizedTools,
    policy: {
      name: policy?.name ?? "",
      maxAmount: Number(policy?.maxAmount ?? 0),
      maxAgeDays: Number(policy?.maxAgeDays ?? 0),
      currency: policy?.currency ?? "",
      enforcement: policy?.enforcement ?? "block_and_log",
    },
  };
}

export function fingerprintSentinelSnapshot(snapshot) {
  return createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");
}

function changed(changes, field, category, from, to, severity, impact) {
  changes.push({
    id: `${category}:${field}`,
    category,
    field,
    from,
    to,
    severity,
    impact,
  });
}

export function compareSentinelSnapshots(baseline, current) {
  const changes = [];
  let severity = "low";

  for (const field of ["provider", "model", "environment"]) {
    if (baseline.agent?.[field] !== current.agent?.[field]) {
      const level = field === "model" ? "high" : "medium";
      severity = maxSeverity(severity, level);
      changed(
        changes,
        field,
        "agent_configuration",
        baseline.agent?.[field] ?? null,
        current.agent?.[field] ?? null,
        level,
        field === "model"
          ? "The model changed and must be re-assessed against the security baseline."
          : "Agent configuration drifted from the approved baseline.",
      );
    }
  }

  if (baseline.agent?.endpointConfigured !== current.agent?.endpointConfigured) {
    severity = maxSeverity(severity, "high");
    changed(
      changes,
      "endpointConfigured",
      "connection",
      baseline.agent?.endpointConfigured ?? false,
      current.agent?.endpointConfigured ?? false,
      "high",
      "The endpoint connection posture changed and needs a fresh connection check.",
    );
  }

  const baselineTools = new Map((baseline.tools ?? []).map((tool) => [tool.id, tool]));
  const currentTools = new Map((current.tools ?? []).map((tool) => [tool.id, tool]));
  for (const [id, tool] of currentTools) {
    if (!baselineTools.has(id)) {
      const level = tool.risk === "critical" ? "critical" : tool.sideEffect ? "high" : "medium";
      severity = maxSeverity(severity, level);
      changed(
        changes,
        `added:${id}`,
        "tool_registry",
        null,
        tool,
        level,
        tool.sideEffect
          ? "A new side-effect tool can expand the agent's blast radius."
          : "A new tool changed the agent's available capability surface.",
      );
    }
  }
  for (const [id, tool] of baselineTools) {
    if (!currentTools.has(id)) {
      severity = maxSeverity(severity, tool.sideEffect ? "high" : "medium");
      changed(
        changes,
        `removed:${id}`,
        "tool_registry",
        tool,
        null,
        tool.sideEffect ? "high" : "medium",
        "A previously reviewed tool is no longer available to the agent.",
      );
    }
  }

  for (const field of ["name", "maxAmount", "maxAgeDays", "currency", "enforcement"]) {
    if (baseline.policy?.[field] !== current.policy?.[field]) {
      const level = field === "maxAmount" || field === "maxAgeDays" || field === "enforcement" ? "critical" : "medium";
      severity = maxSeverity(severity, level);
      changed(
        changes,
        field,
        "policy",
        baseline.policy?.[field] ?? null,
        current.policy?.[field] ?? null,
        level,
        "The enforcement contract changed and must be re-verified before production traffic continues.",
      );
    }
  }

  return {
    drifted: changes.length > 0,
    severity: changes.length ? severity : "none",
    changes,
  };
}

export function sentinelStatus({ baseline, drift, enabled = true }) {
  if (!enabled) return "disabled";
  if (!baseline) return "unbaselined";
  if (drift.drifted) return "drifted";
  return "protected";
}
