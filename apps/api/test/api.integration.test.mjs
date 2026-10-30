import dotenv from "dotenv";
import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { closeDatabase, query } from "../src/core/db.mjs";

dotenv.config({
  path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env"),
});

const baseUrl = process.env.AGENTGUARD_API_URL ?? "http://127.0.0.1:4100";
let email;
let password;
let workspaceId;
let isolatedWorkspaceReady = false;

let cookie;

async function ensureIsolatedWorkspace() {
  if (isolatedWorkspaceReady) return;
  email = `integration-${randomUUID()}@agentguard.local`;
  password = `Integration-${randomUUID()}!`;
  const register = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      name: "Integration Test Owner",
      workspaceName: `Integration ${randomUUID().slice(0, 8)}`,
    }),
  });
  const body = await register.json();
  assert.equal(register.status, 201, body?.error ?? "isolated integration registration failed");
  workspaceId = body.user.workspaceId;
  // Give this run the same paid entitlement as the production-like scan
  // assertions, without mutating the shared development seed workspace.
  await query(
    `UPDATE workspace_subscriptions
     SET plan_id='team', status='active', billing_provider='integration',
         current_period_start=DATE_TRUNC('month', NOW()),
         current_period_end=DATE_TRUNC('month', NOW()) + INTERVAL '1 month',
         updated_at=NOW()
     WHERE workspace_id=$1`,
    [workspaceId],
  );
  isolatedWorkspaceReady = true;
}

async function api(path, init = {}) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("Cookie", cookie);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${path} failed (${response.status}): ${body?.error ?? "unknown error"}`,
    );
  }
  return { response, body };
}

test("live API completes an authenticated scan and persists its evidence", async () => {
  await ensureIsolatedWorkspace();
  const health = await api("/api/health");
  assert.equal(health.body.status, "ok");

  const login = await api("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.match(login.response.headers.get("x-request-id"), /^[a-zA-Z0-9._:-]+$/);
  const setCookie =
    login.response.headers.getSetCookie?.()[0] ??
    login.response.headers.get("set-cookie");
  assert.ok(setCookie, "login should issue a session cookie");
  const setCookies = login.response.headers.getSetCookie?.() ?? [setCookie];
  const accessCookie = setCookies.find((value) => value.startsWith("agentguard_session="));
  const refreshCookie = setCookies.find((value) => value.startsWith("agentguard_session_refresh="));
  assert.ok(accessCookie, "login should issue an access cookie");
  assert.ok(refreshCookie, "login should issue a refresh cookie");
  assert.match(accessCookie, /HttpOnly/);
  assert.match(accessCookie, /SameSite=Lax/);
  assert.match(accessCookie, /Max-Age=604800/);
  assert.match(refreshCookie, /Max-Age=2592000/);
  cookie = accessCookie.split(";", 1)[0];
  assert.ok(login.body.user.workspaceId);

  const expiredAccess = jwt.sign(
    {
      sub: login.body.user.id,
      userId: login.body.user.id,
      workspaceId: login.body.user.workspaceId,
    },
    process.env.JWT_SECRET ?? "change-me-development-jwt-secret",
    { expiresIn: -1 },
  );
  const restored = await fetch(`${baseUrl}/api/auth/me`, {
    headers: {
      Cookie: `${expiredAccess ? `agentguard_session=${expiredAccess}; ` : ""}${refreshCookie.split(";", 1)[0]}`,
    },
  });
  const restoredBody = await restored.json();
  assert.equal(restored.status, 200);
  assert.equal(restoredBody.user.id, login.body.user.id);
  const rotatedCookies = restored.headers.getSetCookie?.() ?? [];
  assert.ok(rotatedCookies.some((value) => value.startsWith("agentguard_session=")));
  cookie = rotatedCookies.find((value) => value.startsWith("agentguard_session="))?.split(";", 1)[0] ?? cookie;

  const session = await api("/api/auth/me");
  assert.equal(session.body.user.id, login.body.user.id);

  const bootstrapAgent = await api("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Integration storefront agent",
      endpoint: null,
      provider: "Integration provider",
      model: "integration-model",
      toolIds: ["get_order", "issue_refund"],
    }),
  });
  assert.equal(bootstrapAgent.body.agent.name, "Integration storefront agent");

  const blockedOrigin = await fetch(`${baseUrl}/api/settings/profile`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://evil.example",
      Cookie: cookie,
    },
    body: JSON.stringify({ name: "Blocked origin" }),
  });
  const blockedOriginBody = await blockedOrigin.json();
  assert.equal(blockedOrigin.status, 403);
  assert.ok(blockedOriginBody.requestId);

  const billing = await api("/api/billing");
  assert.equal(billing.body.plan.id, "team");
  assert.equal(billing.body.usage.fullScanCredits, 30);
  assert.ok(billing.body.usage.scanCreditsRemaining <= billing.body.usage.scanCreditsIncluded);
  const plans = await api("/api/billing/plans");
  assert.deepEqual(plans.body.plans.map((plan) => plan.id), ["free", "builder", "team", "agency"]);
  const observability = await api("/api/ops/observability");
  assert.equal(typeof observability.body.queue.queued, "number");
  assert.equal(typeof observability.body.api.fiveXxRate, "number");

  const agents = (await api("/api/agents")).body.agents;
  assert.ok(agents.length > 0, "seed workspace should contain an agent");
  const scannableAgent = agents.find((agent) => agent.id === "storefront-copilot") ?? agents.find(
    (agent) => agent.status !== "quarantined" && !agent.endpoint && !/^production$/i.test(agent.environment),
  );
  assert.ok(scannableAgent, "seed workspace should contain a non-quarantined agent");

  const policy = (await api("/api/overview")).body.policy;
  const updatedPolicy = await api(`/api/policies/${policy.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(policy),
  });
  assert.equal(updatedPolicy.body.policy.id, policy.id);
  assert.ok((await api("/api/tools")).body.tools.length > 0);

  const scenarioCatalog = await api("/api/scenarios");
  assert.equal(scenarioCatalog.body.scenarios.length, 12);
  assert.ok(scenarioCatalog.body.scenarios.every((scenario) => scenario.description && scenario.risk));
  assert.ok(scenarioCatalog.body.scenarios.every((scenario) => scenario.attackClass && scenario.control));
  assert.equal(scenarioCatalog.body.policy.id, policy.id);

  const queued = await api("/api/scans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentId: scannableAgent.id,
      trigger: "Integration test",
    }),
  });
  assert.equal(queued.body.scan.status, "queued");
  assert.equal(queued.body.scan.progress.length, 12);
  assert.ok(queued.body.scan.progress.every((item) => item.status === "queued"));

  let scan = queued.body.scan;
  for (
    let attempt = 0;
    attempt < 40 && (scan.status === "queued" || scan.status === "running");
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    scan = (await api(`/api/scans/${scan.id}`)).body.scan;
  }

  assert.equal(scan.status, "completed");
  assert.equal(scan.results.length, 12);
  assert.equal(scan.passed + scan.failed, 12);
  assert.ok(scan.blocked >= 0);
  const validRefund = scan.results.find((result) => result.scenarioId === "valid_refund");
  assert.equal(validRefund.guard.decision, "ALLOW");
  assert.equal(validRefund.guard.execution, "SIMULATED");
  assert.equal(validRefund.call.name, "issue_refund");
  assert.equal(validRefund.call.arguments.order_id, "TEST-001");
  const amountFinding = scan.results.find((result) => result.scenarioId === "amount_limit");
  assert.ok(amountFinding.remediation);
  assert.equal(amountFinding.remediation.status, "protected");
  assert.equal(amountFinding.remediation.retest.scenarioId, "amount_limit");
  assert.ok(amountFinding.remediation.recommendations.length >= 1);
  assert.equal(scan.progress.length, 12);
  assert.ok(
    scan.progress.every((item) => ["passed", "blocked", "failed", "error"].includes(item.status)),
  );
  assert.equal(scan.progress.find((item) => item.scenarioId === "valid_refund").status, "passed");
  const billingAfterScan = await api("/api/billing");
  assert.equal(
    billingAfterScan.body.usage.scanCreditsUsed,
    billing.body.usage.scanCreditsUsed + billing.body.usage.fullScanCredits,
  );
  const contract = await api(`/api/agents/${scannableAgent.id}/security-contract`);
  const updatedContract = await api(`/api/agents/${scannableAgent.id}/security-contract`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      allowedToolIds: contract.body.contract.allowedToolIds,
      maxRefundAmount: contract.body.contract.maxRefundAmount,
      maxOrderAgeDays: contract.body.contract.maxOrderAgeDays,
      notes: "Integration replay contract",
    }),
  });
  assert.equal(updatedContract.body.contract.version, contract.body.contract.version + 1);
  assert.ok(updatedContract.body.verificationScan);
  let verificationScan = updatedContract.body.verificationScan;
  for (
    let attempt = 0;
    attempt < 40 && ["queued", "running"].includes(verificationScan.status);
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    verificationScan = (await api(`/api/scans/${verificationScan.id}`)).body.scan;
  }
  assert.equal(verificationScan.status, "completed");
  assert.equal(verificationScan.contractVersion, updatedContract.body.contract.version);
  const comparison = await api(`/api/agents/${scannableAgent.id}/security-contract/comparison`);
  assert.equal(comparison.body.comparison.toVersion, updatedContract.body.contract.version);
  assert.equal(comparison.body.comparison.evidence.status, "compared");
  const replayQueued = await api(`/api/agents/${scannableAgent.id}/attack-paths/refund-guard-baseline/replay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  let replayScan = replayQueued.body.scan;
  for (
    let attempt = 0;
    attempt < 40 && ["queued", "running"].includes(replayScan.status);
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    replayScan = (await api(`/api/scans/${replayScan.id}`)).body.scan;
  }
  assert.equal(replayScan.status, "completed");
  assert.equal(replayScan.contractVersion, updatedContract.body.contract.version);
  assert.equal(replayScan.attackPaths.find((path) => path.id === "refund-guard-baseline").status, "protected");

  // Exercise the owner-approved, persisted policy-fix loop using a deliberately
  // misconfigured local simulator. This remains isolated to the integration
  // workspace and never calls a customer endpoint or executes a real refund.
  const policyForFix = (await api("/api/overview")).body.policy;
  const permissivePolicy = await api(`/api/policies/${policyForFix.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...policyForFix, maxAmount: 150 }),
  });
  assert.equal(permissivePolicy.body.policy.maxAmount, 150);
  const fixAgent = await api("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Policy fix verification simulator",
      endpoint: null,
      provider: "Integration simulator",
      model: "integration-model",
      toolIds: ["get_order", "issue_refund"],
    }),
  });
  await query("UPDATE agents SET mode='needs_attention' WHERE id=$1 AND workspace_id=$2", [fixAgent.body.agent.id, workspaceId]);
  const policyFixBillingBefore = (await api("/api/billing")).body.usage.scanCreditsUsed;

  const vulnerableQueued = await api("/api/scans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: fixAgent.body.agent.id, trigger: "Policy fix integration", scenarioIds: ["amount_limit"] }),
  });
  let vulnerableScan = vulnerableQueued.body.scan;
  for (let attempt = 0; attempt < 40 && ["queued", "running"].includes(vulnerableScan.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    vulnerableScan = (await api(`/api/scans/${vulnerableScan.id}`)).body.scan;
  }
  assert.equal(vulnerableScan.status, "completed");
  const vulnerableResult = vulnerableScan.results.find((result) => result.scenarioId === "amount_limit");
  assert.equal(vulnerableResult.verdict, "VULNERABLE");
  assert.equal(vulnerableResult.guard.decision, "ALLOW");
  assert.equal(vulnerableResult.executionSafety, "safe");
  assert.equal(vulnerableResult.policyFix.proposedValue, 99.99);
  assert.equal(vulnerableResult.policyFix.expectedPolicyVersion, permissivePolicy.body.policy.version);
  const billingAfterVulnerableScan = (await api("/api/billing")).body.usage.scanCreditsUsed;
  assert.equal(billingAfterVulnerableScan, policyFixBillingBefore + 2, "the source scan should charge the selected scenario's credits");

  const appliedFix = await api(`/api/scans/${vulnerableScan.id}/policy-fixes/amount_limit/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedPolicyVersion: permissivePolicy.body.policy.version }),
  });
  assert.equal(appliedFix.body.policy.maxAmount, 99.99);
  assert.equal(appliedFix.body.policy.version, permissivePolicy.body.policy.version + 1);
  const duplicateApply = await fetch(`${baseUrl}/api/scans/${vulnerableScan.id}/policy-fixes/amount_limit/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ expectedPolicyVersion: permissivePolicy.body.policy.version }),
  });
  assert.equal(duplicateApply.status, 409, "stale approvals must not apply twice");

  const verificationQueued = await api("/api/scans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentId: fixAgent.body.agent.id,
      trigger: "Policy fix verification",
      scenarioIds: ["amount_limit"],
      remediationVerification: {
        sourceScanId: vulnerableScan.id,
        scenarioId: "amount_limit",
        policyVersionBefore: permissivePolicy.body.policy.version,
      },
    }),
  });
  let policyVerification = verificationQueued.body.scan;
  for (let attempt = 0; attempt < 40 && ["queued", "running"].includes(policyVerification.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    policyVerification = (await api(`/api/scans/${policyVerification.id}`)).body.scan;
  }
  assert.equal(policyVerification.status, "completed");
  const verifiedResult = policyVerification.results.find((result) => result.scenarioId === "amount_limit");
  assert.equal(verifiedResult.verdict, "PROTECTED");
  assert.equal(verifiedResult.executionSafety, "safe");
  assert.deepEqual(verifiedResult.guard, { decision: "BLOCK", execution: "NOT_EXECUTED" });
  assert.deepEqual(policyVerification.remediationVerification, {
    sourceScanId: vulnerableScan.id,
    scenarioId: "amount_limit",
    policyVersionBefore: permissivePolicy.body.policy.version,
  });
  const persistedSource = (await api(`/api/scans/${vulnerableScan.id}`)).body.scan;
  assert.equal(persistedSource.verificationRuns[0].scanId, policyVerification.id);
  assert.equal(persistedSource.verificationRuns[0].scenarioVerdict, "PROTECTED");
  assert.equal(persistedSource.verificationRuns[0].policyVersionAfter, appliedFix.body.policy.version);
  const billingAfterVerification = (await api("/api/billing")).body.usage.scanCreditsUsed;
  assert.equal(billingAfterVerification, billingAfterVulnerableScan + 2, "verification should be metered as its own exact-scenario scan");
  const policyRevision = await query(
    "SELECT version, max_amount FROM policy_revisions WHERE policy_id=$1 AND version=$2",
    [appliedFix.body.policy.id, appliedFix.body.policy.version],
  );
  assert.equal(policyRevision.rowCount, 1, "approved fixes should create a durable policy revision");
  assert.equal(Number(policyRevision.rows[0].max_amount), 99.99);

  // Exercise the second supported policy field end to end as well: trusted
  // order age must trigger a max-age proposal, approval and exact retest.
  const agePolicy = await api(`/api/policies/${appliedFix.body.policy.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...appliedFix.body.policy, maxAgeDays: 30 }),
  });
  const ageQueued = await api("/api/scans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: fixAgent.body.agent.id, trigger: "Age policy fix integration", scenarioIds: ["expired_order"] }),
  });
  let ageScan = ageQueued.body.scan;
  for (let attempt = 0; attempt < 40 && ["queued", "running"].includes(ageScan.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    ageScan = (await api(`/api/scans/${ageScan.id}`)).body.scan;
  }
  assert.equal(ageScan.status, "completed");
  const ageResult = ageScan.results.find((result) => result.scenarioId === "expired_order");
  assert.equal(ageResult.verdict, "VULNERABLE");
  assert.equal(ageResult.guard.decision, "ALLOW");
  assert.equal(ageResult.policyFix.field, "maxAgeDays");
  assert.equal(ageResult.policyFix.proposedValue, 19);
  const appliedAgeFix = await api(`/api/scans/${ageScan.id}/policy-fixes/expired_order/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedPolicyVersion: agePolicy.body.policy.version }),
  });
  assert.equal(appliedAgeFix.body.policy.maxAgeDays, 19);
  assert.equal(appliedAgeFix.body.policy.version, agePolicy.body.policy.version + 1);
  const ageVerificationQueued = await api("/api/scans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentId: fixAgent.body.agent.id,
      trigger: "Age policy fix verification",
      scenarioIds: ["expired_order"],
      remediationVerification: {
        sourceScanId: ageScan.id,
        scenarioId: "expired_order",
        policyVersionBefore: agePolicy.body.policy.version,
      },
    }),
  });
  let ageVerification = ageVerificationQueued.body.scan;
  for (let attempt = 0; attempt < 40 && ["queued", "running"].includes(ageVerification.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    ageVerification = (await api(`/api/scans/${ageVerification.id}`)).body.scan;
  }
  assert.equal(ageVerification.status, "completed");
  const verifiedAgeResult = ageVerification.results.find((result) => result.scenarioId === "expired_order");
  assert.equal(verifiedAgeResult.verdict, "PROTECTED");
  assert.deepEqual(verifiedAgeResult.guard, { decision: "BLOCK", execution: "NOT_EXECUTED" });
  const persistedAgeSource = (await api(`/api/scans/${ageScan.id}`)).body.scan;
  assert.equal(persistedAgeSource.verificationRuns[0].scanId, ageVerification.id);
  const ageRevision = await query(
    "SELECT version, max_age_days FROM policy_revisions WHERE policy_id=$1 AND version=$2",
    [appliedAgeFix.body.policy.id, appliedAgeFix.body.policy.version],
  );
  assert.equal(ageRevision.rowCount, 1);
  assert.equal(Number(ageRevision.rows[0].max_age_days), 19);

  const audit = await api("/api/audit");
  assert.ok(audit.body.events.some((event) => event.action === "auth.login"));
  assert.ok(audit.body.events.some((event) => event.action === "scan.created"));
  assert.ok(audit.body.events.some((event) => event.action === "policy.updated"));
  assert.ok(audit.body.events.some((event) => event.action === "scan.policy_fix.applied"));

  // Retention deletes source evidence; the dependent verification must not
  // become an orphan or prevent the source scan from being removed.
  await query("DELETE FROM scans WHERE id=$1 AND workspace_id=$2", [vulnerableScan.id, workspaceId]);
  const orphanedVerification = await query("SELECT 1 FROM scans WHERE id=$1 AND workspace_id=$2", [policyVerification.id, workspaceId]);
  assert.equal(orphanedVerification.rowCount, 0);
  await query("DELETE FROM scans WHERE id=$1 AND workspace_id=$2", [ageScan.id, workspaceId]);
  const orphanedAgeVerification = await query("SELECT 1 FROM scans WHERE id=$1 AND workspace_id=$2", [ageVerification.id, workspaceId]);
  assert.equal(orphanedAgeVerification.rowCount, 0);
});

test("live API rejects a private agent endpoint", async () => {
  const result = await fetch(`${baseUrl}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      name: "Integration SSRF check",
      endpoint: "http://127.0.0.1:9000/chat",
    }),
  });
  const body = await result.json();
  assert.equal(result.status, 400);
  assert.match(body.error, /Private and local/);
});

test("live API exposes workspace settings with enforced profile and workspace updates", async () => {
  const settings = await api("/api/settings");
  assert.equal(settings.body.user.email, email);
  assert.equal(settings.body.user.workspaceId, settings.body.workspace.id);
  assert.ok(Array.isArray(settings.body.members));
  assert.ok(settings.body.members.some((member) => member.id === settings.body.user.id));
  assert.equal(settings.body.security.sessionStorage, "httpOnly_cookie");

  const profile = await api("/api/settings/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: settings.body.user.name }),
  });
  assert.equal(profile.body.user.name, settings.body.user.name);

  const workspace = await api("/api/settings/workspace", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: settings.body.workspace.name }),
  });
  assert.equal(workspace.body.user.workspaceName, settings.body.workspace.name);

  const rejectedPassword = await fetch(`${baseUrl}/api/settings/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ currentPassword: "wrong-password", newPassword: "new-password-2026" }),
  });
  assert.equal(rejectedPassword.status, 401);
});

test("live API revokes the persistent session on logout", async () => {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const cookies = login.headers.getSetCookie?.() ?? [];
  const refreshCookie = cookies.find((value) => value.startsWith("agentguard_session_refresh="));
  assert.ok(refreshCookie);
  const refreshValue = refreshCookie.split(";", 1)[0];

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: refreshValue },
  });
  assert.equal(logout.status, 204);

  const denied = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Cookie: refreshValue },
  });
  assert.equal(denied.status, 401);
});

test("live API detects critical agent drift and can quarantine it automatically", async () => {
  const created = await api("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Sentinel integration agent",
      endpoint: null,
      provider: "Test provider",
      model: "test-model",
      toolIds: ["get_order"],
    }),
  });
  const agent = created.body.agent;

  const baseline = await api(`/api/agents/${agent.id}/sentinel/baseline`, { method: "POST" });
  assert.equal(baseline.body.sentinel.status, "protected");
  assert.ok(baseline.body.sentinel.baseline.fingerprint);

  const settings = await api(`/api/agents/${agent.id}/sentinel/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true, autoQuarantine: true }),
  });
  assert.equal(settings.body.sentinel.settings.autoQuarantine, true);

  await api(`/api/agents/${agent.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toolIds: ["get_order", "issue_refund"] }),
  });

  const checked = await api(`/api/agents/${agent.id}/sentinel/check`, { method: "POST" });
  assert.equal(checked.body.sentinel.status, "drifted");
  assert.equal(checked.body.sentinel.severity, "critical");
  assert.ok(checked.body.sentinel.openEvent);
  assert.ok(checked.body.sentinel.changes.some((change) => change.category === "tool_registry"));

  const incidentSummary = await api("/api/incidents/summary");
  assert.ok(incidentSummary.body.summary.open >= 1);
  const incidents = (await api("/api/incidents")).body.incidents;
  assert.ok(incidents.some((incident) => incident.eventType === "sentinel_drift"));
  assert.ok(incidents.some((incident) => incident.eventType === "agent_quarantined"));
  const driftIncident = incidents.find((incident) => incident.eventType === "sentinel_drift");
  await api(`/api/incidents/${driftIncident.id}/read`, { method: "POST" });
  await api(`/api/incidents/${driftIncident.id}/resolve`, { method: "POST" });

  const invalidWebhook = await fetch(`${baseUrl}/api/alert-webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name: "Short secret", url: "https://8.8.8.8/hooks", secret: "too-short" }),
  });
  assert.equal(invalidWebhook.status, 400);

  const insecureWebhook = await fetch(`${baseUrl}/api/alert-webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name: "Insecure route", url: "http://8.8.8.8/hooks", secret: "integration-signing-secret-2026", eventTypes: ["sentinel_drift"] }),
  });
  assert.equal(insecureWebhook.status, 400, "webhook creation must reject cleartext HTTP endpoints");

  const webhook = await api("/api/alert-webhooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Integration route", url: "https://8.8.8.8/hooks", secret: "integration-signing-secret-2026", eventTypes: ["sentinel_drift"] }),
  });
  assert.equal(webhook.body.webhook.name, "Integration route");
  assert.equal(webhook.body.webhook.endpointHost, "8.8.8.8");
  assert.equal("secret" in webhook.body.webhook, false);
  const disabledWebhook = await api(`/api/alert-webhooks/${webhook.body.webhook.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Integration route", enabled: false, eventTypes: ["sentinel_drift"] }),
  });
  assert.equal(disabledWebhook.body.webhook.enabled, false);
  const deletedWebhook = await fetch(`${baseUrl}/api/alert-webhooks/${webhook.body.webhook.id}`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  assert.equal(deletedWebhook.status, 204);

  const quarantined = await api(`/api/agents/${agent.id}`);
  assert.equal(quarantined.body.agent.status, "quarantined");

  await api(`/api/agents/${agent.id}/restore`, { method: "POST" });
  const deleted = await fetch(`${baseUrl}/api/agents/${agent.id}`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  assert.equal(deleted.status, 204);
});

test("live API manages an agent without exposing its secret", async () => {
  const created = await api("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Management integration agent",
      endpoint: null,
      provider: "Test provider",
      model: "test-model",
      apiKey: "secret-for-test",
      toolIds: ["get_order"],
    }),
  });
  const agent = created.body.agent;
  assert.equal(agent.status, "pending");
  assert.equal(agent.apiKeyConfigured, true);
  assert.equal("encryptedApiKey" in agent, false);

  const updated = await api(`/api/agents/${agent.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Managed integration agent",
      provider: "Updated provider",
      model: "updated-model",
      environment: "Development",
      endpoint: null,
      clearApiKey: true,
      toolIds: ["get_order"],
    }),
  });
  assert.equal(updated.body.agent.name, "Managed integration agent");
  assert.equal(updated.body.agent.apiKeyConfigured, false);
  assert.equal("encryptedApiKey" in updated.body.agent, false);

  const connection = await api(`/api/agents/${agent.id}/test-connection`, {
    method: "POST",
  });
  assert.equal(connection.body.connection.status, "not_configured");
  assert.equal(connection.body.agent.status, "pending");

  const quarantined = await api(`/api/agents/${agent.id}/quarantine`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "Integration quarantine" }),
  });
  assert.equal(quarantined.body.agent.status, "quarantined");
  assert.equal(quarantined.body.agent.quarantineReason, "Integration quarantine");

  const blockedScan = await fetch(`${baseUrl}/api/scans`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ agentId: agent.id }),
  });
  assert.equal(blockedScan.status, 409);

  const restored = await api(`/api/agents/${agent.id}/restore`, { method: "POST" });
  assert.equal(restored.body.agent.status, "pending");

  const runtimeCreated = await api("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Runtime firewall integration agent",
      endpoint: "https://8.8.8.8/chat",
      toolIds: ["get_order", "issue_refund"],
    }),
  });
  const runtimeAgent = runtimeCreated.body.agent;
  const runtimeEnabled = await api(`/api/agents/${runtimeAgent.id}/runtime/enable`, { method: "POST" });
  assert.equal(runtimeEnabled.body.agent.runtimeEnabled, true);
  assert.match(runtimeEnabled.body.token, /^ag_live_/);
  assert.equal(runtimeEnabled.body.gateway.path, `/api/runtime/agents/${runtimeAgent.id}/invoke`);

  const invalidRuntimeToken = await fetch(`${baseUrl}/api/runtime/agents/${runtimeAgent.id}/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer invalid-token" },
    body: JSON.stringify({ input: "hello" }),
  });
  assert.equal(invalidRuntimeToken.status, 401);

  const runtimeEvents = await api(`/api/agents/${runtimeAgent.id}/runtime/events`);
  assert.deepEqual(runtimeEvents.body.events, []);
  const runtimeDisabled = await api(`/api/agents/${runtimeAgent.id}/runtime/disable`, { method: "POST" });
  assert.equal(runtimeDisabled.body.agent.runtimeEnabled, false);
  const runtimeDeleted = await fetch(`${baseUrl}/api/agents/${runtimeAgent.id}`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  assert.equal(runtimeDeleted.status, 204);

  const deleted = await fetch(`${baseUrl}/api/agents/${agent.id}`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  assert.equal(deleted.status, 204);
});

test.after(async () => {
  if (workspaceId) await query("DELETE FROM workspaces WHERE id=$1", [workspaceId]);
  await closeDatabase();
});
