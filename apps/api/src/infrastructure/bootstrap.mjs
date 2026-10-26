import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { seedAgents } from "../features/catalog/domain.mjs";
import { withTransaction } from "../core/db.mjs";
import { config } from "../core/config.mjs";

export async function seedDevelopmentData() {
  if (config.nodeEnv === "production") return;

  await withTransaction(async (client) => {
    const workspaceId = "workspace-demo";
    const userId = "user-demo";
    await client.query(
      "INSERT INTO workspaces (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
      [workspaceId, "Northstar Labs"],
    );

    const existingUser = await client.query(
      "SELECT id FROM users WHERE LOWER(email)=LOWER($1)",
      [config.seedEmail],
    );
    if (existingUser.rowCount === 0) {
      await client.query(
        "INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)",
        [
          userId,
          config.seedEmail.toLowerCase(),
          "Arman K.",
          await bcrypt.hash(config.seedPassword, 12),
        ],
      );
    }
    const actualUser = await client.query(
      "SELECT id FROM users WHERE LOWER(email)=LOWER($1)",
      [config.seedEmail],
    );
    await client.query(
      "INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1,$2,'owner') ON CONFLICT DO NOTHING",
      [actualUser.rows[0].id, workspaceId],
    );
    await client.query(
      "INSERT INTO policies (id, workspace_id, name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      ["policy-storefront-refunds", workspaceId, "Storefront refunds"],
    );
    await client.query(
      `INSERT INTO policy_revisions
       (id, policy_id, workspace_id, version, name, max_amount, max_age_days, currency, enforcement)
       SELECT 'policy-revision-' || id || '-1', id, workspace_id, version, name, max_amount, max_age_days, currency, enforcement
       FROM policies WHERE id=$1
       ON CONFLICT (policy_id, version) DO NOTHING`,
      ["policy-storefront-refunds"],
    );
    await client.query(
      `INSERT INTO workspace_subscriptions
         (id, workspace_id, plan_id, status, billing_provider, current_period_start, current_period_end)
       VALUES ('subscription-workspace-demo',$1,'team','active','internal',DATE_TRUNC('month', NOW()),DATE_TRUNC('month', NOW()) + INTERVAL '1 month')
       ON CONFLICT (workspace_id) DO UPDATE
       SET plan_id='team', status='active', updated_at=NOW()`,
      [workspaceId],
    );
    await client.query(
      `INSERT INTO usage_periods
         (id, workspace_id, subscription_id, period_start, period_end)
       SELECT 'usage-workspace-demo-' || TO_CHAR(s.current_period_start, 'YYYYMM'),
              s.workspace_id, s.id, s.current_period_start, s.current_period_end
       FROM workspace_subscriptions s
       WHERE s.workspace_id=$1
       ON CONFLICT (workspace_id, period_start) DO NOTHING`,
      [workspaceId],
    );

    for (const seed of seedAgents) {
      await client.query(
        `INSERT INTO agents (id, workspace_id, name, description, environment, provider, model, mode, status, score, last_scan_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
        [
          seed.id,
          workspaceId,
          seed.name,
          seed.description,
          seed.environment,
          seed.provider,
          seed.model,
          seed.mode,
          seed.status,
          seed.score,
          seed.lastScan,
        ],
      );
      for (const toolId of seed.tools) {
        await client.query(
          "INSERT INTO agent_tools (id, agent_id, tool_id) VALUES ($1,$2,$3) ON CONFLICT (agent_id, tool_id) DO NOTHING",
          [`agent-tool-${randomUUID()}`, seed.id, toolId],
        );
      }
    }
  });
}
