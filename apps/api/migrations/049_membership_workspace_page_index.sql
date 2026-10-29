CREATE INDEX IF NOT EXISTS memberships_workspace_created_idx
  ON memberships (workspace_id, created_at ASC, user_id ASC);
