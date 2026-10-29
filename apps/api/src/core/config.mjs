import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The API is launched through an npm workspace from the monorepo root, while
// Docker injects environment variables directly. Load the root development
// file explicitly so both launch modes receive the same local configuration.
// Existing process environment values always win (dotenv's default behavior).
dotenv.config({
  path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../../.env"),
});

const isProduction = process.env.NODE_ENV === "production";

function configuredOrigin() {
  const value = process.env.WEB_ORIGIN ?? "http://localhost:5173";
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("WEB_ORIGIN must be a valid HTTP(S) origin.");
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("WEB_ORIGIN must be an HTTP(S) origin without a path or credentials.");
  }
  if (isProduction && parsed.protocol !== "https:") {
    throw new Error("WEB_ORIGIN must use HTTPS in production.");
  }
  return parsed.origin;
}

function configuredAIBaseUrl() {
  const value = (process.env.AI_BASE_URL ?? "https://api.openai.com/v1").trim();
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("AI_BASE_URL must be a valid HTTP(S) endpoint.");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (isProduction && parsed.protocol !== "https:")
  ) {
    throw new Error("AI_BASE_URL must not include credentials, query, or fragment, and must use HTTPS in production.");
  }
  return parsed.toString().replace(/\/$/, "");
}

function positiveInteger(
  name,
  fallback,
  { min = 1, max = Number.MAX_SAFE_INTEGER } = {},
) {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function positiveDecimal(name, fallback, { min = 0.000000000001, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a positive decimal between ${min} and ${max}.`);
  }
  return value;
}

function nonNegativeDecimal(name, fallback, { max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > max) {
    throw new Error(`${name} must be a non-negative decimal no greater than ${max}.`);
  }
  return value;
}

export function parseTrustProxy(value = process.env.TRUST_PROXY) {
  if (value === undefined || value === "") return false;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  if (/^\d+$/.test(normalized)) {
    const hops = Number(normalized);
    if (Number.isSafeInteger(hops)) return hops;
  }
  throw new Error('TRUST_PROXY must be "true", "false", or a non-negative integer hop count.');
}

const requiredSecret = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (
    isProduction &&
    (!value ||
      value.length < 32 ||
      value.startsWith("change-") ||
      value.startsWith("replace_"))
  ) {
    throw new Error(
      `${name} must be configured with a strong production value.`,
    );
  }
  return value;
};

const requiredProductionValue = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  return value;
};

export const config = Object.freeze({
  nodeEnv: process.env.NODE_ENV ?? "development",
  host: process.env.API_HOST ?? (isProduction ? "0.0.0.0" : "127.0.0.1"),
  // Render injects PORT at runtime and must win over a locally configured
  // API_PORT. API_PORT remains the fallback for local development and Compose.
  port: positiveInteger("PORT", positiveInteger("API_PORT", 4100, { max: 65535 }), { max: 65535 }),
  trustProxy: parseTrustProxy(),
  webOrigin: configuredOrigin(),
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgresql://agentguard:agentguard@127.0.0.1:5432/agentguard",
  databasePoolMax: positiveInteger("DATABASE_POOL_MAX", 20, { min: 1, max: 80 }),
  databaseConnectionTimeoutMs: positiveInteger("DATABASE_CONNECTION_TIMEOUT_MS", 15000, {
    min: 1000,
    max: 120000,
  }),
  jwtSecret: requiredSecret("JWT_SECRET", "change-me-development-jwt-secret"),
  agentSecret: requiredSecret(
    "AGENT_SECRET",
    "change-me-development-agent-secret",
  ),
  authCookie: process.env.AUTH_COOKIE ?? "agentguard_session",
  // Production defaults to verification, but the portfolio launch can opt out
  // explicitly with REQUIRE_EMAIL_VERIFICATION=false until email delivery exists.
  requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION === undefined
    ? isProduction
    : process.env.REQUIRE_EMAIL_VERIFICATION === "true",
  authEmailWebhookUrl: process.env.AUTH_EMAIL_WEBHOOK_URL ?? "",
  seedEmail: process.env.DEV_SEED_EMAIL ?? "demo@agentguard.local",
  seedPassword: process.env.DEV_SEED_PASSWORD ?? "change-me-locally",
  agentRequestTimeoutMs: positiveInteger("AGENT_REQUEST_TIMEOUT_MS", 30000, {
    min: 100,
    max: 300000,
  }),
  agentMaxResponseBytes: positiveInteger("AGENT_MAX_RESPONSE_BYTES", 1048576, {
    min: 1024,
    max: 52428800,
  }),
  scanWorkerIntervalMs: positiveInteger("SCAN_WORKER_INTERVAL_MS", 1000, {
    min: 100,
    max: 60000,
  }),
  scanMaxAttempts: positiveInteger("SCAN_MAX_ATTEMPTS", 3, { max: 10 }),
  scanJobLeaseMs: positiveInteger("SCAN_JOB_LEASE_MS", 300000, {
    min: 1000,
    max: 3600000,
  }),
  scanRetryBaseMs: positiveInteger("SCAN_RETRY_BASE_MS", 2000, {
    min: 100,
    max: 60000,
  }),
  scanWorkerConcurrency: positiveInteger("SCAN_WORKER_CONCURRENCY", 2, {
    min: 1,
    max: 16,
  }),
  scanWorkerShutdownTimeoutMs: positiveInteger("SCAN_WORKER_SHUTDOWN_TIMEOUT_MS", 25000, {
    min: 1000,
    max: 120000,
  }),
  retentionWorkerIntervalMs: positiveInteger("RETENTION_WORKER_INTERVAL_MS", 3600000, {
    min: 60000,
    max: 86400000,
  }),
  billingReconciliationIntervalMs: positiveInteger("BILLING_RECONCILIATION_INTERVAL_MS", 30000, {
    min: 5000,
    max: 600000,
  }),
  billingReconciliationBatchSize: positiveInteger("BILLING_RECONCILIATION_BATCH_SIZE", 20, {
    min: 1,
    max: 100,
  }),
  billingReconciliationLockKey: process.env.BILLING_RECONCILIATION_LOCK_KEY
    ?? "agentguard:billing:tron-reconciliation",
  billingReconciliationRunRetentionDays: positiveInteger("BILLING_RECONCILIATION_RUN_RETENTION_DAYS", 90, {
    min: 7,
    max: 730,
  }),
  usageCostModel: Object.freeze({
    cpuUsdPerHour: nonNegativeDecimal("USAGE_CPU_USD_PER_HOUR", 0.12, { max: 1000 }),
    storageUsdPerGbMonth: nonNegativeDecimal("USAGE_STORAGE_USD_PER_GB_MONTH", 0.1, { max: 1000 }),
    // The fallback rates keep local development deterministic, but they are not
    // a production cost claim. The API exposes this distinction to the UI.
    configuredEstimate: Boolean(
      String(process.env.USAGE_CPU_USD_PER_HOUR ?? "").trim() &&
      String(process.env.USAGE_STORAGE_USD_PER_GB_MONTH ?? "").trim(),
    ),
    snapshotRetentionDays: positiveInteger("USAGE_SNAPSHOT_RETENTION_DAYS", 180, { min: 7, max: 3650 }),
  }),
  // Keep this false during migration. Enable it only after every owner/admin
  // has enrolled TOTP from Settings, otherwise production logins are blocked.
  requireAdminMfa: process.env.REQUIRE_ADMIN_MFA === "true",
  sentinelWorkerIntervalMs: positiveInteger("SENTINEL_WORKER_INTERVAL_MS", 60000, {
    min: 5000,
    max: 3600000,
  }),
  sentinelWorkerBatchSize: positiveInteger("SENTINEL_WORKER_BATCH_SIZE", 200, {
    min: 1,
    max: 1000,
  }),
  sentinelWorkerConcurrency: positiveInteger("SENTINEL_WORKER_CONCURRENCY", 8, {
    min: 1,
    max: 32,
  }),
  incidentWorkerIntervalMs: positiveInteger("INCIDENT_WORKER_INTERVAL_MS", 2000, {
    min: 500,
    max: 60000,
  }),
  authRateLimitWindowMs: positiveInteger("AUTH_RATE_LIMIT_WINDOW_MS", 10 * 60 * 1000, {
    min: 1000,
    max: 3600000,
  }),
  authRateLimitMax: positiveInteger("AUTH_RATE_LIMIT_MAX", 30, { max: 1000 }),
  runtimeRateLimitWindowMs: positiveInteger("RUNTIME_RATE_LIMIT_WINDOW_MS", 60000, {
    min: 1000,
    max: 3600000,
  }),
  runtimeRateLimitMax: positiveInteger("RUNTIME_RATE_LIMIT_MAX", 120, { max: 10000 }),
  runtimeApprovalTtlMs: positiveInteger("RUNTIME_APPROVAL_TTL_MS", 30000, {
    min: 1000,
    max: 300000,
  }),
  runtimeContextClockSkewMs: positiveInteger("RUNTIME_CONTEXT_CLOCK_SKEW_MS", 300000, {
    min: 1000,
    max: 3600000,
  }),
  scanRateLimitWindowMs: positiveInteger("SCAN_RATE_LIMIT_WINDOW_MS", 60000, {
    min: 1000,
    max: 3600000,
  }),
  scanRateLimitMax: positiveInteger("SCAN_RATE_LIMIT_MAX", 10, { max: 1000 }),
  aiCopilotRateLimitWindowMs: positiveInteger("AI_COPILOT_RATE_LIMIT_WINDOW_MS", 60 * 60 * 1000, {
    min: 1000,
    max: 24 * 60 * 60 * 1000,
  }),
  aiCopilotRateLimitMax: positiveInteger("AI_COPILOT_RATE_LIMIT_MAX", 20, { max: 1000 }),
  ai: Object.freeze({
    apiKey: (process.env.AI_API_KEY ?? "").trim(),
    model: (process.env.AI_MODEL ?? "").trim(),
    baseUrl: configuredAIBaseUrl(),
    requestTimeoutMs: positiveInteger("AI_REQUEST_TIMEOUT_MS", 45000, {
      min: 1000,
      max: 120000,
    }),
  }),
  webhookRateLimitWindowMs: positiveInteger("WEBHOOK_RATE_LIMIT_WINDOW_MS", 60000, {
    min: 1000,
    max: 3600000,
  }),
  webhookRateLimitMax: positiveInteger("WEBHOOK_RATE_LIMIT_MAX", 10, { max: 1000 }),
  tron: Object.freeze({
    walletAddress: process.env.MY_TRONLINK_PUBLIC_ADDRESS ?? "",
    usdtContract: process.env.TRON_USDT_CONTRACT ?? "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    gridUrl: process.env.TRON_GRID_URL ?? "https://api.trongrid.io",
    scanUrl: process.env.TRONSCAN_API_URL ?? "https://apilist.tronscanapi.com",
    apiKey: requiredProductionValue("TRON_PRO_API_KEY", ""),
    maxLookbackMs: positiveInteger("TRON_MAX_LOOKBACK_MS", 30 * 24 * 60 * 60 * 1000, {
      min: 60_000,
      max: 90 * 24 * 60 * 60 * 1000,
    }),
    requestTimeoutMs: positiveInteger("TRON_REQUEST_TIMEOUT_MS", 10_000, {
      min: 1_000,
      max: 60_000,
    }),
  }),
  allowPrivateAgentEndpoints:
    !isProduction && process.env.ALLOW_PRIVATE_AGENT_ENDPOINTS === "true",
  isProduction,
});

export function assertProductionConfiguration() {
  if (config.isProduction && !String(config.tron.apiKey).trim()) {
    throw new Error("TRON_PRO_API_KEY must be configured in production.");
  }
}
