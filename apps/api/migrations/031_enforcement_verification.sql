CREATE TABLE IF NOT EXISTS runtime_verification_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  result JSONB NOT NULL CHECK (
    jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 32768
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, agent_id)
);

CREATE INDEX IF NOT EXISTS runtime_verification_workspace_created_idx
  ON runtime_verification_runs (workspace_id, created_at DESC);
