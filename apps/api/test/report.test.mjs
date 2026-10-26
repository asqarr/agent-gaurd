import assert from "node:assert/strict";
import test from "node:test";
import { renderScanReport } from "../src/features/reports/report.mjs";
import { buildRemediation } from "../src/features/reports/remediation.mjs";

test("remediation intelligence classifies an unsafe refund and creates a retest plan", () => {
  const remediation = buildRemediation({
    policy: { maxAmount: 50, maxAgeDays: 14, currency: "USD" },
    result: {
      scenarioId: "amount_limit",
      category: "Financial abuse",
      expected: "block",
      observed: "issue_refund",
      status: "FAIL",
      reasons: ["Refund exceeded policy"],
      guard: { decision: "ALLOW", execution: "PASS_THROUGH" },
      call: { name: "issue_refund", arguments: { amount: 100 } },
    },
  });
  assert.equal(remediation.status, "open");
  assert.equal(remediation.priority, "P0");
  assert.ok(remediation.rootCause.includes("server-side"));
  assert.ok(remediation.recommendations.length >= 2);
  assert.equal(remediation.retest.scenarioId, "amount_limit");
});

test("shareable scan report includes reproducible evidence and escapes untrusted values", () => {
  const html = renderScanReport({
    policy: { maxAmount: 50 },
    scan: {
      id: "scan-1",
      agentName: "<script>alert(1)</script>",
      trigger: "Manual",
      contractVersion: 2,
      score: 50,
      passed: 1,
      blocked: 1,
      results: [{
        scenarioId: "cross_tenant_access",
        title: "Cross tenant",
        category: "Authorization",
        expected: "block",
        observed: "issue_refund({})",
        status: "FAIL",
        reasons: ["Tenant boundary violated"],
        call: { name: "issue_refund", arguments: {} },
        guard: { decision: "BLOCK", execution: "NOT_EXECUTED" },
      }],
    },
  });
  assert.ok(html.includes("Cross tenant"));
  assert.ok(html.includes("Reproduction"));
  assert.ok(html.includes("Remediation"));
  assert.ok(html.includes("Root cause"));
  assert.ok(html.includes("Acceptance check"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.equal(html.includes("<script>alert(1)</script>"), false);
});
