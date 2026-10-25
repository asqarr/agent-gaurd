import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./core/config.mjs";
import { closeDatabase, migrate, query, withTransaction } from "./core/db.mjs";
import {
  clearSessionCookie,
  createActionToken,
  createMfaSecret,
  createOtpAuthUri,
  hashActionToken,
  issueMfaChallenge,
  revokeRefreshSession,
  hashPassword,
  issueSession,
  requireAuth,
  setSessionCookie,
  startRefreshSession,
  verifyPassword,
  verifyMfaChallenge,
  verifyMfaCode,
} from "./features/auth/auth.mjs";
import { seedDevelopmentData } from "./infrastructure/bootstrap.mjs";
import { attackPaths, policy, scenarios, toolDetails, tools } from "./features/catalog/domain.mjs";
import { decryptSecret, encryptSecret } from "./core/secrets.mjs";
import { startScanWorker } from "./features/scans/scan-worker.mjs";
import { startSentinelWorker } from "./features/sentinel/sentinel-worker.mjs";
import { startIncidentWorker } from "./features/incidents/incident-worker.mjs";
import { startRetentionWorker } from "./features/billing/retention-worker.mjs";
import { startPaymentReconciliationWorker } from "./features/billing/payment-reconciliation-worker.mjs";
import { assertHttpsIncidentWebhookUrl, deliverIncidentWebhook, incidentEventTypes } from "./features/incidents/domain.mjs";
import * as repository from "./infrastructure/repository.mjs";
import { assertSafeAgentEndpoint } from "./features/agents/network-guard.mjs";
import { requestAgentInput, testAgentConnection } from "./features/agents/agent-client.mjs";
import { renderScanReport } from "./features/reports/report.mjs";
import { renderEnforcementVerificationReport } from "./features/reports/verification-report.mjs";
import {
  enforcementVerificationFingerprint,
  runEnforcementVerification,
} from "./features/runtime/enforcement-verification.mjs";
import { buildSecurityProof } from "./features/quickstart/domain.mjs";
import { evaluateAttackLab } from "./features/attack-lab/domain.mjs";
import {
  hashGrowthSession,
  hashGrowthSourceKey,
  normalizeClientGrowthEvent,
  normalizePaymentGrowthProperties,
} from "./features/growth-analytics/domain.mjs";
import { recordGrowthEvent } from "./features/growth-analytics/repository.mjs";
import { createRateLimiter } from "./core/rate-limit.mjs";
import {
  approvalMatchesCall,
  buildExecutionReceipt,
  buildApprovalPayload,
  createApprovalId,
  createRuntimeToken,
  enforceExecutionContext,
  finalizeRuntimeCalls,
  hashRuntimeToken,
  inspectRuntimeCalls,
  normalizeExecutionContext,
  readRuntimeToken,
  signApproval,
  verifyApprovalSignature,
} from "./features/runtime/runtime-firewall.mjs";
import { summarizeRuntimeHealth } from "./features/runtime/runtime-health.mjs";
import billingRouter from "./features/billing/billing-router.mjs";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicPath = path.join(__dirname, "../../web/dist");
const requestMetrics = {
  startedAt: Date.now(),
  requests: 0,
  errors: 0,
  totalLatencyMs: 0,
};

// Serve the production React build before any API or security middleware.
// This keeps browser assets public on the single Render web service while
// API requests continue through the normal middleware and authentication.
app.use(express.static(publicPath));
app.use("/assets", express.static(path.join(publicPath, "assets")));

app.disable("x-powered-by");
app.set("trust proxy", config.trustProxy);

function isSameOriginRequest(req, origin) {
  if (!origin) return true;
  const host = req.get("host");
  if (!host) return false;
  try {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.host !== host) return false;
    return config.isProduction
      ? parsedOrigin.protocol === "https:"
      : parsedOrigin.protocol === req.protocol;
  } catch {
    return false;
  }
}

app.use((req, res, next) => {
  const supplied = req.get("X-Request-Id");
  req.requestId = supplied && /^[a-zA-Z0-9._:-]{1,128}$/.test(supplied)
    ? supplied
    : randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  const startedAt = Date.now();
  requestMetrics.requests += 1;
  res.on("finish", () => {
    requestMetrics.totalLatencyMs += Date.now() - startedAt;
    if (res.statusCode >= 500) requestMetrics.errors += 1;
  });
  next();
});

app.use(express.json({ limit: "64kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  if (config.isProduction) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Origin");
  const origin = req.get("Origin");
  let isAllowedOrigin = !origin || origin === config.webOrigin || isSameOriginRequest(req, origin);
  if (origin && !isAllowedOrigin && !config.isProduction) {
    try {
      const parsedOrigin = new URL(origin);
      isAllowedOrigin = parsedOrigin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsedOrigin.hostname);
    } catch {
      isAllowedOrigin = false;
    }
  }
  if (origin && isAllowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Request-Id");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  }
  if (!isAllowedOrigin) {
    return res.status(403).json({ error: "Cross-origin request blocked.", requestId: req.requestId });
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  if (req.path.startsWith("/api/") && ["POST", "PATCH", "PUT", "DELETE"].includes(req.method) && origin && !isAllowedOrigin) {
    return res.status(403).json({ error: "Cross-origin request blocked.", requestId: req.requestId });
  }
  next();
});

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    workspaceId: user.workspaceId,
    workspaceName: user.workspaceName,
    role: user.role,
    emailVerified: Boolean(user.emailVerified ?? user.email_verified_at),
    mfaEnabled: Boolean(user.mfaEnabled ?? user.mfa_enabled),
  };
}

function requestIp(req) {
  const ip = typeof req.ip === "string" ? req.ip : null;
  return ip?.startsWith("::ffff:") ? ip.slice(7) : ip;
}

async function recordAudit(req, details) {
  try {
    return await repository.recordAuditEvent({
      workspaceId: req.auth?.workspaceId ?? details.workspaceId,
      actorUserId: req.auth?.userId ?? details.actorUserId ?? null,
      requestId: req.requestId,
      ipAddress: requestIp(req),
      ...details,
    });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "audit_write_failed",
      requestId: req.requestId,
      error: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}

async function recordGrowthSafely(event) {
  try {
    return await recordGrowthEvent(event);
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "growth_analytics_write_failed",
      eventName: event.eventName,
      error: error instanceof Error ? error.message : String(error),
    }));
    return false;
  }
}

function growthSessionHash(req) {
  return hashGrowthSession(req.get("X-AgentGuard-Growth-Session"));
}

async function dispatchAuthAction({ email, purpose, token, expiresAt }) {
  if (config.authEmailWebhookUrl) {
    const response = await fetch(config.authEmailWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: email,
        purpose,
        token,
        expiresAt: expiresAt.toISOString(),
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Auth email delivery failed with HTTP ${response.status}.`);
    return { delivered: true };
  }
  if (!config.isProduction) {
    console.info(JSON.stringify({ level: "info", event: "auth_action_token_dev", email, purpose, token }));
    return { delivered: false, developmentToken: token };
  }
  console.warn(JSON.stringify({ level: "warn", event: "auth_email_delivery_not_configured", email, purpose }));
  return { delivered: false };
}

function validateCredentials(email, password) {
  return (
    typeof email === "string" &&
    email.includes("@") &&
    typeof password === "string" &&
    password.length >= 8
  );
}

const loginFailures = new Map();
const loginWindowMs = 15 * 60 * 1000;
const loginMaxFailures = 5;
const authRateLimit = createRateLimiter({
  windowMs: config.authRateLimitWindowMs,
  max: config.authRateLimitMax,
  message: "Too many authentication requests. Try again later.",
});
const runtimeRateLimit = createRateLimiter({
  windowMs: config.runtimeRateLimitWindowMs,
  max: config.runtimeRateLimitMax,
  keyFn: (req) => `${req.ip}:${req.params.agentId}`,
  message: "Too many runtime requests for this agent. Try again later.",
});
const scanRateLimit = createRateLimiter({
  windowMs: config.scanRateLimitWindowMs,
  max: config.scanRateLimitMax,
  keyFn: (req) => `${req.auth?.workspaceId ?? req.ip}`,
  message: "Too many scan requests. Try again later.",
});
const attackLabRateLimit = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 30,
  keyFn: (req) => req.ip || req.socket.remoteAddress || "unknown",
  message: "Attack Lab is receiving too many requests. Please try again in a few minutes.",
});
const growthEventRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 80,
  keyFn: (req) => req.ip || req.socket.remoteAddress || "unknown",
  message: "Analytics event limit reached. Try again later.",
});
const webhookRateLimit = createRateLimiter({
  windowMs: config.webhookRateLimitWindowMs,
  max: config.webhookRateLimitMax,
  keyFn: (req) => `${req.auth?.workspaceId ?? req.ip}`,
  message: "Too many webhook operations. Try again later.",
});

function loginKey(req, email) {
  return `${req.ip}:${email.trim().toLowerCase()}`;
}

function isLoginBlocked(key) {
  const entry = loginFailures.get(key);
  if (!entry || entry.resetAt <= Date.now()) {
    loginFailures.delete(key);
    return false;
  }
  return entry.failures >= loginMaxFailures;
}

function recordLoginFailure(key) {
  const current = loginFailures.get(key);
  const entry =
    current && current.resetAt > Date.now()
      ? current
      : { failures: 0, resetAt: Date.now() + loginWindowMs };
  entry.failures += 1;
  loginFailures.set(key, entry);
}

app.get("/api/health", async (req, res) => {
  try {
    await query("SELECT 1");
    res.json({
      status: "ok",
      service: "agentguard-api",
      database: "ok",
      worker: "running",
      requestId: req.requestId,
      uptimeSeconds: Math.floor(process.uptime()),
      metrics: {
        requests: requestMetrics.requests,
        errors: requestMetrics.errors,
        averageLatencyMs: requestMetrics.requests
          ? Math.round(requestMetrics.totalLatencyMs / requestMetrics.requests)
          : 0,
      },
    });
  } catch {
    res
      .status(503)
      .json({
        status: "degraded",
        service: "agentguard-api",
        database: "unavailable",
      requestId: req.requestId,
      });
  }
});

app.post("/api/auth/register", authRateLimit, async (req, res, next) => {
  try {
    const { email, password, name, workspaceName } = req.body ?? {};
    if (
      !validateCredentials(email, password) ||
      typeof name !== "string" ||
      name.trim().length < 2
    ) {
      return res
        .status(400)
        .json({
          error:
            "Name, valid email, and password of at least 8 characters are required.",
        });
    }
    const user = await repository.registerUser({
      email: email.trim(),
      name: name.trim(),
      passwordHash: await hashPassword(password),
      emailVerified: !config.requireEmailVerification,
      workspaceName:
        typeof workspaceName === "string" && workspaceName.trim()
          ? workspaceName.trim()
          : `${name.trim()}'s workspace`,
    });
    await recordGrowthSafely({
      eventName: "business.signup_completed",
      workspaceId: user.workspaceId,
      visitorHash: growthSessionHash(req),
      attachPriorSessionEvents: true,
      properties: { registration: "completed" },
    });
    if (config.requireEmailVerification) {
      const verification = createActionToken("ag_verify");
      const verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await repository.createAuthActionToken({
        id: `email-verification-${randomUUID()}`,
        userId: user.id,
        purpose: "email_verification",
        tokenHash: verification.hash,
        expiresAt: verificationExpiresAt,
      });
      const delivery = await dispatchAuthAction({
        email: user.email,
        purpose: "email_verification",
        token: verification.raw,
        expiresAt: verificationExpiresAt,
      });
      await recordAudit(req, {
        workspaceId: user.workspaceId,
        actorUserId: user.id,
        action: "auth.verification_requested",
        resourceType: "user",
        resourceId: user.id,
      });
      return res.status(202).json({
        verificationRequired: true,
        message: "Check your email to verify the workspace before signing in.",
        developmentToken: delivery.developmentToken,
      });
    }
    setSessionCookie(res, issueSession(user));
    await startRefreshSession(res, user, req);
    await recordAudit(req, {
      workspaceId: user.workspaceId,
      actorUserId: user.id,
      action: "auth.register",
      resourceType: "workspace",
      resourceId: user.workspaceId,
    });
    res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    if (error.code === "EMAIL_EXISTS")
      return res.status(409).json({ error: error.message });
    next(error);
  }
});

app.post("/api/auth/login", authRateLimit, async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};
    if (!validateCredentials(email, password))
      return res
        .status(400)
        .json({ error: "Valid email and password are required." });
    const key = loginKey(req, email);
    if (isLoginBlocked(key)) {
      res.setHeader("Retry-After", String(Math.ceil(loginWindowMs / 1000)));
      return res
        .status(429)
        .json({ error: "Too many login attempts. Try again later." });
    }
    const user = await repository.findUserByEmail(email.trim());
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      recordLoginFailure(key);
      return res.status(401).json({ error: "Email or password is incorrect." });
    }
    if (config.requireEmailVerification && !user.email_verified_at) {
      return res.status(403).json({
        error: "Verify your email before signing in.",
        code: "EMAIL_NOT_VERIFIED",
      });
    }
    if (user.mfa_enabled) {
      return res.json({
        mfaRequired: true,
        challenge: issueMfaChallenge({ id: user.id }),
      });
    }
    loginFailures.delete(key);
    const sessionUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      workspaceId: user.workspace_id,
      workspaceName: user.workspace_name,
      role: user.role,
      sessionVersion: user.session_version,
    };
    setSessionCookie(res, issueSession(sessionUser));
    await startRefreshSession(res, sessionUser, req);
    await recordAudit(req, {
      workspaceId: sessionUser.workspaceId,
      actorUserId: sessionUser.id,
      action: "auth.login",
      resourceType: "session",
      resourceId: sessionUser.id,
    });
    res.json({ user: publicUser(sessionUser) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", async (req, res, next) => {
  try {
    await revokeRefreshSession(req, res);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/me", requireAuth, async (req, res, next) => {
  try {
    const user = await repository.findUserById(req.auth.userId);
    if (!user) return res.status(401).json({ error: "User no longer exists." });
    res.json({
      user: publicUser({
        id: user.id,
        email: user.email,
        name: user.name,
        workspaceId: user.workspace_id,
        workspaceName: user.workspace_name,
        role: user.role,
      }),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/verify-email", async (req, res, next) => {
  try {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!token) return res.status(400).json({ error: "Verification token is required." });
    const action = await repository.getAuthActionToken({
      tokenHash: hashActionToken(token),
      purpose: "email_verification",
    });
    if (!action) return res.status(400).json({ error: "Verification token is invalid or expired." });
    const userId = await repository.consumeAuthActionToken({
      tokenHash: hashActionToken(token),
      purpose: "email_verification",
    });
    if (!userId) return res.status(400).json({ error: "Verification token is invalid or expired." });
    await repository.markEmailVerified(userId);
    res.json({ verified: true, message: "Email verified. You can sign in now." });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/forgot-password", authRateLimit, async (req, res, next) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
    const user = email ? await repository.findUserByEmail(email) : null;
    let developmentToken;
    if (user) {
      const action = createActionToken("ag_reset");
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      await repository.createAuthActionToken({
        id: `password-reset-${randomUUID()}`,
        userId: user.id,
        purpose: "password_reset",
        tokenHash: action.hash,
        expiresAt,
      });
      const delivery = await dispatchAuthAction({
        email: user.email,
        purpose: "password_reset",
        token: action.raw,
        expiresAt,
      });
      developmentToken = delivery.developmentToken;
    }
    // Never reveal whether an email exists in the workspace.
    res.status(202).json({
      message: "If that email belongs to an account, a reset link has been sent.",
      developmentToken,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/reset-password", authRateLimit, async (req, res, next) => {
  try {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    const password = req.body?.password;
    if (!token || typeof password !== "string" || password.length < 12) {
      return res.status(400).json({ error: "A reset token and password of at least 12 characters are required." });
    }
    const tokenHash = hashActionToken(token);
    const action = await repository.getAuthActionToken({ tokenHash, purpose: "password_reset" });
    if (!action) return res.status(400).json({ error: "Reset token is invalid or expired." });
    const userId = await repository.consumeAuthActionToken({ tokenHash, purpose: "password_reset" });
    if (!userId) return res.status(400).json({ error: "Reset token is invalid or expired." });
    await repository.updateUserPassword({ userId, passwordHash: await hashPassword(password) });
    res.json({ reset: true, message: "Password reset. All previous sessions were revoked." });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/mfa/verify", authRateLimit, async (req, res, next) => {
  try {
    const challenge = typeof req.body?.challenge === "string" ? req.body.challenge : "";
    const code = typeof req.body?.code === "string" ? req.body.code : "";
    const claims = verifyMfaChallenge(challenge);
    const user = await repository.findUserById(claims.userId ?? claims.sub);
    if (!user?.mfa_enabled || !user.encrypted_mfa_secret || !verifyMfaCode(decryptSecret(user.encrypted_mfa_secret), code)) {
      return res.status(401).json({ error: "MFA code is invalid." });
    }
    const sessionUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      workspaceId: user.workspace_id,
      workspaceName: user.workspace_name,
      role: user.role,
      sessionVersion: user.session_version,
    };
    setSessionCookie(res, issueSession(sessionUser));
    await startRefreshSession(res, sessionUser, req);
    await recordAudit(req, {
      workspaceId: sessionUser.workspaceId,
      actorUserId: sessionUser.id,
      action: "auth.mfa_login",
      resourceType: "session",
      resourceId: sessionUser.id,
    });
    res.json({ user: publicUser(sessionUser) });
  } catch (error) {
    return res.status(401).json({ error: "MFA challenge is invalid or expired." });
  }
});

// Server-to-server runtime gateway. It intentionally uses a scoped agent token,
// not a browser session, so customer traffic never needs workspace credentials.
app.post("/api/runtime/agents/:agentId/invoke", runtimeRateLimit, async (req, res, next) => {
  const requestId = req.requestId;
  const startedAt = Date.now();
  const startedClock = process.hrtime.bigint();
  const cpuStart = process.cpuUsage();
  const rssStart = process.memoryUsage().rss;
  let meteredAgent = null;
  let meteredRuntimeUsage = null;
  let meteredDecision = "ERROR";
  let meteredToolCount = 0;
  let runtimeFailureStage = "gateway";
  try {
    const token = readRuntimeToken(req);
    if (!token) return res.status(401).json({ error: "Runtime token required." });
    const agent = await repository.getRuntimeAgentByToken(hashRuntimeToken(token));
    if (!agent || agent.id !== req.params.agentId) {
      return res.status(401).json({ error: "Runtime token is invalid." });
    }
    meteredAgent = agent;
    if (!agent.runtimeEnabled) {
      return res.status(403).json({ error: "Runtime Firewall is disabled for this agent." });
    }
    if (agent.status === "quarantined") {
      return res.status(423).json({
        requestId,
        error: "Agent is quarantined. Runtime traffic is locked.",
        guard: { decision: "BLOCK", execution: "NOT_EXECUTED", reasons: ["Agent is quarantined."] },
      });
    }
    const body = req.body ?? {};
    if (typeof body.input !== "string" || !body.input.trim() || body.input.length > 8000) {
      return res.status(400).json({ error: "input is required and must be 8,000 characters or fewer." });
    }
    if (body.metadata !== undefined && (body.metadata === null || typeof body.metadata !== "object" || Array.isArray(body.metadata))) {
      return res.status(400).json({ error: "metadata must be a JSON object." });
    }
    let executionContext;
    try {
      executionContext = normalizeExecutionContext(body.executionContext);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const trustedOrders = body.trustedContext?.orders;
    if (trustedOrders !== undefined) {
      if (trustedOrders === null || typeof trustedOrders !== "object" || Array.isArray(trustedOrders) || Object.keys(trustedOrders).length > 100) {
        return res.status(400).json({ error: "trustedContext.orders must be an object with at most 100 orders." });
      }
      for (const [orderId, order] of Object.entries(trustedOrders)) {
        if (!orderId || order === null || typeof order !== "object" || Array.isArray(order) || !Number.isInteger(order.ageDays) || order.ageDays < 0 || order.ageDays > 36500) {
          return res.status(400).json({ error: "Each trusted order must include an integer ageDays between 0 and 36,500." });
        }
      }
    }

    let runtimeUsage;
    runtimeFailureStage = "quota";
    try {
      runtimeUsage = await repository.reserveRuntimeDecision(agent.workspaceId);
    } catch (error) {
      if (error?.code === "RUNTIME_QUOTA_EXCEEDED" || error?.code === "SUBSCRIPTION_REQUIRED") {
        try {
          await repository.recordRuntimeEvent({
            workspaceId: agent.workspaceId,
            agentId: agent.id,
            requestId,
            decision: "BLOCK",
            toolName: "runtime_quota",
            reasons: ["Runtime invocation was rejected because the workspace has no available Runtime capacity."],
            latencyMs: Date.now() - startedAt,
            outcome: "quota",
            errorCode: error.code,
            failureStage: "quota",
          });
        } catch {
          console.error(JSON.stringify({ level: "error", event: "runtime_telemetry_write_failed", requestId, category: "quota" }));
        }
        return res.status(402).json({
          requestId,
          error: error.message,
          code: error.code,
          failClosed: true,
          execution: "NOT_EXECUTED",
          nextActions: ["upgrade_plan", "purchase_runtime_addon"],
        });
      }
      throw error;
    }
    meteredRuntimeUsage = runtimeUsage;
    runtimeFailureStage = "customer_endpoint";
    const encryptedApiKey = await repository.getRuntimeAgentSecret(agent.id);
    const upstream = await requestAgentInput(
      { endpoint: agent.endpoint, encryptedApiKey },
      {
        input: body.input,
        metadata: {
          ...(body.metadata ?? {}),
          source: "agentguard_runtime",
          execution_mode: "runtime_gateway",
          execute_tools: false,
        },
      },
    );
    runtimeFailureStage = "policy";
    const workspacePolicy = (await repository.getPolicy(agent.workspaceId)) ?? policy;
    const contract = await repository.getSecurityContract({
      workspaceId: agent.workspaceId,
      agentId: agent.id,
    });
    const initialGuard = inspectRuntimeCalls(upstream.toolCalls, {
      allowedToolIds: contract?.allowedToolIds ?? agent.tools,
      policy: {
        ...workspacePolicy,
        maxAmount: Math.min(Number(workspacePolicy.maxAmount), Number(contract?.maxRefundAmount ?? workspacePolicy.maxAmount)),
        maxAgeDays: Math.min(Number(workspacePolicy.maxAgeDays), Number(contract?.maxOrderAgeDays ?? workspacePolicy.maxAgeDays)),
      },
      orders: trustedOrders,
    });
    const guard = finalizeRuntimeCalls(
      upstream.executionSafety === "unsafe"
        ? [{
            call: null,
            decision: "BLOCK",
            execution: "NOT_EXECUTED",
            reasons: [
              "Customer endpoint reported that it executed a tool before AgentGuard. This integration cannot provide pre-execution enforcement.",
            ],
          }]
        : enforceExecutionContext(initialGuard.inspections, executionContext),
    );
    meteredDecision = guard.decision;
    meteredToolCount = guard.inspections.length;
    const approvals = [];
    if (guard.decision === "ALLOW") {
      runtimeFailureStage = "approval_storage";
      const expiresAt = new Date(Date.now() + config.runtimeApprovalTtlMs);
      for (const call of guard.toolCalls) {
        const payload = buildApprovalPayload({
          approvalId: createApprovalId(),
          agentId: agent.id,
          workspaceId: agent.workspaceId,
          requestId,
          call,
          context: executionContext,
          expiresAt: expiresAt.toISOString(),
          policyVersion: contract?.version ? `contract-v${contract.version}` : "runtime-v1",
        });
        const signature = signApproval(payload, token);
        await repository.createRuntimeApproval({
          id: payload.approvalId,
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          requestId,
          toolName: call.name,
          payload,
          signature,
          expiresAt,
        });
        approvals.push({
          id: payload.approvalId,
          payload,
          signature,
          expiresAt: payload.expiresAt,
        });
      }
    }
    runtimeFailureStage = "decision_persistence";
    await repository.recordRuntimeEvent({
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      requestId,
      decision: guard.decision,
      toolName: guard.inspections.map((item) => item.call?.name).filter(Boolean).join(", ") || "no_tool_call",
      reasons: guard.reasons,
      latencyMs: Date.now() - startedAt,
    });
    runtimeFailureStage = "gateway";
    res.json({
      requestId,
      assistantText: upstream.assistantText,
      tool_calls: guard.toolCalls,
      blocked_tool_calls: guard.inspections
        .filter((item) => item.decision === "BLOCK")
        .map((item) => ({ name: item.call?.name ?? "unknown", reasons: item.reasons })),
      guard: {
        decision: guard.decision,
        execution: guard.execution,
        reasons: guard.reasons,
      },
      approved_tool_calls: approvals.map((approval) => ({
        call: {
          name: approval.payload.tool,
          arguments: approval.payload.arguments,
        },
        approval,
      })),
      usage: runtimeUsage,
      integrationSafety: upstream.executionSafety === "unsafe" ? "unsafe_upstream_execution" : "gateway_enforced",
      latencyMs: Date.now() - startedAt,
    });
  } catch (error) {
    if (meteredAgent && meteredRuntimeUsage) {
      const errorCode = runtimeFailureStage === "customer_endpoint"
        ? (/timed out|timeout/i.test(error instanceof Error ? error.message : "") ? "UPSTREAM_TIMEOUT" : "UPSTREAM_FAILURE")
        : runtimeFailureStage === "policy"
          ? "POLICY_PIPELINE_FAILURE"
          : runtimeFailureStage === "approval_storage"
            ? "APPROVAL_STORAGE_FAILURE"
            : runtimeFailureStage === "decision_persistence"
              ? "GATEWAY_INTERNAL_ERROR"
              : "GATEWAY_INTERNAL_ERROR";
      const failureStage = ["customer_endpoint", "policy", "approval_storage", "decision_persistence"].includes(runtimeFailureStage)
        ? runtimeFailureStage
        : "gateway";
      try {
        await repository.recordRuntimeEvent({
          workspaceId: meteredAgent.workspaceId,
          agentId: meteredAgent.id,
          requestId,
          decision: "BLOCK",
          toolName: "runtime_request",
          reasons: ["Runtime invocation failed before a policy decision was recorded."],
          latencyMs: Date.now() - startedAt,
          outcome: "error",
          errorCode,
          failureStage,
        });
      } catch {
        console.error(JSON.stringify({ level: "error", event: "runtime_telemetry_write_failed", requestId, category: "error" }));
      }
    }
    next(error);
  } finally {
    if (meteredAgent && meteredRuntimeUsage) {
      const cpu = process.cpuUsage(cpuStart);
      try {
        await repository.recordUsageMeasurement({
          workspaceId: meteredAgent.workspaceId,
          periodStart: meteredRuntimeUsage.periodStart,
          kind: "runtime_decision",
          units: 1,
          referenceType: "runtime_request",
          referenceId: requestId,
          durationMs: Math.max(0, Math.round(Number(process.hrtime.bigint() - startedClock) / 1e6)),
          cpuUserUs: Math.max(0, cpu.user),
          cpuSystemUs: Math.max(0, cpu.system),
          rssBytes: Math.max(rssStart, process.memoryUsage().rss),
          metadata: {
            agentId: meteredAgent.id,
            decision: meteredDecision,
            toolCount: meteredToolCount,
          },
        });
      } catch (measurementError) {
        console.error(JSON.stringify({
          level: "error",
          event: "usage_measurement_failed",
          requestId,
          error: measurementError instanceof Error ? measurementError.message : String(measurementError),
        }));
      }
    }
  }
});

// The SDK must consume an approval immediately before local tool execution.
// Consumption is atomic in PostgreSQL, so the same approval cannot be replayed.
app.post("/api/runtime/agents/:agentId/approvals/:approvalId/consume", runtimeRateLimit, async (req, res, next) => {
  try {
    const token = readRuntimeToken(req);
    if (!token) return res.status(401).json({ error: "Runtime token required." });
    const agent = await repository.getRuntimeAgentByToken(hashRuntimeToken(token));
    if (!agent || agent.id !== req.params.agentId || !agent.runtimeEnabled) {
      return res.status(401).json({ error: "Runtime token is invalid." });
    }
    const approval = await repository.getRuntimeApproval({
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      approvalId: req.params.approvalId,
    });
    if (!approval) return res.status(404).json({ error: "Approval not found." });
    if (!verifyApprovalSignature(approval.payload, approval.signature, token)) {
      return res.status(401).json({ error: "Approval signature is invalid." });
    }
    const call = req.body?.toolCall;
    if (!call || !approvalMatchesCall(approval.payload, call)) {
      return res.status(409).json({
        error: "Approval does not match the requested tool or arguments.",
        code: "APPROVAL_MISMATCH",
      });
    }
    const consumed = await repository.consumeRuntimeApproval({
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      approvalId: approval.id,
    });
    if (!consumed) {
      return res.status(409).json({
        error: "Approval is expired or has already been consumed.",
        code: "APPROVAL_REPLAYED_OR_EXPIRED",
      });
    }
    await recordGrowthSafely({
      eventName: "business.sdk_verified",
      workspaceId: agent.workspaceId,
      properties: { proof: "single_use_approval_consumed" },
    });
    await recordAudit(req, {
      workspaceId: agent.workspaceId,
      actorType: "runtime",
      action: "runtime_approval.consumed",
      resourceType: "runtime_approval",
      resourceId: approval.id,
      metadata: { agentId: agent.id, toolName: approval.toolName, requestId: approval.requestId },
    });
    res.json({
      approved: true,
      approvalId: approval.id,
      execution: "AUTHORIZED_ONCE",
      toolCall: {
        name: approval.payload.tool,
        arguments: approval.payload.arguments,
      },
      context: approval.payload.context,
      expiresAt: approval.payload.expiresAt,
      executionReceipt: buildExecutionReceipt(approval, token, new Date().toISOString()),
    });
  } catch (error) {
    next(error);
  }
});

// Public, synthetic-only lab. It runs fixed policy/approval challenges and has
// no route to customer endpoints, payment systems, or tool executors.
app.post("/api/attack-lab/run", attackLabRateLimit, (req, res) => {
  try {
    const result = evaluateAttackLab(req.body);
    res.setHeader("Cache-Control", "no-store");
    res.json({ result });
  } catch (error) {
    if (error?.statusCode === 400) {
      return res.status(400).json({ error: error.message, requestId: req.requestId });
    }
    console.error(JSON.stringify({
      level: "error",
      event: "attack_lab_failed",
      requestId: req.requestId,
      error: error instanceof Error ? error.message : String(error),
    }));
    res.status(500).json({ error: "Attack Lab could not safely complete this challenge.", requestId: req.requestId });
  }
});

// Public, allowlisted product events: never accept or persist arbitrary client metadata.
app.post("/api/growth/events", growthEventRateLimit, async (req, res) => {
  try {
    const event = normalizeClientGrowthEvent(req.body);
    await recordGrowthSafely(event);
    res.setHeader("Cache-Control", "no-store");
    res.status(202).json({ accepted: true });
  } catch (error) {
    if (error instanceof TypeError) {
      return res.status(400).json({ error: error.message, requestId: req.requestId });
    }
    console.error(JSON.stringify({
      level: "error",
      event: "growth_event_rejected",
      requestId: req.requestId,
    }));
    res.status(503).json({ error: "Analytics event could not be accepted.", requestId: req.requestId });
  }
});

// Billing checkout and verification are workspace-authenticated inside the router.
app.use("/api/billing", billingRouter);

// Everything below this point is workspace-scoped and requires a valid session.
app.use("/api", requireAuth);

function validateSettingsText(value, { min = 2, max = 80 } = {}) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length >= min && normalized.length <= max
    ? normalized
    : null;
}

app.get("/api/settings", async (req, res, next) => {
  try {
    const settings = await repository.getWorkspaceSettings({
      userId: req.auth.userId,
      workspaceId: req.auth.workspaceId,
    });
    if (!settings) return res.status(404).json({ error: "Workspace not found." });
    res.json(settings);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/settings/profile", async (req, res, next) => {
  try {
    const name = validateSettingsText(req.body?.name);
    if (!name) {
      return res.status(400).json({ error: "Name must be between 2 and 80 characters." });
    }
    const user = await repository.updateUserProfile({
      userId: req.auth.userId,
      name,
    });
    if (!user) return res.status(404).json({ error: "User not found." });
    const sessionUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      workspaceId: user.workspace_id,
      workspaceName: user.workspace_name,
      role: user.role,
      sessionVersion: user.session_version,
    };
    setSessionCookie(res, issueSession(sessionUser));
    await recordAudit(req, {
      action: "settings.profile_updated",
      resourceType: "user",
      resourceId: req.auth.userId,
      metadata: { fields: ["name"] },
    });
    res.json({ user: publicUser(sessionUser) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/settings/workspace", async (req, res, next) => {
  try {
    if (!canManageAgents(req.auth.role)) {
      return res.status(403).json({ error: "Only workspace owners and admins can rename the workspace." });
    }
    const name = validateSettingsText(req.body?.name);
    if (!name) {
      return res.status(400).json({ error: "Workspace name must be between 2 and 80 characters." });
    }
    await repository.updateWorkspaceName({
      workspaceId: req.auth.workspaceId,
      name,
    });
    const user = await repository.findUserById(req.auth.userId);
    if (!user) return res.status(404).json({ error: "User not found." });
    const sessionUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      workspaceId: user.workspace_id,
      workspaceName: user.workspace_name,
      role: user.role,
      sessionVersion: user.session_version,
    };
    setSessionCookie(res, issueSession(sessionUser));
    await recordAudit(req, {
      action: "settings.workspace_renamed",
      resourceType: "workspace",
      resourceId: req.auth.workspaceId,
    });
    res.json({ user: publicUser(sessionUser) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/settings/workspace/delete", async (req, res, next) => {
  try {
    if (req.auth.role !== "owner") return res.status(403).json({ error: "Only the workspace owner can delete this workspace." });
    const confirmation = typeof req.body?.confirmation === "string" ? req.body.confirmation.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const settings = await repository.getWorkspaceSettings({ userId: req.auth.userId, workspaceId: req.auth.workspaceId });
    const user = await repository.findUserById(req.auth.userId);
    if (!settings || !user || confirmation !== settings.workspace.name || !(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ error: "Workspace name confirmation or password is incorrect." });
    }
    await repository.deleteWorkspace({ workspaceId: req.auth.workspaceId });
    clearSessionCookie(res);
    await revokeRefreshSession(req, res);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/settings/password", async (req, res, next) => {
  try {
    const currentPassword = req.body?.currentPassword;
    const newPassword = req.body?.newPassword;
    if (
      typeof currentPassword !== "string" ||
      typeof newPassword !== "string" ||
      currentPassword.length < 8 ||
      newPassword.length < 8
    ) {
      return res.status(400).json({ error: "Both passwords must be at least 8 characters." });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: "New password must be different from the current password." });
    }
    const user = await repository.findUserById(req.auth.userId);
    if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
      return res.status(401).json({ error: "Current password is incorrect." });
    }
    const updated = await repository.updateUserPassword({
      userId: req.auth.userId,
      passwordHash: await hashPassword(newPassword),
    });
    if (!updated) return res.status(404).json({ error: "User not found." });
    const sessionUser = {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      workspaceId: updated.workspace_id,
      workspaceName: updated.workspace_name,
      role: updated.role,
      sessionVersion: updated.session_version,
    };
    setSessionCookie(res, issueSession(sessionUser));
    await startRefreshSession(res, updated, req);
    await recordAudit(req, {
      action: "settings.password_changed",
      resourceType: "user",
      resourceId: req.auth.userId,
    });
    res.json({ user: publicUser(sessionUser) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/settings/mfa/setup", async (req, res, next) => {
  try {
    if (!canManageAgents(req.auth.role)) {
      return res.status(403).json({ error: "MFA is required for workspace owners and admins only." });
    }
    const user = await repository.findUserById(req.auth.userId);
    if (!user) return res.status(404).json({ error: "User not found." });
    const secret = createMfaSecret();
    await repository.updateUserMfa({
      userId: req.auth.userId,
      enabled: false,
      encryptedSecret: encryptSecret(secret),
    });
    await recordAudit(req, {
      action: "auth.mfa_setup_started",
      resourceType: "user",
      resourceId: req.auth.userId,
    });
    res.json({
      enabled: false,
      secret,
      otpAuthUri: createOtpAuthUri({ secret, email: user.email }),
      message: "Add this secret to an authenticator app, then confirm with the six-digit code.",
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/settings/mfa/confirm", async (req, res, next) => {
  try {
    if (!canManageAgents(req.auth.role)) return res.status(403).json({ error: "Only owners and admins can manage MFA." });
    const user = await repository.findUserById(req.auth.userId);
    if (!user?.encrypted_mfa_secret || !verifyMfaCode(decryptSecret(user.encrypted_mfa_secret), req.body?.code)) {
      return res.status(400).json({ error: "The MFA code is invalid or expired." });
    }
    await repository.updateUserMfa({
      userId: req.auth.userId,
      enabled: true,
      encryptedSecret: user.encrypted_mfa_secret,
    });
    await recordAudit(req, { action: "auth.mfa_enabled", resourceType: "user", resourceId: req.auth.userId });
    res.json({ enabled: true, message: "MFA is now required for future administrator logins." });
  } catch (error) {
    next(error);
  }
});

app.post("/api/settings/mfa/disable", async (req, res, next) => {
  try {
    if (!canManageAgents(req.auth.role)) return res.status(403).json({ error: "Only owners and admins can manage MFA." });
    const user = await repository.findUserById(req.auth.userId);
    if (!user || !(await verifyPassword(req.body?.currentPassword ?? "", user.password_hash)) || !verifyMfaCode(decryptSecret(user.encrypted_mfa_secret), req.body?.code)) {
      return res.status(401).json({ error: "Password or MFA code is incorrect." });
    }
    await repository.updateUserMfa({ userId: req.auth.userId, enabled: false, encryptedSecret: null });
    await recordAudit(req, { action: "auth.mfa_disabled", resourceType: "user", resourceId: req.auth.userId });
    res.json({ enabled: false, message: "MFA has been disabled." });
  } catch (error) {
    next(error);
  }
});

app.get("/api/overview", async (req, res, next) => {
  try {
    const result = await repository.overview(req.auth.workspaceId);
    result.policy =
      (await repository.getPolicy(req.auth.workspaceId)) ?? policy;
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/billing", async (req, res, next) => {
  try {
    res.json(await repository.getBillingState(req.auth.workspaceId));
  } catch (error) {
    next(error);
  }
});

app.get("/api/billing/usage-metrics", async (req, res, next) => {
  try {
    if (!canManageAgents(req.auth.role)) {
      return res.status(403).json({ error: "Only workspace owners and admins can view operational cost metrics." });
    }
    res.json({ metrics: await repository.getUsageEconomics(req.auth.workspaceId) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/billing/service-orders", async (req, res, next) => {
  try {
    if (!canManageAgents(req.auth.role)) {
      return res.status(403).json({ error: "Only workspace owners and admins can view service engagements." });
    }
    res.json({ orders: await repository.listBillingServiceOrders(req.auth.workspaceId) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/billing/plan-change/cancel", async (req, res, next) => {
  try {
    if (!canManageAgents(req.auth.role)) return res.status(403).json({ error: "Only workspace owners and admins can manage billing." });
    const canceled = await repository.cancelScheduledPlanChange({ workspaceId: req.auth.workspaceId });
    if (!canceled) return res.status(404).json({ error: "No scheduled plan change was found." });
    await recordAudit(req, { action: "billing.plan_downgrade_canceled", resourceType: "subscription", resourceId: req.auth.workspaceId });
    res.json({ billing: await repository.getBillingState(req.auth.workspaceId) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/billing/addons", async (req, res, next) => {
  try {
    res.json({ addons: await repository.listBillingAddons() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/billing/plans", async (req, res, next) => {
  try {
    res.json({ plans: await repository.listBillingPlans() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/agents", async (req, res, next) => {
  try {
    res.json({ agents: await repository.listAgents(req.auth.workspaceId) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/agents/:agentId", async (req, res, next) => {
  try {
    const agent = await repository.getAgent(
      req.params.agentId,
      req.auth.workspaceId,
    );
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    res.json({ agent, tools: toolDetails(agent.tools) });
  } catch (error) {
    next(error);
  }
});

function canManageAgents(role) {
  return ["owner", "admin"].includes(role);
}

app.get("/api/attack-paths", async (req, res, next) => {
  try {
    const billing = await repository.getBillingState(req.auth.workspaceId);
    const entitledIds = new Set(scenarios.slice(0, billing.entitlements.scenarioLimit).map((scenario) => scenario.id));
    res.json({
      paths: attackPaths.map((path) => ({
        ...path,
        locked: path.scenarioIds.some((scenarioId) => !entitledIds.has(scenarioId)),
        requiredPlan: path.scenarioIds.some((scenarioId) => !entitledIds.has(scenarioId)) ? "Builder" : "Explorer",
      })),
      entitlements: {
        scenarioLimit: billing.entitlements.scenarioLimit,
        fullScenarioSuite: billing.entitlements.fullScenarioSuite,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/agents/:agentId/security-contract", async (req, res, next) => {
  try {
    const agent = await repository.getAgent(req.params.agentId, req.auth.workspaceId);
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    const contract = await repository.getSecurityContract({
      workspaceId: req.auth.workspaceId,
      agentId: agent.id,
    });
    res.json({
      contract,
      tools: toolDetails(agent.tools),
      policy: (await repository.getPolicy(req.auth.workspaceId)) ?? policy,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/agents/:agentId/security-contract/comparison", async (req, res, next) => {
  try {
    const comparison = await repository.getSecurityContractComparison({
      workspaceId: req.auth.workspaceId,
      agentId: req.params.agentId,
    });
    if (!comparison) return res.status(404).json({ error: "Agent not found." });
    res.json({ comparison });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/agents/:agentId/security-contract", async (req, res, next) => {
  try {
    if (!canManageAgents(req.auth.role)) {
      return res.status(403).json({ error: "Only workspace owners and admins can update security contracts." });
    }
    const contract = await repository.updateSecurityContract({
      workspaceId: req.auth.workspaceId,
      agentId: req.params.agentId,
      userId: req.auth.userId,
      contract: req.body ?? {},
    });
    if (!contract) return res.status(404).json({ error: "Agent not found." });
    await recordAudit(req, {
      action: "security_contract.updated",
      resourceType: "agent",
      resourceId: req.params.agentId,
      metadata: { version: contract.version, allowedToolCount: contract.allowedToolIds.length },
    });
    let verificationScan = null;
    let verificationError = null;
    try {
      verificationScan = await repository.enqueueScan({
        workspaceId: req.auth.workspaceId,
        agentId: req.params.agentId,
        trigger: `Contract verification · v${contract.version}`,
        contractVersion: contract.version,
      });
    } catch (verificationFailure) {
      verificationError = {
        code: verificationFailure?.code ?? "CONTRACT_VERIFICATION_UNAVAILABLE",
        message: verificationFailure instanceof Error ? verificationFailure.message : String(verificationFailure),
      };
    }
    res.json({ contract, verificationScan, verificationError });
  } catch (error) {
    if (error?.code === "INVALID_SECURITY_CONTRACT") return res.status(400).json({ error: error.message, code: error.code });
    next(error);
  }
});

app.post("/api/agents/:agentId/attack-paths/:pathId/replay", scanRateLimit, async (req, res, next) => {
  try {
    const path = attackPaths.find((item) => item.id === req.params.pathId);
    if (!path) return res.status(404).json({ error: "Attack path not found." });
    const agent = await repository.getAgent(req.params.agentId, req.auth.workspaceId);
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    if (agent.status === "quarantined") return res.status(409).json({ error: "Agent is quarantined. Restore it before replaying an attack path." });
    const scan = await repository.enqueueScan({
      workspaceId: req.auth.workspaceId,
      agentId: agent.id,
      trigger: `Attack path replay · ${path.title}`,
      scenarioIds: path.scenarioIds,
    });
    await recordAudit(req, {
      action: "attack_path.replayed",
      resourceType: "attack_path",
      resourceId: path.id,
      metadata: { agentId: agent.id, scanId: scan.id, scenarioCount: path.scenarioIds.length },
    });
    res.status(202).json({ scan, path });
  } catch (error) {
    if (["SCAN_QUOTA_EXCEEDED", "SUBSCRIPTION_REQUIRED", "SCENARIO_PLAN_REQUIRED"].includes(error?.code)) {
      return res.status(402).json({ error: error.message, code: error.code });
    }
    if (error?.code === "SCENARIO_NOT_FOUND") return res.status(404).json({ error: error.message, code: error.code });
    next(error);
  }
});

async function requireEntitlement(req, res, entitlement, message) {
  const billing = await repository.getBillingState(req.auth.workspaceId);
  if (!billing.entitlements.active || !billing.entitlements[entitlement]) {
    res.status(402).json({
      error: message,
      code: "PLAN_UPGRADE_REQUIRED",
      entitlement,
      currentPlan: billing.plan.id,
    });
    return null;
  }
  return billing;
}

app.get("/api/audit", async (req, res, next) => {
  try {
    if (!canManageAgents(req.auth.role)) {
      return res.status(403).json({ error: "Only workspace owners and admins can view audit events." });
    }
    res.json({ events: await repository.listAuditEvents({
      workspaceId: req.auth.workspaceId,
      limit: req.query.limit,
    }) });
  } catch (error) {
    next(error);
  }
});

function normalizeIncidentEventTypes(value) {
  if (!Array.isArray(value) || !value.length) return ["*"];
  const valid = new Set(["*", ...incidentEventTypes]);
  const normalized = [...new Set(value.filter((item) => typeof item === "string" && valid.has(item)))];
  return normalized.length ? normalized.slice(0, incidentEventTypes.length + 1) : null;
}

app.get("/api/incidents", async (req, res, next) => {
  try {
    if (!(await requireEntitlement(req, res, "incidentCenter", "Incident Center requires Builder or a higher plan."))) return;
    res.json({ incidents: await repository.listIncidents({
      workspaceId: req.auth.workspaceId,
      status: req.query.status,
      limit: req.query.limit,
    }) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/incidents/summary", async (req, res, next) => {
  try {
    if (!(await requireEntitlement(req, res, "incidentCenter", "Incident Center requires Builder or a higher plan."))) return;
    res.json(await repository.getIncidentSummary(req.auth.workspaceId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/incidents/:incidentId/read", async (req, res, next) => {
  try {
    if (!(await requireEntitlement(req, res, "incidentCenter", "Incident Center requires Builder or a higher plan."))) return;
    const updated = await repository.markIncidentRead({
      workspaceId: req.auth.workspaceId,
      incidentId: req.params.incidentId,
    });
    if (!updated) return res.status(404).json({ error: "Incident not found." });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/incidents/:incidentId/resolve", async (req, res, next) => {
  try {
    if (!(await requireEntitlement(req, res, "incidentCenter", "Incident Center requires Builder or a higher plan."))) return;
    if (!canManageAgents(req.auth.role)) {
      return res.status(403).json({ error: "Only workspace owners and admins can resolve incidents." });
    }
    const updated = await repository.resolveIncident({
      workspaceId: req.auth.workspaceId,
      incidentId: req.params.incidentId,
    });
    if (!updated) return res.status(404).json({ error: "Open incident not found." });
    await recordAudit(req, {
      action: "incident.resolved",
      resourceType: "incident",
      resourceId: req.params.incidentId,
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/alert-webhooks", async (req, res, next) => {
  try {
    if (!(await requireEntitlement(req, res, "alertWebhooks", "Signed alert webhooks require Pro or Agency."))) return;
    res.json({ webhooks: await repository.listAlertWebhooks(req.auth.workspaceId) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/alert-webhooks", webhookRateLimit, async (req, res, next) => {
  try {
    const billing = await requireEntitlement(req, res, "alertWebhooks", "Signed alert webhooks require Pro or Agency.");
    if (!billing) return;
    if (!canManageAgents(req.auth.role)) {
      return res.status(403).json({ error: "Only workspace owners and admins can add alert webhooks." });
    }
    const name = validateSettingsText(req.body?.name, { min: 2, max: 80 });
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    const secret = typeof req.body?.secret === "string" ? req.body.secret.trim() : "";
    const eventTypes = normalizeIncidentEventTypes(req.body?.eventTypes);
    if (!name || !url || secret.length < 16 || !eventTypes) {
      return res.status(400).json({ error: "Webhook name, public HTTPS URL, a 16+ character signing secret, and valid event types are required." });
    }
    try {
      assertHttpsIncidentWebhookUrl(url);
      await assertSafeAgentEndpoint(url);
    } catch (error) {
      if (error.code === "UNSAFE_AGENT_ENDPOINT") return res.status(400).json({ error: error.message });
      throw error;
    }
    const existingWebhooks = await repository.listAlertWebhooks(req.auth.workspaceId);
    if (existingWebhooks.length >= billing.entitlements.maxWebhooks) {
      return res.status(402).json({
        error: `Your ${billing.plan.name} plan allows up to ${billing.entitlements.maxWebhooks} signed alert routes.`,
        code: "WEBHOOK_LIMIT_REACHED",
        entitlement: "maxWebhooks",
        currentPlan: billing.plan.id,
      });
    }
    const webhook = await repository.createAlertWebhook({
      workspaceId: req.auth.workspaceId,
      name,
      url,
      secret,
      eventTypes,
    });
    await recordAudit(req, {
      action: "alert_webhook.created",
      resourceType: "alert_webhook",
      resourceId: webhook.id,
      metadata: { eventTypes },
    });
    res.status(201).json({ webhook });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/alert-webhooks/:webhookId", async (req, res, next) => {
  try {
    if (!(await requireEntitlement(req, res, "alertWebhooks", "Signed alert webhooks require Pro or Agency."))) return;
    if (!canManageAgents(req.auth.role)) {
      return res.status(403).json({ error: "Only workspace owners and admins can update alert webhooks." });
    }
    const name = validateSettingsText(req.body?.name, { min: 2, max: 80 });
    const eventTypes = normalizeIncidentEventTypes(req.body?.eventTypes);
    if (!name || typeof req.body?.enabled !== "boolean" || !eventTypes) {
      return res.status(400).json({ error: "Webhook name, enabled state, and valid event types are required." });
    }
    const webhook = await repository.updateAlertWebhook({
      workspaceId: req.auth.workspaceId,
      webhookId: req.params.webhookId,
      name,
      enabled: req.body.enabled,
      eventTypes,
    });
    if (!webhook) return res.status(404).json({ error: "Webhook not found." });
    await recordAudit(req, {
      action: "alert_webhook.updated",
      resourceType: "alert_webhook",
      resourceId: webhook.id,
      metadata: { enabled: req.body.enabled, eventTypes },
    });
    res.json({ webhook });
  } catch (error) {
    next(error);
  }
});

app.post("/api/alert-webhooks/:webhookId/test", webhookRateLimit, async (req, res, next) => {
  try {
    if (!(await requireEntitlement(req, res, "alertWebhooks", "Signed alert webhooks require Pro or Agency."))) return;
    if (!canManageAgents(req.auth.role)) {
      return res.status(403).json({ error: "Only workspace owners and admins can test alert webhooks." });
    }
    const webhook = await repository.getAlertWebhook({ workspaceId: req.auth.workspaceId, webhookId: req.params.webhookId });
    if (!webhook) return res.status(404).json({ error: "Webhook not found." });
    await deliverIncidentWebhook({
      url: webhook.url,
      secret: webhook.secret,
      webhookId: webhook.id,
      notification: {
        id: `test-${webhook.id}`,
        agentId: null,
        agentName: null,
        eventType: "runtime_block",
        severity: "info",
        title: "AgentGuard webhook test",
        message: "This is a signed test delivery from AgentGuard.",
        resourceType: "webhook",
        resourceId: webhook.id,
        metadata: { test: true },
        createdAt: new Date().toISOString(),
      },
    });
    await recordAudit(req, {
      action: "alert_webhook.tested",
      resourceType: "alert_webhook",
      resourceId: webhook.id,
    });
    res.json({ ok: true, message: "Signed test delivered successfully." });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Webhook delivery failed." });
  }
});

app.delete("/api/alert-webhooks/:webhookId", async (req, res, next) => {
  try {
    if (!(await requireEntitlement(req, res, "alertWebhooks", "Signed alert webhooks require Pro or Agency."))) return;
    if (!canManageAgents(req.auth.role)) {
      return res.status(403).json({ error: "Only workspace owners and admins can delete alert webhooks." });
    }
    const deleted = await repository.deleteAlertWebhook({ workspaceId: req.auth.workspaceId, webhookId: req.params.webhookId });
    if (!deleted) return res.status(404).json({ error: "Webhook not found." });
    await recordAudit(req, {
      action: "alert_webhook.deleted",
      resourceType: "alert_webhook",
      resourceId: req.params.webhookId,
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/sentinel", async (req, res, next) => {
  try {
    if (!(await requireEntitlement(req, res, "sentinel", "Sentinel drift monitoring requires Pro or a higher plan."))) return;
    res.json(await repository.getSentinelOverview(req.auth.workspaceId));
  } catch (error) {
    next(error);
  }
});

app.get("/api/agents/:agentId/sentinel", async (req, res, next) => {
  try {
    if (!(await requireEntitlement(req, res, "sentinel", "Sentinel drift monitoring requires Pro or a higher plan."))) return;
    const state = await repository.getSentinelAgentState({
      workspaceId: req.auth.workspaceId,
      agentId: req.params.agentId,
    });
    if (!state) return res.status(404).json({ error: "Agent not found." });
    res.json({ sentinel: state });
  } catch (error) {
    next(error);
  }
});

app.post("/api/sentinel/check", async (req, res, next) => {
  try {
    if (!(await requireEntitlement(req, res, "sentinel", "Sentinel drift monitoring requires Pro or a higher plan."))) return;
    if (!canManageAgents(req.auth.role)) {
      return res.status(403).json({ error: "Only workspace owners and admins can run Sentinel checks." });
    }
    const agents = await repository.listAgents(req.auth.workspaceId);
    await Promise.all(
      agents.map((agent) => repository.checkSentinel({
        workspaceId: req.auth.workspaceId,
        agentId: agent.id,
      })),
    );
    await recordAudit(req, {
      action: "sentinel.workspace_check",
      resourceType: "workspace",
      resourceId: req.auth.workspaceId,
      metadata: { agentCount: agents.length },
    });
    res.json(await repository.getSentinelOverview(req.auth.workspaceId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/agents/:agentId/sentinel/baseline", async (req, res, next) => {
  try {
    if (!(await requireEntitlement(req, res, "sentinel", "Sentinel drift monitoring requires Pro or a higher plan."))) return;
    if (!canManageAgents(req.auth.role)) {
      return res.status(403).json({ error: "Only workspace owners and admins can create a Sentinel baseline." });
    }
    const state = await repository.createSentinelBaseline({
      workspaceId: req.auth.workspaceId,
      agentId: req.params.agentId,
      userId: req.auth.userId,
      source: "manual",
    });
    if (!state) return res.status(404).json({ error: "Agent not found." });
    await recordAudit(req, {
      action: "sentinel.baseline_created",
      resourceType: "agent",
      resourceId: req.params.agentId,
      metadata: { source: "manual" },
    });
    res.status(201).json({ sentinel: state });
  } catch (error) {
    next(error);
  }
});

app.post("/api/agents/:agentId/sentinel/check", async (req, res, next) => {
  try {
    if (!(await requireEntitlement(req, res, "sentinel", "Sentinel drift monitoring requires Pro or a higher plan."))) return;
    if (!canManageAgents(req.auth.role)) {
      return res.status(403).json({ error: "Only workspace owners and admins can run Sentinel checks." });
    }
    const state = await repository.checkSentinel({
      workspaceId: req.auth.workspaceId,
      agentId: req.params.agentId,
    });
    if (!state) return res.status(404).json({ error: "Agent not found." });
    await recordAudit(req, {
      action: "sentinel.agent_check",
      resourceType: "agent",
      resourceId: req.params.agentId,
    });
    res.json({ sentinel: state });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/agents/:agentId/sentinel/settings", async (req, res, next) => {
  try {
    if (!(await requireEntitlement(req, res, "sentinel", "Sentinel drift monitoring requires Pro or a higher plan."))) return;
    if (!canManageAgents(req.auth.role)) {
      return res.status(403).json({ error: "Only workspace owners and admins can change Sentinel settings." });
    }
    if (typeof req.body?.enabled !== "boolean" || typeof req.body?.autoQuarantine !== "boolean") {
      return res.status(400).json({ error: "Sentinel settings must include boolean enabled and autoQuarantine values." });
    }
    const state = await repository.updateSentinelSettings({
      workspaceId: req.auth.workspaceId,
      agentId: req.params.agentId,
      enabled: req.body.enabled,
      autoQuarantine: req.body.autoQuarantine,
    });
    if (!state) return res.status(404).json({ error: "Agent not found." });
    await recordAudit(req, {
      action: "sentinel.settings_updated",
      resourceType: "agent",
      resourceId: req.params.agentId,
      metadata: { enabled: req.body.enabled, autoQuarantine: req.body.autoQuarantine },
    });
    res.json({ sentinel: state });
  } catch (error) {
    next(error);
  }
});

function allowedToolIds(toolIds) {
  return toolIds.filter((toolId) => tools.some((tool) => tool.id === toolId));
}

function validateAgentText(value, label) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 160
    ? value.trim()
    : null;
}

app.post("/api/agents/:agentId/runtime/enable", async (req, res, next) => {
  try {
    if (!(await requireEntitlement(req, res, "runtimeFirewall", "Runtime Firewall requires Builder or a higher plan."))) return;
    if (!canManageAgents(req.auth.role)) return res.status(403).json({ error: "Only workspace owners and admins can enable Runtime Firewall." });
    const agent = await repository.getAgent(req.params.agentId, req.auth.workspaceId);
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    if (!agent.endpoint) return res.status(400).json({ error: "Connect a customer endpoint before enabling Runtime Firewall." });
    if (agent.status === "quarantined") return res.status(409).json({ error: "Restore the agent before enabling Runtime Firewall." });
    const token = createRuntimeToken();
    await repository.enableRuntimeFirewall({
      workspaceId: req.auth.workspaceId,
      agentId: agent.id,
      tokenHash: hashRuntimeToken(token),
    });
    await recordAudit(req, {
      action: "runtime_firewall.enabled",
      resourceType: "agent",
      resourceId: agent.id,
    });
    res.json({
      agent: { ...agent, runtimeEnabled: true, runtimeBlockedCount: 0, runtimeLastEventAt: null },
      token,
      gateway: { method: "POST", path: `/api/runtime/agents/${agent.id}/invoke` },
    });
  } catch (error) { next(error); }
});

app.post("/api/agents/:agentId/runtime/disable", async (req, res, next) => {
  try {
    if (!canManageAgents(req.auth.role)) return res.status(403).json({ error: "Only workspace owners and admins can disable Runtime Firewall." });
    const agent = await repository.getAgent(req.params.agentId, req.auth.workspaceId);
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    await repository.disableRuntimeFirewall({ workspaceId: req.auth.workspaceId, agentId: agent.id });
    await recordAudit(req, {
      action: "runtime_firewall.disabled",
      resourceType: "agent",
      resourceId: agent.id,
    });
    res.json({ agent: { ...agent, runtimeEnabled: false } });
  } catch (error) { next(error); }
});

app.get("/api/agents/:agentId/runtime/events", async (req, res, next) => {
  try {
    const agent = await repository.getAgent(req.params.agentId, req.auth.workspaceId);
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    res.json({ events: await repository.listRuntimeEvents({ workspaceId: req.auth.workspaceId, agentId: agent.id }) });
  } catch (error) { next(error); }
});

app.get("/api/agents/:agentId/runtime/health", async (req, res, next) => {
  try {
    const agent = await repository.getAgent(req.params.agentId, req.auth.workspaceId);
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    if (!(await requireEntitlement(req, res, "runtimeFirewall", "Runtime health metrics require Builder or a higher plan."))) return;
    const requestedWindow = req.query.window ?? "24h";
    if (requestedWindow !== "24h" && requestedWindow !== "7d") {
      return res.status(400).json({ error: "window must be 24h or 7d." });
    }
    const windowHours = requestedWindow === "7d" ? 168 : 24;
    const metrics = await repository.getRuntimeHealth({
      workspaceId: req.auth.workspaceId,
      agentId: agent.id,
      windowHours,
    });
    res.set("Cache-Control", "no-store");
    res.json({
      health: {
        ...summarizeRuntimeHealth({ metrics, runtimeEnabled: agent.runtimeEnabled }),
        window: requestedWindow,
        observedAt: new Date().toISOString(),
      },
    });
  } catch (error) { next(error); }
});

async function runRuntimeApprovalRaceProbe({ workspaceId, agentId, verificationId }) {
  const approvalId = createApprovalId();
  const probeToken = createRuntimeToken();
  const requestId = `${verificationId}-replay-probe`;
  const expiresAt = new Date(Date.now() + 60_000);
  const call = {
    name: "issue_refund",
    arguments: { order_id: "AG-VERIFY-ORDER", amount: 1 },
  };
  const payload = buildApprovalPayload({
    approvalId,
    agentId,
    workspaceId,
    requestId,
    call,
    context: {
      actorId: "synthetic-verification-actor",
      tenantId: "synthetic-verification-tenant",
      orderId: "AG-VERIFY-ORDER",
      issuedAt: new Date().toISOString(),
    },
    expiresAt: expiresAt.toISOString(),
    policyVersion: "verification-probe",
  });
  await repository.createRuntimeApproval({
    id: approvalId,
    workspaceId,
    agentId,
    requestId,
    toolName: call.name,
    payload,
    signature: signApproval(payload, probeToken),
    expiresAt,
  });

  try {
    const attempts = await Promise.all(Array.from({ length: 8 }, () =>
      repository.consumeRuntimeApproval({ workspaceId, agentId, approvalId }),
    ));
    return { attempts: attempts.length, accepted: attempts.filter(Boolean).length };
  } finally {
    await query(
      `DELETE FROM runtime_approvals
       WHERE id=$1 AND workspace_id=$2 AND agent_id=$3 AND request_id=$4`,
      [approvalId, workspaceId, agentId, requestId],
    );
  }
}

app.get("/api/agents/:agentId/runtime/verification", async (req, res, next) => {
  try {
    if (!(await requireEntitlement(req, res, "runtimeFirewall", "Enforcement verification requires Builder or a higher plan."))) return;
    const agent = await repository.getAgent(req.params.agentId, req.auth.workspaceId);
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    const [policyState, contract, latest] = await Promise.all([
      repository.getPolicy(req.auth.workspaceId),
      repository.getSecurityContract({ workspaceId: req.auth.workspaceId, agentId: agent.id }),
      repository.getRuntimeVerification({ workspaceId: req.auth.workspaceId, agentId: agent.id }),
    ]);
    const currentFingerprint = enforcementVerificationFingerprint({
      agent: { ...agent, workspaceId: req.auth.workspaceId },
      policy: policyState ?? policy,
      contract,
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({
      verification: latest?.result ?? null,
      createdAt: latest?.createdAt ?? null,
      isCurrent: Boolean(latest && latest.fingerprint === currentFingerprint),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/agents/:agentId/runtime/verification", scanRateLimit, async (req, res, next) => {
  try {
    if (!(await requireEntitlement(req, res, "runtimeFirewall", "Enforcement verification requires Builder or a higher plan."))) return;
    if (!canManageAgents(req.auth.role)) {
      return res.status(403).json({ error: "Only workspace owners and admins can run enforcement verification." });
    }
    const agent = await repository.getAgent(req.params.agentId, req.auth.workspaceId);
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    if (agent.status === "quarantined") {
      return res.status(409).json({ error: "Restore the agent before running enforcement verification." });
    }
    if (!agent.runtimeEnabled) {
      return res.status(409).json({ error: "Enable Runtime Firewall before running enforcement verification.", code: "RUNTIME_FIREWALL_DISABLED" });
    }

    const [workspacePolicy, contract] = await Promise.all([
      repository.getPolicy(req.auth.workspaceId),
      repository.getSecurityContract({ workspaceId: req.auth.workspaceId, agentId: agent.id }),
    ]);
    const input = {
      agent: { ...agent, workspaceId: req.auth.workspaceId },
      policy: workspacePolicy ?? policy,
      contract,
    };
    const verificationId = `verify-${randomUUID()}`;
    const verification = await runEnforcementVerification({
      ...input,
      consumeReplayProbe: () => runRuntimeApprovalRaceProbe({
        workspaceId: req.auth.workspaceId,
        agentId: agent.id,
        verificationId,
      }),
    });
    const saved = await repository.saveRuntimeVerification({
      id: verificationId,
      workspaceId: req.auth.workspaceId,
      agentId: agent.id,
      status: verification.status,
      fingerprint: verification.fingerprint,
      result: verification,
    });
    await recordAudit(req, {
      action: "runtime.enforcement_verification",
      resourceType: "runtime_verification",
      resourceId: verificationId,
      metadata: { status: verification.status, passed: verification.summary.passed, failed: verification.summary.failed },
    });
    res.setHeader("Cache-Control", "no-store");
    const [currentPolicy, currentContract, currentAgent] = await Promise.all([
      repository.getPolicy(req.auth.workspaceId),
      repository.getSecurityContract({ workspaceId: req.auth.workspaceId, agentId: agent.id }),
      repository.getAgent(agent.id, req.auth.workspaceId),
    ]);
    const currentFingerprint = currentAgent ? enforcementVerificationFingerprint({
      agent: { ...currentAgent, workspaceId: req.auth.workspaceId },
      policy: currentPolicy ?? policy,
      contract: currentContract,
    }) : null;
    res.json({ verification: saved.result, createdAt: saved.createdAt, isCurrent: Boolean(currentFingerprint && saved.fingerprint === currentFingerprint) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/agents/:agentId/runtime/verification/report", async (req, res, next) => {
  try {
    if (!(await requireEntitlement(req, res, "runtimeFirewall", "Enforcement verification reports require Builder or a higher plan."))) return;
    const agent = await repository.getAgent(req.params.agentId, req.auth.workspaceId);
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    const latest = await repository.getRuntimeVerification({ workspaceId: req.auth.workspaceId, agentId: agent.id });
    if (!latest) return res.status(404).json({ error: "Run enforcement verification before exporting its report." });
    const [workspacePolicy, contract] = await Promise.all([
      repository.getPolicy(req.auth.workspaceId),
      repository.getSecurityContract({ workspaceId: req.auth.workspaceId, agentId: agent.id }),
    ]);
    const currentFingerprint = enforcementVerificationFingerprint({
      agent: { ...agent, workspaceId: req.auth.workspaceId },
      policy: workspacePolicy ?? policy,
      contract,
    });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader("Content-Disposition", `inline; filename="agentguard-verification-${agent.id}.html"`);
    res.send(renderEnforcementVerificationReport({
      verification: latest.result,
      isCurrent: latest.fingerprint === currentFingerprint,
    }));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/agents/:agentId", async (req, res, next) => {
  try {
    if (!canManageAgents(req.auth.role)) return res.status(403).json({ error: "Only workspace owners and admins can edit agents." });
    const current = await repository.getAgent(req.params.agentId, req.auth.workspaceId);
    if (!current) return res.status(404).json({ error: "Agent not found." });
    const body = req.body ?? {};
    const name = validateAgentText(body.name ?? current.name, "Agent name");
    const provider = validateAgentText(body.provider ?? current.provider, "Provider");
    const model = validateAgentText(body.model ?? current.model, "Model");
    const environment = validateAgentText(body.environment ?? current.environment, "Environment");
    if (!name || !provider || !model || !environment) return res.status(400).json({ error: "Agent name, provider, model, and environment are required and must be 160 characters or fewer." });
    if (body.endpoint !== undefined && body.endpoint !== null && typeof body.endpoint !== "string") return res.status(400).json({ error: "Agent endpoint must be a URL string." });
    const endpoint = body.endpoint === null ? "" : typeof body.endpoint === "string" ? body.endpoint.trim() : (current.endpoint ?? "");
    if (endpoint) {
      try { await assertSafeAgentEndpoint(endpoint); } catch (error) {
        if (error.code === "UNSAFE_AGENT_ENDPOINT") return res.status(400).json({ error: error.message });
        throw error;
      }
    }
    if (body.apiKey !== undefined && typeof body.apiKey !== "string") return res.status(400).json({ error: "API key must be a string." });
    if (body.clearApiKey && body.apiKey) return res.status(400).json({ error: "Choose either a replacement API key or clear the existing key." });
    const apiKeyMode = body.clearApiKey ? "clear" : body.apiKey ? "replace" : "keep";
    const toolIds = body.toolIds === undefined ? current.tools : Array.isArray(body.toolIds) ? allowedToolIds(body.toolIds) : null;
    if (!toolIds) return res.status(400).json({ error: "Tool IDs must be an array." });
    const agent = await repository.updateAgent({
      workspaceId: req.auth.workspaceId,
      agentId: current.id,
      agent: { name, provider, model, environment, endpoint: endpoint || null, encryptedApiKey: apiKeyMode === "replace" ? encryptSecret(body.apiKey) : null, status: current.status === "quarantined" ? "quarantined" : "pending" },
      toolIds,
      apiKeyMode,
    });
    await recordAudit(req, {
      action: "agent.updated",
      resourceType: "agent",
      resourceId: current.id,
      metadata: { apiKeyMode, toolCount: toolIds.length },
    });
    res.json({ agent });
  } catch (error) { next(error); }
});

app.post("/api/agents/:agentId/test-connection", async (req, res, next) => {
  try {
    const agent = await repository.getAgent(req.params.agentId, req.auth.workspaceId);
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    const connection = await testAgentConnection({ ...agent, encryptedApiKey: agent.apiKeyConfigured ? (await repository.getAgentSecret(req.params.agentId, req.auth.workspaceId)) : null });
    const status = agent.status === "quarantined"
      ? "quarantined"
      : connection.ok
        ? "connected"
        : connection.status === "not_configured"
          ? "pending"
          : "unreachable";
    if (agent.status !== "quarantined") {
      await repository.setAgentStatus({ workspaceId: req.auth.workspaceId, agentId: agent.id, status });
    }
    if (connection.ok) {
      await recordGrowthSafely({
        eventName: "business.first_agent_connected",
        workspaceId: req.auth.workspaceId,
        visitorHash: growthSessionHash(req),
        properties: { verification: "connection_test_passed" },
      });
    }
    res.json({ connection, agent: { ...agent, status } });
  } catch (error) { next(error); }
});

app.post("/api/agents/:agentId/quarantine", async (req, res, next) => {
  try {
    if (!canManageAgents(req.auth.role)) return res.status(403).json({ error: "Only workspace owners and admins can quarantine agents." });
    const reason = typeof req.body?.reason === "string" && req.body.reason.trim()
      ? req.body.reason.trim().slice(0, 240)
      : "Manual security response";
    const agent = await repository.getAgent(req.params.agentId, req.auth.workspaceId);
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    await repository.quarantineAgent({ workspaceId: req.auth.workspaceId, agentId: agent.id, reason });
    await repository.createIncidentNotification({
      workspaceId: req.auth.workspaceId,
      agentId: agent.id,
      agentName: agent.name,
      eventType: "agent_quarantined",
      severity: "high",
      message: `${agent.name} was quarantined by an operator. Reason: ${reason}`,
      dedupeKey: `quarantine:${agent.id}`,
      resourceType: "agent",
      resourceId: agent.id,
      metadata: { reason, source: "manual" },
    });
    await recordAudit(req, {
      action: "agent.quarantined",
      resourceType: "agent",
      resourceId: agent.id,
      metadata: { reason, source: "manual" },
    });
    res.json({ agent: { ...agent, status: "quarantined", isQuarantined: true, quarantineReason: reason, quarantinedAt: new Date().toISOString() } });
  } catch (error) { next(error); }
});

app.post("/api/agents/:agentId/restore", async (req, res, next) => {
  try {
    if (!canManageAgents(req.auth.role)) return res.status(403).json({ error: "Only workspace owners and admins can restore agents." });
    const agent = await repository.getAgent(req.params.agentId, req.auth.workspaceId);
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    if (agent.status !== "quarantined") return res.status(409).json({ error: "Agent is not quarantined." });
    await repository.restoreAgent({ workspaceId: req.auth.workspaceId, agentId: agent.id });
    await repository.resolveIncidentsForAgent({
      workspaceId: req.auth.workspaceId,
      agentId: agent.id,
      eventType: "agent_quarantined",
    });
    await recordAudit(req, {
      action: "agent.restored",
      resourceType: "agent",
      resourceId: agent.id,
    });
    res.json({ agent: { ...agent, status: "pending", isQuarantined: false, quarantineReason: null, quarantinedAt: null } });
  } catch (error) { next(error); }
});

app.delete("/api/agents/:agentId", async (req, res, next) => {
  try {
    if (!canManageAgents(req.auth.role)) return res.status(403).json({ error: "Only workspace owners and admins can delete agents." });
    const deleted = await repository.deleteAgent(req.params.agentId, req.auth.workspaceId);
    if (!deleted) return res.status(404).json({ error: "Agent not found." });
    await recordAudit(req, {
      action: "agent.deleted",
      resourceType: "agent",
      resourceId: req.params.agentId,
    });
    res.status(204).end();
  } catch (error) { next(error); }
});

app.post("/api/autopilot/assessments", async (req, res, next) => {
  try {
    if (!(await requireEntitlement(req, res, "autopilot", "Autopilot protection blueprints require Pro or a higher plan."))) return;
    const { agentId } = req.body ?? {};
    const agent = await repository.getAgent(agentId, req.auth.workspaceId);
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    if (agent.status === "quarantined") {
      return res.status(409).json({ error: "Restore the agent before starting an assessment." });
    }
    if (config.isProduction && !agent.endpoint) {
      return res.status(400).json({ error: "A customer endpoint is required for Autopilot in production." });
    }

    const connection = await testAgentConnection({
      ...agent,
      encryptedApiKey: agent.apiKeyConfigured
        ? await repository.getAgentSecret(agent.id, req.auth.workspaceId)
        : null,
    });
    if (!connection.ok && connection.status !== "not_configured") {
      return res.status(422).json({
        error: `Agent connection failed: ${connection.message}`,
        connection,
      });
    }

    const result = await repository.createAutopilotAssessment({
      workspaceId: req.auth.workspaceId,
      agentId: agent.id,
      connection,
    });
    res.status(result.reused ? 200 : 202).json({
      assessment: result.assessment,
      reused: result.reused,
    });
  } catch (error) {
    if (["SCAN_QUOTA_EXCEEDED", "SUBSCRIPTION_REQUIRED"].includes(error?.code)) {
      return res.status(402).json({ error: error.message, code: error.code });
    }
    next(error);
  }
});

app.get("/api/autopilot/assessments/:assessmentId", async (req, res, next) => {
  try {
    if (!(await requireEntitlement(req, res, "autopilot", "Autopilot protection blueprints require Pro or a higher plan."))) return;
    const assessment = await repository.getAutopilotAssessment(
      req.params.assessmentId,
      req.auth.workspaceId,
    );
    if (!assessment) return res.status(404).json({ error: "Assessment not found." });
    res.json({ assessment });
  } catch (error) {
    next(error);
  }
});

app.post("/api/autopilot/assessments/:assessmentId/apply", async (req, res, next) => {
  try {
    if (!(await requireEntitlement(req, res, "autopilot", "Autopilot protection blueprints require Pro or a higher plan."))) return;
    if (!canManageAgents(req.auth.role)) {
      return res.status(403).json({ error: "Only workspace owners and admins can apply protection." });
    }
    const assessment = await repository.getAutopilotAssessment(
      req.params.assessmentId,
      req.auth.workspaceId,
    );
    if (!assessment) return res.status(404).json({ error: "Assessment not found." });
    if (assessment.status === "failed") {
      return res.status(409).json({ error: "The assessment failed. Run it again before applying protection." });
    }
    const billing = await repository.getBillingState(req.auth.workspaceId);
    if (!billing.entitlements.runtimeFirewall) {
      return res.status(402).json({
        error: "Runtime Firewall protection requires a plan that includes runtime enforcement.",
        code: "RUNTIME_PLAN_REQUIRED",
      });
    }

    const currentAgent = await repository.getAgent(assessment.agentId, req.auth.workspaceId);
    if (!currentAgent) return res.status(404).json({ error: "Agent not found." });
    const shouldIssueToken = !currentAgent.runtimeEnabled;
    const token = shouldIssueToken ? createRuntimeToken() : null;
    const result = await repository.applyAutopilotProtection({
      assessmentId: assessment.id,
      workspaceId: req.auth.workspaceId,
      userId: req.auth.userId,
      tokenHash: token ? hashRuntimeToken(token) : null,
    });
    const agent = await repository.getAgent(assessment.agentId, req.auth.workspaceId);
    await recordAudit(req, {
      action: "autopilot.protection_applied",
      resourceType: "agent",
      resourceId: assessment.agentId,
      metadata: { assessmentId: assessment.id, alreadyApplied: result.alreadyApplied },
    });
    res.json({
      assessment: await repository.getAutopilotAssessment(assessment.id, req.auth.workspaceId),
      agent,
      protection: {
        applied: true,
        alreadyApplied: result.alreadyApplied,
        token,
        gateway: token
          ? { method: "POST", path: `/api/runtime/agents/${assessment.agentId}/invoke` }
          : null,
      },
    });
  } catch (error) {
    if (error?.code === "ASSESSMENT_NOT_READY" || error?.code === "AGENT_QUARANTINED") {
      return res.status(409).json({ error: error.message, code: error.code });
    }
    next(error);
  }
});

app.post("/api/agents", async (req, res, next) => {
  try {
    const {
      name,
      endpoint,
      apiKey,
      environment = "Staging",
      provider = "Custom endpoint",
      model = "Unknown",
      toolIds = ["get_order", "issue_refund"],
    } = req.body ?? {};
    if (typeof name !== "string" || !name.trim())
      return res.status(400).json({ error: "Agent name is required." });
    if (
      endpoint !== undefined &&
      endpoint !== null &&
      typeof endpoint !== "string"
    ) {
      return res
        .status(400)
        .json({ error: "Agent endpoint must be a URL string." });
    }
    const endpointValue = typeof endpoint === "string" ? endpoint.trim() : "";
    if (endpointValue) {
      try {
        await assertSafeAgentEndpoint(endpointValue);
      } catch (error) {
        if (error.code === "UNSAFE_AGENT_ENDPOINT")
          return res.status(400).json({ error: error.message });
        throw error;
      }
    }
    const agent = await repository.createAgent({
      workspaceId: req.auth.workspaceId,
      agent: {
        id: `agent-${randomUUID()}`,
        name: name.trim(),
        description: "Connected storefront agent.",
        environment,
        provider,
        model,
        mode: "protected",
        status: "pending",
        endpoint: endpointValue || null,
        encryptedApiKey: encryptSecret(
          typeof apiKey === "string" ? apiKey : null,
        ),
      },
      toolIds: Array.isArray(toolIds)
        ? toolIds.filter((toolId) => tools.some((tool) => tool.id === toolId))
        : [],
    });
    await recordGrowthSafely({
      eventName: "business.first_agent_created",
      workspaceId: req.auth.workspaceId,
      visitorHash: growthSessionHash(req),
      properties: { source: "dashboard" },
    });
    await recordAudit(req, {
      action: "agent.created",
      resourceType: "agent",
      resourceId: agent.id,
      metadata: { toolCount: agent.tools.length, endpointConfigured: Boolean(endpointValue) },
    });
    res.status(201).json({ agent });
  } catch (error) {
    if (error?.code === "AGENT_LIMIT_REACHED" || error?.code === "SUBSCRIPTION_REQUIRED") {
      return res.status(402).json({ error: error.message, code: error.code });
    }
    next(error);
  }
});

app.post("/api/quickstart/demo", scanRateLimit, async (req, res, next) => {
  try {
    const result = await repository.createQuickstartDemo({
      workspaceId: req.auth.workspaceId,
    });
    const workspacePolicy = (await repository.getPolicy(req.auth.workspaceId)) ?? policy;
    const proof = buildSecurityProof({ policy: workspacePolicy });
    await recordAudit(req, {
      action: "quickstart.security_demo_started",
      resourceType: "agent",
      resourceId: result.agent.id,
      metadata: {
        scanId: result.scan.id,
        proofId: proof.id,
        simulated: true,
        sideEffectExecuted: proof.evidence.sideEffectExecuted,
      },
    });
    res.status(202).json({
      agent: result.agent,
      scan: result.scan,
      proof,
      demo: {
        isolated: true,
        execution: "simulation",
        message: "This proof uses synthetic data and the pre-execution Runtime Firewall. No customer endpoint or payment system was called.",
      },
    });
  } catch (error) {
    if (["SCAN_QUOTA_EXCEEDED", "SUBSCRIPTION_REQUIRED", "AGENT_LIMIT_REACHED"].includes(error?.code)) {
      return res.status(402).json({ error: error.message, code: error.code });
    }
    next(error);
  }
});

app.get("/api/tools", (req, res) => res.json({ tools }));

app.get("/api/scenarios", async (req, res, next) => {
  try {
    const { scenarios } = await import("./features/catalog/domain.mjs");
    const billing = await repository.getBillingState(req.auth.workspaceId);
    const visibleScenarios = scenarios.slice(0, billing.entitlements.scenarioLimit || 0);
    res.json({
      scenarios: visibleScenarios,
      entitlements: {
        scenarioLimit: billing.entitlements.scenarioLimit,
        fullScenarioSuite: billing.entitlements.fullScenarioSuite,
        lockedScenarioCount: Math.max(0, scenarios.length - visibleScenarios.length),
      },
      policy: (await repository.getPolicy(req.auth.workspaceId)) ?? policy,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/scans", async (req, res, next) => {
  try {
    res.json({ scans: await repository.listScans(req.auth.workspaceId) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/scans", scanRateLimit, async (req, res, next) => {
  try {
    const { agentId, trigger = "Manual", scenarioIds = null } = req.body ?? {};
    const agent = await repository.getAgent(
      agentId ?? "storefront-copilot",
      req.auth.workspaceId,
    );
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    if (agent.status === "quarantined") {
      return res.status(409).json({ error: "Agent is quarantined. Restore it before starting a new scan." });
    }
    if (agent.endpoint && /^production$/i.test(agent.environment)) {
      return res.status(409).json({
        error: "Production scans are blocked by default because a customer endpoint may execute tools internally. Use a mock/Staging endpoint or enable Runtime Firewall and test through the gateway.",
        code: "PRODUCTION_SCAN_BLOCKED",
      });
    }
    const scan = await repository.enqueueScan({
      workspaceId: req.auth.workspaceId,
      agentId: agent.id,
      trigger,
      scenarioIds,
    });
    await recordAudit(req, {
      action: "scan.created",
      resourceType: "scan",
      resourceId: scan.id,
      metadata: { agentId: agent.id, trigger },
    });
    res.status(202).json({ scan });
  } catch (error) {
    if (["SCAN_QUOTA_EXCEEDED", "SUBSCRIPTION_REQUIRED"].includes(error?.code)) {
      return res.status(402).json({ error: error.message, code: error.code });
    }
    next(error);
  }
});

app.get("/api/scans/:scanId", async (req, res, next) => {
  try {
    const scan = await repository.getScan(
      req.params.scanId,
      req.auth.workspaceId,
    );
    if (!scan) return res.status(404).json({ error: "Scan not found." });
    res.json({
      scan,
      policy: (await repository.getPolicy(req.auth.workspaceId)) ?? policy,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/scans/:scanId/report", async (req, res, next) => {
  try {
    const scan = await repository.getScan(req.params.scanId, req.auth.workspaceId);
    if (!scan) return res.status(404).json({ error: "Scan not found." });
    const agent = await repository.getAgent(scan.agentId, req.auth.workspaceId);
    const isQuickstartPreview = agent?.mode === "demo_simulator" && scan.trigger === "Quickstart demo";
    const billing = await repository.getBillingState(req.auth.workspaceId);
    const isFirstFreePreview = billing.plan.id === "free" &&
      scan.status === "completed" &&
      await repository.isFirstCompletedScan({ scanId: scan.id, workspaceId: req.auth.workspaceId });
    if (!isQuickstartPreview && !isFirstFreePreview && !(await requireEntitlement(req, res, "exportReports", "Shareable security reports require Builder or a higher plan."))) return;
    const workspacePolicy = (await repository.getPolicy(req.auth.workspaceId)) ?? policy;
    const reportPolicy = isQuickstartPreview
      ? { ...workspacePolicy, name: "Quickstart refund policy", maxAmount: 50, maxAgeDays: 14, currency: "USD" }
      : workspacePolicy;
    const report = renderScanReport({
      scan,
      policy: reportPolicy,
      preview: isQuickstartPreview || isFirstFreePreview,
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", `inline; filename="agentguard-${scan.id}.html"`);
    res.send(report);
  } catch (error) {
    next(error);
  }
});

app.get("/api/policies", async (req, res, next) => {
  try {
    res.json({
      policies: [(await repository.getPolicy(req.auth.workspaceId)) ?? policy],
    });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/policies/:policyId", async (req, res, next) => {
  try {
    if (!["owner", "admin"].includes(req.auth.role))
      return res
        .status(403)
        .json({ error: "Only workspace owners and admins can edit policies." });
    const current = await repository.getPolicy(req.auth.workspaceId);
    if (!current || current.id !== req.params.policyId)
      return res.status(404).json({ error: "Policy not found." });
    const { name, maxAmount, maxAgeDays, currency } = req.body ?? {};
    const amount = Number(maxAmount);
    const ageDays = Number(maxAgeDays);
    if (
      typeof name !== "string" ||
      !name.trim() ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !Number.isInteger(ageDays) ||
      ageDays <= 0 ||
      typeof currency !== "string" ||
      !/^[A-Z]{3}$/.test(currency)
    ) {
      return res
        .status(400)
        .json({
          error:
            "Policy name, positive amount, positive whole-day window, and 3-letter currency are required.",
        });
    }
    const updated = await repository.updatePolicy({
      policyId: current.id,
      workspaceId: req.auth.workspaceId,
      name: name.trim(),
      maxAmount: amount,
      maxAgeDays: ageDays,
      currency,
    });
    await recordAudit(req, {
      action: "policy.updated",
      resourceType: "policy",
      resourceId: current.id,
      metadata: { maxAmount: amount, maxAgeDays: ageDays, currency },
    });
    res.json({ policy: updated });
  } catch (error) {
    next(error);
  }
});

// Express 5 does not accept the old app.get("*") path syntax. The named
// wildcard below is its compatible equivalent and preserves React Router
// deep-links without turning an unknown API path into index.html.
app.get("/{*splat}", (req, res, next) => {
  if (req.path === "/api" || req.path.startsWith("/api/")) return next();
  return res.sendFile(path.join(publicPath, "index.html"), (error) => {
    if (error) next(error);
  });
});

app.use((error, req, res, next) => {
  console.error(JSON.stringify({
    level: "error",
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    error: error instanceof Error ? error.message : String(error),
    stack: error?.stack,
  }));
  res
    .status(error?.type === "entity.too.large" ? 413 : 500)
    .json({
      error:
        error?.type === "entity.too.large"
          ? "Request body is too large."
          : "Unexpected API error.",
      requestId: req.requestId,
    });
});

async function start() {
  await migrate();
  await seedDevelopmentData();
  const scanTimer = startScanWorker();
  const sentinelTimer = startSentinelWorker();
  const incidentTimer = startIncidentWorker(config.incidentWorkerIntervalMs);
  const retentionTimer = startRetentionWorker();
  const paymentReconciliationTimer = startPaymentReconciliationWorker();
  const server = app.listen(config.port, config.host, () => {
    console.log(
      `AgentGuard API running at http://${config.host}:${config.port}`,
    );
    console.log("Database: PostgreSQL");
    console.log("Scan worker: running");
  });
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`AgentGuard API received ${signal}; draining requests.`);
    clearInterval(scanTimer);
    clearInterval(sentinelTimer);
    clearInterval(incidentTimer);
    clearInterval(retentionTimer);
    clearInterval(paymentReconciliationTimer);
    const forceClose = setTimeout(() => {
      console.error("AgentGuard API graceful shutdown timed out; closing active connections.");
      server.closeAllConnections?.();
      process.exit(1);
    }, 25_000);
    forceClose.unref?.();
    try {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await closeDatabase();
      console.log("AgentGuard API shutdown complete.");
    } catch (error) {
      console.error("AgentGuard API shutdown failed:", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      clearTimeout(forceClose);
    }
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch(async (error) => {
  console.error("AgentGuard API failed to start:", error.message);
  await closeDatabase().catch(() => {});
  process.exitCode = 1;
});
