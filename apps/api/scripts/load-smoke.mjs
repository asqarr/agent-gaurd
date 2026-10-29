import http from "node:http";
import https from "node:https";

function positiveInteger(name, fallback, max = 10000) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}.`);
  }
  return value;
}

function cookiesFrom(response) {
  const values = response.headers.getSetCookie?.();
  if (values?.length) return values;
  const combined = response.headers.get("set-cookie");
  return combined ? combined.split(/,\s*(?=[^;,]+=)/) : [];
}

async function authenticate(baseUrl) {
  const email = process.env.LOAD_TEST_EMAIL;
  const password = process.env.LOAD_TEST_PASSWORD;
  if (!email && !password) return "";
  if (!email || !password) {
    throw new Error("Set both LOAD_TEST_EMAIL and LOAD_TEST_PASSWORD, or neither.");
  }
  const response = await fetch(new URL("/api/auth/login", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Load-test login failed with HTTP ${response.status}.`);
  return cookiesFrom(response).map((value) => value.split(";", 1)[0]).join("; ");
}

function request(url, { agent, cookie, timeoutMs }) {
  const transport = url.protocol === "https:" ? https : http;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const req = transport.request(url, {
      method: "GET",
      agent,
      headers: cookie ? { Cookie: cookie } : {},
      timeout: timeoutMs,
    }, (res) => {
      let bytes = 0;
      res.on("data", (chunk) => { bytes += chunk.length; });
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        durationMs: Date.now() - startedAt,
        bytes,
      }));
    });
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", (error) => resolve({
      status: 0,
      durationMs: Date.now() - startedAt,
      error: error.code ?? error.message,
    }));
    req.end();
  });
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

const baseUrl = process.env.LOAD_TEST_URL ?? "http://127.0.0.1:4100";
const path = process.env.LOAD_TEST_PATH ?? "/api/health";
const requests = positiveInteger("LOAD_TEST_REQUESTS", 100, 100000);
const concurrency = positiveInteger("LOAD_TEST_CONCURRENCY", Math.min(requests, 1000), 1000);
const timeoutMs = positiveInteger("LOAD_TEST_TIMEOUT_MS", 30000, 120000);
const target = new URL(path, baseUrl);
if (!["http:", "https:"].includes(target.protocol)) throw new Error("LOAD_TEST_URL must use HTTP or HTTPS.");
if (target.pathname === "/api/activity/stream") throw new Error("The load smoke tool targets finite responses, not SSE streams.");

const cookie = await authenticate(baseUrl);
const agent = target.protocol === "https:"
  ? new https.Agent({ keepAlive: true, maxSockets: concurrency, maxTotalSockets: concurrency })
  : new http.Agent({ keepAlive: true, maxSockets: concurrency, maxTotalSockets: concurrency });
const results = [];
const startedAt = Date.now();
for (let offset = 0; offset < requests; offset += concurrency) {
  const count = Math.min(concurrency, requests - offset);
  results.push(...await Promise.all(Array.from({ length: count }, () =>
    request(target, { agent, cookie, timeoutMs }),
  )));
}
agent.destroy();

const successful = results.filter((result) => result.status >= 200 && result.status < 300);
const failed = results.filter((result) => result.status < 200 || result.status >= 300);
const latencies = successful.map((result) => result.durationMs).sort((a, b) => a - b);
const statusCounts = failed.reduce((counts, result) => {
  const key = String(result.status || result.error || "network_error");
  counts[key] = (counts[key] ?? 0) + 1;
  return counts;
}, {});

process.stdout.write(`${JSON.stringify({
  target: `${target.origin}${target.pathname}`,
  requests,
  concurrency,
  successful: successful.length,
  failed: failed.length,
  failedByStatus: statusCounts,
  latencyMs: {
    p50: percentile(latencies, 0.50),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
  },
  wallTimeMs: Date.now() - startedAt,
})}\n`);
if (failed.length) process.exitCode = 1;
