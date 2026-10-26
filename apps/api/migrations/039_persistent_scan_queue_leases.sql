ALTER TABLE scan_jobs
  ADD COLUMN IF NOT EXISTS lease_token TEXT,
  ADD COLUMN IF NOT EXISTS locked_by TEXT,
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS scan_jobs_recovery_idx
  ON scan_jobs (status, locked_at, available_at)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS scan_jobs_worker_idx
  ON scan_jobs (locked_by, status, heartbeat_at)
  WHERE status='running';
