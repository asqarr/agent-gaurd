CREATE TABLE IF NOT EXISTS agent_security_contract_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  allowed_tool_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  max_refund_amount NUMERIC(12, 2) NOT NULL DEFAULT 50 CHECK (max_refund_amount > 0),
  max_order_age_days INTEGER NOT NULL DEFAULT 14 CHECK (max_order_age_days >= 0),
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, version)
);

CREATE INDEX IF NOT EXISTS agent_security_contract_versions_lookup_idx
  ON agent_security_contract_versions (workspace_id, agent_id, version DESC);

INSERT INTO agent_security_contract_versions
  (id, workspace_id, agent_id, version, allowed_tool_ids, max_refund_amount, max_order_age_days, notes, created_by, created_at)
SELECT
  'contract-version-' || c.agent_id || '-' || c.version,
  c.workspace_id,
  c.agent_id,
  c.version,
  c.allowed_tool_ids,
  c.max_refund_amount,
  c.max_order_age_days,
  c.notes,
  c.created_by,
  c.created_at
FROM agent_security_contracts c
ON CONFLICT (agent_id, version) DO NOTHING;
