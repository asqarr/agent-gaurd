CREATE TABLE IF NOT EXISTS runtime_approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  payload JSONB NOT NULL,
  signature TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS runtime_approvals_agent_created_idx
  ON runtime_approvals (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS runtime_approvals_active_idx
  ON runtime_approvals (agent_id, id, expires_at)
  WHERE consumed_at IS NULL;

ALTER TABLE scans
  ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'simulation',
  ADD COLUMN IF NOT EXISTS safety_status TEXT NOT NULL DEFAULT 'safe',
  ADD COLUMN IF NOT EXISTS safety_warning TEXT;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS encrypted_mfa_secret TEXT;

CREATE TABLE IF NOT EXISTS auth_action_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('password_reset', 'email_verification')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS auth_action_tokens_active_idx
  ON auth_action_tokens (user_id, purpose, expires_at)
  WHERE consumed_at IS NULL;
