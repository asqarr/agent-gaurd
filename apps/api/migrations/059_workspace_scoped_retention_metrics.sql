ALTER TABLE evidence_retention_runs
  ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS evidence_retention_runs_workspace_finished_idx
  ON evidence_retention_runs (workspace_id, finished_at DESC);
