CREATE TABLE IF NOT EXISTS billing_payment_exceptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  checkout_session_id TEXT REFERENCES billing_checkout_sessions(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'tron-p2p',
  network TEXT NOT NULL DEFAULT 'TRON',
  tx_hash TEXT NOT NULL,
  provider_payment_id TEXT,
  sender_address TEXT,
  recipient_address TEXT,
  token_contract TEXT,
  amount_atomic NUMERIC(78, 0) NOT NULL CHECK (amount_atomic > 0),
  amount_usdt NUMERIC(30, 12) NOT NULL CHECK (amount_usdt > 0),
  decimals INTEGER NOT NULL DEFAULT 6 CHECK (decimals > 0 AND decimals <= 18),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  transfer_timestamp TIMESTAMPTZ,
  reason TEXT NOT NULL CHECK (reason IN (
    'underpaid', 'overpaid', 'late_payment', 'unmatched_order',
    'wrong_token', 'wrong_recipient', 'duplicate_transaction', 'manual_review'
  )),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'assigned', 'refund_required', 'refunded', 'resolved', 'ignored'
  )),
  resolution_note TEXT,
  resolved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, network, tx_hash)
);

CREATE INDEX IF NOT EXISTS billing_payment_exceptions_workspace_idx
  ON billing_payment_exceptions (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS billing_payment_exceptions_status_idx
  ON billing_payment_exceptions (status, detected_at DESC);

CREATE INDEX IF NOT EXISTS billing_payment_exceptions_checkout_idx
  ON billing_payment_exceptions (checkout_session_id, created_at DESC);

