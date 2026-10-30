// Server-side authorization for high-impact Agent tool calls.
// The model can propose an action; this module decides whether it may execute.
const defaultPolicy = {
  maxAmount: 50,
  maxAgeDays: 14,
};

export const defaultOrders = Object.freeze({
  "TEST-001": Object.freeze({ ageDays: 5 }),
  "TEST-002": Object.freeze({ ageDays: 20 }),
});

function decimalToMinor(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const text = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function validatePolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return ["The configured policy is missing or invalid; the guard is fail-closed."];
  }

  const reasons = [];
  const maxAmountMinor = decimalToMinor(policy.maxAmount);
  if (maxAmountMinor === null || maxAmountMinor <= 0n) {
    reasons.push("The configured refund ceiling is invalid; the guard is fail-closed.");
  }
  if (!Number.isInteger(policy.maxAgeDays) || policy.maxAgeDays < 0 || policy.maxAgeDays > 36500) {
    reasons.push("The configured order age limit is invalid; the guard is fail-closed.");
  }
  if (policy.currency !== undefined &&
    (typeof policy.currency !== "string" || !/^[A-Z]{3}$/.test(policy.currency))) {
    reasons.push("The configured policy currency is invalid; the guard is fail-closed.");
  }
  return reasons;
}

function trustedOrderFor(orders, orderId) {
  if (typeof orderId !== "string" || !orders || typeof orders !== "object" ||
    Array.isArray(orders) || !Object.hasOwn(orders, orderId)) {
    return null;
  }
  const order = orders[orderId];
  if (!order || typeof order !== "object" || Array.isArray(order) ||
    !Number.isInteger(order.ageDays) || order.ageDays < 0 || order.ageDays > 36500) {
    return null;
  }
  return order;
}

function blockedForPolicy(reasons) {
  return { decision: "BLOCK", reasons };
}

export function checkRefundCall(
  call,
  { policy = defaultPolicy, orders = defaultOrders } = {},
) {
  if (!call || call.name !== "issue_refund") {
    return blockedForPolicy(["Unknown or missing tool name."]);
  }

  const args = call.arguments;

  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return blockedForPolicy(["Tool arguments must be an object."]);
  }

  const policyReasons = validatePolicy(policy);
  if (policyReasons.length) return blockedForPolicy(policyReasons);

  const maxAmountMinor = decimalToMinor(policy.maxAmount);
  const reasons = [];

  const { order_id, amount } = args;
  const order = trustedOrderFor(orders, order_id);

  if (!order) {
    reasons.push("Order does not exist in trusted records.");
  } else if (order.ageDays > policy.maxAgeDays) {
    reasons.push(
      `Order is ${order.ageDays} days old; maximum is ${policy.maxAgeDays} days.`,
    );
  }

  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    reasons.push("Amount must be a positive finite number.");
  } else if (decimalToMinor(amount) === null) {
    reasons.push("Amount must use at most two decimal places.");
  } else if (decimalToMinor(amount) > maxAmountMinor) {
    const currency = policy.currency ?? "USD";
    reasons.push(
      `Requested amount is ${amount} ${currency}; maximum is ${policy.maxAmount} ${currency}.`,
    );
  }

  return {
    decision: reasons.length > 0 ? "BLOCK" : "ALLOW",
    reasons,
  };
}

function objectArguments(call) {
  return call?.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
    ? call.arguments
    : null;
}

// Every side-effect tool gets a deterministic policy decision. Tools without
// a specific rule fail closed instead of silently inheriting refund behavior.
export function checkToolCall(call, { policy = defaultPolicy, orders = defaultOrders } = {}) {
  if (call?.name === "issue_refund") return checkRefundCall(call, { policy, orders });
  const args = objectArguments(call);
  if (!args) return blockedForPolicy(["Tool arguments must be an object."]);

  const policyReasons = validatePolicy(policy);
  if (policyReasons.length) return blockedForPolicy(policyReasons);

  if (call.name === "cancel_order") {
    const order = trustedOrderFor(orders, args.order_id);
    const reasons = [];
    if (!order) reasons.push("Order does not exist in trusted records.");
    else if (order.ageDays > policy.maxAgeDays) {
      reasons.push(`Order is ${order.ageDays} days old; maximum is ${policy.maxAgeDays} days.`);
    }
    return { decision: reasons.length ? "BLOCK" : "ALLOW", reasons };
  }

  if (call.name === "create_ticket") {
    const reasons = [];
    if (!trustedOrderFor(orders, args.order_id)) reasons.push("Ticket order must belong to trusted records.");
    if (typeof args.message !== "string" || !args.message.trim()) reasons.push("Ticket message must be a non-empty string.");
    if (typeof args.message === "string" && /payment|card|secret|password|token|api[_ -]?key|full profile/i.test(args.message)) {
      reasons.push("Ticket content contains sensitive fields that must be redacted.");
    }
    return { decision: reasons.length ? "BLOCK" : "ALLOW", reasons };
  }

  return { decision: "BLOCK", reasons: ["No policy is configured for this side-effect tool."] };
}
