import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import test from "node:test";

const configuredBaseUrl = process.env.AGENTGUARD_RUNTIME_API_URL ?? "";
const databaseUrl = process.env.DATABASE_URL ??
  "postgresql://agentguard:agentguard@127.0.0.1:5432/agentguard";

async function readJson(response) {
  return response.json().catch(() => ({}));
}

async function waitForApi(baseUrl, child) {
  let lastError = "API did not become ready";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Runtime test API exited before readiness: ${lastError}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
      lastError = `health returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Runtime test API readiness timeout: ${lastError}`);
}

test("runtime gateway binds approvals, blocks unsafe refunds, and rejects replay/tamper", async (t) => {
  const managedApi = !configuredBaseUrl;
  const baseUrl = configuredBaseUrl || "http://127.0.0.1:4101";
  let apiProcess;
  let upstream;
  const cleanupCallbacks = [];
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
  t.after(async () => {
    try {
      for (const cleanup of cleanupCallbacks.reverse()) await cleanup();
    } finally {
      if (upstream?.listening) await new Promise((resolve) => upstream.close(resolve));
      if (apiProcess?.exitCode === null) apiProcess.kill();
      await adminPool.end();
    }
  });
  if (managedApi) {
    const apiDirectory = fileURLToPath(new URL("..", import.meta.url));
    apiProcess = spawn(process.execPath, [fileURLToPath(new URL("../src/server.mjs", import.meta.url))], {
      cwd: apiDirectory,
      env: {
        ...process.env,
        API_HOST: "127.0.0.1",
        API_PORT: "4101",
        ALLOW_PRIVATE_AGENT_ENDPOINTS: "true",
        AGENT_REQUEST_TIMEOUT_MS: "250",
        NODE_ENV: "test",
      },
      stdio: "ignore",
    });
    await waitForApi(baseUrl, apiProcess);
  }

  // Public Attack Lab must work without a browser session, but must remain a
  // synthetic-only policy proof with no customer executor side effects.
  const publicLabCases = [
    { scenarioId: "refund_policy", amount: 120, expected: "BLOCK" },
    { scenarioId: "refund_policy", amount: 20, expected: "ALLOW" },
    { scenarioId: "argument_tampering", changedAmount: 21, expected: "BLOCK" },
    { scenarioId: "approval_replay", expected: "BLOCK" },
  ];
  for (const { expected, ...challenge } of publicLabCases) {
    const response = await fetch(`${baseUrl}/api/attack-lab/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(challenge),
    });
    const body = await readJson(response);
    assert.equal(response.status, 200, "Attack Lab should be public and require no session cookie");
    assert.equal(body.result.decision, expected);
    assert.equal(body.result.evidence.customerEndpointCalled, false);
    assert.equal(body.result.evidence.externalToolCalls, 0);
    assert.equal(body.result.evidence.financialSideEffects, 0);
  }

  const growthSessionId = randomUUID();
  const landingEventId = randomUUID();
  const landingEvent = await fetch(`${baseUrl}/api/growth/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      eventName: "marketing.landing_view",
      eventId: landingEventId,
      sessionId: growthSessionId,
      properties: {
        page: "home",
        utmSource: "agency_partner",
        referrer: "https://www.example.com/path?email=must-not-be-stored@example.com",
        email: "must-not-be-stored@example.com",
      },
    }),
  });
  assert.equal(landingEvent.status, 202);
  const forgedPayment = await fetch(`${baseUrl}/api/growth/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      eventName: "business.payment_confirmed",
      eventId: randomUUID(),
      sessionId: growthSessionId,
      properties: { amount_usdt: 399 },
    }),
  });
  assert.equal(forgedPayment.status, 400, "public clients cannot forge verified business milestones");

  let executed = 0;
  let upstreamCalls = 0;
  upstream = http.createServer((request, response) => {
    upstreamCalls += 1;
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body).input ?? "";
      const unsafe = input.includes("unsafe");
      response.setHeader("Content-Type", "application/json");
      const payload = JSON.stringify({
        assistant_text: "proposal",
        tool_calls: [{ name: "issue_refund", arguments: { order_id: "TEST-001", amount: unsafe ? 100 : 40 } }],
      });
      if (input.includes("upstream timeout")) {
        setTimeout(() => response.end(payload), 1000);
        return;
      }
      if (input.includes("upstream error")) response.statusCode = 503;
      response.end(payload);
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address();

  const password = `Runtime-Gateway-E2E-${randomUUID()}-2026`;
  const registrationResponse = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-AgentGuard-Growth-Session": growthSessionId,
    },
    body: JSON.stringify({
      email: `runtime-gateway-e2e-${randomUUID()}@example.com`,
      password,
      name: "Runtime Gateway E2E",
      workspaceName: `Runtime Gateway E2E ${randomUUID()}`,
    }),
  });
  assert.equal(registrationResponse.status, 201);
  const registered = await readJson(registrationResponse);
  const workspaceName = registered.user?.workspaceName;
  const workspaceId = registered.user?.workspaceId;
  assert.ok(workspaceName);
  assert.ok(workspaceId);
  const cookies = registrationResponse.headers.getSetCookie?.() ?? [registrationResponse.headers.get("set-cookie") ?? ""];
  const cookie = cookies.find((item) => item.startsWith("agentguard_session="))?.split(";", 1)[0];
  assert.ok(cookie);
  const api = async (path, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Cookie", cookie);
    headers.set("X-AgentGuard-Growth-Session", growthSessionId);
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
    return { response, body: await readJson(response) };
  };
  cleanupCallbacks.push(async () => {
    await api("/api/settings/workspace/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: workspaceName, password }),
    }).catch(() => {});
  });
  const testPlan = await adminPool.query(
    `UPDATE workspace_subscriptions
     SET plan_id='team', status='active', updated_at=NOW()
     WHERE workspace_id=$1`,
    [workspaceId],
  );
  assert.equal(testPlan.rowCount, 1, "isolated E2E workspace should receive its test-only plan entitlement");

  const otherPassword = `Runtime-Gateway-Other-${randomUUID()}-2026`;
  const otherRegistration = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `runtime-gateway-other-${randomUUID()}@example.com`,
      password: otherPassword,
      name: "Other Runtime Workspace",
      workspaceName: `Other Runtime Workspace ${randomUUID()}`,
    }),
  });
  assert.equal(otherRegistration.status, 201);
  const otherRegistered = await readJson(otherRegistration);
  const otherWorkspaceId = otherRegistered.user?.workspaceId;
  const otherWorkspaceName = otherRegistered.user?.workspaceName;
  const otherCookie = (otherRegistration.headers.getSetCookie?.() ?? [otherRegistration.headers.get("set-cookie") ?? ""])
    .find((item) => item.startsWith("agentguard_session="))?.split(";", 1)[0];
  assert.ok(otherWorkspaceId && otherWorkspaceName && otherCookie);
  const otherApi = async (path, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Cookie", otherCookie);
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
    return { response, body: await readJson(response) };
  };
  cleanupCallbacks.push(async () => {
    await otherApi("/api/settings/workspace/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: otherWorkspaceName, password: otherPassword }),
    }).catch(() => {});
  });
  const otherPlan = await adminPool.query(
    `UPDATE workspace_subscriptions SET plan_id='team', status='active', updated_at=NOW() WHERE workspace_id=$1`,
    [otherWorkspaceId],
  );
  assert.equal(otherPlan.rowCount, 1);

  const signupEvents = await adminPool.query(
    `SELECT event_name, visitor_hash, properties
     FROM growth_events
     WHERE workspace_id=$1 AND event_name IN ('marketing.landing_view','business.signup_completed')
     ORDER BY event_name`,
    [workspaceId],
  );
  assert.equal(signupEvents.rowCount, 2, "signup attaches same-tab anonymous attribution to the workspace");
  assert.ok(signupEvents.rows.every((row) => row.visitor_hash?.length === 64));
  assert.equal(signupEvents.rows.find((row) => row.event_name === "marketing.landing_view")?.properties?.referrer_host, "example.com");
  assert.equal(signupEvents.rows.some((row) => JSON.stringify(row.properties).includes("must-not-be-stored@example.com")), false);

  const created = await api("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `Gateway E2E ${Date.now()}`,
      endpoint: `http://127.0.0.1:${upstreamAddress.port}/chat`,
      toolIds: ["issue_refund"],
    }),
  });
  assert.equal(created.response.status, 201);
  const agentId = created.body.agent.id;
  const unauthenticatedProof = await fetch(`${baseUrl}/api/agents/${agentId}/runtime/verification`);
  assert.equal(unauthenticatedProof.status, 401, "verification evidence must require an authenticated workspace session");
  const crossWorkspaceProof = await otherApi(`/api/agents/${agentId}/runtime/verification`);
  assert.equal(crossWorkspaceProof.response.status, 404, "another workspace must not discover this Agent's proof");
  const firstAgentEvent = await adminPool.query(
    `SELECT COUNT(*)::int AS count FROM growth_events
     WHERE workspace_id=$1 AND event_name='business.first_agent_created'`,
    [workspaceId],
  );
  assert.equal(firstAgentEvent.rows[0].count, 1);
  cleanupCallbacks.push(async () => {
    await api(`/api/agents/${agentId}/runtime/disable`, { method: "POST" }).catch(() => {});
    await api(`/api/agents/${agentId}`, { method: "DELETE" }).catch(() => {});
  });

  const enabled = await api(`/api/agents/${agentId}/runtime/enable`, { method: "POST" });
  assert.equal(enabled.response.status, 200);
  const token = enabled.body.token;
  const runtimeHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const executionContext = { actorId: "customer-1", tenantId: "merchant-1", orderId: "TEST-001", issuedAt: new Date().toISOString() };

  const upstreamCallsBeforeVerification = upstreamCalls;
  const verificationResponse = await api(`/api/agents/${agentId}/runtime/verification`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  assert.equal(verificationResponse.response.status, 200, verificationResponse.body.error);
  assert.equal(verificationResponse.body.verification.status, "passed");
  assert.equal(verificationResponse.body.verification.summary.passed, 5);
  assert.equal(verificationResponse.body.verification.summary.failed, 0);
  assert.equal(verificationResponse.body.verification.summary.customerEndpointCalls, 0);
  assert.equal(verificationResponse.body.verification.summary.externalToolCalls, 0);
  assert.equal(verificationResponse.body.verification.summary.financialSideEffects, 0);
  assert.ok(verificationResponse.body.verification.notTested.some((item) => item.includes("alternate direct-to-tool routes")));
  assert.equal(upstreamCalls, upstreamCallsBeforeVerification, "verification must never call the configured customer endpoint");

  const savedVerification = await api(`/api/agents/${agentId}/runtime/verification`);
  assert.equal(savedVerification.response.status, 200);
  assert.equal(savedVerification.body.isCurrent, true);
  assert.equal(savedVerification.body.verification.id, verificationResponse.body.verification.id);
  const crossWorkspaceSavedProof = await otherApi(`/api/agents/${agentId}/runtime/verification`);
  assert.equal(crossWorkspaceSavedProof.response.status, 404, "another workspace must not read persisted proof evidence");
  const crossWorkspaceReport = await otherApi(`/api/agents/${agentId}/runtime/verification/report`);
  assert.equal(crossWorkspaceReport.response.status, 404, "another workspace must not export this proof report");

  const proofReport = await fetch(`${baseUrl}/api/agents/${agentId}/runtime/verification/report`, { headers: { Cookie: cookie } });
  const proofHtml = await proofReport.text();
  assert.equal(proofReport.status, 200);
  assert.match(proofHtml, /ENFORCEMENT VERIFICATION/);
  assert.match(proofHtml, /Not tested/);
  assert.match(proofHtml, /does not inspect your application source code/);

  const invoke = await fetch(`${baseUrl}/api/runtime/agents/${agentId}/invoke`, {
    method: "POST",
    headers: runtimeHeaders,
    body: JSON.stringify({ input: "safe refund", executionContext }),
  });
  const invokeBody = await readJson(invoke);
  assert.equal(invoke.status, 200);
  assert.equal(invokeBody.guard.decision, "ALLOW");
  assert.equal(invokeBody.approved_tool_calls.length, 1);
  const approval = invokeBody.approved_tool_calls[0];

  const tampered = await fetch(`${baseUrl}/api/runtime/agents/${agentId}/approvals/${approval.approval.id}/consume`, {
    method: "POST",
    headers: runtimeHeaders,
    body: JSON.stringify({ toolCall: { ...approval.call, arguments: { order_id: "TEST-001", amount: 4000 } } }),
  });
  assert.equal(tampered.status, 409);
  assert.equal(executed, 0);

  const consumed = await fetch(`${baseUrl}/api/runtime/agents/${agentId}/approvals/${approval.approval.id}/consume`, {
    method: "POST",
    headers: runtimeHeaders,
    body: JSON.stringify({ toolCall: approval.call }),
  });
  assert.equal(consumed.status, 200);
  assert.equal((await consumed.json()).execution, "AUTHORIZED_ONCE");
  const sdkEvent = await adminPool.query(
    `SELECT COUNT(*)::int AS count FROM growth_events
     WHERE workspace_id=$1 AND event_name='business.sdk_verified'`,
    [workspaceId],
  );
  assert.equal(sdkEvent.rows[0].count, 1, "SDK adoption requires a real single-use approval consumption");

  const replay = await fetch(`${baseUrl}/api/runtime/agents/${agentId}/approvals/${approval.approval.id}/consume`, {
    method: "POST",
    headers: runtimeHeaders,
    body: JSON.stringify({ toolCall: approval.call }),
  });
  assert.equal(replay.status, 409);
  assert.equal(executed, 0);

  const unsafe = await fetch(`${baseUrl}/api/runtime/agents/${agentId}/invoke`, {
    method: "POST",
    headers: runtimeHeaders,
    body: JSON.stringify({ input: "unsafe refund", executionContext }),
  });
  const unsafeBody = await readJson(unsafe);
  assert.equal(unsafe.status, 200);
  assert.equal(unsafeBody.guard.decision, "BLOCK");
  assert.equal(unsafeBody.guard.execution, "NOT_EXECUTED");
  assert.deepEqual(unsafeBody.tool_calls, []);
  assert.deepEqual(unsafeBody.approved_tool_calls, []);

  for (const input of ["upstream error", "upstream timeout"]) {
    const failedInvoke = await fetch(`${baseUrl}/api/runtime/agents/${agentId}/invoke`, {
      method: "POST",
      headers: runtimeHeaders,
      body: JSON.stringify({ input, executionContext }),
    });
    assert.equal(failedInvoke.status, 500, `${input} should fail closed instead of returning an approval`);
    const failedBody = await readJson(failedInvoke);
    assert.equal(failedBody.approved_tool_calls, undefined);
  }

  const healthResponse = await api(`/api/agents/${agentId}/runtime/health?window=24h`);
  assert.equal(healthResponse.response.status, 200);
  assert.equal(healthResponse.body.health.observationStatus, "degraded");
  assert.equal(healthResponse.body.health.sampleCount, 4);
  assert.equal(healthResponse.body.health.decisionCount, 2);
  assert.equal(healthResponse.body.health.allowCount, 1);
  assert.equal(healthResponse.body.health.blockCount, 1);
  assert.equal(healthResponse.body.health.errorCount, 2);
  assert.equal(healthResponse.body.health.quotaRejectedCount, 0);
  assert.ok(healthResponse.body.health.p50Ms <= healthResponse.body.health.p95Ms);
  assert.deepEqual(
    healthResponse.body.health.recentIssues.map((issue) => issue.errorCode).sort(),
    ["UPSTREAM_FAILURE", "UPSTREAM_TIMEOUT"],
  );
  assert.equal(JSON.stringify(healthResponse.body.health).includes("127.0.0.1"), false, "telemetry must not expose configured endpoint details");
  assert.equal(JSON.stringify(healthResponse.body.health).includes("Agent returned HTTP"), false, "telemetry must expose safe codes, not raw errors");
  const invalidHealthWindow = await api(`/api/agents/${agentId}/runtime/health?window=30d`);
  assert.equal(invalidHealthWindow.response.status, 400);
  const crossWorkspaceHealth = await otherApi(`/api/agents/${agentId}/runtime/health`);
  assert.equal(crossWorkspaceHealth.response.status, 404, "Runtime telemetry must remain workspace scoped");

  const eventList = await api(`/api/agents/${agentId}/runtime/events`);
  assert.equal(eventList.response.status, 200);
  assert.ok(eventList.body.events.some((event) => event.outcome === "error" && event.errorCode === "UPSTREAM_TIMEOUT"));

  const policyResponse = await api("/api/policies");
  const currentPolicy = policyResponse.body.policies[0];
  const changedPolicy = await api(`/api/policies/${currentPolicy.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...currentPolicy, maxAmount: currentPolicy.maxAmount + 1 }),
  });
  assert.equal(changedPolicy.response.status, 200);
  const staleProof = await api(`/api/agents/${agentId}/runtime/verification`);
  assert.equal(staleProof.body.isCurrent, false, "changing policy must invalidate the previous proof fingerprint");
  const staleReport = await fetch(`${baseUrl}/api/agents/${agentId}/runtime/verification/report`, { headers: { Cookie: cookie } });
  const staleHtml = await staleReport.text();
  assert.equal(staleReport.status, 200);
  assert.match(staleHtml, /Configuration has changed since this proof was created/);
  assert.match(staleReport.headers.get("content-security-policy") ?? "", /default-src 'none'/);

});
