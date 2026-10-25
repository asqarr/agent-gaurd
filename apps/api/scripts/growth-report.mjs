import "dotenv/config";
import { closeDatabase, migrate, query } from "../src/core/db.mjs";

function reportDays(args) {
  const index = args.indexOf("--days");
  const raw = index >= 0 ? args[index + 1] : args.find((value) => value.startsWith("--days="))?.split("=")[1];
  const days = raw === undefined ? 30 : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 180) {
    throw new Error("--days must be an integer from 1 to 180.");
  }
  return days;
}

const days = reportDays(process.argv.slice(2));
const stages = [
  ["marketing.landing_view", "Landing sessions"],
  ["marketing.demo_cta_clicked", "Demo CTA sessions"],
  ["attack_lab.challenge_run", "Attack Lab sessions"],
  ["marketing.connect_cta_clicked", "Connect CTA sessions"],
  ["auth.signup_started", "Signup started"],
  ["business.signup_completed", "Signup completed"],
  ["business.first_agent_created", "First Agent created"],
  ["business.first_agent_connected", "First Agent connected"],
  ["business.first_scan_completed", "First Scan completed"],
  ["business.sdk_verified", "SDK approval consumed"],
  ["business.payment_confirmed", "Verified payment"],
  ["business.pilot_started", "Agency pilot started"],
];

try {
  await migrate();
  const result = await query(
    `SELECT event_name,
            COUNT(*)::int AS events,
            COUNT(DISTINCT visitor_hash)::int AS sessions,
            COUNT(DISTINCT workspace_id)::int AS workspaces,
            COALESCE(SUM(CASE WHEN event_name='business.payment_confirmed'
              THEN COALESCE((properties->>'amount_usdt')::numeric, 0) ELSE 0 END), 0)::numeric(14,2) AS amount_usdt
     FROM growth_events
     WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
     GROUP BY event_name`,
    [days],
  );
  const byName = new Map(result.rows.map((row) => [row.event_name, row]));
  let previous = null;
  const rows = stages.map(([eventName, label]) => {
    const row = byName.get(eventName);
    const count = eventName === "business.payment_confirmed"
      ? Number(row?.events ?? 0)
      : eventName.startsWith("business.")
        ? Number(row?.workspaces ?? 0)
        : Number(row?.sessions ?? 0);
    const conversion = previous && previous.count > 0
      ? `${((count / previous.count) * 100).toFixed(1)}%`
      : "—";
    if (count > 0 || row) previous = { count };
    return {
      stage: label,
      count,
      conversionFromPrevious: conversion,
      rawEvents: Number(row?.events ?? 0),
      ...(eventName === "business.payment_confirmed"
        ? { verifiedUSDT: Number(row?.amount_usdt ?? 0).toFixed(2) }
        : {}),
    };
  });

  const sourceResult = await query(
    `WITH first_touch AS (
       SELECT DISTINCT ON (visitor_hash)
              visitor_hash,
              COALESCE(properties->>'utm_source', properties->>'referrer_host', 'direct') AS source
       FROM growth_events
       WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
         AND visitor_hash IS NOT NULL
       ORDER BY visitor_hash, created_at ASC
     )
     SELECT source, COUNT(*)::int AS sessions
     FROM first_touch
     GROUP BY source
     ORDER BY sessions DESC, source ASC
     LIMIT 20`,
    [days],
  );

  console.log(`AgentGuard first-party funnel · last ${days} days · event retention 180 days`);
  console.table(rows);
  console.log("First-touch sources (anonymous tab sessions):");
  console.table(sourceResult.rows);
  console.log("Counts are directional product analytics; payment rows come only from verified provider webhooks.");
} finally {
  await closeDatabase();
}
