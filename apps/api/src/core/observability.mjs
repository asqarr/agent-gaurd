const startedAt = Date.now();
const metrics = {
  requests: 0,
  errors: 0,
  totalLatencyMs: 0,
  statusCounts: new Map(),
  routeCounts: new Map(),
};

function routeName(req) {
  return req.route?.path ? `${req.method} ${req.baseUrl ?? ""}${req.route.path}` : `${req.method} ${req.path}`;
}

export function observeRequest(req, res) {
  const requestStartedAt = Date.now();
  metrics.requests += 1;
  res.on("finish", () => {
    const status = String(res.statusCode);
    const route = routeName(req);
    metrics.totalLatencyMs += Date.now() - requestStartedAt;
    if (res.statusCode >= 500) metrics.errors += 1;
    metrics.statusCounts.set(status, (metrics.statusCounts.get(status) ?? 0) + 1);
    metrics.routeCounts.set(route, (metrics.routeCounts.get(route) ?? 0) + 1);
  });
}

export function getRequestMetrics() {
  const requests = metrics.requests;
  return {
    startedAt: new Date(startedAt).toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    requests,
    errors: metrics.errors,
    fiveXxRate: requests ? Number((metrics.errors / requests).toFixed(4)) : 0,
    averageLatencyMs: requests ? Math.round(metrics.totalLatencyMs / requests) : 0,
    statusCounts: Object.fromEntries(metrics.statusCounts),
    topRoutes: [...metrics.routeCounts.entries()]
      .sort(([, left], [, right]) => right - left)
      .slice(0, 20)
      .map(([route, count]) => ({ route, count })),
  };
}
