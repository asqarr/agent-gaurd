CREATE TABLE IF NOT EXISTS workspace_activity_cursors (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  last_stream_id BIGINT NOT NULL DEFAULT 0 CHECK (last_stream_id >= 0)
);

ALTER TABLE workspace_activity_events
  ADD COLUMN IF NOT EXISTS stream_id BIGINT;

WITH numbered_events AS (
  SELECT id, row_number() OVER (PARTITION BY workspace_id ORDER BY id) AS stream_id
  FROM workspace_activity_events
)
UPDATE workspace_activity_events AS events
SET stream_id = numbered_events.stream_id
FROM numbered_events
WHERE events.id = numbered_events.id AND events.stream_id IS NULL;

INSERT INTO workspace_activity_cursors (workspace_id, last_stream_id)
SELECT workspace_id, MAX(stream_id)
FROM workspace_activity_events
GROUP BY workspace_id
ON CONFLICT (workspace_id) DO UPDATE
SET last_stream_id = GREATEST(workspace_activity_cursors.last_stream_id, EXCLUDED.last_stream_id);

ALTER TABLE workspace_activity_events
  ALTER COLUMN stream_id SET NOT NULL;

DROP INDEX IF EXISTS workspace_activity_events_feed_idx;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_activity_events_workspace_stream_uidx
  ON workspace_activity_events (workspace_id, stream_id);
CREATE INDEX IF NOT EXISTS workspace_activity_events_feed_idx
  ON workspace_activity_events (workspace_id, stream_id DESC);

CREATE OR REPLACE FUNCTION assign_workspace_activity_stream_id() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO workspace_activity_cursors (workspace_id, last_stream_id)
  VALUES (NEW.workspace_id, 1)
  ON CONFLICT (workspace_id) DO UPDATE
  SET last_stream_id = workspace_activity_cursors.last_stream_id + 1
  RETURNING last_stream_id INTO NEW.stream_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workspace_activity_events_assign_stream_id ON workspace_activity_events;
CREATE TRIGGER workspace_activity_events_assign_stream_id
BEFORE INSERT ON workspace_activity_events
FOR EACH ROW EXECUTE FUNCTION assign_workspace_activity_stream_id();

CREATE OR REPLACE FUNCTION notify_workspace_activity_event() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify(
    'agentguard_workspace_activity',
    json_build_object('workspaceId', NEW.workspace_id, 'eventId', NEW.stream_id::text)::text
  );

  IF MOD(NEW.stream_id, 100) = 0 THEN
    DELETE FROM workspace_activity_events
    WHERE created_at < NOW() - INTERVAL '90 days';

    DELETE FROM workspace_activity_events
    WHERE workspace_id = NEW.workspace_id
      AND id IN (
        SELECT id FROM workspace_activity_events
        WHERE workspace_id = NEW.workspace_id
        ORDER BY stream_id DESC
        OFFSET 5000
      );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
