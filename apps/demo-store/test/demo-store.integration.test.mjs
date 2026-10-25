import "dotenv/config";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import test from "node:test";
import { createDemoStoreServer } from "../src/server.mjs";
import { stableStringify } from "@agentguard/sdk";

const databaseUrl = process.env.DEMO_STORE_DATABASE_URL ?? process.env.DATABASE_URL ??
  "postgresql://agentguard:agentguard@127.0.0.1:5432/agentguard";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForApi(baseUrl, process) {
  let lastError = "API did not become ready";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`Test API exited early: ${lastError}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
      lastError = `health returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Test API readiness timeout: ${lastError}`);
}

async function readJson(response) {
  return response.json().catch(() => ({}));
}

function signedReceipt({ token, agentId, approvalId, requestId, amount }) {
  const payload = {
    version: 1,
    approvalId,
    agentId,
    workspaceId: "demo-store-replay-test-workspace",
    requestId,
    tool: "issue_refund",
    arguments: { order_id: "DEMO-ORDER-100", amount },
    context: {
      actorId: "demo-customer-1",
      tenantId: "demo-merchant",
      orderId: "DEMO-ORDER-100",
      issuedAt: new Date().toISOString(),
    },
    consumedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
  return {
    payload,
    signature: createHmac("sha256", token).update(stableStringify(payload)).digest("base64url"),
  };
}

function postInternalRefund(baseUrl, receipt) {
  return fetch(`${baseUrl}/internal/tools/issue_refund`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toolCall: { name: receipt.payload.tool, arguments: receipt.payload.arguments }, executionReceipt: receipt }),
  });
}

test("sample store blocks the $100 bypass, executes an approved $40 refund, and reports scan evidence", async () => {
  const testSchema = `demo_store_test_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
  const apiPort = await freePort();
  const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
  const apiDirectory = fileURLToPath(new URL("../../api", import.meta.url));
  const apiProcess = spawn(process.execPath, [fileURLToPath(new URL("../../api/src/server.mjs", import.meta.url))], {
    cwd: apiDirectory,
    env: {
      ...process.env,
      API_HOST: "127.0.0.1",
      API_PORT: String(apiPort),
      ALLOW_PRIVATE_AGENT_ENDPOINTS: "true",
      NODE_ENV: "test",
    },
    stdio: "ignore",
  });

  let store;
  let storeReplica;
  let cookie;
  let agentId;
  let workspaceName;
  let workspaceId;
  const password = `DemoStore-E2E-${randomUUID()}-2026`;
  const email = `demo-store-e2e-${randomUUID()}@example.com`;
  let runtimeEnabled = false;
  try {
    await waitForApi(apiBaseUrl, apiProcess);
    const registerResponse = await fetch(`${apiBaseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        name: "Demo Store E2E",
        workspaceName: `Demo Store E2E ${randomUUID()}`,
      }),
    });
    assert.equal(registerResponse.status, 201, "the isolated E2E workspace should be created");
    const registered = await readJson(registerResponse);
    workspaceName = registered.user?.workspaceName;
    workspaceId = registered.user?.workspaceId;
    assert.ok(workspaceName);
    assert.ok(workspaceId);
    const cookies = registerResponse.headers.getSetCookie?.() ?? [registerResponse.headers.get("set-cookie") ?? ""];
    cookie = cookies.find((value) => value.startsWith("agentguard_session="))?.split(";", 1)[0];
    assert.ok(cookie);
    const upgradedTestPlan = await adminPool.query(
      `UPDATE workspace_subscriptions
       SET plan_id='builder', status='active', updated_at=NOW()
       WHERE workspace_id=$1`,
      [workspaceId],
    );
    assert.equal(upgradedTestPlan.rowCount, 1, "isolated E2E workspace should receive its test-only Runtime entitlement");

    const api = async (path, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Cookie", cookie);
      const response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers });
      return { response, body: await readJson(response) };
    };

    const currentPolicy = (await api("/api/overview")).body.policy;
    assert.equal(Number(currentPolicy.maxAmount), 50, "test workspace should use the $50 refund ceiling");

    store = createDemoStoreServer({ databaseUrl, schema: testSchema });
    await store.initialize();
    const storeAddress = await store.listen();
    const storeBaseUrl = `http://127.0.0.1:${storeAddress.port}`;
    const unconfiguredHealth = await (await fetch(`${storeBaseUrl}/health`)).json();
    assert.equal(unconfiguredHealth.gatewayConfigured, false);
    const agentCreated = await api("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `Demo Store E2E ${Date.now()}`,
        endpoint: `${storeBaseUrl}/agent/propose`,
        environment: "Staging",
        provider: "AgentGuard Demo Store",
        model: "synthetic-refund-agent-v1",
        toolIds: ["get_order", "issue_refund"],
      }),
    });
    assert.equal(agentCreated.response.status, 201, agentCreated.body.error);
    agentId = agentCreated.body.agent.id;

    const enabled = await api(`/api/agents/${agentId}/runtime/enable`, { method: "POST" });
    assert.equal(enabled.response.status, 200, enabled.body.error);
    runtimeEnabled = true;
    store.configureGateway({ baseUrl: apiBaseUrl, agentId, token: enabled.body.token });
    const configuredHealth = await (await fetch(`${storeBaseUrl}/health`)).json();
    assert.equal(configuredHealth.gatewayConfigured, true);

    const unsafeRefund = await fetch(`${storeBaseUrl}/api/refunds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: "DEMO-ORDER-100", amount: 100 }),
    });
    const unsafeBody = await readJson(unsafeRefund);
    assert.equal(unsafeRefund.status, 200);
    assert.equal(unsafeBody.guard.decision, "BLOCK");
    assert.equal(unsafeBody.guard.execution, "NOT_EXECUTED");
    assert.deepEqual(unsafeBody.executions, []);
    assert.equal(unsafeBody.sideEffectExecuted, false);

    const directBypass = await fetch(`${storeBaseUrl}/internal/tools/issue_refund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolCall: { name: "issue_refund", arguments: { order_id: "DEMO-ORDER-100", amount: 100 } } }),
    });
    const directBody = await readJson(directBypass);
    assert.equal(directBypass.status, 403);
    assert.equal(directBody.code, "AGENTGUARD_RECEIPT_REQUIRED");

    const emptyLedger = await (await fetch(`${storeBaseUrl}/internal/refunds`)).json();
    assert.deepEqual(emptyLedger.refunds, [], "neither blocked nor direct calls may mutate the store ledger");

    const allowedRefund = await fetch(`${storeBaseUrl}/api/refunds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: "DEMO-ORDER-100", amount: 40 }),
    });
    const allowedBody = await readJson(allowedRefund);
    assert.equal(allowedRefund.status, 200);
    assert.equal(allowedBody.guard.decision, "ALLOW");
    assert.equal(allowedBody.executions.length, 1);
    assert.equal(allowedBody.executions[0].amount, 40);
    assert.equal(allowedBody.sideEffectExecuted, true);
    const ledger = await (await fetch(`${storeBaseUrl}/internal/refunds`)).json();
    assert.equal(ledger.refunds.length, 1);
    assert.equal(ledger.refunds[0].approvalId, allowedBody.executions[0].approvalId);

    const queued = await api("/api/scans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId,
        trigger: "Demo store E2E",
        scenarioIds: ["valid_refund", "amount_limit", "expired_order", "untrusted_claim", "boundary_refund"],
      }),
    });
    assert.equal(queued.response.status, 202, queued.body.error);
    let scan = queued.body.scan;
    for (let attempt = 0; attempt < 80 && ["queued", "running"].includes(scan.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      scan = (await api(`/api/scans/${scan.id}`)).body.scan;
    }
    assert.equal(scan.status, "completed");
    assert.equal(scan.results.length, 5);
    const overLimit = scan.results.find((result) => result.scenarioId === "amount_limit");
    assert.equal(overLimit.guard.decision, "BLOCK");
    assert.equal(overLimit.guard.execution, "NOT_EXECUTED");

    const reportResponse = await fetch(`${apiBaseUrl}/api/scans/${scan.id}/report`, { headers: { Cookie: cookie } });
    const report = await reportResponse.text();
    assert.equal(reportResponse.status, 200);
    assert.match(report, /Commercial impact/);
    assert.match(report, /Reproduction recipe/);
    assert.match(report, /Developer fix \/ Remediation/);
    assert.match(report, /issue_refund/);

    const replayReceipt = signedReceipt({
      token: enabled.body.token,
      agentId,
      approvalId: `approval-replay-${randomUUID()}`,
      requestId: `request-replay-${randomUUID()}`,
      amount: 25,
    });
    storeReplica = createDemoStoreServer({ databaseUrl, schema: testSchema });
    await storeReplica.initialize();
    const replicaAddress = await storeReplica.listen();
    const replicaBaseUrl = `http://127.0.0.1:${replicaAddress.port}`;
    storeReplica.configureGateway({ baseUrl: apiBaseUrl, agentId, token: enabled.body.token });

    const concurrentAttempts = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      postInternalRefund(index % 2 ? replicaBaseUrl : storeBaseUrl, replayReceipt)));
    assert.equal(concurrentAttempts.filter((response) => response.status === 200).length, 1);
    assert.equal(concurrentAttempts.filter((response) => response.status === 409).length, 7);
    const concurrentReplayError = await concurrentAttempts.find((response) => response.status === 409).json();
    assert.equal(concurrentReplayError.code, "EXECUTION_RECEIPT_REPLAYED");

    const rollbackReceipt = signedReceipt({
      token: enabled.body.token,
      agentId,
      approvalId: `approval-rollback-${randomUUID()}`,
      requestId: "force-rollback",
      amount: 20,
    });
    await adminPool.query(
      `ALTER TABLE ${testSchema}.refunds
       ADD CONSTRAINT demo_store_e2e_force_rollback CHECK (request_id <> 'force-rollback')`,
    );
    let rolledBackAttempt;
    try {
      rolledBackAttempt = await postInternalRefund(storeBaseUrl, rollbackReceipt);
    } finally {
      await adminPool.query(
        `ALTER TABLE ${testSchema}.refunds
         DROP CONSTRAINT IF EXISTS demo_store_e2e_force_rollback`,
      );
    }
    assert.equal(rolledBackAttempt.status, 500, "a synthetic ledger failure must fail the tool execution");
    assert.equal((await readJson(rolledBackAttempt)).error, "Demo Store request failed.");
    const rolledBackApproval = await adminPool.query(
      `SELECT approval_id FROM ${testSchema}.consumed_approvals WHERE approval_id=$1`,
      [rollbackReceipt.payload.approvalId],
    );
    assert.equal(rolledBackApproval.rowCount, 0, "failed refund insertion must roll back receipt consumption");

    const retryAfterRollback = await postInternalRefund(replicaBaseUrl, rollbackReceipt);
    assert.equal(retryAfterRollback.status, 200, "the same receipt can be retried after the transaction rolled back");

    await store.close();
    store = createDemoStoreServer({ databaseUrl, schema: testSchema });
    await store.initialize();
    await store.listen(storeAddress.port);
    store.configureGateway({ baseUrl: apiBaseUrl, agentId, token: enabled.body.token });

    const persistedLedger = await (await fetch(`${storeBaseUrl}/internal/refunds`)).json();
    assert.equal(persistedLedger.refunds.length, 3, "refunds must survive a store process restart");
    const replayAfterRestart = await postInternalRefund(replicaBaseUrl, replayReceipt);
    assert.equal(replayAfterRestart.status, 409, "a consumed receipt must remain unusable after restart");
    assert.equal((await readJson(replayAfterRestart)).code, "EXECUTION_RECEIPT_REPLAYED");
    const rollbackReplayAfterRestart = await postInternalRefund(storeBaseUrl, rollbackReceipt);
    assert.equal(rollbackReplayAfterRestart.status, 409, "a committed retry must remain consumed after restart");
    const ledgerAfterReplay = await (await fetch(`${storeBaseUrl}/internal/refunds`)).json();
    assert.equal(ledgerAfterReplay.refunds.length, 3, "a replay must not create another refund");
  } finally {
    if (agentId && cookie) {
      const headers = new Headers({ Cookie: cookie });
      if (runtimeEnabled) await fetch(`${apiBaseUrl}/api/agents/${agentId}/runtime/disable`, { method: "POST", headers }).catch(() => {});
      await fetch(`${apiBaseUrl}/api/agents/${agentId}`, { method: "DELETE", headers }).catch(() => {});
    }
    if (cookie && workspaceName) {
      await fetch(`${apiBaseUrl}/api/settings/workspace/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ confirmation: workspaceName, password }),
      }).catch(() => {});
    }
    if (store) await store.close().catch(() => {});
    if (storeReplica) await storeReplica.close().catch(() => {});
    try {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE`);
    } finally {
      await adminPool.end();
    }
    if (apiProcess.exitCode === null) apiProcess.kill();
  }
});
