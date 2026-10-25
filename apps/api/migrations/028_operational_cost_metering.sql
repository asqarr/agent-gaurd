CREATE TABLE IF NOT EXISTS usage_measurements (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period_start TIMESTAMPTZ NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('scan', 'runtime_decision')),
  units INTEGER NOT NULL CHECK (units > 0),
  reference_type TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  cpu_user_us BIGINT NOT NULL DEFAULT 0 CHECK (cpu_user_us >= 0),
  cpu_system_us BIGINT NOT NULL DEFAULT 0 CHECK (cpu_system_us >= 0),
  rss_bytes BIGINT NOT NULL DEFAULT 0 CHECK (rss_bytes >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, kind, reference_id)
);

CREATE INDEX IF NOT EXISTS usage_measurements_workspace_period_idx
  ON usage_measurements (workspace_id, period_start, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS usage_storage_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  database_size_bytes BIGINT NOT NULL DEFAULT 0 CHECK (database_size_bytes >= 0),
  logical_bytes BIGINT NOT NULL DEFAULT 0 CHECK (logical_bytes >= 0),
  scans_bytes BIGINT NOT NULL DEFAULT 0 CHECK (scans_bytes >= 0),
  scan_results_bytes BIGINT NOT NULL DEFAULT 0 CHECK (scan_results_bytes >= 0),
  scan_progress_bytes BIGINT NOT NULL DEFAULT 0 CHECK (scan_progress_bytes >= 0),
  runtime_events_bytes BIGINT NOT NULL DEFAULT 0 CHECK (runtime_events_bytes >= 0),
  measurements_bytes BIGINT NOT NULL DEFAULT 0 CHECK (measurements_bytes >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS usage_storage_snapshots_workspace_captured_idx
  ON usage_storage_snapshots (workspace_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS evidence_retention_runs (
  id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  candidates INTEGER NOT NULL DEFAULT 0 CHECK (candidates >= 0),
  deleted_scans INTEGER NOT NULL DEFAULT 0 CHECK (deleted_scans >= 0),
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS evidence_retention_runs_finished_idx
  ON evidence_retention_runs (finished_at DESC);

CREATE TABLE IF NOT EXISTS billing_service_orders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  checkout_session_id TEXT NOT NULL UNIQUE REFERENCES billing_checkout_sessions(id) ON DELETE CASCADE,
  addon_purchase_id TEXT REFERENCES billing_addon_purchases(id) ON DELETE SET NULL,
  addon_id TEXT NOT NULL REFERENCES billing_addon_catalog(id),
  target_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'in_progress', 'delivered', 'accepted', 'canceled')),
  scope TEXT NOT NULL DEFAULT '',
  delivery_window TEXT NOT NULL DEFAULT '',
  acceptance_terms TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS billing_service_orders_workspace_idx
  ON billing_service_orders (workspace_id, created_at DESC);
