ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS runtime_decisions_included INTEGER NOT NULL DEFAULT 0 CHECK (runtime_decisions_included >= 0);

ALTER TABLE usage_periods
  ADD COLUMN IF NOT EXISTS runtime_decisions_used INTEGER NOT NULL DEFAULT 0 CHECK (runtime_decisions_used >= 0);

UPDATE subscription_plans SET runtime_decisions_included=0 WHERE id='free';
UPDATE subscription_plans SET runtime_decisions_included=10000 WHERE id='builder';
UPDATE subscription_plans SET runtime_decisions_included=100000 WHERE id='team';
UPDATE subscription_plans SET runtime_decisions_included=500000 WHERE id='agency';
