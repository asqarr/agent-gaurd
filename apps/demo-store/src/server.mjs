import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createAgentGuardClient, stableStringify, verifyExecutionReceipt } from "@agentguard/sdk";
import { createRefundRepository } from "./refund-repository.mjs";

const MAX_BODY_BYTES = 16 * 1024;
const REFUND_POLICY = Object.freeze({ maxAmount: 50, currency: "USD" });
const DEMO_ORDER = Object.freeze({ id: "DEMO-ORDER-100", ageDays: 2, tenantId: "demo-merchant" });

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.status = 400;
    throw error;
  }
}

function refundToolCall(input) {
  const amount = Number(input?.amount);
  const orderId = typeof input?.orderId === "string" ? input.orderId : DEMO_ORDER.id;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) {
    const error = new Error("amount must be a positive number no greater than 10,000.");
    error.status = 400;
    throw error;
  }
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-8) {
    const error = new Error("amount must use no more than two decimal places.");
    error.status = 400;
    throw error;
  }
  if (orderId !== DEMO_ORDER.id) {
    const error = new Error("The synthetic demo store only recognizes DEMO-ORDER-100.");
    error.status = 404;
    throw error;
  }
  return { name: "issue_refund", arguments: { order_id: orderId, amount } };
}

function extractProposal(input) {
  const amountMatch = String(input ?? "").match(/(?:\$\s*)?(\d+(?:\.\d{1,2})?)\s*(?:dollars?|USD)?/i);
  const orderMatch = String(input ?? "").match(/order\s+([A-Za-z0-9_-]+)/i);
  if (!amountMatch || !orderMatch) return null;
  return {
    name: "issue_refund",
    arguments: { order_id: orderMatch[1], amount: Number(amountMatch[1]) },
  };
}

export function createDemoStoreServer({ baseUrl, agentId, token, databaseUrl, schema, now = () => new Date() } = {}) {
  let guard = baseUrl && agentId && token
    ? createAgentGuardClient({ baseUrl, agentId, token })
    : null;
  let configuredAgentId = agentId ?? null;
  let configuredToken = token ?? null;
  const refundRepository = createRefundRepository({ databaseUrl, schema });
  let closed = false;

  async function executeRefund(call, receipt) {
    if (!receipt || !verifyExecutionReceipt(receipt, configuredToken, { now: now().getTime() })) {
      const error = new Error("A valid, unexpired AgentGuard execution receipt is required.");
      error.status = 403;
      error.code = "AGENTGUARD_RECEIPT_REQUIRED";
      throw error;
    }
    const payload = receipt.payload;
    if (payload.agentId !== configuredAgentId || payload.tool !== call?.name ||
      stableStringify(payload.arguments) !== stableStringify(call?.arguments) ||
      payload.context?.orderId !== call?.arguments?.order_id ||
      payload.context?.tenantId !== DEMO_ORDER.tenantId) {
      const error = new Error("The AgentGuard receipt is not bound to this exact refund, order, and merchant.");
      error.status = 403;
      error.code = "AGENTGUARD_RECEIPT_MISMATCH";
      throw error;
    }
    if (call.name !== "issue_refund" || call.arguments.order_id !== DEMO_ORDER.id ||
      !Number.isFinite(call.arguments.amount) || call.arguments.amount <= 0 ||
      Math.abs(call.arguments.amount * 100 - Math.round(call.arguments.amount * 100)) > 1e-8 ||
      call.arguments.amount > REFUND_POLICY.maxAmount) {
      const error = new Error("The store's independent refund policy rejected this action.");
      error.status = 403;
      error.code = "STORE_POLICY_BLOCKED";
      throw error;
    }
    return refundRepository.createRefund({
      approvalId: payload.approvalId,
      agentId: payload.agentId,
      requestId: payload.requestId,
      tool: call.name,
      orderId: call.arguments.order_id,
      tenantId: payload.context.tenantId,
      amount: call.arguments.amount,
      currency: REFUND_POLICY.currency,
      consumedAt: payload.consumedAt,
      executedAt: now().toISOString(),
    });
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://demo-store.local");
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, { status: "ok", mode: "synthetic-demo", gatewayConfigured: Boolean(guard) });
      }
      if (request.method === "GET" && url.pathname === `/api/orders/${DEMO_ORDER.id}`) {
        return json(response, 200, { order: DEMO_ORDER });
      }
      if (request.method === "POST" && url.pathname === "/agent/propose") {
        const body = await readJson(request);
        const proposal = extractProposal(body.input);
        return json(response, 200, {
          assistant_text: proposal ? "I will request the refund for policy review." : "I need a valid refund amount and order.",
          tool_calls: proposal ? [proposal] : [],
          execution_status: "not_executed",
        });
      }
      if (request.method === "POST" && url.pathname === "/api/refunds") {
        if (!guard) return json(response, 503, { error: "AgentGuard runtime credentials are not configured." });
        const body = await readJson(request);
        const call = refundToolCall(body);
        const result = await guard.execute({
          input: `Please issue a refund of $${call.arguments.amount} for order ${call.arguments.order_id}.`,
          executionContext: {
            actorId: "demo-customer-1",
            tenantId: DEMO_ORDER.tenantId,
            orderId: DEMO_ORDER.id,
            issuedAt: now().toISOString(),
          },
          trustedContext: { orders: { [DEMO_ORDER.id]: { ageDays: DEMO_ORDER.ageDays } } },
          tools: {
            issue_refund: async (args, authorization) => executeRefund({ name: "issue_refund", arguments: args }, authorization.executionReceipt),
          },
        });
        return json(response, 200, {
          requestId: result.requestId,
          guard: result.guard,
          blocked_tool_calls: result.blocked_tool_calls,
          executions: result.executions,
          sideEffectExecuted: result.executions.length > 0,
        });
      }
      if (request.method === "POST" && url.pathname === "/internal/tools/issue_refund") {
        const body = await readJson(request);
        const call = body.toolCall;
        return json(response, 200, { refund: await executeRefund(call, body.executionReceipt) });
      }
      if (request.method === "GET" && url.pathname === "/internal/refunds") {
        return json(response, 200, { refunds: await refundRepository.listRefunds() });
      }
      return json(response, 404, { error: "Route not found." });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      return json(response, status, {
        error: status < 500 && error instanceof Error ? error.message : "Demo Store request failed.",
        ...(status < 500 && error?.code ? { code: error.code } : {}),
      });
    }
  });

  return {
    server,
    initialize() {
      return refundRepository.initialize();
    },
    configureGateway(configuration) {
      if (!configuration?.baseUrl || !configuration?.agentId || !configuration?.token) {
        throw new TypeError("AgentGuard baseUrl, agentId, and token are required.");
      }
      configuredAgentId = configuration.agentId;
      configuredToken = configuration.token;
      guard = createAgentGuardClient(configuration);
    },
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve(server.address());
        });
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        if (server.listening) {
          await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
          });
        }
      } finally {
        await refundRepository.close();
      }
    },
  };
}

async function main() {
  const port = Number(process.env.DEMO_STORE_PORT ?? 4200);
  const app = createDemoStoreServer({
    baseUrl: process.env.AGENTGUARD_URL,
    agentId: process.env.AGENTGUARD_AGENT_ID,
    token: process.env.AGENTGUARD_TOKEN,
    databaseUrl: process.env.DEMO_STORE_DATABASE_URL,
  });
  try {
    await app.initialize();
    await app.listen(port, process.env.DEMO_STORE_HOST ?? "127.0.0.1");
    console.log(`Synthetic AgentGuard demo store listening on ${process.env.DEMO_STORE_HOST ?? "127.0.0.1"}:${port}`);
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
