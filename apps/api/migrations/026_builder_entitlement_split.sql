UPDATE subscription_plans
SET autopilot=FALSE,
    sentinel=FALSE,
    incident_center=TRUE,
    export_reports=TRUE,
    features='["Full 12-scenario red-team suite", "200 monthly Scan Credits", "Runtime Firewall", "Export-ready reports", "Limited Incident Center", "30-day evidence"]'::jsonb
WHERE id='builder';
