import { request } from "../../shared/api/client";
import type { BillingAddon, BillingCheckout, BillingPayment, BillingPaymentException, BillingPlan, BillingServiceOrder, BillingState, BillingUsageMetrics, OperationalObservability } from "../../shared/types/api";

export async function getBillingState(): Promise<BillingState> {
  const response = await request("/api/billing");
  return response.json();
}

export async function getBillingPlans(): Promise<BillingPlan[]> {
  const response = await request("/api/billing/plans");
  return (await response.json()).plans;
}

export async function getBillingAddons(): Promise<BillingAddon[]> {
  const response = await request("/api/billing/addons");
  return (await response.json()).addons;
}

export async function getBillingUsageMetrics(): Promise<BillingUsageMetrics> {
  const response = await request("/api/billing/usage-metrics");
  return (await response.json()).metrics;
}

export async function getBillingServiceOrders(): Promise<BillingServiceOrder[]> {
  const response = await request("/api/billing/service-orders");
  return (await response.json()).orders;
}

function createIdempotencyKey(planId: string) {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `billing-${planId}-${suffix}`;
}

export type DirectBillingCheckout = {
  checkout: BillingCheckout;
  order_id: string;
  orderId: string;
  walletAddress: string;
  amountUSDT: string;
  amountUsdt: string;
  amountAtomic: string;
  token: "USDT";
  network: "TRC20";
  tokenContract: string;
  decimals: number;
  expiresAt: string | null;
  paymentMode: "direct_p2p";
};

export async function createBillingCheckout(planId: string, idempotencyKey = createIdempotencyKey(planId), planName?: string, priceUSD?: number): Promise<DirectBillingCheckout | { change: { planId: string; effectiveAt: string }; billing: BillingState }> {
  const response = await request("/api/billing/checkout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ planId, planName, priceUSD }),
  });
  return response.json();
}

export async function getBillingCheckout(checkoutId: string): Promise<BillingCheckout> {
  const response = await request(`/api/billing/checkout/${encodeURIComponent(checkoutId)}`);
  return (await response.json()).checkout;
}

export async function getDirectBillingCheckout(checkoutId: string): Promise<DirectBillingCheckout> {
  const response = await request(`/api/billing/checkout/${encodeURIComponent(checkoutId)}`);
  return response.json();
}

export async function cancelScheduledPlanChange(): Promise<BillingState> {
  const response = await request("/api/billing/plan-change/cancel", { method: "POST" });
  return (await response.json()).billing;
}

function createAddonIdempotencyKey(addonId: string) {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `addon-${addonId}-${suffix}`;
}

export async function createBillingAddonCheckout(addonId: string, agentId?: string, serviceAcknowledged = false, priceUSD?: number): Promise<DirectBillingCheckout> {
  const response = await request("/api/billing/addons/checkout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": createAddonIdempotencyKey(addonId),
    },
    body: JSON.stringify({ addonId, agentId, serviceAcknowledged, priceUSD }),
  });
  return response.json();
}

export async function verifyBillingPayment(orderId: string): Promise<{ verified: boolean; status: string; order_id: string; txHash?: string; alreadyVerified?: boolean; message?: string }> {
  const response = await request("/api/billing/verify-payment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_id: orderId }),
  });
  return response.json();
}

export async function reportBillingPaymentException(orderId: string, txHash: string): Promise<{
  verified: boolean;
  status: string;
  order_id: string;
  txHash?: string;
  message?: string;
  exception?: BillingPaymentException;
}> {
  const response = await request("/api/billing/payment-exceptions/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_id: orderId, tx_hash: txHash }),
  });
  return response.json();
}

export async function getBillingPaymentHistory(): Promise<BillingPayment[]> {
  const response = await request("/api/billing/payment-history");
  return (await response.json()).payments;
}

export async function getBillingPaymentExceptions(): Promise<BillingPaymentException[]> {
  const response = await request("/api/billing/payment-exceptions");
  return (await response.json()).exceptions;
}

export async function getOperationalObservability(): Promise<OperationalObservability> {
  const response = await request("/api/ops/observability");
  return response.json();
}

export async function resolveBillingPaymentException(exceptionId: string, action: "refund_required" | "resolved" | "ignored" | "refunded", note?: string): Promise<BillingPaymentException> {
  const response = await request(`/api/billing/payment-exceptions/${encodeURIComponent(exceptionId)}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, note }),
  });
  return (await response.json()).exception;
}

export async function attachBillingPaymentException(exceptionId: string, checkoutId: string, note?: string): Promise<{ exception: BillingPaymentException; payment: BillingPayment }> {
  const response = await request(`/api/billing/payment-exceptions/${encodeURIComponent(exceptionId)}/attach`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checkoutId, note }),
  });
  return response.json();
}
