import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.TRUST_PROXY = "2";
const { config, parseTrustProxy } = await import("../src/core/config.mjs");

test("application config passes the Compose hop count to Express as a number", () => {
  assert.equal(config.trustProxy, 2);
  assert.equal(typeof config.trustProxy, "number");
});

test("parses TRUST_PROXY numeric values as trusted proxy hop counts", () => {
  assert.equal(parseTrustProxy("0"), 0);
  assert.equal(parseTrustProxy("1"), 1);
  assert.equal(parseTrustProxy("2"), 2);
  assert.equal(parseTrustProxy(" 2 "), 2);
});

test("preserves boolean TRUST_PROXY compatibility", () => {
  assert.equal(parseTrustProxy("true"), true);
  assert.equal(parseTrustProxy("TRUE"), true);
  assert.equal(parseTrustProxy("false"), false);
  assert.equal(parseTrustProxy(""), false);
});

test("defaults missing TRUST_PROXY to false", () => {
  const previous = process.env.TRUST_PROXY;
  delete process.env.TRUST_PROXY;
  try {
    assert.equal(parseTrustProxy(), false);
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previous;
  }
});

test("rejects malformed or unsafe TRUST_PROXY configuration clearly", () => {
  for (const value of ["yes", "-1", "1.5", "1e2", "9007199254740992"]) {
    assert.throws(() => parseTrustProxy(value), /TRUST_PROXY must be/);
  }
});
