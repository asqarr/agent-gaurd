CREATE TABLE IF NOT EXISTS auth_refresh_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  user_agent TEXT,
  ip_address TEXT
);

CREATE INDEX IF NOT EXISTS auth_refresh_sessions_user_idx
  ON auth_refresh_sessions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS auth_refresh_sessions_active_idx
  ON auth_refresh_sessions (token_hash, expires_at)
  WHERE revoked_at IS NULL;
