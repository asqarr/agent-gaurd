ALTER TABLE billing_checkout_sessions
  ADD COLUMN IF NOT EXISTS payment_amount_atomic NUMERIC(78, 0);

ALTER TABLE billing_checkout_sessions
  DROP CONSTRAINT IF EXISTS billing_checkout_sessions_payment_amount_atomic_check;

ALTER TABLE billing_checkout_sessions
  ADD CONSTRAINT billing_checkout_sessions_payment_amount_atomic_check
  CHECK (payment_amount_atomic IS NULL OR payment_amount_atomic > 0);

-- Every active direct TRON checkout receives a unique six-decimal USDT quote.
-- Completed and expired quotes may be reused because the payment time window
-- prevents an old transfer from matching a later invoice.
CREATE UNIQUE INDEX IF NOT EXISTS billing_checkout_sessions_tron_quote_uidx
  ON billing_checkout_sessions (provider, payment_amount_atomic)
  WHERE provider = 'tron-p2p'
    AND payment_amount_atomic IS NOT NULL
    AND status IN ('waiting', 'awaiting_payment', 'confirming');

CREATE INDEX IF NOT EXISTS billing_checkout_sessions_tron_reconciliation_idx
  ON billing_checkout_sessions (status, expires_at, created_at)
  WHERE provider = 'tron-p2p' AND status IN ('waiting', 'awaiting_payment', 'confirming');
