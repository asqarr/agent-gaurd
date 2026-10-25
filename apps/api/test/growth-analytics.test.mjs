import assert from "node:assert/strict";
import test from "node:test";
import {
  hashGrowthSession,
  hashGrowthSourceKey,
  normalizeClientGrowthEvent,
  normalizePaymentGrowthProperties,
} from "../src/features/growth-analytics/domain.mjs";

const sessionId = "e9f84542-88a6-4f80-8e37-522754680919";
const eventId = "172b7ea1-0101-4884-a6d6-4a7d4790e1cb";

test("growth session identifiers are validated and stored as irreversible hashes", () => {
  const hash = hashGrowthSession(sessionId);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(hash, sessionId);
  assert.equal(hashGrowthSession(sessionId.toUpperCase()), hash);
  assert.equal(hashGrowthSession("visitor@example.com"), null);
  assert.equal(hashGrowthSession("not-a-uuid"), null);
});

test("public events accept only allowlisted names and keep only safe dimensions", () => {
  const normalized = normalizeClientGrowthEvent({
    eventName: "attack_lab.challenge_run",
    eventId,
    sessionId,
    properties: {
      page: "attack_lab",
      scenarioId: "refund_policy",
      utmSource: "Agency_Partner",
      referrer: "https://www.example.com/path?email=secret@example.com",
      email: "secret@example.com",
      endpoint: "https://customer.example/api",
      prompt: "customer-provided content",
    },
  });
  assert.deepEqual(normalized.properties, {
    page: "attack_lab",
    scenarioId: "refund_policy",
    utm_source: "agency_partner",
    referrer_host: "example.com",
  });
  assert.equal("sessionId" in normalized, false);
  assert.equal("email" in normalized.properties, false);
  assert.equal("endpoint" in normalized.properties, false);
  assert.equal("prompt" in normalized.properties, false);
  assert.equal(normalized.visitorHash, hashGrowthSession(sessionId));
});

test("public ingestion cannot forge trusted server-side conversion events", () => {
  assert.throws(() => normalizeClientGrowthEvent({
    eventName: "business.payment_confirmed",
    eventId,
    sessionId,
    properties: { amount_usdt: 1 },
  }), /not allowed/);
  assert.throws(() => normalizeClientGrowthEvent({
    eventName: "attack_lab.challenge_run",
    eventId,
    sessionId,
    properties: { page: "attack_lab", scenarioId: "unknown" },
  }), /known Attack Lab scenario/);
  assert.throws(() => normalizeClientGrowthEvent({
    eventName: "auth.signup_started",
    eventId,
    sessionId,
    properties: { page: "home" },
  }), /source page is invalid/);
});

test("verified payment reporting uses bounded, non-sensitive dimensions", () => {
  assert.deepEqual(normalizePaymentGrowthProperties({
    checkoutType: "addon",
    addonId: "scan_credits_1000",
    amount: "29.990000",
  }), {
    checkout_type: "addon",
    addon_id: "scan_credits_1000",
    amount_usdt: 29.99,
  });
  assert.deepEqual(normalizePaymentGrowthProperties({
    checkoutType: "plan",
    planId: "pro",
    addonId: "ignored",
    amount: "NaN",
  }), { checkout_type: "subscription", plan_id: "pro" });
  assert.equal(hashGrowthSourceKey("tron-p2p:payment-1"), hashGrowthSourceKey("tron-p2p:payment-1"));
  assert.notEqual(hashGrowthSourceKey("tron-p2p:payment-1"), "tron-p2p:payment-1");
});
