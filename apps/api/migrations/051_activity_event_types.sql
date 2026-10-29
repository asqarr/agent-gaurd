ALTER TABLE workspace_activity_events
  DROP CONSTRAINT IF EXISTS workspace_activity_events_event_type_check;

ALTER TABLE workspace_activity_events
  ADD CONSTRAINT workspace_activity_events_event_type_check
  CHECK (event_type IN (
    'scan.queued', 'scan.started', 'scan.progress', 'scan.completed',
    'scan.retry_scheduled', 'scan.failed', 'runtime.allowed',
    'runtime.blocked', 'runtime.error', 'runtime.quota_rejected', 'runtime.approval_consumed',
    'sentinel.drift_detected', 'agent.quarantined', 'incident.opened',
    'incident.resolved', 'copilot.generated'
  ));
