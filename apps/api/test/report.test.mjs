import assert from "node:assert/strict";
import test from "node:test";
import { renderScanReport } from "../src/features/reports/report.mjs";

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
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.equal(html.includes("<script>alert(1)</script>"), false);
});
