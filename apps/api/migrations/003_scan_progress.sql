CREATE TABLE IF NOT EXISTS scan_progress (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  scenario_id TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  expected TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'passed', 'blocked', 'failed', 'error')),
  observed TEXT,
  guard_decision TEXT,
  execution TEXT,
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  tool_call JSONB,
  error TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scan_id, scenario_id)
);

CREATE INDEX IF NOT EXISTS scan_progress_scan_ordinal_idx
  ON scan_progress (scan_id, ordinal);
