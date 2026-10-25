ALTER TABLE billing_checkout_sessions
  DROP CONSTRAINT IF EXISTS billing_checkout_sessions_status_check;

ALTER TABLE billing_checkout_sessions
  ADD CONSTRAINT billing_checkout_sessions_status_check
  CHECK (status IN ('created', 'waiting', 'awaiting_payment', 'confirming', 'paid', 'completed', 'expired', 'canceled', 'failed'));

CREATE INDEX IF NOT EXISTS billing_checkout_sessions_direct_tron_idx
  ON billing_checkout_sessions (workspace_id, status, created_at DESC)
  WHERE provider = 'tron-p2p';

