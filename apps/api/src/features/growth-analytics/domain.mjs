import { createHash, randomUUID } from "node:crypto";

export const GROWTH_EVENT_NAMES = Object.freeze([
  "marketing.landing_view",
  "marketing.connect_cta_clicked",
  "marketing.demo_cta_clicked",
  "attack_lab.challenge_run",
  "auth.signup_started",
  "business.signup_completed",
  "business.first_agent_created",
  "business.first_agent_connected",
  "business.first_scan_completed",
  "business.sdk_verified",
  "business.payment_confirmed",
  "business.pilot_started",
]);

const clientEvents = new Set([
  "marketing.landing_view",
  "marketing.connect_cta_clicked",
  "marketing.demo_cta_clicked",
  "attack_lab.challenge_run",
  "auth.signup_started",
]);
const scenarios = new Set(["refund_policy", "argument_tampering", "approval_replay"]);
const pages = new Set(["home", "attack_lab", "security_guide", "prompt_injection_guide", "app"]);
const publicPages = new Set(["home", "attack_lab", "security_guide", "prompt_injection_guide"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const attributionPattern = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

export function hashGrowthSession(value) {
  if (typeof value !== "string" || !uuidPattern.test(value)) return null;
  return createHash("sha256").update(value.toLowerCase()).digest("hex");
}

export function hashGrowthSourceKey(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 512) return null;
  return createHash("sha256").update(value).digest("hex");
}

function normalizeAttributionValue(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ").slice(0, 80);
  return normalized && attributionPattern.test(normalized) ? normalized.toLowerCase() : null;
}

function normalizeReferrerHost(value) {
  if (typeof value !== "string" || value.length > 255) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.hostname.toLowerCase().replace(/^www\./, "").slice(0, 180) || null;
  } catch {
    return null;
  }
}

export function normalizeClientGrowthEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Analytics event must be an object.");
  }
  const { eventName, sessionId, eventId, properties } = input;
  if (typeof eventName !== "string" || !clientEvents.has(eventName)) {
    throw new TypeError("Analytics event is not allowed.");
  }
  const visitorHash = hashGrowthSession(sessionId);
  if (!visitorHash || typeof eventId !== "string" || !uuidPattern.test(eventId)) {
    throw new TypeError("A valid session and event identifier are required.");
  }
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    throw new TypeError("Analytics properties must be an object.");
  }

  const safe = {};
  if (pages.has(properties.page)) safe.page = properties.page;
  if (eventName === "attack_lab.challenge_run") {
    if (!scenarios.has(properties.scenarioId) || properties.page !== "attack_lab") {
      throw new TypeError("A known Attack Lab scenario is required.");
    }
    safe.scenarioId = properties.scenarioId;
    safe.page = "attack_lab";
  }
  for (const [inputKey, outputKey] of [
    ["utmSource", "utm_source"],
    ["utmMedium", "utm_medium"],
    ["utmCampaign", "utm_campaign"],
  ]) {
    const value = normalizeAttributionValue(properties[inputKey]);
    if (value) safe[outputKey] = value;
  }
  const referrerHost = normalizeReferrerHost(properties.referrer);
  if (referrerHost) safe.referrer_host = referrerHost;

  if (eventName === "marketing.landing_view" && !publicPages.has(safe.page)) {
    throw new TypeError("Landing page is invalid.");
  }
  if (eventName.startsWith("marketing.") && !safe.page) {
    throw new TypeError("Marketing event source page is invalid.");
  }
  if (eventName === "auth.signup_started" && safe.page !== "app") {
    throw new TypeError("Signup source page is invalid.");
  }

  return {
    eventName,
    visitorHash,
    clientEventId: eventId.toLowerCase(),
    properties: safe,
  };
}

export function createGrowthEventId() {
  return `growth-${randomUUID()}`;
}

export function normalizePaymentGrowthProperties({ checkoutType, planId, addonId, amount }) {
  const safeType = checkoutType === "addon" ? "addon" : "subscription";
  const normalizedAmount = Number(amount);
  return {
    checkout_type: safeType,
    ...(safeType === "subscription" && typeof planId === "string" && /^[a-z0-9_-]{2,40}$/i.test(planId)
      ? { plan_id: planId }
      : {}),
    ...(safeType === "addon" && typeof addonId === "string" && /^[a-z0-9_-]{2,80}$/i.test(addonId)
      ? { addon_id: addonId }
      : {}),
    ...(Number.isFinite(normalizedAmount) && normalizedAmount > 0 && normalizedAmount <= 1000000
      ? { amount_usdt: Math.round(normalizedAmount * 100) / 100 }
      : {}),
  };
}
