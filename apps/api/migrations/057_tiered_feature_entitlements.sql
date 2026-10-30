ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS security_contracts BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ai_remediation_copilot BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE subscription_plans
SET security_contracts=FALSE,
    ai_remediation_copilot=FALSE,
    white_label_reports=FALSE,
    multi_client_management=FALSE,
    features='["100 monthly Runtime Decisions on 1 agent", "5 essential boundary scenarios", "9 one-time Scan Credits (one baseline scan)", "7-day evidence"]'::jsonb
WHERE id='free';

UPDATE subscription_plans
SET security_contracts=TRUE,
    ai_remediation_copilot=FALSE,
    white_label_reports=FALSE,
    multi_client_management=FALSE,
    features='["Full 12-scenario red-team suite", "Versioned Security Contracts + attack-path replay", "200 monthly Scan Credits", "Runtime Firewall", "Export-ready reports", "Incident Center", "30-day evidence"]'::jsonb
WHERE id='builder';

UPDATE subscription_plans
SET security_contracts=TRUE,
    ai_remediation_copilot=TRUE,
    white_label_reports=FALSE,
    multi_client_management=FALSE,
    features='["Everything in Builder", "1,000 monthly Scan Credits", "AI Remediation Copilot", "Autopilot", "Sentinel", "Incident Center + Webhooks", "90-day evidence"]'::jsonb
WHERE id='team';

UPDATE subscription_plans
SET security_contracts=TRUE,
    ai_remediation_copilot=TRUE,
    white_label_reports=FALSE,
    multi_client_management=FALSE,
    description='Operate a larger security operation with higher capacity and extended evidence retention.',
    features='["Everything in Pro", "4,000 monthly Scan Credits", "15 protected agents", "25 signed alert routes", "180-day evidence"]'::jsonb
WHERE id='agency';
