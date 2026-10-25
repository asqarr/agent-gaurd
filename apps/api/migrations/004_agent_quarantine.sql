ALTER TABLE agents ADD COLUMN IF NOT EXISTS quarantined_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS quarantine_reason TEXT;

CREATE INDEX IF NOT EXISTS agents_quarantine_idx
  ON agents (workspace_id, status) WHERE status = 'quarantined';
