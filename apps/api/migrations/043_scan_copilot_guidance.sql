CREATE TABLE IF NOT EXISTS scan_copilot_guidance (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  scenario_id TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  guidance JSONB NOT NULL,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scan_id, scenario_id)
);

CREATE INDEX IF NOT EXISTS scan_copilot_guidance_workspace_created_idx
  ON scan_copilot_guidance (workspace_id, created_at DESC);
