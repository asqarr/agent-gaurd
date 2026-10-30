ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS enforcement_verification BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE subscription_plans
SET enforcement_verification = (id IN ('builder', 'team', 'agency'));

UPDATE subscription_plans
SET features='["Full 12-scenario red-team suite", "Versioned Security Contracts + attack-path replay", "Enforcement verification + proof report", "200 monthly Scan Credits", "Runtime Firewall", "Export-ready reports", "Incident Center", "30-day evidence"]'::jsonb
WHERE id='builder';

CREATE INDEX IF NOT EXISTS runtime_events_created_workspace_retention_idx
  ON runtime_events (created_at, workspace_id);

CREATE INDEX IF NOT EXISTS runtime_verification_created_workspace_retention_idx
  ON runtime_verification_runs (created_at, workspace_id);

ALTER TABLE evidence_retention_runs
  ADD COLUMN IF NOT EXISTS runtime_verification_candidates INTEGER NOT NULL DEFAULT 0 CHECK (runtime_verification_candidates >= 0),
  ADD COLUMN IF NOT EXISTS runtime_event_candidates INTEGER NOT NULL DEFAULT 0 CHECK (runtime_event_candidates >= 0),
  ADD COLUMN IF NOT EXISTS deleted_runtime_events INTEGER NOT NULL DEFAULT 0 CHECK (deleted_runtime_events >= 0),
  ADD COLUMN IF NOT EXISTS deleted_runtime_verification_runs INTEGER NOT NULL DEFAULT 0 CHECK (deleted_runtime_verification_runs >= 0);
