import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.ALLOW_PRIVATE_AGENT_ENDPOINTS = "false";

const { testAgentConnection, requestAgentInput, requestAgentScenario } = await import(
  "../src/features/agents/agent-client.mjs"
);
const { deliverIncidentWebhook } = await import(
  "../src/features/incidents/domain.mjs"
);

function mixedPublicAndPrivateResolver() {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async lookup(hostname, options) {
      calls += 1;
      assert.equal(hostname, "mixed-consumer.example.test");
      assert.deepEqual(options, { all: true, verbatim: true });
      return [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ];
    },
  };
}

const endpoint = "https://mixed-consumer.example.test/endpoint";

test("connection checks fail closed when any DNS answer is private", async () => {
  const resolver = mixedPublicAndPrivateResolver();
  const result = await testAgentConnection(
    { endpoint, encryptedApiKey: null },
    { lookup: resolver.lookup },
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, "unsafe_endpoint");
  assert.equal(resolver.calls, 1);
});

test("runtime forwarding fails closed when any DNS answer is private", async () => {
  const resolver = mixedPublicAndPrivateResolver();
  await assert.rejects(
    () => requestAgentInput(
      { endpoint, encryptedApiKey: null },
      { input: "synthetic request", lookup: resolver.lookup },
    ),
    (error) => error.code === "UNSAFE_AGENT_ENDPOINT",
  );
  assert.equal(resolver.calls, 1);
});

test("scan requests fail closed when any DNS answer is private", async () => {
  const resolver = mixedPublicAndPrivateResolver();
  await assert.rejects(
    () => requestAgentScenario(
      { endpoint, encryptedApiKey: null },
      { id: "amount_limit", orderId: "SYNTHETIC-001", amount: 100, expected: "block" },
      { lookup: resolver.lookup },
    ),
    (error) => error.code === "UNSAFE_AGENT_ENDPOINT",
  );
  assert.equal(resolver.calls, 1);
});

test("webhook deliveries fail closed when any DNS answer is private", async () => {
  const resolver = mixedPublicAndPrivateResolver();
  await assert.rejects(
    () => deliverIncidentWebhook({
      url: endpoint,
      secret: "local-test-secret-only",
      webhookId: "delivery-synthetic-001",
      notification: {
        id: "incident-synthetic-001",
        eventType: "runtime_block",
        severity: "high",
        title: "Synthetic test",
        message: "No customer data",
        createdAt: new Date().toISOString(),
      },
      lookup: resolver.lookup,
    }),
    (error) => error.code === "UNSAFE_AGENT_ENDPOINT",
  );
  assert.equal(resolver.calls, 1);
});
