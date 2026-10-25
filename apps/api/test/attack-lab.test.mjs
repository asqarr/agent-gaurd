import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAttackLab } from "../src/features/attack-lab/domain.mjs";

test("Attack Lab applies the real refund policy to synthetic calls without side effects", () => {
  const blocked = evaluateAttackLab({ scenarioId: "refund_policy", amount: 120 });
  assert.equal(blocked.decision, "BLOCK");
  assert.equal(blocked.execution, "NOT_EXECUTED");
  assert.equal(blocked.evidence.customerEndpointCalled, false);
  assert.equal(blocked.evidence.externalToolCalls, 0);
  assert.equal(blocked.evidence.financialSideEffects, 0);
  assert.match(blocked.reasons.join(" "), /maximum is 50/);

  const allowed = evaluateAttackLab({ scenarioId: "refund_policy", amount: 20 });
  assert.equal(allowed.decision, "ALLOW");
  assert.equal(allowed.execution, "SIMULATION_ONLY");
  assert.equal(allowed.evidence.externalToolCalls, 0);
  assert.equal(allowed.evidence.financialSideEffects, 0);

  const validCents = evaluateAttackLab({ scenarioId: "refund_policy", amount: 20.1 });
  assert.equal(validCents.decision, "ALLOW");
  assert.equal(evaluateAttackLab({ scenarioId: "refund_policy", amount: 50 }).decision, "ALLOW");
  assert.equal(evaluateAttackLab({ scenarioId: "refund_policy", amount: 50.01 }).decision, "BLOCK");
});

test("Attack Lab rejects an approval after a tool argument is changed", () => {
  const result = evaluateAttackLab({ scenarioId: "argument_tampering", changedAmount: 21 });
  assert.equal(result.decision, "BLOCK");
  assert.equal(result.execution, "NOT_EXECUTED");
  assert.equal(result.approval.signatureValid, true);
  assert.equal(result.approval.argumentsMatch, false);
  assert.equal(result.evidence.externalToolCalls, 0);
});

test("Attack Lab demonstrates one-time approval and rejects replay without execution", () => {
  const result = evaluateAttackLab({ scenarioId: "approval_replay" });
  assert.equal(result.decision, "BLOCK");
  assert.equal(result.approval.signatureValid, true);
  assert.equal(result.approval.firstAttemptAuthorized, true);
  assert.equal(result.approval.replayRejected, true);
  assert.equal(result.evidence.externalToolCalls, 0);
  assert.equal(result.evidence.financialSideEffects, 0);
});

test("Attack Lab validates scenario IDs and numeric input strictly", () => {
  assert.throws(() => evaluateAttackLab({ scenarioId: "unknown" }), { statusCode: 400 });
  assert.throws(() => evaluateAttackLab({ scenarioId: "refund_policy", amount: "120" }), { statusCode: 400 });
  assert.throws(() => evaluateAttackLab({ scenarioId: "refund_policy", amount: 5001 }), { statusCode: 400 });
  assert.throws(() => evaluateAttackLab({ scenarioId: "refund_policy", amount: 1.005 }), { statusCode: 400 });
  assert.throws(() => evaluateAttackLab({ scenarioId: "argument_tampering", changedAmount: 20 }), { statusCode: 400 });
});
