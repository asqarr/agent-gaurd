import { createHmac, timingSafeEqual } from "node:crypto";

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function stableStringify(value) {
  return canonicalize(value);
}

function signApproval(payload, token) {
  return createHmac("sha256", token)
    .update(stableStringify(payload))
    .digest("base64url");
}

export function verifyExecutionReceipt(receipt, token, { now = Date.now() } = {}) {
  if (!receipt?.payload || typeof receipt.signature !== "string" || !token) return false;
  const payload = receipt.payload;
  if (payload.version !== 1 || !payload.approvalId || !payload.agentId || !payload.workspaceId || !payload.requestId || !payload.tool) return false;
  const expiresAt = Date.parse(payload.expiresAt);
  const consumedAt = Date.parse(payload.consumedAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now || !Number.isFinite(consumedAt) || consumedAt > now + 300000 || consumedAt > expiresAt) return false;
  const expected = signApproval(payload, token);
  const left = Buffer.from(expected);
  const right = Buffer.from(receipt.signature);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyApproval(approval, token) {
  if (!approval?.payload || typeof approval.signature !== "string") return false;
  const expected = signApproval(approval.payload, token);
  const left = Buffer.from(expected);
  const right = Buffer.from(approval.signature);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class AgentGuardError extends Error {
  constructor(message, { code = "AGENTGUARD_ERROR", status = 0, response = null } = {}) {
    super(message);
    this.name = "AgentGuardError";
    this.code = code;
    this.status = status;
    this.response = response;
  }
}

export class AgentGuardUnavailableError extends AgentGuardError {
  constructor(message, options = {}) {
    super(message, { ...options, code: "GATEWAY_UNAVAILABLE" });
    this.name = "AgentGuardUnavailableError";
  }
}

function toolCallMatchesApproval(approval, call) {
  return approval?.payload?.tool === call?.name &&
    stableStringify(approval.payload.arguments ?? {}) === stableStringify(call?.arguments ?? {});
}

export class AgentGuardClient {
  constructor({ baseUrl, agentId, token, fetchImpl = globalThis.fetch, timeoutMs = 30000 }) {
    if (!baseUrl || !agentId || !token) {
      throw new TypeError("baseUrl, agentId, and token are required.");
    }
    if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.agentId = agentId;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async #request(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new AgentGuardError(payload.error ?? `AgentGuard request failed (${response.status}).`, {
          status: response.status,
          code: payload.code ?? "GATEWAY_REJECTED",
          response: payload,
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof AgentGuardError) throw error;
      throw new AgentGuardUnavailableError(
        error?.name === "AbortError" ? "AgentGuard timed out; no tool was executed." : "AgentGuard is unavailable; no tool was executed.",
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async invoke({ input, metadata = {}, trustedContext, executionContext } = {}) {
    if (typeof input !== "string" || !input.trim()) {
      throw new TypeError("input is required.");
    }
    return this.#request(`/api/runtime/agents/${encodeURIComponent(this.agentId)}/invoke`, {
      input,
      metadata,
      trustedContext,
      executionContext,
    });
  }

  async #consume(approval, call) {
    if (!verifyApproval(approval, this.token)) {
      throw new AgentGuardError("Approval signature is invalid; no tool was executed.", {
        code: "APPROVAL_SIGNATURE_INVALID",
      });
    }
    if (!toolCallMatchesApproval(approval, call)) {
      throw new AgentGuardError("Tool arguments changed after approval; no tool was executed.", {
        code: "APPROVAL_MISMATCH",
      });
    }
    const result = await this.#request(
      `/api/runtime/agents/${encodeURIComponent(this.agentId)}/approvals/${encodeURIComponent(approval.id)}/consume`,
      { toolCall: call },
    );
    const receipt = result.executionReceipt;
    if (!result.approved || result.execution !== "AUTHORIZED_ONCE" ||
      !verifyExecutionReceipt(receipt, this.token) ||
      receipt.payload.approvalId !== approval.id ||
      receipt.payload.agentId !== this.agentId ||
      receipt.payload.tool !== call.name ||
      stableStringify(receipt.payload.arguments ?? {}) !== stableStringify(call.arguments ?? {})) {
      throw new AgentGuardError("Gateway did not return a valid one-time execution receipt; no tool was executed.", {
        code: "EXECUTION_RECEIPT_INVALID",
        response: result,
      });
    }
    return { ...result, executionReceipt: receipt };
  }

  /**
   * Invoke the agent, consume every one-time approval, and only then execute
   * the returned calls. The executor map must never execute raw model output.
   */
  async execute({ input, metadata = {}, trustedContext, executionContext, tools = {} } = {}) {
    const result = await this.invoke({ input, metadata, trustedContext, executionContext });
    const approved = Array.isArray(result.approved_tool_calls) ? result.approved_tool_calls : [];
    if (result.guard?.decision === "BLOCK" || !approved.length) {
      return { ...result, executions: [] };
    }

    const missingExecutor = approved.find((entry) => typeof tools[entry.call?.name] !== "function");
    if (missingExecutor) {
      throw new AgentGuardError(`No executor is registered for ${missingExecutor.call?.name ?? "unknown tool"}; no tool was executed.`, {
        code: "TOOL_EXECUTOR_MISSING",
      });
    }

    // Consume all approvals before invoking any tool to avoid partial execution
    // when the gateway becomes unavailable halfway through a multi-call turn.
    const authorized = await Promise.all(approved.map(async (entry) => ({
      entry,
      authorization: await this.#consume(entry.approval, entry.call),
    })));

    const executions = [];
    for (const { entry, authorization } of authorized) {
      const executor = tools[entry.call.name];
      executions.push(await executor(entry.call.arguments ?? {}, {
        approvalId: authorization.approvalId,
        requestId: entry.approval.payload.requestId,
        context: entry.approval.payload.context,
        executionReceipt: authorization.executionReceipt,
      }));
    }
    return { ...result, executions };
  }
}

export function createAgentGuardClient(options) {
  return new AgentGuardClient(options);
}
