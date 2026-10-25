import assert from "node:assert/strict";
import test from "node:test";
import { attackPaths, evaluateAttackPath } from "../src/features/catalog/domain.mjs";
import {
  compareScanEvidence,
  compareSecurityContracts,
  defaultSecurityContract,
  normalizeSecurityContract,
} from "../src/features/contracts/domain.mjs";

test("security contracts can only narrow the configured tool boundary", () => {
  const contract = normalizeSecurityContract(
    {
      allowedToolIds: ["get_order", "issue_refund", "unknown_tool"],
      maxRefundAmount: 25,
      maxOrderAgeDays: 7,
      notes: "Refunds need a trusted boundary",
    },
    { agentToolIds: ["get_order", "issue_refund"], policy: { maxAmount: 50, maxAgeDays: 14 } },
  );
  assert.deepEqual(contract.allowedToolIds, ["get_order", "issue_refund"]);
  assert.equal(contract.maxRefundAmount, 25);
  assert.equal(contract.maxOrderAgeDays, 7);
  assert.throws(
    () => normalizeSecurityContract({ allowedToolIds: [] }, { agentToolIds: ["get_order"] }),
    { code: "INVALID_SECURITY_CONTRACT" },
  );
  const narrowed = normalizeSecurityContract(
    { allowedToolIds: ["get_order"], maxRefundAmount: 500, maxOrderAgeDays: 90 },
    { agentToolIds: ["get_order"], policy: { maxAmount: 50, maxAgeDays: 14 } },
  );
  assert.equal(narrowed.maxRefundAmount, 50);
  assert.equal(narrowed.maxOrderAgeDays, 14);
  assert.deepEqual(defaultSecurityContract({ agentToolIds: ["get_order"] }).allowedToolIds, ["get_order"]);
});

test("attack paths produce protected and vulnerable chain evidence", () => {
  const path = attackPaths.find((item) => item.id === "cross-tenant-exfiltration");
  assert.ok(path);
  const protectedPath = evaluateAttackPath(path, path.scenarioIds.map((scenarioId) => ({ scenarioId, status: "PASS", observed: "blocked", guard: { decision: "BLOCK", execution: "NOT_EXECUTED" }, reasons: [] })));
  assert.equal(protectedPath.status, "protected");
  const vulnerablePath = evaluateAttackPath(path, [{ scenarioId: path.scenarioIds[0], status: "FAIL", observed: "allowed", guard: { decision: "ALLOW", execution: "SIMULATED" }, reasons: ["Boundary bypass"] }]);
  assert.equal(vulnerablePath.status, "vulnerable");
});

test("contract comparison detects widened boundaries and scan regressions", () => {
  const before = {
    version: 1,
    allowedToolIds: ["get_order", "issue_refund"],
    maxRefundAmount: 25,
    maxOrderAgeDays: 7,
    notes: "baseline",
  };
  const after = {
    version: 2,
    allowedToolIds: ["get_order", "issue_refund", "create_ticket"],
    maxRefundAmount: 50,
    maxOrderAgeDays: 14,
    notes: "widened",
  };
  const contractDiff = compareSecurityContracts(before, after);
  assert.equal(contractDiff.status, "weakened");
  assert.deepEqual(contractDiff.addedTools, ["create_ticket"]);
  assert.equal(contractDiff.boundaryChanges.length, 2);
  const evidence = compareScanEvidence(
    {
      score: 100,
      results: [{ scenarioId: "amount_limit", status: "PASS" }],
      attackPaths: [{ id: "refund-guard-baseline", status: "protected" }],
    },
    {
      score: 75,
      results: [{ scenarioId: "amount_limit", status: "FAIL" }],
      attackPaths: [{ id: "refund-guard-baseline", status: "vulnerable" }],
    },
  );
  assert.equal(evidence.verdict, "regressed");
  assert.equal(evidence.regressedCount, 2);
  assert.equal(evidence.scoreDelta, -25);
});
