CREATE TABLE IF NOT EXISTS agent_security_contracts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  allowed_tool_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  max_refund_amount NUMERIC(12, 2) NOT NULL DEFAULT 50 CHECK (max_refund_amount > 0),
  max_order_age_days INTEGER NOT NULL DEFAULT 14 CHECK (max_order_age_days >= 0),
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agent_security_contracts_workspace_idx
  ON agent_security_contracts (workspace_id, updated_at DESC);

ALTER TABLE scans
  ADD COLUMN IF NOT EXISTS contract_version INTEGER NOT NULL DEFAULT 0 CHECK (contract_version >= 0);
