ALTER TABLE auth_refresh_sessions
  ADD COLUMN IF NOT EXISTS rotated_to_session_id TEXT;

ALTER TABLE auth_refresh_sessions
  ADD COLUMN IF NOT EXISTS rotation_grace_until TIMESTAMPTZ;
