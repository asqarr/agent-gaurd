CREATE TABLE IF NOT EXISTS autopilot_assessments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  scan_id TEXT NOT NULL UNIQUE REFERENCES scans(id) ON DELETE CASCADE,
  connection JSONB NOT NULL DEFAULT '{}'::jsonb,
  applied_at TIMESTAMPTZ,
  applied_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS autopilot_assessments_workspace_created_idx
  ON autopilot_assessments (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS autopilot_assessments_agent_created_idx
  ON autopilot_assessments (agent_id, created_at DESC);
