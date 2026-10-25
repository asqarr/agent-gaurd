ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS scenario_limit INTEGER NOT NULL DEFAULT 5 CHECK (scenario_limit > 0),
  ADD COLUMN IF NOT EXISTS autopilot BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sentinel BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS incident_center BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS alert_webhooks BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS export_reports BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS max_webhooks INTEGER NOT NULL DEFAULT 0 CHECK (max_webhooks >= 0);

ALTER TABLE scans
  ADD COLUMN IF NOT EXISTS scenario_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE subscription_plans
SET name='Explorer',
    description='Start with one agent and the essential security boundary suite.',
    price_usd_cents=0,
    max_agents=1,
    monthly_scan_credits=30,
    history_days=7,
    seat_limit=1,
    runtime_firewall=FALSE,
    scenario_limit=5,
    autopilot=FALSE,
    sentinel=FALSE,
    incident_center=FALSE,
    alert_webhooks=FALSE,
    export_reports=FALSE,
    max_webhooks=0,
    features='["5 essential boundary scenarios", "1 protected agent", "7-day evidence"]'::jsonb
WHERE id='free';

UPDATE subscription_plans
SET name='Builder',
    description='Ship safer agents with the full adversarial suite and live controls.',
    price_usd_cents=3900,
    max_agents=3,
    monthly_scan_credits=600,
    history_days=90,
    seat_limit=3,
    runtime_firewall=TRUE,
    scenario_limit=12,
    autopilot=TRUE,
    sentinel=TRUE,
    incident_center=TRUE,
    alert_webhooks=FALSE,
    export_reports=FALSE,
    max_webhooks=0,
    features='["Full 12-scenario red-team suite", "Runtime Firewall", "Autopilot protection blueprint", "Sentinel drift monitoring", "90-day evidence"]'::jsonb
WHERE id='builder';

UPDATE subscription_plans
SET name='Pro',
    description='Run security operations across a growing production agent fleet.',
    price_usd_cents=12900,
    max_agents=10,
    monthly_scan_credits=3000,
    history_days=365,
    seat_limit=10,
    runtime_firewall=TRUE,
    scenario_limit=12,
    autopilot=TRUE,
    sentinel=TRUE,
    incident_center=TRUE,
    alert_webhooks=TRUE,
    export_reports=TRUE,
    max_webhooks=3,
    features='["Everything in Builder", "Incident Center + signed webhooks", "10-agent fleet", "10 operator seats", "365-day evidence"]'::jsonb
WHERE id='team';

INSERT INTO subscription_plans
  (id, name, description, billing_interval, price_usd_cents, max_agents, monthly_scan_credits, history_days, seat_limit, runtime_firewall, scenario_limit, autopilot, sentinel, incident_center, alert_webhooks, export_reports, max_webhooks, features)
VALUES
  ('agency', 'Agency', 'Operate a larger multi-agent security operation from one control plane.', 'month', 29900, 30, 12000, 730, 25, TRUE, 12, TRUE, TRUE, TRUE, TRUE, TRUE, 25, '["Everything in Pro", "30-agent fleet", "25 operator seats", "25 signed alert routes", "730-day evidence"]'::jsonb)
ON CONFLICT (id) DO UPDATE SET
  name=EXCLUDED.name,
  description=EXCLUDED.description,
  price_usd_cents=EXCLUDED.price_usd_cents,
  max_agents=EXCLUDED.max_agents,
  monthly_scan_credits=EXCLUDED.monthly_scan_credits,
  history_days=EXCLUDED.history_days,
  seat_limit=EXCLUDED.seat_limit,
  runtime_firewall=EXCLUDED.runtime_firewall,
  scenario_limit=EXCLUDED.scenario_limit,
  autopilot=EXCLUDED.autopilot,
  sentinel=EXCLUDED.sentinel,
  incident_center=EXCLUDED.incident_center,
  alert_webhooks=EXCLUDED.alert_webhooks,
  export_reports=EXCLUDED.export_reports,
  max_webhooks=EXCLUDED.max_webhooks,
  features=EXCLUDED.features,
  active=TRUE;
