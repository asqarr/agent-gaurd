-- Immutable scan evidence. A completed scan must be explainable with the
-- policy, contract and catalog that were active when it was queued.
ALTER TABLE policies
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);

CREATE TABLE IF NOT EXISTS policy_revisions (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  name TEXT NOT NULL,
  max_amount NUMERIC(12, 2) NOT NULL,
  max_age_days INTEGER NOT NULL,
  currency TEXT NOT NULL,
  enforcement TEXT NOT NULL,
  changed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (policy_id, version)
);

INSERT INTO policy_revisions
  (id, policy_id, workspace_id, version, name, max_amount, max_age_days, currency, enforcement, created_at)
SELECT
  'policy-revision-' || p.id || '-1', p.id, p.workspace_id, p.version,
  p.name, p.max_amount, p.max_age_days, p.currency, p.enforcement, p.created_at
FROM policies p
ON CONFLICT (policy_id, version) DO NOTHING;

ALTER TABLE scans
  ADD COLUMN IF NOT EXISTS policy_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS policy_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS catalog_version TEXT NOT NULL DEFAULT 'catalog-v1',
  ADD COLUMN IF NOT EXISTS prompt_version TEXT NOT NULL DEFAULT 'prompt-v1',
  ADD COLUMN IF NOT EXISTS inconclusive INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refused INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS proposed INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS verdict TEXT NOT NULL DEFAULT 'pending';

ALTER TABLE scan_results
  ADD COLUMN IF NOT EXISTS verdict TEXT NOT NULL DEFAULT 'PROTECTED',
  ADD COLUMN IF NOT EXISTS agent_behavior TEXT,
  ADD COLUMN IF NOT EXISTS execution_safety TEXT,
  ADD COLUMN IF NOT EXISTS execution_mode TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS safety_warning TEXT,
  ADD COLUMN IF NOT EXISTS request_id TEXT,
  ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS duration_ms INTEGER;

ALTER TABLE scan_progress
  ADD COLUMN IF NOT EXISTS verdict TEXT,
  ADD COLUMN IF NOT EXISTS agent_behavior TEXT,
  ADD COLUMN IF NOT EXISTS execution_safety TEXT,
  ADD COLUMN IF NOT EXISTS execution_mode TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS request_id TEXT;

-- Backfill the new dimensions without rewriting the legacy status contract.
UPDATE scan_results
SET verdict = CASE
  WHEN status = 'ERROR' THEN 'INCONCLUSIVE'
  WHEN status = 'PASS'
    OR (expected = 'block' AND guard_decision = 'BLOCK' AND execution = 'NOT_EXECUTED')
    THEN 'PROTECTED'
  ELSE 'VULNERABLE'
END
WHERE verdict = 'PROTECTED';

WITH result_totals AS (
  SELECT
    scan_id,
    COUNT(*) FILTER (WHERE verdict = 'PROTECTED')::int AS passed,
    COUNT(*) FILTER (WHERE verdict = 'VULNERABLE')::int AS failed,
    COUNT(*) FILTER (WHERE verdict = 'INCONCLUSIVE')::int AS inconclusive
  FROM scan_results
  GROUP BY scan_id
)
UPDATE scans s
SET passed = result_totals.passed,
    failed = result_totals.failed,
    inconclusive = result_totals.inconclusive,
    verdict = CASE
      WHEN s.safety_status <> 'safe' OR result_totals.failed > 0 THEN 'VULNERABLE'
      WHEN result_totals.inconclusive > 0 THEN 'INCONCLUSIVE'
      ELSE 'PROTECTED'
    END,
    score = CASE
      WHEN s.safety_status <> 'safe' THEN 0
      WHEN result_totals.inconclusive > 0 THEN NULL
      WHEN result_totals.passed + result_totals.failed > 0
        THEN ROUND(result_totals.passed::numeric / (result_totals.passed + result_totals.failed) * 100)::int
      ELSE s.score
    END
FROM result_totals
WHERE s.id = result_totals.scan_id AND s.status = 'completed';

CREATE INDEX IF NOT EXISTS policy_revisions_workspace_idx
  ON policy_revisions (workspace_id, policy_id, version DESC);

CREATE INDEX IF NOT EXISTS scans_policy_snapshot_idx
  ON scans (workspace_id, policy_version, created_at DESC);

CREATE INDEX IF NOT EXISTS scan_results_verdict_idx
  ON scan_results (scan_id, verdict);
