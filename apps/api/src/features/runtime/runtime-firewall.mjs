import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { tools } from "../catalog/domain.mjs";
import { checkRefundCall } from "../policies/policy-guard.mjs";
import { config } from "../../core/config.mjs";

export function createRuntimeToken() {
  return `ag_live_${randomBytes(32).toString("base64url")}`;
}

export function hashRuntimeToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function readRuntimeToken(req) {
  const authorization = req.headers.authorization;
  return authorization?.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : null;
}

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

export function hashCanonical(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function createApprovalId() {
  return `approval-${randomUUID()}`;
}

export function normalizeExecutionContext(value, { now = Date.now(), clockSkewMs = config.runtimeContextClockSkewMs } = {}) {
  if (value === undefined || value === null) {
    return {
      actorId: null,
      tenantId: null,
      orderId: null,
      issuedAt: new Date(now).toISOString(),
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("executionContext must be a JSON object.");
    error.code = "INVALID_EXECUTION_CONTEXT";
    throw error;
  }
  const readId = (name, required = false) => {
    const current = value[name];
    if (current === undefined || current === null || current === "") {
      if (required) {
        const error = new Error(`executionContext.${name} is required.`);
        error.code = "INVALID_EXECUTION_CONTEXT";
        throw error;
      }
      return null;
    }
    if (typeof current !== "string" || current.length < 1 || current.length > 160) {
      const error = new Error(`executionContext.${name} must be a short string.`);
      error.code = "INVALID_EXECUTION_CONTEXT";
      throw error;
    }
    return current;
  };
  const issuedAt = value.issuedAt ?? value.requestTime;
  const issuedAtMs = typeof issuedAt === "number" ? issuedAt : Date.parse(issuedAt);
  if (!Number.isFinite(issuedAtMs) || Math.abs(now - issuedAtMs) > clockSkewMs) {
    const error = new Error("executionContext.issuedAt must be close to the current time.");
    error.code = "INVALID_EXECUTION_CONTEXT";
    throw error;
  }
  return {
    actorId: readId("actorId"),
    tenantId: readId("tenantId"),
    orderId: readId("orderId"),
    issuedAt: new Date(issuedAtMs).toISOString(),
  };
}

export function hasSensitiveExecutionContext(context) {
  return Boolean(context?.actorId && context?.orderId && context?.issuedAt);
}

function summarizeInspections(inspections) {
  const blocked = inspections.filter((item) => item.decision === "BLOCK");
  const allowed = inspections.filter((item) => item.decision === "ALLOW");
  const reasons = inspections.flatMap((item) => item.reasons ?? []);
  return {
    decision: blocked.length ? "BLOCK" : "ALLOW",
    execution: blocked.length ? "NOT_EXECUTED" : "PASS_THROUGH",
    reasons: [...new Set(reasons)],
    inspections,
    // Fail closed: one unsafe call suppresses every proposed call from this turn.
    toolCalls: blocked.length ? [] : allowed.map((item) => item.call),
  };
}

export function inspectRuntimeCall(call, { allowedToolIds = [], policy, orders } = {}) {
  const tool = tools.find((item) => item.name === call?.name);
  if (!tool) {
    return {
      decision: "BLOCK",
      execution: "NOT_EXECUTED",
      reasons: ["Tool is not registered in AgentGuard's tool catalog."],
      call,
    };
  }

  if (!allowedToolIds.includes(tool.id)) {
    return {
      decision: "BLOCK",
      execution: "NOT_EXECUTED",
      reasons: [`${tool.name} is not enabled for this agent.`],
      call,
    };
  }

  if (!tool.sideEffect) {
    return {
      decision: "ALLOW",
      execution: "PASS_THROUGH",
      reasons: [],
      call,
    };
  }

  if (tool.name === "issue_refund") {
    const guard = checkRefundCall(call, { policy, orders });
    return {
      ...guard,
      execution: guard.decision === "ALLOW" ? "PASS_THROUGH" : "NOT_EXECUTED",
      call,
    };
  }

  return {
    decision: "BLOCK",
    execution: "NOT_EXECUTED",
    reasons: [`${tool.name} has a side effect but no runtime policy is configured for it.`],
    call,
  };
}

export function inspectRuntimeCalls(toolCalls, options = {}) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const inspections = calls.map((call) => inspectRuntimeCall(call, options));
  return summarizeInspections(inspections);
}

export function enforceExecutionContext(inspections, context) {
  return inspections.map((inspection) => {
    const tool = tools.find((item) => item.name === inspection.call?.name);
    if (inspection.decision !== "ALLOW" || !tool?.sideEffect || hasSensitiveExecutionContext(context)) {
      return inspection;
    }
    return {
      ...inspection,
      decision: "BLOCK",
      execution: "NOT_EXECUTED",
      reasons: [
        ...inspection.reasons,
        "Sensitive actions require actorId, orderId, and a current issuedAt execution context.",
      ],
    };
  });
}

export function finalizeRuntimeCalls(inspections) {
  return summarizeInspections(inspections);
}

export function buildApprovalPayload({
  approvalId = createApprovalId(),
  agentId,
  workspaceId,
  requestId,
  call,
  context,
  expiresAt,
  policyVersion = "runtime-v1",
}) {
  return {
    version: 1,
    approvalId,
    agentId,
    workspaceId,
    requestId,
    tool: call?.name ?? null,
    arguments: call?.arguments ?? {},
    context: context ?? null,
    policyVersion,
    expiresAt,
  };
}

export function signApproval(payload, runtimeToken) {
  return createHmac("sha256", runtimeToken)
    .update(stableStringify(payload))
    .digest("base64url");
}

export function buildExecutionReceipt(approval, runtimeToken, consumedAt = new Date().toISOString()) {
  const payload = approval?.payload;
  if (!payload?.approvalId || !payload.agentId || !payload.workspaceId || !payload.requestId || !payload.tool) {
    throw new TypeError("A complete runtime approval is required to issue an execution receipt.");
  }
  const receiptPayload = {
    version: 1,
    approvalId: payload.approvalId,
    agentId: payload.agentId,
    workspaceId: payload.workspaceId,
    requestId: payload.requestId,
    tool: payload.tool,
    arguments: payload.arguments ?? {},
    context: payload.context ?? null,
    consumedAt,
    expiresAt: payload.expiresAt,
  };
  return { payload: receiptPayload, signature: signApproval(receiptPayload, runtimeToken) };
}

export function verifyApprovalSignature(payload, signature, runtimeToken) {
  if (typeof signature !== "string" || !signature) return false;
  const expected = signApproval(payload, runtimeToken);
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function approvalMatchesCall(payload, call) {
  return hashCanonical({ tool: payload?.tool, arguments: payload?.arguments }) ===
    hashCanonical({ tool: call?.name, arguments: call?.arguments ?? {} });
}
