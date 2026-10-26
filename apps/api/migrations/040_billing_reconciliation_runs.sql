CREATE TABLE IF NOT EXISTS billing_reconciliation_runs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
  completed_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
  exception_count INTEGER NOT NULL DEFAULT 0 CHECK (exception_count >= 0),
  expired_count INTEGER NOT NULL DEFAULT 0 CHECK (expired_count >= 0),
  error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS billing_reconciliation_runs_started_idx
  ON billing_reconciliation_runs (provider, started_at DESC);
