import { request } from "../../shared/api/client";
import type { SentinelDriftEvent, SentinelOverview, SentinelState } from "../../shared/types/api";

export async function getSentinelOverview(): Promise<SentinelOverview> {
  return request("/api/sentinel")
    .then((response) => response.json());
}

export async function getSentinelState(agentId: string): Promise<SentinelState> {
  return request(`/api/agents/${agentId}/sentinel`)
    .then((response) => response.json())
    .then((body) => body.sentinel);
}

export async function getSentinelDriftEvent(eventId: string): Promise<SentinelDriftEvent> {
  return request(`/api/sentinel/events/${encodeURIComponent(eventId)}`)
    .then((response) => response.json())
    .then((body) => body.event);
}

export async function createSentinelBaseline(agentId: string): Promise<SentinelState> {
  return request(`/api/agents/${agentId}/sentinel/baseline`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  })
    .then((response) => response.json())
    .then((body) => body.sentinel);
}

export async function checkSentinel(agentId: string): Promise<SentinelState> {
  return request(`/api/agents/${agentId}/sentinel/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  })
    .then((response) => response.json())
    .then((body) => body.sentinel);
}

export async function checkAllSentinel(): Promise<SentinelOverview> {
  return request("/api/sentinel/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }).then((response) => response.json());
}

export async function updateSentinelSettings(
  agentId: string,
  settings: { enabled: boolean; autoQuarantine: boolean },
): Promise<SentinelState> {
  return request(`/api/agents/${agentId}/sentinel/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  })
    .then((response) => response.json())
    .then((body) => body.sentinel);
}
