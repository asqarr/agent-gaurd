import assert from "node:assert/strict";
import test from "node:test";
import { createRateLimiter } from "../src/core/rate-limit.mjs";

function responseDouble() {
  return {
    headers: new Map(),
    statusCode: 200,
    setHeader(name, value) {
      this.headers.set(name, value);
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

test("rate limiter exposes quota headers and blocks after the configured maximum", () => {
  const limiter = createRateLimiter({
    windowMs: 60_000,
    max: 2,
    keyFn: () => "integration-client",
  });
  const req = { requestId: "request-rate-limit", ip: "127.0.0.1" };
  let nextCalls = 0;

  const first = responseDouble();
  limiter(req, first, () => { nextCalls += 1; });
  const second = responseDouble();
  limiter(req, second, () => { nextCalls += 1; });
  const blocked = responseDouble();
  limiter(req, blocked, () => { nextCalls += 1; });

  assert.equal(nextCalls, 2);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.payload.requestId, req.requestId);
  assert.equal(blocked.headers.get("RateLimit-Limit"), "2");
  assert.equal(blocked.headers.get("RateLimit-Remaining"), "0");
  assert.ok(Number(blocked.headers.get("Retry-After")) >= 1);
});
