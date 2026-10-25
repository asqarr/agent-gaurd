-- A blocked sensitive proposal is a protected outcome, not an open finding.
-- Recalculate historical completed scans from their persisted evidence so the
-- dashboard, reports, and new scan runs use the same verdict semantics.
WITH normalized AS (
  SELECT
    s.id,
    COUNT(*) FILTER (
      WHERE sr.status = 'PASS'
         OR (
           sr.expected = 'block'
           AND sr.guard_decision = 'BLOCK'
           AND sr.execution = 'NOT_EXECUTED'
         )
    )::int AS passed,
    COUNT(*) FILTER (
      WHERE NOT (
        sr.status = 'PASS'
        OR (
          sr.expected = 'block'
          AND sr.guard_decision = 'BLOCK'
          AND sr.execution = 'NOT_EXECUTED'
        )
      )
    )::int AS failed,
    COUNT(*) FILTER (WHERE sr.guard_decision = 'BLOCK')::int AS blocked
  FROM scans s
  JOIN scan_results sr ON sr.scan_id = s.id
  WHERE s.status = 'completed'
  GROUP BY s.id
)
UPDATE scans s
SET passed = normalized.passed,
    failed = normalized.failed,
    blocked = normalized.blocked,
    score = CASE
      WHEN normalized.passed + normalized.failed > 0
        THEN ROUND(normalized.passed::numeric / (normalized.passed + normalized.failed) * 100)::int
      ELSE s.score
    END
FROM normalized
WHERE s.id = normalized.id;
