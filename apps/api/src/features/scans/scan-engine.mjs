import { randomUUID } from "node:crypto";
import { scenarios } from "../catalog/domain.mjs";
import { inspectRuntimeCall } from "../runtime/runtime-firewall.mjs";
import { requestAgentScenario } from "../agents/agent-client.mjs";
import { redactToolCall } from "./evidence-redaction.mjs";
import {
  SCAN_CATALOG_VERSION,
  executionModeFor,
  finalVerdictFor,
  safetyStatusFor,
  statusForVerdict,
  summarizeScanResults,
} from "./scan-verdict.mjs";

function describeToolCall(call) {
  let argumentsText = "{}";
  try {
    argumentsText = JSON.stringify(redactToolCall(call)?.arguments ?? {});
  } catch {
    argumentsText = "[unserializable arguments]";
  }
  return `${call.name}(${argumentsText.slice(0, 280)})`;
}

export function evaluateScenario(scenario, calls, options = {}) {
  const toolCalls = Array.isArray(calls) ? calls : [];
  const executionSafety = options.executionSafety ?? (options.source === "customer_endpoint" ? "unknown" : "safe");
  if (toolCalls.length === 0) {
    const verdict = finalVerdictFor({
      scenario,
      validAllowedCall: false,
      protectedBlockedCall: false,
      agentRefused: true,
      executionSafety: options.executionSafety,
      source: options.source,
    });
    return {
      status: statusForVerdict(verdict),
      verdict,
      agentBehavior: "REFUSED",
      observed: "No tool call",
      guard: null,
      reasons: [],
      call: null,
      executionSafety,
      executionMode: executionModeFor(options.source),
    };
  }

  const decisions = toolCalls.map((call) => ({
    call,
    guard: inspectRuntimeCall(call, {
      allowedToolIds: options.allowedToolIds,
      policy: options.policy,
      orders: options.orders,
    }),
  }));
  const blocked = decisions.find((item) => item.guard.decision === "BLOCK");
  const first = decisions[0];
  const validAllowedCall =
    toolCalls.length === 1 && first.guard.decision === "ALLOW";
  const protectedBlockedCall = blocked !== undefined;
  const verdict = finalVerdictFor({
    scenario,
    validAllowedCall,
    protectedBlockedCall,
    executionSafety: options.executionSafety,
    source: options.source,
  });

  return {
    status: statusForVerdict(verdict),
    verdict,
    agentBehavior: "PROPOSED",
    observed: toolCalls.map(describeToolCall).join("; "),
    guard: {
      decision: blocked ? "BLOCK" : "ALLOW",
      execution: blocked ? "NOT_EXECUTED" : "SIMULATED",
    },
    reasons: decisions.flatMap((item) => item.guard.reasons),
    call: redactToolCall(first.call),
    executionSafety,
    executionMode: executionModeFor(options.source),
  };
}

export async function runAgentScan({
  agent,
  requestScenario = requestAgentScenario,
  policy,
  allowedToolIds,
  now = new Date(),
  onScenarioUpdate,
  scenarios: selectedScenarios = scenarios,
  scanId = "scan-local",
}) {
  const startedAt = Date.now();
  const results = [];
  let safetyStatus = "safe";
  let safetyWarning = null;

  for (const [index, scenario] of selectedScenarios.entries()) {
    await onScenarioUpdate?.({
      scenario,
      index,
      total: selectedScenarios.length,
      status: "running",
    });

    const scenarioStartedAt = Date.now();
    try {
      const requestId = `${scanId}:${scenario.id}`;
      const response = await requestScenario(agent, scenario, { requestId });
      safetyStatus = safetyStatusFor(safetyStatus, response.executionSafety, response.source);
      if (safetyStatus === "unsafe") {
        safetyWarning = "The customer endpoint reported that it executed a tool during a security scan. Stop production scanning and move the agent behind Runtime Firewall or a mock/staging executor.";
      } else if (safetyStatus === "unknown_endpoint") {
        safetyWarning = "AgentGuard cannot prove that the customer endpoint's internal executor stayed inert. Use a mock/staging endpoint or route execution through Runtime Firewall.";
      }
      const result = {
        scenarioId: scenario.id,
        title: scenario.title,
        category: scenario.category,
        expected: scenario.expected,
        ...evaluateScenario(scenario, response.toolCalls, {
          policy,
          allowedToolIds,
          executionSafety: response.executionSafety,
          source: response.source,
        }),
        source: response.source,
        requestId: response.requestId ?? requestId,
        attempt: response.attempt ?? 1,
        safetyWarning: response.executionSafety === "unsafe"
          ? "Endpoint reported a real tool execution during scan."
          : undefined,
        durationMs: Math.max(1, Date.now() - scenarioStartedAt),
      };
      results.push(result);
      await onScenarioUpdate?.({
        scenario,
        index,
        total: selectedScenarios.length,
        status: result.verdict === "INCONCLUSIVE"
          ? "error"
          : result.guard?.decision === "BLOCK"
            ? "blocked"
          : result.status === "PASS"
            ? "passed"
            : "failed",
        result,
        durationMs: Math.max(1, Date.now() - scenarioStartedAt),
      });
    } catch (error) {
      await onScenarioUpdate?.({
        scenario,
        index,
        total: selectedScenarios.length,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        durationMs: Math.max(1, Date.now() - scenarioStartedAt),
      });
      throw error;
    }
  }

  const summary = summarizeScanResults(results);

  return {
    id: `scan-${randomUUID().slice(0, 8)}`,
    agentId: agent.id,
    status: "completed",
    ...summary,
    durationMs: Math.max(1, Date.now() - startedAt),
    createdAt: now.toISOString(),
    trigger: "Manual",
    catalogVersion: SCAN_CATALOG_VERSION,
    safetyStatus,
    safetyWarning,
    results,
  };
}

export function runScan({ agent, trigger = "Manual", now = new Date() }) {
  const localRequest = async (currentAgent, scenario) => {
    const mistake =
      currentAgent.mode === "needs_attention" &&
      ["amount_limit", "expired_order", "untrusted_claim", "indirect_injection"].includes(scenario.id);
    const toolCalls =
      scenario.expected === "allow" || mistake
        ? [
            {
              name: "issue_refund",
              arguments: {
                order_id: scenario.orderId,
                amount: scenario.amount,
              },
            },
          ]
        : [];
    return { assistantText: "", toolCalls, source: "seed_simulator", executionSafety: "safe" };
  };

  return runAgentScan({ agent, requestScenario: localRequest, now }).then(
    (scan) => ({ ...scan, trigger }),
  );
}
3;
