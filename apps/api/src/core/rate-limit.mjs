import { config } from "./config.mjs";
import { query } from "./db.mjs";

function clientKey(req) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function createRateLimiter({ windowMs, max, keyFn = clientKey, message = "Too many requests. Try again later." }) {
  const buckets = new Map();
  let lastCleanup = 0;

  return (req, res, next) => {
    const now = Date.now();
    if (now - lastCleanup > windowMs) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
      lastCleanup = now;
    }

    const key = String(keyFn(req));
    const current = buckets.get(key);
    const bucket = current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + windowMs };
    bucket.count += 1;
    buckets.set(key, bucket);
    const remaining = Math.max(0, max - bucket.count);
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: message, requestId: req.requestId });
    }
    next();
  };
}

export function createDistributedRateLimiter({
  windowMs,
  max,
  keyFn = clientKey,
  message = "Too many requests. Try again later.",
}) {
  let cleanupAt = 0;
  return async (req, res, next) => {
    const now = Date.now();
    const windowId = Math.floor(now / windowMs);
    const resetAtMs = (windowId + 1) * windowMs;
    const bucketKey = `${String(keyFn(req))}:${windowId}`;
    try {
      const result = await query(
        `INSERT INTO api_rate_limit_buckets (bucket_key, request_count, reset_at)
         VALUES ($1, 1, to_timestamp($2 / 1000.0))
         ON CONFLICT (bucket_key) DO UPDATE
         SET request_count = api_rate_limit_buckets.request_count + 1,
             updated_at = NOW()
         RETURNING request_count, EXTRACT(EPOCH FROM reset_at) * 1000 AS reset_at_ms`,
        [bucketKey, resetAtMs],
      );
      const bucket = result.rows[0];
      const count = Number(bucket.request_count);
      const resetAt = Number(bucket.reset_at_ms) || resetAtMs;
      res.setHeader("RateLimit-Limit", String(max));
      res.setHeader("RateLimit-Remaining", String(Math.max(0, max - count)));
      res.setHeader("RateLimit-Reset", String(Math.ceil(resetAt / 1000)));
      if (count > max) {
        res.setHeader("Retry-After", String(Math.max(1, Math.ceil((resetAt - now) / 1000))));
        return res.status(429).json({ error: message, requestId: req.requestId });
      }
      if (now >= cleanupAt) {
        cleanupAt = now + Math.max(windowMs, 60_000);
        void query(
          "DELETE FROM api_rate_limit_buckets WHERE reset_at < NOW() - INTERVAL '1 hour'",
        ).catch((error) => console.error(JSON.stringify({
          level: "warn",
          event: "rate_limit_cleanup_failed",
          error: error instanceof Error ? error.message : String(error),
        })));
      }
      return next();
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "distributed_rate_limit_failed",
        requestId: req.requestId,
        error: error instanceof Error ? error.message : String(error),
      }));
      // Production fails closed so a database outage cannot silently remove
      // protection from authentication, runtime, scan, or billing routes.
      if (config.isProduction) {
        return res.status(503).json({ error: "Request protection is temporarily unavailable.", requestId: req.requestId });
      }
      return next();
    }
  };
}

export function createConfiguredRateLimiter(options) {
  return config.isProduction ? createDistributedRateLimiter(options) : createRateLimiter(options);
}
