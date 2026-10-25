CREATE TABLE IF NOT EXISTS billing_payouts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'ironixpay',
  provider_payout_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  amount NUMERIC(30, 12) NOT NULL CHECK (amount > 0),
  fee NUMERIC(30, 12),
  net_amount NUMERIC(30, 12),
  currency TEXT NOT NULL DEFAULT 'USDT',
  network TEXT NOT NULL DEFAULT 'TRON',
  to_address TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  source_payment_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  tx_hash TEXT,
  error_reason TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (provider, provider_payout_id)
);

ALTER TABLE billing_payments
  ADD COLUMN IF NOT EXISTS net_amount NUMERIC(30, 12),
  ADD COLUMN IF NOT EXISTS payout_id TEXT REFERENCES billing_payouts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS billing_payouts_queue_idx
  ON billing_payouts (status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS billing_payouts_provider_idx
  ON billing_payouts (provider, provider_payout_id);

CREATE INDEX IF NOT EXISTS billing_payments_payout_idx
  ON billing_payments (payout_id, status);
