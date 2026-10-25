import assert from "node:assert/strict";
import test from "node:test";
process.env.NODE_ENV = "test";
process.env.ALLOW_PRIVATE_AGENT_ENDPOINTS = "false";
const { assertSafeAgentEndpoint, resolveSafeAgentEndpoint, createPinnedLookup } = await import(
  "../src/features/agents/network-guard.mjs"
);

test("rejects localhost and private IPv4 agent endpoints", async () => {
  await assert.rejects(
    () => assertSafeAgentEndpoint("http://127.0.0.1:9000/chat"),
    /Private and local/,
  );
  await assert.rejects(
    () => assertSafeAgentEndpoint("http://10.0.0.8/chat"),
    /Private and local/,
  );
  await assert.rejects(() => assertSafeAgentEndpoint("http://172.16.4.2/chat"), /Private and local/);
  await assert.rejects(() => assertSafeAgentEndpoint("http://192.168.1.20/chat"), /Private and local/);
});

test("rejects loopback IPv6 and URLs containing credentials", async () => {
  await assert.rejects(
    () => assertSafeAgentEndpoint("http://[::1]:9000/chat"),
    /Private and local/,
  );
  await assert.rejects(
    () => assertSafeAgentEndpoint("https://user:pass@example.com/chat"),
    /credentials/,
  );
});

test("rejects non-HTTP agent protocols", async () => {
  await assert.rejects(
    () => assertSafeAgentEndpoint("file:///etc/passwd"),
    /HTTP or HTTPS/,
  );
});

test("accepts public IPv4 and IPv6 literals and preserves the URL return contract", async () => {
  const ipv4 = await assertSafeAgentEndpoint("https://8.8.8.8/agent");
  const ipv6 = await assertSafeAgentEndpoint("https://[2606:4700:4700::1111]/agent");
  assert.ok(ipv4 instanceof URL);
  assert.ok(ipv6 instanceof URL);
  assert.equal(ipv4.hostname, "8.8.8.8");
  assert.equal(ipv6.hostname, "[2606:4700:4700::1111]");
});

test("preserves the unsafe-endpoint error code for malformed or unresolved URLs", async () => {
  await assert.rejects(
    () => assertSafeAgentEndpoint("file:///etc/passwd"),
    (error) => error.code === "UNSAFE_AGENT_ENDPOINT",
  );
  await assert.rejects(
    () =>
      resolveSafeAgentEndpoint("https://unresolvable.example.test/", {
        lookup: async () => {
          throw new Error("synthetic resolver failure");
        },
      }),
    (error) =>
      error.code === "UNSAFE_AGENT_ENDPOINT" &&
      /could not be resolved/.test(error.message),
  );
});

test("rejects reserved IPv4 ranges and alternate numeric IP spellings", async () => {
  for (const address of [
    "0.2.3.4",
    "100.64.0.1",
    "169.254.1.2",
    "192.0.2.10",
    "198.18.1.2",
    "198.51.100.10",
    "203.0.113.10",
    "224.0.0.1",
    "240.0.0.1",
  ]) {
    await assert.rejects(
      () => assertSafeAgentEndpoint(`http://${address}/`),
      /Private and local/,
      address,
    );
  }
  for (const address of ["2130706433", "0x7f000001", "0177.0.0.1", "127.1"]) {
    await assert.rejects(
      () => assertSafeAgentEndpoint(`http://${address}/`),
      /Private and local/,
      address,
    );
  }
});

test("rejects non-global, reserved, and IPv4-mapped IPv6 addresses", async () => {
  for (const address of [
    "::",
    "::1",
    "::ffff:8.8.8.8",
    "::ffff:c0a8:108",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "2001::1",
    "2002::1",
    "3ffe::1",
    "3fff::1",
  ]) {
    await assert.rejects(
      () => assertSafeAgentEndpoint(`http://[${address}]/`),
      /Private and local/,
      address,
    );
  }
});

test("rejects a hostname when any DNS answer is non-public", async () => {
  let lookupCalls = 0;
  await assert.rejects(
    () =>
      resolveSafeAgentEndpoint("https://mixed.example.test/hook", {
        lookup: async (hostname, options) => {
          lookupCalls += 1;
          assert.equal(hostname, "mixed.example.test");
          assert.deepEqual(options, { all: true, verbatim: true });
          return [
            { address: "8.8.8.8", family: 4 },
            { address: "::ffff:192.168.1.8", family: 6 },
          ];
        },
      }),
    /Private and local/,
  );
  await assert.rejects(
    () =>
      resolveSafeAgentEndpoint("https://mixed.example.test/hook", {
        lookup: async () => [
          { address: "8.8.8.8", family: 4 },
          { address: "::ffff:192.168.1.8", family: 6 },
        ],
      }),
    (error) => error.code === "UNSAFE_AGENT_ENDPOINT",
  );
  assert.equal(lookupCalls, 1);
});

test("pins the selected address after validating all DNS answers", async () => {
  const result = await resolveSafeAgentEndpoint("https://agent.example.test/api", {
    lookup: async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "1.1.1.1", family: 4 },
    ],
  });
  assert.equal(result.address, "8.8.8.8");
  assert.equal(result.family, 4);
  assert.equal(result.endpoint.hostname, "agent.example.test");
});

test("pinned DNS callback returns only the checked address for both Node lookup modes", () => {
  const lookup = createPinnedLookup("8.8.8.8", 4);
  lookup("agent.example.test", {}, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, "8.8.8.8");
    assert.equal(family, 4);
  });
  lookup("agent.example.test", { all: true }, (error, addresses) => {
    assert.equal(error, null);
    assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]);
  });
  assert.throws(() => createPinnedLookup("not-an-ip", 4), /previously resolved/);
});
