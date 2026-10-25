ALTER TABLE agents ADD COLUMN IF NOT EXISTS sentinel_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS sentinel_auto_quarantine BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS sentinel_last_checked_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS sentinel_baselines (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  fingerprint TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS sentinel_active_baseline_idx
  ON sentinel_baselines (agent_id) WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS sentinel_baselines_workspace_idx
  ON sentinel_baselines (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sentinel_drift_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  baseline_id TEXT REFERENCES sentinel_baselines(id) ON DELETE SET NULL,
  current_fingerprint TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  changes JSONB NOT NULL DEFAULT '[]'::jsonb,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS sentinel_open_fingerprint_idx
  ON sentinel_drift_events (agent_id, current_fingerprint) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS sentinel_events_workspace_created_idx
  ON sentinel_drift_events (workspace_id, detected_at DESC);

CREATE INDEX IF NOT EXISTS sentinel_events_agent_created_idx
  ON sentinel_drift_events (agent_id, detected_at DESC);
