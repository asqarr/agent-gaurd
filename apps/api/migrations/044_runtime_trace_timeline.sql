ALTER TABLE runtime_events
  ADD COLUMN IF NOT EXISTS trace_id TEXT
    CHECK (trace_id IS NULL OR trace_id ~ '^[0-9a-f]{32}$'),
  ADD COLUMN IF NOT EXISTS trace_spans JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(trace_spans) = 'array');

CREATE INDEX IF NOT EXISTS runtime_events_workspace_trace_idx
  ON runtime_events (workspace_id, trace_id, created_at DESC)
  WHERE trace_id IS NOT NULL;
