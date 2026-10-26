import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { closeDatabase, migrate, query, withAdvisoryLock } from "../src/core/db.mjs";
import * as repository from "../src/infrastructure/repository.mjs";
import {
  claimNextJob,
  touchScanJob,
} from "../src/features/scans/scan-queue-repository.mjs";
import {
  completeReconciliationRun,
  startReconciliationRun,
} from "../src/features/billing/reconciliation-repository.mjs";
import { processCryptoPaymentReconciliation } from "../src/features/billing/payment-reconciliation-worker.mjs";

await migrate();

test("persistent scan leases recover and reject stale workers", async (t) => {
  const scope = await query(
    `SELECT w.id AS workspace_id, a.id AS agent_id
     FROM workspaces w JOIN agents a ON a.workspace_id=w.id
     ORDER BY w.created_at ASC LIMIT 1`,
  );
  assert.ok(scope.rows[0], "the integration database needs a seeded workspace and agent");
  const scanId = `queue-test-scan-${randomUUID()}`;
  const jobId = `queue-test-job-${randomUUID()}`;
  const { workspace_id: workspaceId, agent_id: agentId } = scope.rows[0];
  await query(
    `INSERT INTO scans (id, workspace_id, agent_id, status, trigger)
     VALUES ($1, $2, $3, 'running', 'Queue lease integration test')`,
    [scanId, workspaceId, agentId],
  );
  await query(
    `INSERT INTO scan_jobs
       (id, scan_id, status, attempts, locked_at, heartbeat_at, lease_token, locked_by)
     VALUES ($1, $2, 'running', 1, NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes', $3, 'dead-worker')`,
    [jobId, scanId, "dead-lease"],
  );
  t.after(async () => {
    await query("DELETE FROM scans WHERE id=$1", [scanId]);
  });

  const reclaimed = await claimNextJob({ leaseMs: 1000, maxAttempts: 3, workerId: "recovery-worker" });
  assert.equal(reclaimed.scan_id, scanId);
  assert.equal(reclaimed.attempts, 2);
  assert.equal(reclaimed.locked_by, "recovery-worker");
  assert.notEqual(reclaimed.lease_token, "dead-lease");
  await assert.rejects(
    () => touchScanJob({ jobId, leaseToken: "dead-lease" }),
    { code: "SCAN_LEASE_LOST" },
  );
  await touchScanJob({ jobId, leaseToken: reclaimed.lease_token });
});

test("reconciliation runs are serialized by PostgreSQL and retain an auditable result", async (t) => {
  const lockKey = `integration-lock-${randomUUID()}`;
  let release;
  const held = withAdvisoryLock(lockKey, async () => new Promise((resolve) => {
    release = resolve;
  }));
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
  const competing = await withAdvisoryLock(lockKey, async () => "should-not-run");
  assert.equal(competing.acquired, false);
  release();
  await held;

  const run = await startReconciliationRun({ provider: "tron-p2p", metadata: { test: true } });
  const completed = await completeReconciliationRun({
    runId: run.id,
    result: { scanned: 4, completed: 1, exceptions: 2, expired: 1 },
    metadata: { source: "integration-test" },
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.scanned_count, 4);
  assert.equal(completed.completed_count, 1);
  assert.equal(completed.exception_count, 2);
  assert.equal(completed.expired_count, 1);
  await query("DELETE FROM billing_reconciliation_runs WHERE id=$1", [run.id]);
});

test("TRON reconciliation settles an exact transfer once and records the run", async (t) => {
  const workspaceId = `tron-reconciliation-workspace-${randomUUID()}`;
  const subscriptionId = `tron-reconciliation-subscription-${randomUUID()}`;
  const walletAddress = "TDg6Vo6pkvKLy1jPpD4LBSLa3EwrVEk2JP";
  const contract = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  const originalFetch = globalThis.fetch;
  const previous = {
    wallet: process.env.MY_TRONLINK_PUBLIC_ADDRESS,
    contract: process.env.TRON_USDT_CONTRACT,
    grid: process.env.TRON_GRID_URL,
    scan: process.env.TRONSCAN_API_URL,
  };
  process.env.MY_TRONLINK_PUBLIC_ADDRESS = walletAddress;
  process.env.TRON_USDT_CONTRACT = contract;
  process.env.TRON_GRID_URL = "https://grid.integration.test";
  process.env.TRONSCAN_API_URL = "https://scan.integration.test";

  await query(
    `INSERT INTO workspaces (id, name) VALUES ($1, 'TRON reconciliation integration')`,
    [workspaceId],
  );
  await query(
    `INSERT INTO workspace_subscriptions
       (id, workspace_id, plan_id, status, billing_provider, current_period_start, current_period_end)
     VALUES ($1, $2, 'free', 'active', 'internal', DATE_TRUNC('month', NOW()), DATE_TRUNC('month', NOW()) + INTERVAL '1 month')`,
    [subscriptionId, workspaceId],
  );
  const checkout = await repository.createCheckoutSession({
    workspaceId,
    planId: "builder",
    provider: "tron-p2p",
    idempotencyKey: `tron-reconciliation-${randomUUID()}`,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
  const txHash = `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{
    transaction_id: txHash,
    token_info: { address: contract, decimals: 6 },
    from: "Tsender111111111111111111111111111",
    to: walletAddress,
    value: checkout.paymentAmountAtomic,
    block_timestamp: Date.now(),
    confirmed: true,
    contract_ret: "SUCCESS",
  }] }), { status: 200, headers: { "Content-Type": "application/json" } });

  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries({
      MY_TRONLINK_PUBLIC_ADDRESS: previous.wallet,
      TRON_USDT_CONTRACT: previous.contract,
      TRON_GRID_URL: previous.grid,
      TRONSCAN_API_URL: previous.scan,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await query("DELETE FROM workspaces WHERE id=$1", [workspaceId]);
  });

  const first = await processCryptoPaymentReconciliation();
  assert.equal(first.skipped, false);
  assert.equal(first.completed, 1);
  const settled = await query(
    `SELECT c.status, s.plan_id, p.tx_hash
     FROM billing_checkout_sessions c
     JOIN workspace_subscriptions s ON s.workspace_id=c.workspace_id
     JOIN billing_payments p ON p.checkout_session_id=c.id
     WHERE c.id=$1`,
    [checkout.id],
  );
  assert.equal(settled.rows[0].status, "completed");
  assert.equal(settled.rows[0].plan_id, "builder");
  assert.equal(settled.rows[0].tx_hash, txHash);

  const second = await processCryptoPaymentReconciliation();
  assert.equal(second.completed, 0);
  const paymentCount = await query(
    "SELECT COUNT(*)::int AS count FROM billing_payments WHERE tx_hash=$1",
    [txHash],
  );
  assert.equal(paymentCount.rows[0].count, 1);
});

test.after(() => closeDatabase());
