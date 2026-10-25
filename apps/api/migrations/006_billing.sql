CREATE TABLE IF NOT EXISTS subscription_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  billing_interval TEXT NOT NULL DEFAULT 'month' CHECK (billing_interval IN ('month', 'year')),
  price_usd_cents INTEGER NOT NULL CHECK (price_usd_cents >= 0),
  max_agents INTEGER NOT NULL CHECK (max_agents > 0),
  monthly_scan_credits INTEGER NOT NULL CHECK (monthly_scan_credits >= 0),
  history_days INTEGER NOT NULL CHECK (history_days > 0),
  seat_limit INTEGER NOT NULL CHECK (seat_limit > 0),
  runtime_firewall BOOLEAN NOT NULL DEFAULT FALSE,
  features JSONB NOT NULL DEFAULT '[]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO subscription_plans
  (id, name, description, billing_interval, price_usd_cents, max_agents, monthly_scan_credits, history_days, seat_limit, runtime_firewall, features)
VALUES
  ('free', 'Free', 'Validate one agent with a complete security baseline.', 'month', 0, 1, 30, 7, 1, FALSE, '["Full security baseline", "Scenario evidence", "7-day history"]'::jsonb),
  ('builder', 'Builder', 'Continuously test a small production agent fleet.', 'month', 2900, 3, 600, 90, 3, TRUE, '["Advanced red-team scenarios", "Scheduled scans", "Runtime Firewall", "90-day history"]'::jsonb),
  ('team', 'Team', 'Protect multiple agents with shared security operations.', 'month', 9900, 10, 3000, 365, 10, TRUE, '["Everything in Builder", "Team access", "Priority evidence retention", "Export-ready reports"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS workspace_subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES subscription_plans(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('trialing', 'active', 'past_due', 'canceled', 'incomplete')),
  billing_provider TEXT NOT NULL DEFAULT 'internal',
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workspace_subscriptions_status_idx
  ON workspace_subscriptions (status, current_period_end);

CREATE TABLE IF NOT EXISTS usage_periods (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES workspace_subscriptions(id) ON DELETE CASCADE,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  scan_credits_used INTEGER NOT NULL DEFAULT 0 CHECK (scan_credits_used >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, period_start)
);

CREATE TABLE IF NOT EXISTS usage_ledger (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES workspace_subscriptions(id) ON DELETE CASCADE,
  period_start TIMESTAMPTZ NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('scan_credits', 'agent_slot', 'runtime_request')),
  units INTEGER NOT NULL CHECK (units > 0),
  reference_type TEXT,
  reference_id TEXT,
  idempotency_key TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS usage_ledger_workspace_created_idx
  ON usage_ledger (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS billing_checkout_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES subscription_plans(id),
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'awaiting_payment', 'confirming', 'paid', 'expired', 'canceled', 'failed')),
  provider_checkout_id TEXT,
  amount_usd_cents INTEGER NOT NULL CHECK (amount_usd_cents > 0),
  quote_amount NUMERIC(30, 12),
  quote_currency TEXT,
  network TEXT,
  pay_address TEXT,
  idempotency_key TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (provider, provider_checkout_id)
);

CREATE TABLE IF NOT EXISTS billing_payments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_id TEXT REFERENCES workspace_subscriptions(id) ON DELETE SET NULL,
  checkout_session_id TEXT REFERENCES billing_checkout_sessions(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  provider_payment_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirming', 'confirmed', 'failed', 'expired', 'refunded')),
  amount NUMERIC(30, 12) NOT NULL,
  currency TEXT NOT NULL,
  network TEXT,
  wallet_address TEXT,
  tx_hash TEXT,
  confirmations INTEGER NOT NULL DEFAULT 0 CHECK (confirmations >= 0),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_payment_id),
  UNIQUE (network, tx_hash)
);

CREATE INDEX IF NOT EXISTS billing_payments_workspace_created_idx
  ON billing_payments (workspace_id, created_at DESC);

INSERT INTO workspace_subscriptions
  (id, workspace_id, plan_id, status, billing_provider, current_period_start, current_period_end)
SELECT
  'subscription-' || w.id,
  w.id,
  'free',
  'active',
  'internal',
  DATE_TRUNC('month', NOW()),
  DATE_TRUNC('month', NOW()) + INTERVAL '1 month'
FROM workspaces w
ON CONFLICT (workspace_id) DO NOTHING;

INSERT INTO usage_periods
  (id, workspace_id, subscription_id, period_start, period_end)
SELECT
  'usage-' || s.workspace_id || '-' || TO_CHAR(s.current_period_start, 'YYYYMM'),
  s.workspace_id,
  s.id,
  s.current_period_start,
  s.current_period_end
FROM workspace_subscriptions s
ON CONFLICT (workspace_id, period_start) DO NOTHING;
