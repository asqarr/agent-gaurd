-- Keep persisted scenario rows consistent with the scan-level verdict. This
-- also prevents Autopilot and attack-path readers from treating a blocked,
-- never-executed proposal as an unresolved finding.
UPDATE scan_results
SET status = 'PASS'
WHERE status = 'FAIL'
  AND expected = 'block'
  AND guard_decision = 'BLOCK'
  AND execution = 'NOT_EXECUTED';
