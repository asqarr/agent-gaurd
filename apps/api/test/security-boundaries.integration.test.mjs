import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import test from "node:test";

const configuredBaseUrl = process.env.AGENTGUARD_SECURITY_API_URL ?? "";
let baseUrl = configuredBaseUrl;
const databaseUrl = process.env.DATABASE_URL ??
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
    if (process.exitCode !== null) throw new Error(`Security test API exited early: ${lastError}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
      lastError = `health returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Security test API readiness timeout: ${lastError}`);
}

async function jsonRequest(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  return { response, body: await response.json().catch(() => ({})) };
}

function cookieFrom(response, name = "agentguard_session") {
  const values = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  return values.find((value) => value.startsWith(`${name}=`))?.split(";", 1)[0] ?? "";
}

test("workspace boundaries reject cross-tenant access and unsafe production scans", async (t) => {
  let apiProcess;
  const cleanupCallbacks = [];
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
  t.after(async () => {
    try {
      for (const cleanup of cleanupCallbacks.reverse()) await cleanup();
    } finally {
      await adminPool.end();
      if (apiProcess?.exitCode === null) apiProcess.kill();
    }
  });

  if (!baseUrl) {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const apiDirectory = fileURLToPath(new URL("..", import.meta.url));
    apiProcess = spawn(process.execPath, [fileURLToPath(new URL("../src/server.mjs", import.meta.url))], {
      cwd: apiDirectory,
      env: {
        ...process.env,
        API_HOST: "127.0.0.1",
        API_PORT: String(port),
        ALLOW_PRIVATE_AGENT_ENDPOINTS: "true",
        NODE_ENV: "test",
      },
      stdio: "ignore",
    });
    await waitForApi(baseUrl, apiProcess);
  }

  const ownerPassword = `Tenant-E2E-${randomUUID()}-2026`;
  const ownerRegistration = await jsonRequest("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `tenant-owner-${randomUUID()}@example.com`,
      password: ownerPassword,
      name: "Tenant Isolation Owner",
      workspaceName: `Tenant isolation ${randomUUID()}`,
    }),
  });
  assert.equal(ownerRegistration.response.status, 201);
  const ownerCookie = cookieFrom(ownerRegistration.response);
  assert.ok(ownerCookie);
  const ownerWorkspaceId = ownerRegistration.body.user?.workspaceId;
  const ownerWorkspaceName = ownerRegistration.body.user?.workspaceName;
  assert.ok(ownerWorkspaceId);
  assert.ok(ownerWorkspaceName);
  const ownerApi = (path, init = {}) => jsonRequest(path, {
    ...init,
    headers: { ...(init.headers ?? {}), Cookie: ownerCookie },
  });
  cleanupCallbacks.push(async () => {
    await ownerApi("/api/settings/workspace/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: ownerWorkspaceName, password: ownerPassword }),
    }).catch(() => {});
  });
  const testPlan = await adminPool.query(
    `UPDATE workspace_subscriptions
     SET plan_id='team', status='active', updated_at=NOW()
     WHERE workspace_id=$1`,
    [ownerWorkspaceId],
  );
  assert.equal(testPlan.rowCount, 1, "isolated owner workspace should receive a test-only plan entitlement");
  const createdAgent = await ownerApi("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `Tenant isolation ${Date.now()}`,
      endpoint: null,
      toolIds: ["get_order"],
    }),
  });
  assert.equal(createdAgent.response.status, 201);
  const ownerAgentId = createdAgent.body.agent.id;

  const productionAgent = await ownerApi("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `Production scan guard ${Date.now()}`,
      endpoint: "https://8.8.8.8/chat",
      environment: "Production",
      toolIds: ["issue_refund"],
    }),
  });
  assert.equal(productionAgent.response.status, 201);
  const productionAgentId = productionAgent.body.agent.id;
  const crossEmail = `tenant-${randomUUID()}@example.com`;
  const crossPassword = `Tenant-Cross-${randomUUID()}-2026`;
  const registered = await jsonRequest("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: crossEmail,
      password: crossPassword,
      name: "Isolation Test User",
      workspaceName: `Isolation workspace ${Date.now()}`,
    }),
  });
  assert.equal(registered.response.status, 201);
  const crossCookie = cookieFrom(registered.response);
  assert.ok(crossCookie);
  const crossApi = (path, init = {}) => jsonRequest(path, {
    ...init,
    headers: { ...(init.headers ?? {}), Cookie: crossCookie },
  });
  cleanupCallbacks.push(async () => {
    await crossApi("/api/settings/workspace/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: registered.body.user?.workspaceName, password: crossPassword }),
    }).catch(() => {});
  });

  const crossTenantAgent = await crossApi(`/api/agents/${ownerAgentId}`);
  assert.equal(crossTenantAgent.response.status, 404);
  const crossTenantContract = await crossApi(`/api/agents/${ownerAgentId}/security-contract`);
  assert.equal(crossTenantContract.response.status, 404);

  const productionScan = await ownerApi("/api/scans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: productionAgentId, trigger: "Production safety acceptance test" }),
  });
  assert.equal(productionScan.response.status, 409);
  assert.equal(productionScan.body.code, "PRODUCTION_SCAN_BLOCKED");
});
