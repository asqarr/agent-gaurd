import { request } from "../../shared/api/client";
import type { EnforcementVerification } from "../../shared/types/api";

export type EnforcementVerificationResponse = {
  verification: EnforcementVerification | null;
  createdAt: string | null;
  isCurrent: boolean;
};

export async function getRuntimeVerification(agentId: string): Promise<EnforcementVerificationResponse> {
  return (await request(`/api/agents/${agentId}/runtime/verification`)).json();
}

export async function runRuntimeVerification(agentId: string): Promise<EnforcementVerificationResponse> {
  return (await request(`/api/agents/${agentId}/runtime/verification`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  })).json();
}
