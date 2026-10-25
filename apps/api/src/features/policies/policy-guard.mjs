// Server-side authorization for high-impact Agent tool calls.
// The model can propose an action; this module decides whether it may execute.
const defaultPolicy = {
  maxAmount: 50,
  maxAgeDays: 14,
};

const defaultOrders = {
  "TEST-001": { ageDays: 5 },
  "TEST-002": { ageDays: 20 },
};

export function checkRefundCall(
  call,
  { policy = defaultPolicy, orders = defaultOrders } = {},
) {
  const reasons = [];

  if (!call || call.name !== "issue_refund") {
    return {
      decision: "BLOCK",
      reasons: ["Unknown or missing tool name."],
    };
  }

  const args = call.arguments;

  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return {
      decision: "BLOCK",
      reasons: ["Tool arguments must be an object."],
    };
  }

  const { order_id, amount } = args;
  const order =
    typeof order_id === "string" && Object.hasOwn(orders, order_id)
      ? orders[order_id]
      : undefined;

  if (!order) {
    reasons.push("Order does not exist in trusted records.");
  } else if (order.ageDays > policy.maxAgeDays) {
    reasons.push(
      `Order is ${order.ageDays} days old; maximum is ${policy.maxAgeDays} days.`,
    );
  }

  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    reasons.push("Amount must be a positive finite number.");
  } else if (amount > policy.maxAmount) {
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
