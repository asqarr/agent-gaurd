import { request } from "../../shared/api/client";
import type { AttackPath, ContractComparison, Scan, SecurityContract, Tool } from "../../shared/types/api";

export async function getSecurityContract(agentId: string): Promise<{ contract: SecurityContract; tools: Tool[]; policy: { maxAmount: number; maxAgeDays: number; currency: string } }> {
  const response = await request(`/api/agents/${agentId}/security-contract`);
  return response.json();
}

export async function updateSecurityContract(agentId: string, contract: Pick<SecurityContract, "allowedToolIds" | "maxRefundAmount" | "maxOrderAgeDays" | "notes">): Promise<{ contract: SecurityContract; verificationScan: Scan | null; verificationError: { code: string; message: string } | null }> {
  const response = await request(`/api/agents/${agentId}/security-contract`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(contract),
  });
  return response.json();
}

export async function getSecurityContractComparison(agentId: string): Promise<ContractComparison> {
  const response = await request(`/api/agents/${agentId}/security-contract/comparison`);
  return (await response.json()).comparison;
}

export async function getAttackPaths(): Promise<{ paths: AttackPath[]; entitlements: { scenarioLimit: number; fullScenarioSuite: boolean } }> {
  const response = await request("/api/attack-paths");
  return response.json();
}

export async function replayAttackPath(agentId: string, pathId: string): Promise<{ scan: Scan; path: AttackPath }> {
  const response = await request(`/api/agents/${agentId}/attack-paths/${pathId}/replay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  return response.json();
}
