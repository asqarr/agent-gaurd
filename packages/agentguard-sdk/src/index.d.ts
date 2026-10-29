export type ToolCall = {
  name: string;
  arguments?: Record<string, unknown>;
};

export type ExecutionContext = {
  actorId?: string;
  tenantId?: string;
  orderId?: string;
  issuedAt?: string | number;
};

export type Approval = {
  id: string;
  payload: {
    version: 1;
    approvalId: string;
    agentId: string;
    workspaceId: string;
    requestId: string;
    tool: string;
    arguments: Record<string, unknown>;
    context: ExecutionContext;
    traceContext?: { traceId: string; spanId: string; traceFlags: number };
    policyVersion: string;
    expiresAt: string;
  };
  signature: string;
  expiresAt: string;
};

export type RuntimeResponse = {
  requestId: string;
  traceId?: string;
  assistantText: string;
  tool_calls: ToolCall[];
  approved_tool_calls: Array<{ call: ToolCall; approval: Approval }>;
  blocked_tool_calls: Array<{ name: string; reasons: string[] }>;
  guard: { decision: "ALLOW" | "BLOCK"; execution: string; reasons: string[] };
};

export type AgentGuardClientOptions = {
  baseUrl: string;
  agentId: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export declare function stableStringify(value: unknown): string;
export declare function verifyApproval(approval: Approval, token: string): boolean;
export type ExecutionReceipt = {
  payload: {
    version: 1;
    approvalId: string;
    agentId: string;
    workspaceId: string;
    requestId: string;
    tool: string;
    arguments: Record<string, unknown>;
    context: ExecutionContext | null;
    consumedAt: string;
    expiresAt: string;
  };
  signature: string;
};
export declare function verifyExecutionReceipt(receipt: ExecutionReceipt, token: string, options?: { now?: number }): boolean;
export declare class AgentGuardError extends Error {
  code: string;
  status: number;
  response: unknown;
}
export declare class AgentGuardUnavailableError extends AgentGuardError {}
export declare class AgentGuardClient {
  constructor(options: AgentGuardClientOptions);
  invoke(input: {
    input: string;
    metadata?: Record<string, unknown>;
    trustedContext?: Record<string, unknown>;
    executionContext?: ExecutionContext;
  }): Promise<RuntimeResponse>;
  execute(input: {
    input: string;
    metadata?: Record<string, unknown>;
    trustedContext?: Record<string, unknown>;
    executionContext?: ExecutionContext;
    tools: Record<string, (args: Record<string, unknown>, authorization: { approvalId: string; requestId: string; context: ExecutionContext; executionReceipt: ExecutionReceipt }) => Promise<unknown> | unknown>;
  }): Promise<RuntimeResponse & { executions: unknown[] }>;
}
export declare function createAgentGuardClient(options: AgentGuardClientOptions): AgentGuardClient;
