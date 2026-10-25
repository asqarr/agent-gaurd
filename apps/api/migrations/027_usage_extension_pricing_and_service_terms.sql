ALTER TABLE billing_addon_catalog
  ADD COLUMN IF NOT EXISTS service_scope TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS delivery_window TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS acceptance_terms TEXT NOT NULL DEFAULT '';

UPDATE billing_addon_catalog
SET price_usd_cents=2900,
    description='One-time extra scan capacity. Never renews automatically, never expires, and remains available after a plan renewal.',
    service_scope='',
    delivery_window='',
    acceptance_terms=''
WHERE id='scan_credits_1000';

UPDATE billing_addon_catalog
SET price_usd_cents=2900,
    description='One-time extra Runtime Firewall capacity. Never renews automatically, never expires, and remains available after a plan renewal.',
    service_scope='',
    delivery_window='',
    acceptance_terms=''
WHERE id='runtime_decisions_100000';

UPDATE billing_addon_catalog
SET price_usd_cents=24900,
    description='A scoped human-led security review for one Agent. Payment starts a defined service engagement, not an unlimited support promise.',
    service_scope='One Agent, one endpoint, the 12-scenario suite, relevant Attack Paths, Policy review, and one shareable report. Integration changes and remediation are excluded.',
    delivery_window='Report delivery target: within 3 business days after the required access and scope details are provided.',
    acceptance_terms='The engagement is accepted when the scoped report contains reproducible Evidence, severity, reproduction steps, expected versus actual behavior, and remediation guidance.'
WHERE id='security_audit_1';

UPDATE billing_addon_catalog
SET price_usd_cents=19900,
    description='A separately scoped implementation engagement. It is not included in any subscription and does not renew automatically.',
    service_scope='One written setup or integration scope agreed before work begins. Ongoing support, custom development, and additional systems require a new scope.',
    delivery_window='Scheduling and delivery are agreed after the scope is reviewed and accepted.',
    acceptance_terms='The engagement is accepted when the agreed setup checklist or handoff artifact is delivered. Production changes remain the customer''s responsibility unless explicitly scoped.'
WHERE id='implementation_support_1';

UPDATE billing_addon_catalog
SET description='Adds one Agent slot for the current paid period. Renewal is manual and the slot expires with that period.',
    service_scope='',
    delivery_window='',
    acceptance_terms=''
WHERE id='agent_slot_1';

UPDATE billing_addon_catalog
SET description='One-time extra Runtime Firewall capacity. Never renews automatically, never expires, and remains available after a plan renewal.',
    service_scope='',
    delivery_window='',
    acceptance_terms=''
WHERE id='runtime_decisions_10000';

UPDATE billing_addon_catalog
SET description='One-time extra scan capacity. Never renews automatically, never expires, and remains available after a plan renewal.',
    service_scope='',
    delivery_window='',
    acceptance_terms=''
WHERE id='scan_credits_200';
