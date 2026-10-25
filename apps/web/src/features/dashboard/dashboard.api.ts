import { request } from "../../shared/api/client";
import type { Agent, Overview } from "../../shared/types/api";

export async function getDashboard(): Promise<{ overview: Overview; agents: Agent[] }> {
  const [overviewResponse, agentsResponse] = await Promise.all([
    request("/api/overview"),
    request("/api/agents"),
  ]);
  return {
    overview: await overviewResponse.json(),
    agents: (await agentsResponse.json()).agents,
  };
}
