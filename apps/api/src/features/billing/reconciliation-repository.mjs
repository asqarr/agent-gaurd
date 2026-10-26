import { randomUUID } from "node:crypto";
import { query } from "../../core/db.mjs";
import { config } from "../../core/config.mjs";
import { atomicToUsdt } from "./tron-payment.mjs";

function mapCheckoutSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    planId: row.plan_id,
    checkoutType: row.checkout_type ?? "plan",
    addonId: row.addon_id ?? null,
    provider: row.provider,
    status: row.status,
    providerCheckoutId: row.provider_checkout_id,
    amountUsdCents: row.amount_usd_cents,
    paymentAmountAtomic: row.payment_amount_atomic === null || row.payment_amount_atomic === undefined
      ? null
      : String(row.payment_amount_atomic),
    paymentAmountUsdt: row.payment_amount_atomic === null || row.payment_amount_atomic === undefined
      ? null
      : atomicToUsdt(String(row.payment_amount_atomic)),
    quoteAmount: row.quote_amount,
    quoteCurrency: row.quote_currency,
    network: row.network,
    payAddress: row.pay_address,
    expiresAt: row.expires_at,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listPendingTronCheckouts({ limit = 20 } = {}) {
  const result = await query(
    `SELECT * FROM billing_checkout_sessions
     WHERE provider='tron-p2p'
       AND status IN ('waiting', 'awaiting_payment', 'confirming')
       AND expires_at IS NOT NULL
       AND expires_at > NOW()
     ORDER BY created_at ASC
     LIMIT $1`,
    [Math.max(1, Math.min(Number(limit) || 20, 100))],
  );
  return result.rows.map(mapCheckoutSession);
}

export async function listRecentTronCheckoutCandidates({ sinceMs, untilMs = Date.now(), limit = 500 } = {}) {
  const start = new Date(Number(sinceMs));
  const end = new Date(Number(untilMs));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  const result = await query(
    `SELECT * FROM billing_checkout_sessions
     WHERE provider='tron-p2p'
       AND status IN ('waiting', 'awaiting_payment', 'confirming', 'expired')
       AND created_at <= $2
       AND created_at >= $1
     ORDER BY created_at ASC
     LIMIT $3`,
    [start, end, Math.max(1, Math.min(Number(limit) || 500, 1000))],
  );
  return result.rows.map(mapCheckoutSession);
}

export async function listKnownTronTransactionHashes({ sinceMs } = {}) {
  const start = new Date(Number(sinceMs));
  if (Number.isNaN(start.getTime())) return new Set();
  const result = await query(
    `SELECT tx_hash
     FROM billing_payments
     WHERE network='TRON' AND tx_hash IS NOT NULL AND created_at >= $1
     UNION
     SELECT tx_hash
     FROM billing_payment_exceptions
     WHERE network='TRON' AND tx_hash IS NOT NULL AND created_at >= $1`,
    [start],
  );
  return new Set(result.rows.map((row) => String(row.tx_hash).toLowerCase()));
}

export async function expirePendingTronCheckouts() {
  const result = await query(
    `UPDATE billing_checkout_sessions
     SET status='expired', updated_at=NOW()
     WHERE provider='tron-p2p'
       AND status IN ('waiting', 'awaiting_payment', 'confirming')
       AND expires_at IS NOT NULL
       AND expires_at <= NOW()
     RETURNING id`,
  );
  return result.rowCount;
}

export async function startReconciliationRun({
  provider = "tron-p2p",
  metadata = {},
  retentionDays = config.billingReconciliationRunRetentionDays,
} = {}) {
  await query(
    `DELETE FROM billing_reconciliation_runs
     WHERE provider=$1
       AND started_at < NOW() - ($2::double precision * INTERVAL '1 day')`,
    [provider, retentionDays],
  );
  const id = `reconciliation-${randomUUID()}`;
  const result = await query(
    `INSERT INTO billing_reconciliation_runs (id, provider, status, metadata)
     VALUES ($1, $2, 'running', $3::jsonb)
     RETURNING *`,
    [id, provider, JSON.stringify(metadata ?? {})],
  );
  return result.rows[0];
}

export async function completeReconciliationRun({ runId, result, metadata = {} }) {
  const summary = result ?? {};
  const updated = await query(
    `UPDATE billing_reconciliation_runs
     SET status='completed', finished_at=NOW(), scanned_count=$2,
         completed_count=$3, exception_count=$4, expired_count=$5,
         metadata=$6::jsonb
     WHERE id=$1
     RETURNING *`,
    [
      runId,
      Math.max(0, Number(summary.scanned) || 0),
      Math.max(0, Number(summary.completed) || 0),
      Math.max(0, Number(summary.exceptions) || 0),
      Math.max(0, Number(summary.expired) || 0),
      JSON.stringify(metadata ?? {}),
    ],
  );
  return updated.rows[0] ?? null;
}

export async function failReconciliationRun({ runId, error, metadata = {} }) {
  const updated = await query(
    `UPDATE billing_reconciliation_runs
     SET status='failed', finished_at=NOW(), error=$2, metadata=$3::jsonb
     WHERE id=$1
     RETURNING *`,
    [runId, String(error instanceof Error ? error.message : error).slice(0, 2000), JSON.stringify(metadata ?? {})],
  );
  return updated.rows[0] ?? null;
}
