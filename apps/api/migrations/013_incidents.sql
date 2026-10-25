CREATE TABLE IF NOT EXISTS incident_notifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('sentinel_drift', 'agent_quarantined', 'scan_finding', 'scan_failed', 'runtime_block')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  read_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS incident_open_dedupe_idx
  ON incident_notifications (workspace_id, dedupe_key) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS incident_workspace_created_idx
  ON incident_notifications (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS incident_workspace_unread_idx
  ON incident_notifications (workspace_id, read_at, created_at DESC) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS alert_webhooks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  encrypted_url TEXT NOT NULL,
  encrypted_secret TEXT NOT NULL,
  event_types JSONB NOT NULL DEFAULT '["*"]'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS alert_webhooks_workspace_idx
  ON alert_webhooks (workspace_id, enabled);

CREATE TABLE IF NOT EXISTS incident_webhook_deliveries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  notification_id TEXT NOT NULL REFERENCES incident_notifications(id) ON DELETE CASCADE,
  webhook_id TEXT NOT NULL REFERENCES alert_webhooks(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (notification_id, webhook_id)
);

CREATE INDEX IF NOT EXISTS incident_delivery_queue_idx
  ON incident_webhook_deliveries (status, next_attempt_at);
