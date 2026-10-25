CREATE UNIQUE INDEX IF NOT EXISTS users_lower_email_unique_idx
  ON users (LOWER(email));

CREATE UNIQUE INDEX IF NOT EXISTS policies_workspace_unique_idx
  ON policies (workspace_id);
