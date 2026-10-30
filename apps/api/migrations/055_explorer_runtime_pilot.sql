UPDATE subscription_plans
SET runtime_firewall=TRUE,
    runtime_decisions_included=100,
    description='Run a small live security pilot on one agent before scaling up.',
    features='["100 monthly Runtime Decisions on 1 agent", "5 essential boundary scenarios", "20 one-time Scan Credits", "7-day evidence"]'::jsonb
WHERE id='free';
