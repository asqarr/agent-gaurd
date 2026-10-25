// Payment providers must verify signatures and on-chain settlement before calling
// normalizeVerifiedCryptoPayment. The billing core never trusts browser redirects.

const allowedStatuses = new Set(["pending", "confirming", "confirmed", "failed", "expired", "refunded"]);

export function normalizeVerifiedCryptoPayment(event) {
  if (!event || event.provider !== "crypto") {
    const error = new Error("A normalized crypto payment event is required.");
    error.code = "INVALID_PAYMENT_EVENT";
    throw error;
  }
  if (typeof event.providerPaymentId !== "string" || !event.providerPaymentId.trim()) {
    const error = new Error("Crypto payment events require a provider payment ID.");
    error.code = "INVALID_PAYMENT_EVENT";
    throw error;
  }
  if (!allowedStatuses.has(event.status)) {
    const error = new Error("Crypto payment status is not supported.");
    error.code = "INVALID_PAYMENT_EVENT";
    throw error;
  }
  if (typeof event.amount !== "string" || !/^\d+(\.\d{1,12})?$/.test(event.amount)) {
    const error = new Error("Crypto payment amount must be a decimal string.");
    error.code = "INVALID_PAYMENT_EVENT";
    throw error;
  }
  if (event.netAmount !== undefined && event.netAmount !== null && (typeof event.netAmount !== "string" || !/^\d+(\.\d{1,12})?$/.test(event.netAmount))) {
    const error = new Error("Crypto payment net amount must be a decimal string.");
    error.code = "INVALID_PAYMENT_EVENT";
    throw error;
  }
  if (typeof event.currency !== "string" || !/^[A-Z0-9-]{2,16}$/.test(event.currency)) {
    const error = new Error("Crypto payment currency is invalid.");
    error.code = "INVALID_PAYMENT_EVENT";
    throw error;
  }
  if (event.confirmations !== undefined && (!Number.isInteger(event.confirmations) || event.confirmations < 0)) {
    const error = new Error("Crypto payment confirmations must be a non-negative integer.");
    error.code = "INVALID_PAYMENT_EVENT";
    throw error;
  }
  if (event.paymentTimestamp !== undefined && event.paymentTimestamp !== null) {
    const timestamp = new Date(event.paymentTimestamp);
    if (Number.isNaN(timestamp.getTime())) {
      const error = new Error("Crypto payment timestamp is invalid.");
      error.code = "INVALID_PAYMENT_EVENT";
      throw error;
    }
  }
  return {
    provider: "crypto",
    providerPaymentId: event.providerPaymentId.trim(),
    checkoutSessionId: typeof event.checkoutSessionId === "string" ? event.checkoutSessionId : null,
    providerCheckoutId: typeof event.providerCheckoutId === "string" ? event.providerCheckoutId.trim() : null,
    status: event.status,
    amount: event.amount,
    netAmount: event.netAmount ?? event.amount,
    currency: event.currency,
    network: typeof event.network === "string" ? event.network.trim() : null,
    walletAddress: typeof event.walletAddress === "string" ? event.walletAddress.trim() : null,
    txHash: typeof event.txHash === "string" ? event.txHash.trim() : null,
    confirmations: event.confirmations ?? 0,
    paymentTimestamp: event.paymentTimestamp ? new Date(event.paymentTimestamp).toISOString() : null,
    rawPayload: event.rawPayload && typeof event.rawPayload === "object" ? event.rawPayload : {},
  };
}
