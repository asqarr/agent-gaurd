CREATE TABLE IF NOT EXISTS growth_events (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL CHECK (event_name IN (
    'marketing.landing_view',
    'marketing.connect_cta_clicked',
    'marketing.demo_cta_clicked',
    'attack_lab.challenge_run',
    'auth.signup_started',
    'business.signup_completed',
    'business.first_agent_created',
    'business.first_agent_connected',
    'business.first_scan_completed',
    'business.sdk_verified',
    'business.payment_confirmed',
    'business.pilot_started'
  )),
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  visitor_hash TEXT CHECK (visitor_hash IS NULL OR visitor_hash ~ '^[a-f0-9]{64}$'),
  client_event_id UUID,
  source_key TEXT,
  properties JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(properties) = 'object' AND octet_length(properties::text) <= 4096),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS growth_events_created_at_idx
  ON growth_events (created_at DESC);
CREATE INDEX IF NOT EXISTS growth_events_name_created_idx
  ON growth_events (event_name, created_at DESC);
CREATE INDEX IF NOT EXISTS growth_events_workspace_created_idx
  ON growth_events (workspace_id, created_at DESC)
  WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS growth_events_visitor_created_idx
  ON growth_events (visitor_hash, created_at ASC)
  WHERE visitor_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS growth_events_client_event_unique
  ON growth_events (client_event_id)
  WHERE client_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS growth_events_source_key_unique
  ON growth_events (source_key)
  WHERE source_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS growth_events_once_per_workspace_unique
  ON growth_events (workspace_id, event_name)
  WHERE workspace_id IS NOT NULL AND event_name IN (
    'business.signup_completed',
    'business.first_agent_created',
    'business.first_agent_connected',
    'business.first_scan_completed',
    'business.sdk_verified',
    'business.pilot_started'
  );
