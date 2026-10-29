CREATE TABLE IF NOT EXISTS workspace_activity_events (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT,
  agent_name TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'scan.queued', 'scan.started', 'scan.progress', 'scan.completed',
    'scan.retry_scheduled', 'scan.failed', 'runtime.allowed',
    'runtime.blocked', 'runtime.error', 'runtime.quota_rejected', 'runtime.approval_consumed',
    'sentinel.drift_detected', 'agent.quarantined', 'incident.opened',
    'incident.resolved', 'copilot.generated'
  )),
  category TEXT NOT NULL CHECK (category IN ('scan', 'runtime', 'sentinel', 'incident', 'copilot')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'success', 'warning', 'critical')),
  title TEXT NOT NULL,
  explanation TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workspace_activity_events_feed_idx
  ON workspace_activity_events (workspace_id, id DESC);
CREATE INDEX IF NOT EXISTS workspace_activity_events_created_idx
  ON workspace_activity_events (created_at);

CREATE OR REPLACE FUNCTION notify_workspace_activity_event() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify(
    'agentguard_workspace_activity',
    json_build_object('workspaceId', NEW.workspace_id, 'eventId', NEW.id::text)::text
  );

  IF MOD(NEW.id, 100) = 0 THEN
    DELETE FROM workspace_activity_events
    WHERE created_at < NOW() - INTERVAL '90 days';

    DELETE FROM workspace_activity_events
    WHERE workspace_id = NEW.workspace_id
      AND id IN (
        SELECT id FROM workspace_activity_events
        WHERE workspace_id = NEW.workspace_id
        ORDER BY id DESC
        OFFSET 5000
      );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workspace_activity_events_notify ON workspace_activity_events;
CREATE TRIGGER workspace_activity_events_notify
AFTER INSERT ON workspace_activity_events
FOR EACH ROW EXECUTE FUNCTION notify_workspace_activity_event();
