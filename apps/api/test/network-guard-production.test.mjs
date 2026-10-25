import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "production";
process.env.WEB_ORIGIN = "https://app.example.test";
process.env.JWT_SECRET = "synthetic-test-jwt-secret-no-production-use-2026";
process.env.AGENT_SECRET = "synthetic-test-agent-secret-no-production-use-2026";
process.env.ALLOW_PRIVATE_AGENT_ENDPOINTS = "true";

const { assertSafeAgentEndpoint } = await import(
  "../src/features/agents/network-guard.mjs"
);

test("production rejects cleartext Agent endpoints even when private-endpoint opt-in is set", async () => {
  await assert.rejects(
    () => assertSafeAgentEndpoint("http://8.8.8.8/chat"),
    (error) => error.code === "UNSAFE_AGENT_ENDPOINT" && /HTTPS in production/.test(error.message),
  );

  const endpoint = await assertSafeAgentEndpoint("https://8.8.8.8/chat");
  assert.equal(endpoint.protocol, "https:");
});
