DROP INDEX IF EXISTS billing_checkout_sessions_tron_quote_uidx;

CREATE UNIQUE INDEX billing_checkout_sessions_tron_quote_uidx
  ON billing_checkout_sessions (provider, payment_amount_atomic)
  WHERE provider = 'tron-p2p'
    AND payment_amount_atomic IS NOT NULL
    AND status IN ('waiting', 'awaiting_payment', 'confirming');
