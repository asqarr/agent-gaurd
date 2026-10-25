ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime_token_hash TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime_blocked_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime_last_event_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS agents_runtime_token_idx
  ON agents (runtime_token_hash)
  WHERE runtime_token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS runtime_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('ALLOW', 'BLOCK')),
  tool_name TEXT NOT NULL DEFAULT 'no_tool_call',
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS runtime_events_agent_created_idx
  ON runtime_events (agent_id, created_at DESC);
