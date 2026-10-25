import assert from "node:assert/strict";
import test from "node:test";
import { assessmentPhase, buildSecurityBlueprint } from "../src/features/autopilot/domain.mjs";

function scanWith(results, overrides = {}) {
  return {
    status: "completed",
    score: 75,
    passed: results.filter((result) => result.status === "PASS").length,
    failed: results.filter((result) => result.status === "FAIL").length,
    results,
    ...overrides,
  };
}

test("autopilot builds an honest blueprint from scan evidence and fail-closed tools", () => {
  const blueprint = buildSecurityBlueprint({
    agent: { tools: ["get_order", "issue_refund"], runtimeEnabled: false },
    policy: { maxAmount: 50, maxAgeDays: 14, currency: "USD" },
    connection: { status: "reachable", latencyMs: 42, message: "ok", responseFormat: "tool_calls" },
    scan: scanWith([
      {
        scenarioId: "indirect_injection",
        title: "Injected order note",
        category: "Indirect prompt injection",
        status: "FAIL",
        observed: "issue_refund({})",
        guard: { decision: "ALLOW" },
        reasons: [],
        call: { name: "issue_refund", arguments: {} },
      },
      {
        scenarioId: "valid_refund",
        title: "Valid refund",
        category: "Policy",
        status: "PASS",
        observed: "issue_refund({})",
        guard: { decision: "ALLOW" },
        reasons: [],
        call: { name: "issue_refund", arguments: {} },
      },
      {
        scenarioId: "unknown_case",
        title: "Unknown tool",
        category: "Tool abuse",
        status: "PASS",
        observed: "delete_everything({})",
        guard: { decision: "BLOCK" },
        reasons: ["unregistered"],
        call: { name: "delete_everything", arguments: {} },
      },
    ]),
  });

  assert.equal(blueprint.stats.findings, 1);
  assert.equal(blueprint.stats.criticalFindings, 1);
  assert.equal(blueprint.stats.unknownTools, 1);
  assert.equal(blueprint.connection.simulated, false);
  assert.equal(blueprint.findings[0].id, "indirect_injection");
  assert.equal(blueprint.recommendations.find((item) => item.id === "runtime_firewall").status, "ready");
  assert.equal(blueprint.recommendations.find((item) => item.id === "fail_closed_allowlist").status, "active");
});

test("autopilot phase reflects scan progress and approval state", () => {
  assert.equal(assessmentPhase({ assessment: {}, scan: { status: "queued" } }), "connecting");
  assert.equal(assessmentPhase({ assessment: {}, scan: { status: "running", progress: [{ status: "queued" }] } }), "inventory");
  assert.equal(assessmentPhase({ assessment: {}, scan: { status: "running", progress: [{ status: "running" }] } }), "testing");
  assert.equal(assessmentPhase({ assessment: {}, scan: { status: "completed" }, blueprint: {} }), "blueprint");
  assert.equal(assessmentPhase({ assessment: { appliedAt: "2026-10-08T00:00:00.000Z" }, scan: { status: "completed" }, blueprint: {} }), "protected");
});
