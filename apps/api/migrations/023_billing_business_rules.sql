ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS scan_credit_mode TEXT NOT NULL DEFAULT 'monthly'
    CHECK (scan_credit_mode IN ('monthly', 'one_time')),
  ADD COLUMN IF NOT EXISTS white_label_reports BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS multi_client_management BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE workspace_subscriptions
  ADD COLUMN IF NOT EXISTS renewal_mode TEXT NOT NULL DEFAULT 'manual'
    CHECK (renewal_mode IN ('manual', 'automatic')),
  ADD COLUMN IF NOT EXISTS pending_plan_id TEXT REFERENCES subscription_plans(id),
  ADD COLUMN IF NOT EXISTS pending_plan_effective_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS one_time_scan_credits_used INTEGER NOT NULL DEFAULT 0
    CHECK (one_time_scan_credits_used >= 0);

ALTER TABLE billing_checkout_sessions
  ALTER COLUMN plan_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS checkout_type TEXT NOT NULL DEFAULT 'plan'
    CHECK (checkout_type IN ('plan', 'addon')),
  ADD COLUMN IF NOT EXISTS addon_id TEXT;

CREATE TABLE IF NOT EXISTS billing_addon_catalog (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('scan_credits', 'runtime_decisions', 'agent_slot', 'security_audit', 'support')),
  units INTEGER NOT NULL CHECK (units > 0),
  price_usd_cents INTEGER NOT NULL CHECK (price_usd_cents > 0),
  billing_interval TEXT NOT NULL DEFAULT 'one_time' CHECK (billing_interval IN ('one_time', 'month')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE billing_checkout_sessions
  ADD CONSTRAINT billing_checkout_sessions_addon_fk
  FOREIGN KEY (addon_id) REFERENCES billing_addon_catalog(id);

CREATE TABLE IF NOT EXISTS billing_addon_purchases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  checkout_session_id TEXT NOT NULL REFERENCES billing_checkout_sessions(id) ON DELETE CASCADE,
  addon_id TEXT NOT NULL REFERENCES billing_addon_catalog(id),
  kind TEXT NOT NULL CHECK (kind IN ('scan_credits', 'runtime_decisions', 'agent_slot', 'security_audit', 'support')),
  units_total INTEGER NOT NULL CHECK (units_total > 0),
  units_remaining INTEGER NOT NULL CHECK (units_remaining >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'expired', 'canceled')),
  expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS billing_addon_purchases_balance_idx
  ON billing_addon_purchases (workspace_id, kind, status, expires_at, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS billing_addon_purchases_checkout_uidx
  ON billing_addon_purchases (checkout_session_id);

INSERT INTO billing_addon_catalog (id, name, description, kind, units, price_usd_cents, billing_interval)
VALUES
  ('scan_credits_200', '200 extra Scan Credits', 'One-time extra scan capacity. Never renews automatically.', 'scan_credits', 200, 900, 'one_time'),
  ('scan_credits_1000', '1,000 extra Scan Credits', 'One-time extra scan capacity. Never renews automatically.', 'scan_credits', 1000, 3500, 'one_time'),
  ('runtime_decisions_10000', '10,000 extra Runtime Decisions', 'One-time extra Runtime Firewall capacity.', 'runtime_decisions', 10000, 500, 'one_time'),
  ('runtime_decisions_100000', '100,000 extra Runtime Decisions', 'One-time extra Runtime Firewall capacity.', 'runtime_decisions', 100000, 2500, 'one_time'),
  ('agent_slot_1', 'One extra Agent slot', 'Adds one Agent slot for the current paid period. Renewal is manual.', 'agent_slot', 1, 1200, 'month'),
  ('security_audit_1', 'Agent Security Audit', 'One scoped audit for one Agent: 12 scenarios, relevant attack paths and one report.', 'security_audit', 1, 19900, 'one_time'),
  ('implementation_support_1', 'Dedicated implementation support', 'One separately billed, scoped setup/support engagement. Not included in any plan.', 'support', 1, 19900, 'one_time')
ON CONFLICT (id) DO UPDATE SET
  name=EXCLUDED.name,
  description=EXCLUDED.description,
  kind=EXCLUDED.kind,
  units=EXCLUDED.units,
  price_usd_cents=EXCLUDED.price_usd_cents,
  billing_interval=EXCLUDED.billing_interval,
  active=TRUE;

UPDATE subscription_plans
SET scan_credit_mode='one_time',
    monthly_scan_credits=20,
    white_label_reports=FALSE,
    multi_client_management=FALSE,
    features='["5 essential boundary scenarios", "20 one-time Scan Credits", "1 protected agent", "7-day evidence"]'::jsonb
WHERE id='free';

UPDATE subscription_plans
SET scan_credit_mode='monthly',
    monthly_scan_credits=200,
    max_agents=2,
    history_days=30,
    white_label_reports=FALSE,
    multi_client_management=FALSE,
    features='["Full 12-scenario red-team suite", "200 monthly Scan Credits", "Runtime Firewall", "Reports", "30-day evidence"]'::jsonb
WHERE id='builder';

UPDATE subscription_plans
SET scan_credit_mode='monthly',
    monthly_scan_credits=1000,
    max_agents=5,
    history_days=90,
    white_label_reports=FALSE,
    multi_client_management=FALSE,
    features='["Everything in Builder", "1,000 monthly Scan Credits", "Autopilot", "Sentinel", "Incident Center + Webhooks", "90-day evidence"]'::jsonb
WHERE id='team';

UPDATE subscription_plans
SET scan_credit_mode='monthly',
    monthly_scan_credits=4000,
    max_agents=15,
    history_days=180,
    white_label_reports=TRUE,
    multi_client_management=TRUE,
    features='["Everything in Pro", "4,000 monthly Scan Credits", "White-label reports", "Multi-client management", "180-day evidence"]'::jsonb
WHERE id='agency';

UPDATE workspace_subscriptions
SET renewal_mode='manual'
WHERE renewal_mode IS NULL OR renewal_mode <> 'manual';
