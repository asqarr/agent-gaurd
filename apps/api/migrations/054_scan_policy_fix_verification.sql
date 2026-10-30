ALTER TABLE scans
  ADD COLUMN IF NOT EXISTS remediation_source_scan_id TEXT
    REFERENCES scans(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS remediation_scenario_id TEXT,
  ADD COLUMN IF NOT EXISTS remediation_policy_version_before INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'scans_remediation_verification_shape_check'
      AND conrelid = 'scans'::regclass
  ) THEN
    ALTER TABLE scans
      ADD CONSTRAINT scans_remediation_verification_shape_check
      CHECK (
        (remediation_source_scan_id IS NULL AND remediation_scenario_id IS NULL AND remediation_policy_version_before IS NULL)
        OR
        (remediation_source_scan_id IS NOT NULL AND remediation_scenario_id IS NOT NULL AND remediation_policy_version_before IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS scans_remediation_source_idx
  ON scans (workspace_id, remediation_source_scan_id, remediation_scenario_id, created_at DESC)
  WHERE remediation_source_scan_id IS NOT NULL;
