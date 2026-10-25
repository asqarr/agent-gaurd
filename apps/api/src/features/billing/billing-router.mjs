import { Router } from "express";
import { config } from "../../core/config.mjs";
import { requireAuth } from "../auth/auth.mjs";
import { createRateLimiter } from "../../core/rate-limit.mjs";
import * as repository from "../../infrastructure/repository.mjs";
import { hashGrowthSourceKey, normalizePaymentGrowthProperties } from "../growth-analytics/domain.mjs";
import { recordGrowthEvent } from "../growth-analytics/repository.mjs";
import {
  atomicToUsdt,
  findMatchingIncomingTransfer,
  getPublicTronAddress,
  getTronPaymentConfig,
  usdtCentsToAtomic,
} from "./tron-payment.mjs";

const router = Router();
const PAYMENT_PROVIDER = "tron-p2p";
const CHECKOUT_TTL_MS = 30 * 60 * 1000;

const verifyRateLimit = createRateLimiter({
  windowMs: config.webhookRateLimitWindowMs,
  max: Math.max(config.webhookRateLimitMax, 30),
  keyFn: (req) => `${req.ip || req.socket.remoteAddress || "unknown"}:${req.auth?.workspaceId ?? "anonymous"}`,
  message: "Too many payment verification requests. Try again later.",
});

function workspaceId(req) {
  return req.currentWorkspaceId ?? req.auth?.workspaceId ?? null;
}

function canManageBilling(req) {
  return ["owner", "admin"].includes(req.auth?.role);
}

function idempotencyKey(req) {
  return req.get("Idempotency-Key")?.trim() ?? "";
}

function isValidIdempotencyKey(value) {
  return /^[a-zA-Z0-9._:-]{8,128}$/.test(value);
}

function invalidInput(message, code = "INVALID_BILLING_INPUT") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseUsdCents(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    value = value.toFixed(2);
  }
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ""] = value.trim().split(".");
  const cents = Number(`${whole}${fraction.padEnd(2, "0")}`);
  return Number.isSafeInteger(cents) ? cents : null;
}

function resolvePlan(plans, body) {
  const requested = typeof body?.planName === "string"
    ? body.planName.trim().toLowerCase()
    : typeof body?.planId === "string"
      ? body.planId.trim().toLowerCase()
      : "";
  if (!requested) return null;
  return plans.find((item) => item.id.toLowerCase() === requested || item.name.toLowerCase() === requested) ?? null;
}

function directPaymentDetails(checkout) {
  const tron = getTronPaymentConfig();
  const amountAtomic = checkout.paymentAmountAtomic ?? usdtCentsToAtomic(Number(checkout.amountUsdCents));
  const amountUsdt = checkout.paymentAmountUsdt ?? atomicToUsdt(amountAtomic);
  return {
    order_id: checkout.id,
    orderId: checkout.id,
    checkout: {
      ...checkout,
      status: checkout.status,
    },
    walletAddress: tron.walletAddress,
    amountUSDT: amountUsdt,
    amountUsdt,
    amountAtomic,
    token: "USDT",
    network: "TRC20",
    tokenContract: tron.usdtContract,
    decimals: tron.decimals,
    expiresAt: checkout.expiresAt,
    paymentMode: "direct_p2p",
  };
}

async function recordBillingAudit(req, workspace, action, resourceId, metadata = {}, resourceType = "billing_checkout") {
  await repository.recordAuditEvent({
    workspaceId: workspace,
    actorUserId: req.auth?.userId ?? null,
    action,
    resourceType,
    resourceId,
    requestId: req.requestId ?? null,
    ipAddress: req.ip ?? null,
    metadata,
  });
}

async function recordVerifiedPaymentGrowth(event, result) {
  if (event.status !== "confirmed") return;
  try {
    const checkout = await repository.getCheckoutSession({
      workspaceId: result.workspaceId,
      checkoutSessionId: result.checkoutSessionId,
    });
    await recordGrowthEvent({
      eventName: "business.payment_confirmed",
      workspaceId: result.workspaceId,
      sourceKey: hashGrowthSourceKey(`${PAYMENT_PROVIDER}:${event.providerPaymentId}`),
      properties: normalizePaymentGrowthProperties({
        checkoutType: checkout?.checkoutType,
        planId: checkout?.planId,
        addonId: checkout?.addonId,
        amount: event.amount,
      }),
    });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "growth_payment_record_failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

async function createDirectCheckout({ workspace, checkoutType, planId = null, addonId = null, key, metadata = {} }) {
  const walletAddress = getPublicTronAddress();
  const tron = getTronPaymentConfig();
  const expiresAt = new Date(Date.now() + CHECKOUT_TTL_MS);
  const checkout = await repository.createCheckoutSession({
    workspaceId: workspace,
    planId,
    checkoutType,
    addonId,
    provider: PAYMENT_PROVIDER,
    status: "waiting",
    idempotencyKey: key,
    quoteCurrency: "USDT",
    network: "TRC20",
    payAddress: walletAddress,
    expiresAt,
    metadata: {
      ...metadata,
      paymentMode: "direct_p2p",
      token: "USDT",
      tokenContract: tron.usdtContract,
      decimals: tron.decimals,
    },
  });
  if (!checkout) throw invalidInput("The checkout session could not be created.", "CHECKOUT_CREATE_FAILED");
  if (checkout.provider !== PAYMENT_PROVIDER) throw invalidInput("This idempotency key belongs to an older payment method.", "IDEMPOTENCY_PROVIDER_CONFLICT");
  return checkout;
}

async function handlePlanCheckout(req, res, next) {
  try {
    const workspace = workspaceId(req);
    if (!workspace) return res.status(401).json({ error: "Authentication required." });
    if (!canManageBilling(req)) return res.status(403).json({ error: "Only workspace owners and admins can manage billing." });
    const key = idempotencyKey(req);
    if (!isValidIdempotencyKey(key)) return res.status(400).json({ error: "A valid Idempotency-Key header is required." });
    const plan = resolvePlan(await repository.listBillingPlans(), req.body);
    if (!plan) return res.status(404).json({ error: "The selected plan is not available." });
    if (plan.priceUsdCents <= 0) return res.status(400).json({ error: "The free plan does not require checkout." });
    const submittedPrice = parseUsdCents(req.body?.priceUSD);
    if (req.body?.priceUSD !== undefined && submittedPrice !== plan.priceUsdCents) return res.status(400).json({ error: "The submitted price does not match the server plan price." });
    const current = await repository.getBillingState(workspace);
    const rank = { free: 0, builder: 1, team: 2, agency: 3 };
    if ((rank[plan.id] ?? 0) < (rank[current.plan.id] ?? 0) && current.entitlements.active) {
      const change = await repository.schedulePlanChange({ workspaceId: workspace, planId: plan.id });
      await recordBillingAudit(req, workspace, "billing.plan_downgrade_scheduled", current.subscription.id, { fromPlanId: current.plan.id, toPlanId: plan.id, effectiveAt: change.effectiveAt });
      return res.json({ change, billing: await repository.getBillingState(workspace) });
    }
    let checkout = await repository.getCheckoutSessionByIdempotency({ workspaceId: workspace, idempotencyKey: key });
    if (checkout && checkout.planId !== plan.id) return res.status(409).json({ error: "This Idempotency-Key is already linked to another plan." });
    if (!checkout) checkout = await createDirectCheckout({ workspace, checkoutType: "plan", planId: plan.id, key });
    if (checkout.provider !== PAYMENT_PROVIDER) return res.status(409).json({ error: "This checkout belongs to an older payment method.", code: "IDEMPOTENCY_PROVIDER_CONFLICT" });
    await recordBillingAudit(req, workspace, "billing.checkout_created", checkout.id, { planId: plan.id, provider: PAYMENT_PROVIDER, currency: "USDT", network: "TRC20" });
    return res.status(201).json(directPaymentDetails(checkout));
  } catch (error) {
    if (["TRON_CONFIGURATION_ERROR", "TRON_AMOUNT_ERROR"].includes(error?.code)) return res.status(503).json({ error: "Direct TRON payment is not configured correctly." });
    if (["IDEMPOTENCY_PROVIDER_CONFLICT", "CHECKOUT_CREATE_FAILED"].includes(error?.code)) return res.status(409).json({ error: error.message, code: error.code });
    next(error);
  }
}

async function handleAddonCheckout(req, res, next) {
  try {
    const workspace = workspaceId(req);
    if (!workspace) return res.status(401).json({ error: "Authentication required." });
    if (!canManageBilling(req)) return res.status(403).json({ error: "Only workspace owners and admins can purchase add-ons." });
    const addonId = typeof req.body?.addonId === "string" ? req.body.addonId.trim() : "";
    const agentId = typeof req.body?.agentId === "string" ? req.body.agentId.trim() : null;
    const serviceAcknowledged = req.body?.serviceAcknowledged === true;
    const key = idempotencyKey(req);
    if (!addonId || !/^[a-z0-9_-]{2,80}$/i.test(addonId)) return res.status(400).json({ error: "A valid addonId is required." });
    if (!isValidIdempotencyKey(key)) return res.status(400).json({ error: "A valid Idempotency-Key header is required." });
    const addon = (await repository.listBillingAddons()).find((item) => item.id === addonId);
    if (!addon) return res.status(404).json({ error: "The selected add-on is not available." });
    if (req.body?.priceUSD !== undefined && parseUsdCents(req.body.priceUSD) !== addon.priceUsdCents) return res.status(400).json({ error: "The submitted price does not match the server add-on price." });
    if (["security_audit", "support"].includes(addon.kind) && !serviceAcknowledged) return res.status(400).json({ error: "Review and accept the service scope before opening payment.", code: "SERVICE_TERMS_REQUIRED" });
    if (addon.kind === "security_audit") {
      if (!agentId) return res.status(400).json({ error: "An Agent is required for a Security Audit." });
      if (!await repository.getAgent(agentId, workspace)) return res.status(404).json({ error: "The selected Agent was not found." });
    }
    let checkout = await repository.getCheckoutSessionByIdempotency({ workspaceId: workspace, idempotencyKey: key });
    if (checkout && checkout.addonId !== addonId) return res.status(409).json({ error: "This Idempotency-Key is already linked to another add-on." });
    if (!checkout) checkout = await createDirectCheckout({ workspace, checkoutType: "addon", addonId, key, metadata: { addonId, targetAgentId: agentId, serviceScope: addon.serviceScope, serviceAcknowledged } });
    if (checkout.provider !== PAYMENT_PROVIDER) return res.status(409).json({ error: "This checkout belongs to an older payment method.", code: "IDEMPOTENCY_PROVIDER_CONFLICT" });
    await recordBillingAudit(req, workspace, "billing.addon_checkout_created", checkout.id, { addonId, agentId, provider: PAYMENT_PROVIDER });
    return res.status(201).json(directPaymentDetails(checkout));
  } catch (error) {
    if (error?.code === "ADDON_NOT_FOUND") return res.status(404).json({ error: error.message });
    if (["TRON_CONFIGURATION_ERROR", "TRON_AMOUNT_ERROR"].includes(error?.code)) return res.status(503).json({ error: "Direct TRON payment is not configured correctly." });
    if (error?.code === "IDEMPOTENCY_PROVIDER_CONFLICT") return res.status(409).json({ error: error.message, code: error.code });
    next(error);
  }
}

async function handleCheckoutLookup(req, res, next) {
  try {
    const checkout = await repository.getCheckoutSession({ workspaceId: workspaceId(req), checkoutSessionId: req.params.checkoutId });
    if (!checkout) return res.status(404).json({ error: "Checkout session not found." });
    return res.json({ checkout, ...(checkout.provider === PAYMENT_PROVIDER ? directPaymentDetails(checkout) : {}) });
  } catch (error) {
    next(error);
  }
}

async function handleVerifyPayment(req, res, next) {
  try {
    const workspace = workspaceId(req);
    if (!workspace) return res.status(401).json({ error: "Authentication required." });
    if (!canManageBilling(req)) return res.status(403).json({ error: "Only workspace owners and admins can verify billing." });
    const orderId = typeof req.body?.order_id === "string" ? req.body.order_id.trim() : typeof req.body?.checkoutId === "string" ? req.body.checkoutId.trim() : "";
    if (!/^checkout-[a-f0-9-]{20,80}$/i.test(orderId)) return res.status(400).json({ error: "A valid order_id is required." });
    const checkout = await repository.getCheckoutSession({ workspaceId: workspace, checkoutSessionId: orderId });
    if (!checkout || checkout.provider !== PAYMENT_PROVIDER) return res.status(404).json({ error: "Direct TRON checkout not found." });
    if (["completed", "paid"].includes(checkout.status)) return res.json({ verified: true, status: checkout.status, order_id: orderId, alreadyVerified: true });
    if (["expired", "canceled", "failed"].includes(checkout.status)) return res.status(410).json({ verified: false, status: checkout.status, error: "This checkout is no longer payable." });
    if (checkout.expiresAt && new Date(checkout.expiresAt).getTime() < Date.now()) return res.status(410).json({ verified: false, status: "expired", error: "This checkout has expired." });
    const tron = getTronPaymentConfig();
    const expectedAtomic = checkout.paymentAmountAtomic ?? usdtCentsToAtomic(Number(checkout.amountUsdCents));
    const transfer = await findMatchingIncomingTransfer({ address: tron.walletAddress, expectedAtomic, createdAt: checkout.createdAt, expiresAt: checkout.expiresAt });
    if (!transfer) return res.json({ verified: false, status: checkout.status, order_id: orderId, message: "No confirmed matching USDT-TRC20 transfer was found yet." });
    const event = {
      provider: "crypto",
      providerPaymentId: transfer.txHash,
      checkoutSessionId: checkout.id,
      providerCheckoutId: transfer.txHash,
      status: "confirmed",
      amount: atomicToUsdt(transfer.amountAtomic),
      netAmount: atomicToUsdt(transfer.amountAtomic),
      currency: "USDT",
      network: "TRON",
      walletAddress: tron.walletAddress,
      txHash: transfer.txHash,
      confirmations: 1,
      paymentTimestamp: transfer.timestamp?.toISOString(),
      rawPayload: transfer.raw,
    };
    const payment = await repository.applyVerifiedCryptoPayment(event, { paymentProvider: PAYMENT_PROVIDER, confirmedCheckoutStatus: "completed" });
    await recordVerifiedPaymentGrowth(event, payment);
    await recordBillingAudit(req, workspace, "billing.payment_verified", checkout.id, { provider: PAYMENT_PROVIDER, txHash: transfer.txHash, amount: event.amount, network: "TRON" });
    return res.json({ verified: true, status: "completed", order_id: orderId, txHash: transfer.txHash, payment });
  } catch (error) {
    if (["TRON_CONFIGURATION_ERROR", "TRON_AMOUNT_ERROR", "TRON_VERIFICATION_INPUT_ERROR", "TRON_TIME_WINDOW_ERROR"].includes(error?.code)) return res.status(503).json({ verified: false, error: "TRON payment verification is not configured correctly." });
    if (["TRON_PROVIDER_ERROR", "TRON_INVALID_RESPONSE", "TRON_TIMEOUT", "TRON_HTTP_401", "TRON_HTTP_403", "TRON_HTTP_429", "TRON_HTTP_500", "TRON_HTTP_502", "TRON_HTTP_503", "TRON_HTTP_504"].includes(error?.code)) return res.status(502).json({ verified: false, error: "The public TRON indexer is temporarily unavailable. Try again shortly." });
    if (["PAYMENT_AMOUNT_MISMATCH", "PAYMENT_TIME_INVALID", "PAYMENT_REPLAY"].includes(error?.code)) return res.status(409).json({ verified: false, error: error.message, code: error.code });
    next(error);
  }
}

async function handlePaymentHistory(req, res, next) {
  try {
    const workspace = workspaceId(req);
    if (!workspace) return res.status(401).json({ error: "Authentication required." });
    return res.json({ payments: await repository.listBillingPaymentHistory({ workspaceId: workspace, limit: req.query.limit }) });
  } catch (error) {
    next(error);
  }
}

async function handlePaymentExceptions(req, res, next) {
  try {
    const workspace = workspaceId(req);
    if (!workspace) return res.status(401).json({ error: "Authentication required." });
    const status = typeof req.query.status === "string" && req.query.status.trim() ? req.query.status.trim() : null;
    const allowed = new Set(["open", "assigned", "refund_required", "refunded", "resolved", "ignored"]);
    if (status && !allowed.has(status)) return res.status(400).json({ error: "Unsupported payment exception status." });
    return res.json({ exceptions: await repository.listPaymentExceptions({ workspaceId: workspace, status, limit: req.query.limit }) });
  } catch (error) {
    next(error);
  }
}

async function handleResolvePaymentException(req, res, next) {
  try {
    const workspace = workspaceId(req);
    if (!workspace) return res.status(401).json({ error: "Authentication required." });
    if (!canManageBilling(req)) return res.status(403).json({ error: "Only workspace owners and admins can resolve payment exceptions." });
    const action = typeof req.body?.action === "string" ? req.body.action.trim().toLowerCase() : "";
    const status = ({
      refund: "refund_required",
      refund_required: "refund_required",
      resolve: "resolved",
      resolved: "resolved",
      ignore: "ignored",
      ignored: "ignored",
      refunded: "refunded",
    })[action];
    if (!status) return res.status(400).json({ error: "Choose refund_required, resolved, ignored, or refunded." });
    const exceptionId = typeof req.params.exceptionId === "string" ? req.params.exceptionId.trim() : "";
    if (!/^payment-exception-[a-f0-9-]{20,80}$/i.test(exceptionId)) return res.status(400).json({ error: "A valid payment exception ID is required." });
    const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 1000) : null;
    const exception = await repository.resolvePaymentException({
      workspaceId: workspace,
      exceptionId,
      actorUserId: req.auth?.userId ?? null,
      status,
      note,
    });
    if (!exception) return res.status(404).json({ error: "Payment exception not found." });
    await recordBillingAudit(req, workspace, `billing.payment_exception_${status}`, exceptionId, { status, note }, "billing_payment_exception");
    return res.json({ exception });
  } catch (error) {
    if (error?.code === "PAYMENT_EXCEPTION_CLOSED") return res.status(409).json({ error: error.message, code: error.code });
    next(error);
  }
}

async function handleAttachPaymentException(req, res, next) {
  try {
    const workspace = workspaceId(req);
    if (!workspace) return res.status(401).json({ error: "Authentication required." });
    if (!canManageBilling(req)) return res.status(403).json({ error: "Only workspace owners and admins can attach payments to a checkout." });
    const exceptionId = typeof req.params.exceptionId === "string" ? req.params.exceptionId.trim() : "";
    const checkoutId = typeof req.body?.checkoutId === "string" ? req.body.checkoutId.trim() : "";
    if (!/^payment-exception-[a-f0-9-]{20,80}$/i.test(exceptionId)) return res.status(400).json({ error: "A valid payment exception ID is required." });
    if (!/^checkout-[a-f0-9-]{20,80}$/i.test(checkoutId)) return res.status(400).json({ error: "A valid checkout ID is required." });
    const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 1000) : null;
    const tron = getTronPaymentConfig();
    const result = await repository.attachPaymentExceptionToCheckout({
      workspaceId: workspace,
      exceptionId,
      checkoutSessionId: checkoutId,
      actorUserId: req.auth?.userId ?? null,
      expectedRecipient: tron.walletAddress,
      expectedContract: tron.usdtContract,
      note,
    });
    if (!result) return res.status(404).json({ error: "Payment exception not found." });
    await recordBillingAudit(req, workspace, "billing.payment_exception_attached", exceptionId, { checkoutId, txHash: result.exception.txHash }, "billing_payment_exception");
    return res.json(result);
  } catch (error) {
    if (["PAYMENT_EXCEPTION_CLOSED", "CHECKOUT_NOT_ATTACHABLE", "PAYMENT_AMOUNT_MISMATCH", "PAYMENT_REPLAY", "PAYMENT_TIME_INVALID", "PAYMENT_RECIPIENT_MISMATCH", "PAYMENT_TOKEN_MISMATCH"].includes(error?.code)) {
      return res.status(409).json({ error: error.message, code: error.code });
    }
    if (error?.code === "CHECKOUT_NOT_FOUND") return res.status(404).json({ error: error.message, code: error.code });
    if (error?.code === "TRON_CONFIGURATION_ERROR") return res.status(503).json({ error: "Direct TRON payment is not configured correctly." });
    next(error);
  }
}

router.post("/checkout", requireAuth, handlePlanCheckout);
router.post("/addons/checkout", requireAuth, handleAddonCheckout);
router.post("/verify-payment", requireAuth, verifyRateLimit, handleVerifyPayment);
router.get("/checkout/:checkoutId", requireAuth, handleCheckoutLookup);
router.get("/payment-history", requireAuth, handlePaymentHistory);
router.get("/payment-exceptions", requireAuth, handlePaymentExceptions);
router.post("/payment-exceptions/:exceptionId/resolve", requireAuth, handleResolvePaymentException);
router.post("/payment-exceptions/:exceptionId/attach", requireAuth, handleAttachPaymentException);

export default router;
