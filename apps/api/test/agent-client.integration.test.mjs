import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { requestAgentInput, requestAgentScenario, testAgentConnection } from "../src/features/agents/agent-client.mjs";

test("agent client sends the contract and normalizes tool calls over a pinned connection", async (t) => {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const payload = JSON.parse(body);
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          text: payload.metadata.scenarioId,
          tool_calls: [
            {
              name: "issue_refund",
              arguments: JSON.stringify({ order_id: "TEST-001", amount: 40 }),
            },
          ],
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const result = await requestAgentScenario(
    {
      endpoint: `http://127.0.0.1:${address.port}/chat`,
      encryptedApiKey: null,
    },
    { id: "valid_refund", orderId: "TEST-001", amount: 40, expected: "allow" },
  );

  assert.equal(result.source, "customer_endpoint");
  assert.equal(result.assistantText, "valid_refund");
  assert.deepEqual(result.toolCalls, [
    { name: "issue_refund", arguments: { order_id: "TEST-001", amount: 40 } },
  ]);
});

test("agent connection check uses a neutral request and does not execute tools", async (t) => {
  let received;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      received = JSON.parse(body);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ text: "connection ok" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const result = await testAgentConnection({
    endpoint: `http://127.0.0.1:${address.port}/health`,
    encryptedApiKey: null,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "reachable");
  assert.equal(result.responseFormat, "json");
  assert.equal(received.metadata.type, "connection_test");
  assert.equal(received.metadata.source, "agentguard");
  assert.equal(received.tool_calls, undefined);
});

test("runtime input forwarding preserves customer metadata and normalizes tool calls", async (t) => {
  let received;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received = JSON.parse(body);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        assistant_text: "I found the order.",
        tool_calls: [{ name: "get_order", arguments: { order_id: "ORDER-42" } }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const result = await requestAgentInput(
    { endpoint: `http://127.0.0.1:${address.port}/chat`, encryptedApiKey: null },
    { input: "Where is order ORDER-42?", metadata: { sessionId: "session-1" } },
  );

  assert.equal(received.input, "Where is order ORDER-42?");
  assert.equal(received.metadata.sessionId, "session-1");
  assert.equal(result.assistantText, "I found the order.");
  assert.deepEqual(result.toolCalls, [{ name: "get_order", arguments: { order_id: "ORDER-42" } }]);
});

test("agent connection pins the synthetic DNS answer used during validation", async (t) => {
  let remoteAddress;
  const server = http.createServer((request, response) => {
    remoteAddress = request.socket.remoteAddress;
    request.resume();
    request.on("end", () => response.end(JSON.stringify({ text: "pinned" })));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const result = await testAgentConnection(
    {
      endpoint: `http://synthetic-agent.example.test:${server.address().port}/health`,
      encryptedApiKey: null,
    },
    {
      lookup: async (hostname, options) => {
        assert.equal(hostname, "synthetic-agent.example.test");
        assert.deepEqual(options, { all: true, verbatim: true });
        return [{ address: "127.0.0.1", family: 4 }];
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(remoteAddress, "127.0.0.1");
});

test("scan scenario requests use the validated synthetic DNS answer", async (t) => {
  let remoteAddress;
  let lookupCalls = 0;
  const server = http.createServer((request, response) => {
    remoteAddress = request.socket.remoteAddress;
    request.resume();
    request.on("end", () => response.end(JSON.stringify({ text: "scan response", tool_calls: [] })));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const result = await requestAgentScenario(
    {
      endpoint: `http://synthetic-scan-agent.example.test:${server.address().port}/chat`,
      encryptedApiKey: null,
    },
    { id: "amount_limit", orderId: "TEST-001", amount: 100, expected: "block" },
    {
      lookup: async (hostname, options) => {
        lookupCalls += 1;
        assert.equal(hostname, "synthetic-scan-agent.example.test");
        assert.deepEqual(options, { all: true, verbatim: true });
        return [{ address: "127.0.0.1", family: 4 }];
      },
    },
  );

  assert.equal(result.source, "customer_endpoint");
  assert.equal(remoteAddress, "127.0.0.1");
  assert.equal(lookupCalls, 1, "the request must not trigger a second DNS resolution");
});

test("Agent connection checks do not follow upstream redirects", async (t) => {
  let redirectTargetHits = 0;
  const target = http.createServer((_request, response) => {
    redirectTargetHits += 1;
    response.end(JSON.stringify({ text: "must not be reached" }));
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));

  const redirector = http.createServer((_request, response) => {
    response.writeHead(302, {
      Location: `http://127.0.0.1:${target.address().port}/private`,
    }).end();
  });
  await new Promise((resolve) => redirector.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await Promise.all([
      new Promise((resolve, reject) => redirector.close((error) => error ? reject(error) : resolve())),
      new Promise((resolve, reject) => target.close((error) => error ? reject(error) : resolve())),
    ]);
  });

  const result = await testAgentConnection({
    endpoint: `http://127.0.0.1:${redirector.address().port}/health`,
    encryptedApiKey: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "rejected");
  assert.equal(result.httpStatus, 302);
  assert.equal(redirectTargetHits, 0);
});
