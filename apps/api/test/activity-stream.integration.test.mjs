import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import test from "node:test";

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const baseUrl = "http://127.0.0.1:4102";
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://agentguard:agentguard@127.0.0.1:5432/agentguard";
const adminPool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
const apiDirectory = fileURLToPath(new URL("..", import.meta.url));
const apiEntry = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
const { appendWorkspaceActivity } = await import("../src/features/activity/activity-repository.mjs");
const { recordRuntimeEvent } = await import("../src/infrastructure/repository.mjs");
const { createIncidentNotification } = await import("../src/features/incidents/incident-repository.mjs");
const { issueSession } = await import("../src/features/auth/auth.mjs");
const { closeDatabase } = await import("../src/core/db.mjs");

let apiProcess;
const createdWorkspaceIds = new Set();
const createdUserIds = new Set();
const activeStreams = new Set();

async function waitForApi() {
  let lastError = "API did not become ready";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (apiProcess.exitCode !== null) throw new Error(`Activity test API exited: ${lastError}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
      lastError = `health returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Activity test API readiness timeout: ${lastError}`);
}

async function registerWorkspace(label) {
  const password = `Activity-E2E-${randomUUID()}!`;
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `activity-e2e-${randomUUID()}@agentguard.local`,
      password,
      name: `Activity ${label}`,
      workspaceName: `Activity E2E ${label} ${randomUUID().slice(0, 8)}`,
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 201, body?.error ?? "isolated activity workspace registration failed");
  createdWorkspaceIds.add(body.user.workspaceId);
  createdUserIds.add(body.user.id);
  const cookies = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  const cookie = cookies.find((value) => value.startsWith("agentguard_session="))?.split(";", 1)[0];
  assert.ok(cookie, "registration should issue a session cookie");
  return { cookie, workspaceId: body.user.workspaceId };
}

async function api(cookie, path, init = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Cookie: cookie },
  });
}

async function openActivityStream(cookie, lastEventId) {
  const controller = new AbortController();
  activeStreams.add(controller);
  const headers = new Headers({ Cookie: cookie });
  if (lastEventId !== undefined) headers.set("Last-Event-ID", lastEventId);
  const response = await fetch(`${baseUrl}/api/activity/stream`, { headers, signal: controller.signal });
  assert.equal(response.status, 200, "authenticated SSE connection should be accepted");
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  return { controller, reader: response.body.getReader() };
}

async function nextSseEvent(reader, expectedName, timeoutMs = 8000) {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let timeout;
    const result = await Promise.race([
      reader.read().then((value) => ({ kind: "read", value })),
      new Promise((resolvePromise) => {
        timeout = setTimeout(() => resolvePromise({ kind: "timeout" }), Math.max(1, deadline - Date.now()));
      }),
    ]);
    clearTimeout(timeout);
    if (result.kind === "timeout") throw new Error(`Timed out waiting for SSE ${expectedName} event`);
    if (result.value.done) throw new Error("SSE stream ended before the expected event arrived");
    buffer += decoder.decode(result.value.value, { stream: true });

    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const lines = block.split(/\r?\n/);
      const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
      if (eventName !== expectedName) continue;
      const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      return JSON.parse(data);
    }
  }
  throw new Error(`Timed out waiting for SSE ${expectedName} event`);
}

async function closeStream(stream) {
  stream.controller.abort();
  await stream.reader.cancel().catch(() => {});
  activeStreams.delete(stream.controller);
}

test("authenticated Activity API persists, streams, scopes, and replays events", async () => {
  apiProcess = spawn(process.execPath, [apiEntry], {
    cwd: apiDirectory,
    env: { ...process.env, API_HOST: "127.0.0.1", API_PORT: "4102", NODE_ENV: "test" },
    stdio: "ignore",
  });
  await waitForApi();

  const workspace = await registerWorkspace("Owner");
  const unauthenticated = await fetch(`${baseUrl}/api/activity`);
  assert.equal(unauthenticated.status, 401, "activity history must require authentication");
  const initiallyEmpty = await api(workspace.cookie, "/api/activity");
  assert.equal(initiallyEmpty.status, 200);
  assert.deepEqual((await initiallyEmpty.json()).events, []);

  const historical = await appendWorkspaceActivity({
    workspaceId: workspace.workspaceId,
    eventType: "copilot.generated",
    agentName: "Activity E2E Agent",
    resourceType: "scan",
    resourceId: "scan-activity-e2e",
    metadata: { scenarioId: "valid_refund", model: "test-model", apiKey: "must-not-be-returned" },
  });
  const stream = await openActivityStream(workspace.cookie);
  const historyEvent = await nextSseEvent(stream.reader, "activity-history");
  assert.equal(historyEvent.id, historical.id);
  assert.equal(historyEvent.title, "AI remediation plan generated");
  assert.equal(JSON.stringify(historyEvent).includes("must-not-be-returned"), false);

  const liveEventPromise = nextSseEvent(stream.reader, "activity");
  const liveEvent = await appendWorkspaceActivity({
    workspaceId: workspace.workspaceId,
    eventType: "runtime.blocked",
    agentName: "Activity E2E Agent",
    resourceType: "runtime_event",
    resourceId: "request-activity-e2e",
    metadata: { toolCount: 1, traceId: "trace-activity-e2e", prompt: "must-not-be-returned" },
  });
  const deliveredLiveEvent = await liveEventPromise;
  assert.equal(deliveredLiveEvent.id, liveEvent.id);
  assert.equal(deliveredLiveEvent.explanation.includes("issued no one-time approval"), true);
  assert.equal(JSON.stringify(deliveredLiveEvent).includes("must-not-be-returned"), false);

  const history = await api(workspace.cookie, "/api/activity?limit=10");
  const historyBody = await history.json();
  assert.deepEqual(historyBody.events.map((event) => event.id), [liveEvent.id, historical.id]);
  assert.equal(historyBody.hasMore, false);
  const olderPage = await api(workspace.cookie, `/api/activity?limit=10&beforeId=${liveEvent.id}`);
  assert.deepEqual((await olderPage.json()).events.map((event) => event.id), [historical.id]);

  const otherWorkspace = await registerWorkspace("Other");
  const isolatedHistory = await api(otherWorkspace.cookie, "/api/activity");
  assert.deepEqual((await isolatedHistory.json()).events, [], "one workspace must not see another workspace's feed");

  await closeStream(stream);
  const replayed = await appendWorkspaceActivity({
    workspaceId: workspace.workspaceId,
    eventType: "runtime.approval_consumed",
    agentName: "Activity E2E Agent",
    resourceType: "runtime_event",
    resourceId: "request-activity-e2e-replay",
    metadata: { traceId: "trace-activity-e2e-replay" },
  });
  const reconnect = await openActivityStream(workspace.cookie, liveEvent.id);
  const replayEvent = await nextSseEvent(reconnect.reader, "activity");
  assert.equal(replayEvent.id, replayed.id, "Last-Event-ID should replay persisted events created while disconnected");
  assert.match(replayEvent.explanation, /customer SDK consumed an approval/);
  await closeStream(reconnect);

  await adminPool.query(
    "UPDATE workspace_subscriptions SET plan_id='team' WHERE workspace_id = ANY($1::text[])",
    [[workspace.workspaceId, otherWorkspace.workspaceId]],
  );
  const memberId = `user-${randomUUID()}`;
  const memberEmail = `activity-member-${randomUUID()}@agentguard.local`;
  const memberName = "Activity E2E Member";
  await adminPool.query(
    "INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,'integration-test-hash')",
    [memberId, memberEmail, memberName],
  );
  await adminPool.query(
    "INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1,$2,'member')",
    [memberId, workspace.workspaceId],
  );
  createdUserIds.add(memberId);
  const memberToken = issueSession({
    id: memberId,
    email: memberEmail,
    name: memberName,
    workspaceId: workspace.workspaceId,
    workspaceName: "Activity E2E",
    role: "member",
    sessionVersion: 0,
  });
  const memberCookie = `agentguard_session=${encodeURIComponent(memberToken)}`;
  const agentResponse = await api(workspace.cookie, "/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Investigation E2E Agent", toolIds: ["get_order"] }),
  });
  const agentBody = await agentResponse.json();
  assert.equal(agentResponse.status, 201, agentBody?.error ?? "investigation fixture agent should be created");
  const agentId = agentBody.agent.id;

  const requestId = `investigation-${randomUUID()}`;
  await recordRuntimeEvent({
    workspaceId: workspace.workspaceId,
    agentId,
    agentName: agentBody.agent.name,
    requestId,
    decision: "BLOCK",
    toolName: "issue_refund",
    reasons: ["Refund exceeds the active policy limit."],
    latencyMs: 24,
    traceId: "0123456789abcdef0123456789abcdef",
    traceSpans: [{
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "span-investigation-e2e",
      parentSpanId: null,
      name: "Policy evaluation",
      stage: "policy_evaluation",
      outcome: "blocked",
      decision: "BLOCK",
      startedAt: new Date().toISOString(),
      durationMs: 24,
    }],
  });
  const runtimeEvidenceResponse = await api(
    workspace.cookie,
    `/api/agents/${encodeURIComponent(agentId)}/runtime/events/${encodeURIComponent(requestId)}`,
  );
  assert.equal(runtimeEvidenceResponse.status, 200);
  const runtimeEvidence = (await runtimeEvidenceResponse.json()).event;
  assert.equal(runtimeEvidence.requestId, requestId);
  assert.equal(runtimeEvidence.traceSpans[0].name, "Policy evaluation");
  const crossWorkspaceRuntime = await api(
    otherWorkspace.cookie,
    `/api/agents/${encodeURIComponent(agentId)}/runtime/events/${encodeURIComponent(requestId)}`,
  );
  assert.equal(crossWorkspaceRuntime.status, 404, "Runtime evidence must not cross workspace boundaries");

  const incident = await createIncidentNotification({
    workspaceId: workspace.workspaceId,
    agentId,
    agentName: agentBody.agent.name,
    eventType: "scan_finding",
    severity: "high",
    title: "Investigation E2E incident",
    message: "A high severity scan finding needs review.",
    dedupeKey: `activity-investigation-${randomUUID()}`,
    resourceType: "scan",
    resourceId: "scan-investigation-e2e",
    metadata: { source: "activity-stream-integration-test" },
  });
  const incidentEvidenceResponse = await api(workspace.cookie, `/api/incidents/${encodeURIComponent(incident.id)}`);
  assert.equal(incidentEvidenceResponse.status, 200);
  assert.equal((await incidentEvidenceResponse.json()).incident.id, incident.id);
  const crossWorkspaceIncident = await api(otherWorkspace.cookie, `/api/incidents/${encodeURIComponent(incident.id)}`);
  assert.equal(crossWorkspaceIncident.status, 404, "Incident evidence must not cross workspace boundaries");
  const memberIncidentRead = await api(memberCookie, `/api/incidents/${encodeURIComponent(incident.id)}`);
  assert.equal(memberIncidentRead.status, 200, "workspace members should be able to inspect incident evidence");
  const memberResolve = await api(memberCookie, `/api/incidents/${encodeURIComponent(incident.id)}/resolve`, { method: "POST" });
  assert.equal(memberResolve.status, 403, "members must not resolve incidents");
  const resolveResponse = await api(workspace.cookie, `/api/incidents/${encodeURIComponent(incident.id)}/resolve`, { method: "POST" });
  assert.equal(resolveResponse.status, 204, "an owner should be able to resolve the incident from its evidence view");
  const resolvedIncident = await api(workspace.cookie, `/api/incidents/${encodeURIComponent(incident.id)}`);
  assert.equal((await resolvedIncident.json()).incident.status, "resolved");

  const driftId = `sentinel-${randomUUID()}`;
  await adminPool.query(
    `INSERT INTO sentinel_drift_events
       (id, workspace_id, agent_id, current_fingerprint, severity, status, changes)
     VALUES ($1,$2,$3,$4,'high','open',$5::jsonb)`,
    [
      driftId,
      workspace.workspaceId,
      agentId,
      `fingerprint-${randomUUID()}`,
      JSON.stringify([{ id: "tool-set", category: "tools", field: "tool set", from: ["get_order"], to: ["issue_refund"], severity: "high", impact: "A high risk tool was added." }]),
    ],
  );
  const driftEvidenceResponse = await api(workspace.cookie, `/api/sentinel/events/${encodeURIComponent(driftId)}`);
  assert.equal(driftEvidenceResponse.status, 200);
  const driftEvidence = (await driftEvidenceResponse.json()).event;
  assert.equal(driftEvidence.id, driftId);
  assert.equal(driftEvidence.agentId, agentId);
  assert.equal(driftEvidence.changes[0].impact, "A high risk tool was added.");
  const crossWorkspaceDrift = await api(otherWorkspace.cookie, `/api/sentinel/events/${encodeURIComponent(driftId)}`);
  assert.equal(crossWorkspaceDrift.status, 404, "Sentinel evidence must not cross workspace boundaries");

  const quarantineResponse = await api(workspace.cookie, `/api/agents/${encodeURIComponent(agentId)}/quarantine`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "Investigation E2E confirmed high-risk behavior." }),
  });
  assert.equal(quarantineResponse.status, 200);
  const quarantinedAgent = (await quarantineResponse.json()).agent;
  assert.equal(quarantinedAgent.status, "quarantined");
  assert.equal(quarantinedAgent.quarantineReason, "Investigation E2E confirmed high-risk behavior.");
  const crossWorkspaceQuarantine = await api(otherWorkspace.cookie, `/api/agents/${encodeURIComponent(agentId)}/quarantine`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "Must not affect another workspace." }),
  });
  assert.equal(crossWorkspaceQuarantine.status, 404, "quarantine actions must remain workspace-scoped");
  const memberQuarantine = await api(memberCookie, `/api/agents/${encodeURIComponent(agentId)}/quarantine`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "A member cannot take this action." }),
  });
  assert.equal(memberQuarantine.status, 403, "members must not quarantine agents");
  const restoreResponse = await api(workspace.cookie, `/api/agents/${encodeURIComponent(agentId)}/restore`, { method: "POST" });
  assert.equal(restoreResponse.status, 200);
  assert.equal((await restoreResponse.json()).agent.status, "pending");
});

test.after(async () => {
  for (const controller of activeStreams) controller.abort();
  if (apiProcess?.exitCode === null) {
    const exited = new Promise((resolvePromise) => apiProcess.once("exit", resolvePromise));
    apiProcess.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolvePromise) => setTimeout(resolvePromise, 5000))]);
    if (apiProcess.exitCode === null) apiProcess.kill("SIGKILL");
  }
  if (createdWorkspaceIds.size) {
    await adminPool.query("DELETE FROM workspaces WHERE id = ANY($1::text[])", [[...createdWorkspaceIds]]);
  }
  if (createdUserIds.size) {
    await adminPool.query("DELETE FROM users WHERE id = ANY($1::text[])", [[...createdUserIds]]);
  }
  await adminPool.end();
  await closeDatabase();
});
