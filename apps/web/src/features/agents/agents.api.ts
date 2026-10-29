import { request } from "../../shared/api/client";
import type { Agent, AgentConnection, RuntimeEvent, RuntimeHealth } from "../../shared/types/api";

export async function getAgents(): Promise<Agent[]> {
  return (await request("/api/agents")).json().then((body) => body.agents);
}

export async function createAgent(input: {
  name: string;
  endpoint: string;
  apiKey?: string;
  environment?: string;
  provider?: string;
  model?: string;
  toolIds?: string[];
}): Promise<Agent> {
  return (
    await request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  ).json().then((body) => body.agent);
}

export async function updateAgent(input: {
  id: string;
  name: string;
  endpoint: string;
  apiKey?: string;
  clearApiKey?: boolean;
  environment: string;
  provider: string;
  model: string;
  toolIds: string[];
}): Promise<Agent> {
  return (
    await request(`/api/agents/${input.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  ).json().then((body) => body.agent);
}

export async function testAgentConnection(agentId: string): Promise<{ connection: AgentConnection; agent: Agent }> {
  return (
    await request(`/api/agents/${agentId}/test-connection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
  ).json();
}

export async function deleteAgent(agentId: string): Promise<void> {
  await request(`/api/agents/${agentId}`, { method: "DELETE" });
}

export async function quarantineAgent(agentId: string, reason: string): Promise<Agent> {
  return (
    await request(`/api/agents/${agentId}/quarantine`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    })
  ).json().then((body) => body.agent);
}

export async function restoreAgent(agentId: string): Promise<Agent> {
  return (
    await request(`/api/agents/${agentId}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
  ).json().then((body) => body.agent);
}

export async function enableRuntimeFirewall(agentId: string): Promise<{
  agent: Agent;
  token: string;
  gateway: { method: string; path: string };
}> {
  return (
    await request(`/api/agents/${agentId}/runtime/enable`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
  ).json();
}

export async function disableRuntimeFirewall(agentId: string): Promise<Agent> {
  return (
    await request(`/api/agents/${agentId}/runtime/disable`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
  ).json().then((body) => body.agent);
}

export async function getRuntimeEvents(agentId: string): Promise<RuntimeEvent[]> {
  return (await request(`/api/agents/${agentId}/runtime/events`)).json().then((body) => body.events);
}

export async function getRuntimeEvent(agentId: string, requestId: string): Promise<RuntimeEvent> {
  return (await request(`/api/agents/${encodeURIComponent(agentId)}/runtime/events/${encodeURIComponent(requestId)}`))
    .json()
    .then((body) => body.event);
}

export async function getRuntimeHealth(agentId: string, window: "24h" | "7d" = "24h"): Promise<RuntimeHealth> {
  return (await request(`/api/agents/${agentId}/runtime/health?window=${window}`)).json().then((body) => body.health);
}
