ALTER TABLE billing_addon_catalog
  ADD COLUMN IF NOT EXISTS included_hours INTEGER NOT NULL DEFAULT 0
    CHECK (included_hours >= 0),
  ADD COLUMN IF NOT EXISTS overage_policy TEXT NOT NULL DEFAULT '';

ALTER TABLE billing_service_orders
  ADD COLUMN IF NOT EXISTS included_hours INTEGER NOT NULL DEFAULT 0
    CHECK (included_hours >= 0),
  ADD COLUMN IF NOT EXISTS overage_policy TEXT NOT NULL DEFAULT '';

UPDATE billing_addon_catalog
SET included_hours=3,
    overage_policy='Remediation, integration changes, and work beyond the included time require a separately approved quote.'
WHERE id='security_audit_1';

UPDATE billing_addon_catalog
SET included_hours=2,
    overage_policy='Additional systems, custom development, and ongoing support require a separately approved scope and quote.'
WHERE id='implementation_support_1';
