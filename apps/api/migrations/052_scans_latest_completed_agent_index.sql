CREATE INDEX IF NOT EXISTS scans_latest_completed_agent_idx
  ON scans (workspace_id, agent_id, created_at DESC)
  WHERE status = 'completed';
