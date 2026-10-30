UPDATE subscription_plans
SET monthly_scan_credits=9,
    description='Run one five-scenario baseline scan and a small live pilot on one agent before scaling up.',
    features='["100 monthly Runtime Decisions on 1 agent", "5 essential boundary scenarios", "9 one-time Scan Credits (one baseline scan)", "7-day evidence"]'::jsonb
WHERE id='free';
