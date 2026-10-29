import { request } from "../../shared/api/client";
import type { AlertWebhook, AuditEvent, Incident, IncidentSummary } from "../../shared/types/api";

export async function getIncidentSummary(): Promise<IncidentSummary> {
  return request("/api/incidents/summary").then((response) => response.json());
}

export async function getIncidents(status: "open" | "resolved" | "all" = "open"): Promise<Incident[]> {
  return request(`/api/incidents?status=${status}`).then((response) => response.json()).then((body) => body.incidents);
}

export async function getIncident(incidentId: string): Promise<Incident> {
  return request(`/api/incidents/${encodeURIComponent(incidentId)}`).then((response) => response.json()).then((body) => body.incident);
}

export async function getAuditEvents(): Promise<AuditEvent[]> {
  return request("/api/audit?limit=12").then((response) => response.json()).then((body) => body.events);
}

export async function markIncidentRead(incidentId: string) {
  await request(`/api/incidents/${incidentId}/read`, { method: "POST" });
}

export async function resolveIncident(incidentId: string) {
  await request(`/api/incidents/${incidentId}/resolve`, { method: "POST" });
}

export async function getAlertWebhooks(): Promise<AlertWebhook[]> {
  return request("/api/alert-webhooks").then((response) => response.json()).then((body) => body.webhooks);
}

export async function createAlertWebhook(payload: { name: string; url: string; secret: string; eventTypes: string[] }): Promise<AlertWebhook> {
  return request("/api/alert-webhooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then((response) => response.json()).then((body) => body.webhook);
}

export async function updateAlertWebhook(webhook: AlertWebhook): Promise<AlertWebhook> {
  return request(`/api/alert-webhooks/${webhook.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: webhook.name, enabled: webhook.enabled, eventTypes: webhook.eventTypes }),
  }).then((response) => response.json()).then((body) => body.webhook);
}

export async function testAlertWebhook(webhookId: string): Promise<void> {
  await request(`/api/alert-webhooks/${webhookId}/test`, { method: "POST" });
}

export async function deleteAlertWebhook(webhookId: string): Promise<void> {
  await request(`/api/alert-webhooks/${webhookId}`, { method: "DELETE" });
}
