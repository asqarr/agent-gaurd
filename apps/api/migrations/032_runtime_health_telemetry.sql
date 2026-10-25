ALTER TABLE runtime_events
  ADD COLUMN IF NOT EXISTS outcome TEXT NOT NULL DEFAULT 'decision'
    CHECK (outcome IN ('decision', 'error', 'quota')),
  ADD COLUMN IF NOT EXISTS error_code TEXT
    CHECK (error_code IS NULL OR error_code IN (
      'UPSTREAM_TIMEOUT',
      'UPSTREAM_FAILURE',
      'POLICY_PIPELINE_FAILURE',
      'APPROVAL_STORAGE_FAILURE',
      'GATEWAY_INTERNAL_ERROR',
      'RUNTIME_QUOTA_EXCEEDED',
      'SUBSCRIPTION_REQUIRED'
    )),
  ADD COLUMN IF NOT EXISTS failure_stage TEXT
    CHECK (failure_stage IS NULL OR failure_stage IN (
      'quota',
      'customer_endpoint',
      'policy',
      'approval_storage',
      'decision_persistence',
      'gateway'
    ));

CREATE INDEX IF NOT EXISTS runtime_events_workspace_agent_created_idx
  ON runtime_events (workspace_id, agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS runtime_events_health_window_idx
  ON runtime_events (workspace_id, agent_id, outcome, created_at DESC);
