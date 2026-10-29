CREATE INDEX IF NOT EXISTS agents_sentinel_schedule_idx
  ON agents (sentinel_last_checked_at ASC NULLS FIRST, created_at ASC, id ASC)
  WHERE sentinel_enabled=TRUE;
