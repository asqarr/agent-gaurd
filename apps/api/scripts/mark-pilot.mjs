import "dotenv/config";
import { randomUUID } from "node:crypto";
import { closeDatabase, migrate, query } from "../src/core/db.mjs";

const workspaceId = process.argv[2]?.trim();
if (!workspaceId || workspaceId.length > 128) {
  console.error("Usage: npm run growth:mark-pilot -- <workspace-id>");
  process.exitCode = 2;
} else {
  try {
    await migrate();
    const result = await query(
      `INSERT INTO growth_events (id, event_name, workspace_id, properties)
       SELECT $1, 'business.pilot_started', id, '{"source":"operator_marked"}'::jsonb
       FROM workspaces WHERE id=$2
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [`growth-${randomUUID()}`, workspaceId],
    );
    if (result.rowCount) console.log("Agency pilot milestone recorded.");
    else {
      const exists = await query("SELECT 1 FROM workspaces WHERE id=$1", [workspaceId]);
      if (!exists.rowCount) {
        console.error("Workspace not found; no event was recorded.");
        process.exitCode = 1;
      } else {
        console.log("This workspace already has a pilot milestone; no duplicate was recorded.");
      }
    }
  } finally {
    await closeDatabase();
  }
}
