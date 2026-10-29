import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceActivityRecord } from "../src/features/activity/activity-domain.mjs";

test("activity records keep runtime summaries and discard request secrets", () => {
  const event = createWorkspaceActivityRecord({
    eventType: "runtime.error",
    agentId: "agent-1",
    agentName: "Storefront\nAgent",
    resourceType: "runtime_event",
    resourceId: "request-1",
    metadata: {
      stage: "customer_endpoint",
      latencyMs: 42,
      traceId: "trace-1",
      apiKey: "private-key",
      prompt: "private user content",
    },
  });

  assert.equal(event.agentName, "Storefront Agent");
  assert.deepEqual(event.metadata, {
    stage: "customer_endpoint",
    latencyMs: 42,
    traceId: "trace-1",
  });
  assert.doesNotMatch(JSON.stringify(event), /private-key|private user content/);
  assert.match(event.explanation, /Sensitive upstream details are not included/);
});

test("activity records reject unknown event types and omit malformed identifiers", () => {
  assert.throws(() => createWorkspaceActivityRecord({ eventType: "user.password" }), /Unsupported/);

  const event = createWorkspaceActivityRecord({
    eventType: "scan.completed",
    agentId: "../other-workspace",
    agentName: "Agent",
    resourceType: "user",
    resourceId: "secret/token",
    metadata: { score: 95, password: "must-not-persist" },
  });
  assert.equal(event.agentId, null);
  assert.equal(event.resourceType, null);
  assert.equal(event.resourceId, null);
  assert.deepEqual(event.metadata, { score: 95 });
});
