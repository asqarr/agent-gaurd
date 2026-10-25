import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import { PassThrough } from "node:stream";
import test from "node:test";
process.env.NODE_ENV = "test";
// These tests use only synthetic DNS and mocked TLS transport; no network request leaves the process.
process.env.ALLOW_PRIVATE_AGENT_ENDPOINTS = "true";
const { assertHttpsIncidentWebhookUrl, incidentPayload, incidentTitle, retryDelayMs, signIncidentPayload, deliverIncidentWebhook } =
  await import("../src/features/incidents/domain.mjs");

test("incident webhook signatures are deterministic and scoped to the body", () => {
  const first = signIncidentPayload("secret", "payload");
  assert.equal(first, signIncidentPayload("secret", "payload"));
  assert.notEqual(first, signIncidentPayload("secret", "changed"));
  assert.match(first, /^sha256=[a-f0-9]{64}$/);
});

test("incident payloads are structured without exposing credentials", () => {
  const payload = incidentPayload({
    id: "incident-1",
    eventType: "sentinel_drift",
    severity: "critical",
    title: incidentTitle("sentinel_drift", "Returns Agent"),
    message: "Model changed.",
    agentId: "agent-1",
    agentName: "Returns Agent",
    resourceType: "sentinel_event",
    resourceId: "event-1",
    metadata: { field: "model" },
    createdAt: "2026-10-08T00:00:00.000Z",
  });
  assert.equal(payload.event, "sentinel_drift");
  assert.equal(payload.agent.name, "Returns Agent");
  assert.equal("secret" in payload, false);
  assert.equal("url" in payload, false);
});

test("incident retries back off and cap at one hour", () => {
  assert.equal(retryDelayMs(1), 1000);
  assert.equal(retryDelayMs(3), 4000);
  assert.equal(retryDelayMs(20), 3600000);
});

test("webhook delivery rejects redirects to a private URL without making a second request", async (t) => {
  const requests = [];
  t.mock.method(https, "request", (options, callback) => {
    requests.push(options);
    const request = new EventEmitter();
    request.end = () => {
      const response = new PassThrough();
      response.statusCode = 307;
      response.headers = { location: "http://127.0.0.1:9/private-action" };
      callback(response);
      response.end();
    };
    request.destroy = (error) => request.emit("error", error);
    return request;
  });

  await assert.rejects(
    () => deliverIncidentWebhook({
      url: "https://synthetic-webhook.example.test/events",
      secret: "local-test-secret-only",
      notification: {
        id: "incident-local-test",
        eventType: "runtime_block",
        severity: "high",
        title: "Synthetic redirect regression",
        message: "Synthetic test payload",
        createdAt: new Date().toISOString(),
      },
      webhookId: "delivery-local-test",
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    }),
    /Webhook redirects are not followed/,
  );
  assert.equal(requests.length, 1, "the HTTP client must not retry at the redirect target");
  assert.equal(requests[0].protocol, "https:");
});

test("webhook endpoints require HTTPS before any DNS lookup or request", async () => {
  let lookupCalls = 0;
  await assert.rejects(
    () => deliverIncidentWebhook({
      url: "http://8.8.8.8/events",
      secret: "local-test-secret-only",
      webhookId: "delivery-http-rejected",
      notification: {
        id: "incident-http-rejected",
        eventType: "runtime_block",
        severity: "high",
        title: "HTTP rejection test",
        message: "Synthetic payload",
        createdAt: new Date().toISOString(),
      },
      lookup: async () => {
        lookupCalls += 1;
        return [{ address: "8.8.8.8", family: 4 }];
      },
    }),
    (error) => error.code === "UNSAFE_AGENT_ENDPOINT" && /HTTPS/.test(error.message),
  );
  assert.throws(
    () => assertHttpsIncidentWebhookUrl("http://8.8.8.8/events"),
    (error) => error.code === "UNSAFE_AGENT_ENDPOINT",
  );
  assert.equal(lookupCalls, 0);
});

test("webhook delivery connects with the DNS address checked by the guard", async (t) => {
  const requests = [];
  let lookupCalls = 0;
  t.mock.method(https, "request", (options, callback) => {
    requests.push(options);
    const request = new EventEmitter();
    request.end = () => {
      const response = new PassThrough();
      response.statusCode = 204;
      callback(response);
      response.end();
    };
    request.destroy = (error) => request.emit("error", error);
    return request;
  });

  const result = await deliverIncidentWebhook({
    url: "https://synthetic-webhook.example.test/events",
    secret: "local-test-secret-only",
    notification: {
      id: "incident-dns-pin-test",
      eventType: "runtime_block",
      severity: "high",
      title: "Synthetic DNS pin test",
      message: "No production data",
      createdAt: new Date().toISOString(),
    },
    webhookId: "delivery-dns-pin-test",
    lookup: async (hostname, options) => {
      lookupCalls += 1;
      assert.equal(hostname, "synthetic-webhook.example.test");
      assert.deepEqual(options, { all: true, verbatim: true });
      return [{ address: "8.8.8.8", family: 4 }];
    },
  });

  assert.deepEqual(result, { status: 204 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].protocol, "https:");
  requests[0].lookup("synthetic-webhook.example.test", { all: true }, (error, addresses) => {
    assert.equal(error, null);
    assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]);
  });
  assert.equal(lookupCalls, 1, "the pinned request must not resolve the hostname again");
});
