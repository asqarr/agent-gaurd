import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { createPinnedLookup, resolveSafeAgentEndpoint } from "../agents/network-guard.mjs";

export const incidentEventTypes = Object.freeze([
  "sentinel_drift",
  "agent_quarantined",
  "scan_finding",
  "scan_failed",
  "runtime_block",
]);

export const incidentSeverities = Object.freeze(["info", "low", "medium", "high", "critical"]);

export function incidentTitle(eventType, agentName = "Agent") {
  switch (eventType) {
    case "sentinel_drift": return `${agentName} configuration drift detected`;
    case "agent_quarantined": return `${agentName} was quarantined`;
    case "scan_finding": return `${agentName} security findings need review`;
    case "scan_failed": return `${agentName} security scan failed`;
    case "runtime_block": return `${agentName} blocked an unsafe runtime action`;
    default: return `${agentName} security event`;
  }
}

export function incidentPayload(notification) {
  return {
    schemaVersion: 1,
    deliveryId: `delivery-${randomUUID()}`,
    event: notification.eventType,
    severity: notification.severity,
    id: notification.id,
    title: notification.title,
    message: notification.message,
    agent: notification.agentId
      ? { id: notification.agentId, name: notification.agentName ?? null }
      : null,
    resource: notification.resourceType
      ? { type: notification.resourceType, id: notification.resourceId ?? null }
      : null,
    metadata: notification.metadata ?? {},
    createdAt: notification.createdAt,
  };
}

export function signIncidentPayload(secret, body) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function retryDelayMs(attempts) {
  return Math.min(60 * 60 * 1000, 1000 * 2 ** Math.max(0, attempts - 1));
}

export function assertHttpsIncidentWebhookUrl(rawUrl) {
  let endpoint;
  try {
    endpoint = new URL(rawUrl);
  } catch {
    const error = new Error("Webhook URL must be a valid public HTTPS URL.");
    error.code = "UNSAFE_AGENT_ENDPOINT";
    throw error;
  }
  if (endpoint.protocol !== "https:") {
    const error = new Error("Webhook URL must use HTTPS.");
    error.code = "UNSAFE_AGENT_ENDPOINT";
    throw error;
  }
  return endpoint;
}

export async function deliverIncidentWebhook({ url, secret, notification, webhookId, lookup }) {
  assertHttpsIncidentWebhookUrl(url);
  const resolved = await resolveSafeAgentEndpoint(url, { lookup });
  const payload = incidentPayload(notification);
  const body = JSON.stringify(payload);
  const { endpoint, address, family } = resolved;
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, "");
  const transport = endpoint.protocol === "https:" ? https : http;
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "User-Agent": "AgentGuard-Incident-Webhook/1.0",
    "X-AgentGuard-Event": notification.eventType,
    "X-AgentGuard-Delivery": webhookId,
    "X-AgentGuard-Signature": signIncidentPayload(secret, body),
    Host: endpoint.host,
  };

  // The selected DNS answer is pinned for the connection. Node's fetch follows
  // redirects by default and would also resolve the hostname again; this
  // explicit client does neither.
  const status = await new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let request;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    try {
      request = transport.request(
        {
          protocol: endpoint.protocol,
          hostname,
          port: endpoint.port || undefined,
          path: `${endpoint.pathname}${endpoint.search}`,
          method: "POST",
          headers,
          family,
          lookup: createPinnedLookup(address, family),
          ...(net.isIP(hostname) ? {} : { servername: hostname }),
        },
        (response) => {
          const responseStatus = response.statusCode ?? 0;
          response.on("error", (error) => finish(error));
          response.on("end", () => finish(null, responseStatus));
          response.resume();
        },
      );
      request.on("error", (error) => finish(error));
      timer = setTimeout(
        () => request.destroy(new Error("Webhook request timed out.")),
        10000,
      );
      timer.unref?.();
      request.end(body);
    } catch (error) {
      finish(error);
    }
  });

  if (status >= 300 && status < 400) {
    throw new Error(
      `Webhook redirects are not followed (HTTP ${status}); configure the final endpoint URL directly.`,
    );
  }
  if (status < 200 || status >= 300) {
    throw new Error(`Webhook returned HTTP ${status}.`);
  }
  return { status };
}
