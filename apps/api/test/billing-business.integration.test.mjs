import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import * as repository from "../src/infrastructure/repository.mjs";
import { closeDatabase, query } from "../src/core/db.mjs";

const baseUrl = process.env.AGENTGUARD_API_URL ?? "http://127.0.0.1:4100";
const seedEmail = process.env.DEV_SEED_EMAIL ?? "demo@agentguard.local";
const seedPassword = process.env.DEV_SEED_PASSWORD ?? "change-me-locally";

async function jsonRequest(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  return { response, body: await response.json().catch(() => ({})) };
}

function sessionCookie(response) {
  const cookies = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  return cookies.find((value) => value.startsWith("agentguard_session="))?.split(";", 1)[0] ?? "";
}

test("billing rules enforce one-time free credits, add-ons, alerts and manual downgrade", async (t) => {
  const catalog = await repository.listBillingAddons();
  assert.equal(catalog.find((addon) => addon.id === "runtime_decisions_100000")?.priceUsdCents, 2900);
  assert.equal(catalog.find((addon) => addon.id === "scan_credits_1000")?.priceUsdCents, 2900);
  assert.equal(catalog.find((addon) => addon.id === "security_audit_1")?.priceUsdCents, 24900);
  assert.match(catalog.find((addon) => addon.id === "security_audit_1")?.serviceScope ?? "", /one Agent/i);
  assert.match(catalog.find((addon) => addon.id === "implementation_support_1")?.acceptanceTerms ?? "", /accepted/i);
  const email = `billing-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "billing-business-test-2026";
  const registered = await jsonRequest("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name: "Billing Business Test", workspaceName: `Billing test ${Date.now()}` }),
  });
  assert.equal(registered.response.status, 201);
  const cookie = sessionCookie(registered.response);
  assert.ok(cookie);
  const api = (path, init = {}) => jsonRequest(path, { ...init, headers: { ...(init.headers ?? {}), Cookie: cookie } });
  const workspaceId = registered.body.user.workspaceId;
  let agentId;
  t.after(async () => {
    await api("/api/settings/workspace/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: registered.body.user.workspaceName, password }),
    }).catch(() => {});
    await closeDatabase();
  });

  const initial = await api("/api/billing");
  assert.equal(initial.body.plan.id, "free");
  assert.equal(initial.body.plan.monthlyScanCredits, 20);
  assert.equal(initial.body.plan.scanCreditMode, "one_time");
  assert.equal(initial.body.usage.scanCreditsUsed, 0);

  const agent = await api("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Billing test agent", endpoint: null, toolIds: ["get_order"] }),
  });
  assert.equal(agent.response.status, 201);
  agentId = agent.body.agent.id;

  const queueScan = async () => api("/api/scans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, scenarioIds: ["valid_refund", "amount_limit", "expired_order", "untrusted_claim", "boundary_refund"] }),
  });
  assert.equal((await queueScan()).response.status, 202);
  assert.equal((await queueScan()).response.status, 202);
  const atNinety = await api("/api/billing");
  assert.equal(atNinety.body.usage.scanCreditsUsed, 18);
  assert.ok(atNinety.body.usage.alerts.some((alert) => alert.resource === "scan_credits" && alert.threshold === 90));

  const blockedBeforeAddon = await queueScan();
  assert.equal(blockedBeforeAddon.response.status, 402);
  assert.equal(blockedBeforeAddon.body.code, "SCAN_QUOTA_EXCEEDED");

  const checkout = await repository.createCheckoutSession({
    workspaceId,
    checkoutType: "addon",
    addonId: "scan_credits_200",
    provider: "tron-p2p",
    idempotencyKey: `test-addon-${Date.now()}`,
  });
  await repository.applyVerifiedCryptoPayment({
    provider: "crypto",
    providerPaymentId: `payment-${Date.now()}`,
    checkoutSessionId: checkout.id,
    status: "confirmed",
    amount: checkout.quoteAmount,
    currency: "USDT",
    network: "TRON",
    walletAddress: "TQFEyGNzHZAJmebJUvsoZvJghHm2yNhXAD",
    txHash: `tx-${Date.now()}`,
    confirmations: 6,
  });
  const afterAddon = await api("/api/billing");
  assert.equal(afterAddon.body.usage.scanCreditAddonsRemaining, 200);

  assert.equal((await queueScan()).response.status, 202);
  const afterOverage = await api("/api/billing");
  assert.equal(afterOverage.body.usage.scanCreditsUsed, 20);
  assert.equal(afterOverage.body.usage.scanCreditAddonsRemaining, 193);
  assert.ok(afterOverage.body.usage.alerts.some((alert) => alert.threshold === 100));

  await query("UPDATE workspace_subscriptions SET current_period_end=NOW() - INTERVAL '1 day' WHERE workspace_id=$1", [workspaceId]);
  const afterPeriodBoundary = await api("/api/billing");
  assert.equal(afterPeriodBoundary.body.plan.id, "free");
  assert.equal(afterPeriodBoundary.body.usage.scanCreditsUsed, 20);
  assert.equal(afterPeriodBoundary.body.usage.scanCreditsIncluded, 20);

  await query(
    "UPDATE workspace_subscriptions SET plan_id='builder', status='active', current_period_end=NOW() + INTERVAL '30 days' WHERE workspace_id=$1",
    [workspaceId],
  );
  await query(
    "UPDATE usage_periods SET runtime_decisions_used=10000 WHERE workspace_id=$1 AND period_start=$2",
    [workspaceId, afterPeriodBoundary.body.usage.periodStart],
  );
  const runtimeAtLimit = await api("/api/billing");
  assert.deepEqual(
    runtimeAtLimit.body.usage.alerts.filter((alert) => alert.resource === "runtime_decisions").map((alert) => alert.threshold),
    [70, 90, 100],
  );
  assert.match(
    runtimeAtLimit.body.usage.alerts.find((alert) => alert.resource === "runtime_decisions" && alert.threshold === 100).message,
    /returns 402 and executes no sensitive Tool/i,
  );
  await assert.rejects(
    () => repository.reserveRuntimeDecision(workspaceId),
    { code: "RUNTIME_QUOTA_EXCEEDED" },
  );
  await query(
    "UPDATE workspace_subscriptions SET plan_id='free', status='active', current_period_end=NOW() + INTERVAL '30 days' WHERE workspace_id=$1",
    [workspaceId],
  );

  const measurementReference = `runtime-metric-${Date.now()}`;
  await repository.recordUsageMeasurement({
    workspaceId,
    periodStart: afterPeriodBoundary.body.usage.periodStart,
    kind: "runtime_decision",
    units: 1,
    referenceType: "runtime_request",
    referenceId: measurementReference,
    durationMs: 42,
    cpuUserUs: 1200,
    cpuSystemUs: 300,
    rssBytes: 1024 * 1024,
  });
  await repository.recordUsageMeasurement({
    workspaceId,
    periodStart: afterPeriodBoundary.body.usage.periodStart,
    kind: "runtime_decision",
    units: 1,
    referenceType: "runtime_request",
    referenceId: measurementReference,
    durationMs: 99,
    cpuUserUs: 2000,
    cpuSystemUs: 500,
    rssBytes: 2 * 1024 * 1024,
  });
  await repository.captureUsageStorageSnapshots();
  const measured = await repository.getUsageEconomics(workspaceId);
  assert.equal(measured.measurement.runtimeDecisions, 1);
  assert.equal(measured.measurement.maxDurationMs, 99);
  assert.equal(measured.unitEconomics.per10000RuntimeDecisions.sampleUnits, 1);
  assert.equal(measured.unitEconomics.per1000ScanCredits.sampleUnits, measured.measurement.scanCredits);
  assert.ok(measured.storage);
  assert.ok(measured.estimatedCostUsd.total >= 0);

  const serviceCheckout = await repository.createCheckoutSession({
    workspaceId,
    checkoutType: "addon",
    addonId: "security_audit_1",
    provider: "tron-p2p",
    idempotencyKey: `service-audit-${Date.now()}`,
    metadata: {
      addonId: "security_audit_1",
      targetAgentId: agentId,
      serviceAcknowledged: true,
    },
  });
  await repository.applyVerifiedCryptoPayment({
    provider: "crypto",
    providerPaymentId: `service-payment-${Date.now()}`,
    checkoutSessionId: serviceCheckout.id,
    status: "confirmed",
    amount: serviceCheckout.quoteAmount,
    currency: "USDT",
    network: "TRON",
    walletAddress: "TQFEyGNzHZAJmebJUvsoZvJghHm2yNhXAD",
    txHash: `service-tx-${Date.now()}`,
    confirmations: 6,
  });
  const serviceOrders = await repository.listBillingServiceOrders(workspaceId);
  assert.equal(serviceOrders.length, 1);
  assert.equal(serviceOrders[0].kind, "security_audit");
  assert.equal(serviceOrders[0].status, "queued");
  assert.equal(serviceOrders[0].targetAgentId, agentId);
  assert.equal(serviceOrders[0].includedHours, 3);
  assert.match(serviceOrders[0].overagePolicy, /separately approved quote/i);

  const retentionScanId = `retention-${Date.now()}`;
  await query(
    `INSERT INTO scans (id, workspace_id, agent_id, status, trigger, created_at)
     VALUES ($1, $2, $3, 'failed', 'Retention test', NOW() - INTERVAL '8 days')`,
    [retentionScanId, workspaceId, agentId],
  );
  const purged = await repository.purgeExpiredEvidence();
  assert.ok(purged.deletedScans >= 1);
  const retainedScan = await query("SELECT COUNT(*)::int AS count FROM scans WHERE id=$1", [retentionScanId]);
  assert.equal(retainedScan.rows[0].count, 0);

  const ownerLogin = await jsonRequest("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: seedEmail, password: seedPassword }),
  });
  const ownerCookie = sessionCookie(ownerLogin.response);
  assert.ok(ownerCookie);
  const ownerChange = await jsonRequest("/api/billing/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: ownerCookie, "Idempotency-Key": `downgrade-${Date.now()}` },
    body: JSON.stringify({ planId: "builder" }),
  });
  assert.equal(ownerChange.response.status, 200);
  assert.equal(ownerChange.body.change.planId, "builder");
  assert.ok(ownerChange.body.change.effectiveAt);
  const canceled = await jsonRequest("/api/billing/plan-change/cancel", { method: "POST", headers: { Cookie: ownerCookie } });
  assert.equal(canceled.response.status, 200);

  const demoSubscription = await query(
    `SELECT s.workspace_id, s.plan_id, p.price_usd_cents
     FROM workspace_subscriptions s
     JOIN subscription_plans p ON p.id=s.plan_id
     JOIN memberships m ON m.workspace_id=s.workspace_id
     JOIN users u ON u.id=m.user_id
     WHERE u.email=$1
     ORDER BY m.created_at LIMIT 1`,
    [seedEmail],
  );
  const demo = demoSubscription.rows[0];
  const renewalCheckout = await repository.createCheckoutSession({
    workspaceId: demo.workspace_id,
    planId: demo.plan_id,
    provider: "tron-p2p",
    idempotencyKey: `renewal-${Date.now()}`,
  });
  const renewalEvent = {
    provider: "crypto",
    providerPaymentId: `renewal-payment-${Date.now()}`,
    checkoutSessionId: renewalCheckout.id,
    status: "confirmed",
    amount: renewalCheckout.quoteAmount,
    currency: "USDT",
    network: "TRON",
    walletAddress: "TQFEyGNzHZAJmebJUvsoZvJghHm2yNhXAD",
    txHash: `renewal-tx-${Date.now()}`,
    confirmations: 6,
  };
  await repository.applyVerifiedCryptoPayment(renewalEvent);
  const firstRenewalPeriod = await query("SELECT current_period_end FROM workspace_subscriptions WHERE workspace_id=$1", [demo.workspace_id]);
  const firstEnd = firstRenewalPeriod.rows[0].current_period_end;
  const duplicate = await repository.applyVerifiedCryptoPayment(renewalEvent);
  assert.equal(duplicate.duplicate, true);
  const secondRenewalPeriod = await query("SELECT current_period_end FROM workspace_subscriptions WHERE workspace_id=$1", [demo.workspace_id]);
  assert.equal(new Date(secondRenewalPeriod.rows[0].current_period_end).getTime(), new Date(firstEnd).getTime());
});
