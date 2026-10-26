import { config } from "../../core/config.mjs";
import { withAdvisoryLock } from "../../core/db.mjs";
import * as repository from "../../infrastructure/repository.mjs";
import * as reconciliationRepository from "./reconciliation-repository.mjs";
import { hashGrowthSourceKey, normalizePaymentGrowthProperties } from "../growth-analytics/domain.mjs";
import { recordGrowthEvent } from "../growth-analytics/repository.mjs";
import {
  atomicToUsdt,
  fetchIncomingUsdtTransfers,
  getTronPaymentConfig,
  isMatchingIncomingTransfer,
  usdtCentsToAtomic,
} from "./tron-payment.mjs";
import {
  completeReconciliationRun,
  failReconciliationRun,
  startReconciliationRun,
} from "./reconciliation-repository.mjs";

const PAYMENT_PROVIDER = "tron-p2p";

async function recordPaymentGrowth(checkout, transfer) {
  try {
    await recordGrowthEvent({
      eventName: "business.payment_confirmed",
      workspaceId: checkout.workspaceId,
      sourceKey: hashGrowthSourceKey(`${PAYMENT_PROVIDER}:${transfer.txHash}`),
      properties: normalizePaymentGrowthProperties({
        checkoutType: checkout.checkoutType,
        planId: checkout.planId,
        addonId: checkout.addonId,
        amount: atomicToUsdt(transfer.amountAtomic),
      }),
    });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "growth_payment_record_failed",
      checkoutId: checkout.id,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

function expectedAtomic(checkout) {
  return checkout.paymentAmountAtomic
    ?? usdtCentsToAtomic(Number(checkout.amountUsdCents));
}

function usableTransfer(transfer) {
  let positiveAmount = false;
  try {
    positiveAmount = BigInt(transfer?.amountAtomic ?? 0) > 0n;
  } catch {
    positiveAmount = false;
  }
  return Boolean(
    /^[a-f0-9]{64}$/i.test(transfer?.txHash ?? "")
      && positiveAmount
      && transfer?.timestamp
      && transfer?.confirmed
      && transfer.status !== "REVERT"
      && transfer.status !== "FAILED",
  );
}

function transferEvent(checkout, transfer, walletAddress) {
  return {
    provider: "crypto",
    providerPaymentId: transfer.txHash,
    checkoutSessionId: checkout.id,
    providerCheckoutId: transfer.txHash,
    status: "confirmed",
    amount: atomicToUsdt(transfer.amountAtomic),
    netAmount: atomicToUsdt(transfer.amountAtomic),
    currency: "USDT",
    network: "TRON",
    walletAddress,
    txHash: transfer.txHash,
    confirmations: 1,
    paymentTimestamp: transfer.timestamp.toISOString(),
    rawPayload: transfer.raw,
  };
}

function inInvoiceWindow(transfer, checkout) {
  const createdAt = new Date(checkout.createdAt);
  const expiresAt = checkout.expiresAt ? new Date(checkout.expiresAt) : null;
  return transfer.timestamp >= createdAt && (!expiresAt || transfer.timestamp <= expiresAt);
}

function likelyAmountMismatch(transfer, checkout) {
  try {
    const received = BigInt(transfer.amountAtomic);
    const base = BigInt(usdtCentsToAtomic(Number(checkout.amountUsdCents)));
    return received >= base / 2n && received <= base * 2n;
  } catch {
    return false;
  }
}

function exceptionReason(transfer, candidates, settledCheckoutIds, tron) {
  if (transfer.to !== tron.walletAddress) return { reason: "wrong_recipient", checkout: null };
  if (transfer.contract !== tron.usdtContract || transfer.decimals !== tron.decimals) {
    return { reason: "wrong_token", checkout: null };
  }
  const late = candidates.find((checkout) => {
    if (settledCheckoutIds.has(checkout.id) || checkout.status !== "expired" || !checkout.expiresAt) return false;
    return transfer.timestamp > new Date(checkout.expiresAt)
      && String(expectedAtomic(checkout)) === String(transfer.amountAtomic);
  });
  if (late) return { reason: "late_payment", checkout: late };

  const inWindow = candidates.filter((checkout) => (
    !settledCheckoutIds.has(checkout.id)
      && inInvoiceWindow(transfer, checkout)
      && likelyAmountMismatch(transfer, checkout)
      && String(expectedAtomic(checkout)) !== String(transfer.amountAtomic)
  ));
  if (inWindow.length === 1) {
    const checkout = inWindow[0];
    return {
      reason: BigInt(transfer.amountAtomic) < BigInt(expectedAtomic(checkout)) ? "underpaid" : "overpaid",
      checkout,
    };
  }
  return { reason: "unmatched_order", checkout: null };
}

async function reconcileCryptoPayments() {
  const expired = await reconciliationRepository.expirePendingTronCheckouts();
  const pending = await reconciliationRepository.listPendingTronCheckouts({ limit: config.billingReconciliationBatchSize });

  const tron = getTronPaymentConfig();
  const earliestCreatedAt = pending.reduce((earliest, checkout) => {
    const createdAt = new Date(checkout.createdAt);
    return createdAt < earliest ? createdAt : earliest;
  }, new Date(Date.now() - config.tron.maxLookbackMs));
  const candidates = await reconciliationRepository.listRecentTronCheckoutCandidates({
    sinceMs: earliestCreatedAt.getTime(),
    untilMs: Date.now(),
    limit: Math.max(100, config.billingReconciliationBatchSize * 10),
  });
  const knownHashes = await reconciliationRepository.listKnownTronTransactionHashes({ sinceMs: earliestCreatedAt.getTime() });
  const transfers = await fetchIncomingUsdtTransfers({
    address: tron.walletAddress,
    sinceMs: earliestCreatedAt.getTime(),
    untilMs: Date.now(),
  });

  let completed = 0;
  let exceptions = 0;
  const settledCheckoutIds = new Set();
  for (const transfer of transfers) {
    if (!usableTransfer(transfer) || knownHashes.has(transfer.txHash.toLowerCase())) continue;

    const checkout = candidates.find((candidate) => (
      !settledCheckoutIds.has(candidate.id)
        && isMatchingIncomingTransfer(transfer, {
          address: tron.walletAddress,
          expectedAtomic: expectedAtomic(candidate),
          createdAt: candidate.createdAt,
          expiresAt: candidate.expiresAt,
        })
    ));
    if (checkout) {
      const event = transferEvent(checkout, transfer, tron.walletAddress);
      try {
        const payment = await repository.applyVerifiedCryptoPayment(event, {
          paymentProvider: PAYMENT_PROVIDER,
          confirmedCheckoutStatus: "completed",
        });
        knownHashes.add(transfer.txHash.toLowerCase());
        settledCheckoutIds.add(checkout.id);
        if (payment.duplicate) continue;
        completed += 1;
        await repository.recordAuditEvent({
          workspaceId: checkout.workspaceId,
          actorType: "system",
          action: "billing.payment_reconciled",
          resourceType: "billing_checkout",
          resourceId: checkout.id,
          metadata: { provider: PAYMENT_PROVIDER, txHash: transfer.txHash, amount: event.amount, network: "TRON" },
        });
        await recordPaymentGrowth(checkout, transfer);
        continue;
      } catch (error) {
        console.error(JSON.stringify({
          level: "error",
          event: "billing.payment_reconciliation_failed",
          checkoutId: checkout.id,
          txHash: transfer.txHash,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }

    try {
      const classified = exceptionReason(transfer, candidates, settledCheckoutIds, tron);
      const exception = await repository.recordPaymentException({
        workspaceId: classified.checkout?.workspaceId ?? null,
        checkoutSessionId: classified.checkout?.id ?? null,
        provider: PAYMENT_PROVIDER,
        network: "TRON",
        txHash: transfer.txHash,
        providerPaymentId: transfer.txHash,
        senderAddress: transfer.from,
        recipientAddress: transfer.to,
        tokenContract: transfer.contract,
        amountAtomic: transfer.amountAtomic,
        amountUsdt: atomicToUsdt(transfer.amountAtomic),
        decimals: transfer.decimals,
        transferTimestamp: transfer.timestamp.toISOString(),
        reason: classified.reason,
        rawPayload: transfer.raw,
      });
      knownHashes.add(transfer.txHash.toLowerCase());
      if (exception.status === "open") exceptions += 1;
      if (classified.checkout?.workspaceId) {
        await repository.recordAuditEvent({
          workspaceId: classified.checkout.workspaceId,
          actorType: "system",
          action: "billing.payment_exception_detected",
          resourceType: "billing_payment_exception",
          resourceId: exception.id,
          metadata: { reason: classified.reason, txHash: transfer.txHash, amount: atomicToUsdt(transfer.amountAtomic) },
        });
      }
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "billing.payment_exception_record_failed",
        txHash: transfer.txHash,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  return { expired, scanned: transfers.length, completed, exceptions };
}

export async function processCryptoPaymentReconciliation() {
  const locked = await withAdvisoryLock(config.billingReconciliationLockKey, async () => {
    const run = await startReconciliationRun({
      provider: PAYMENT_PROVIDER,
      metadata: { worker: "api", mode: "polling" },
    });
    try {
      const result = await reconcileCryptoPayments();
      await completeReconciliationRun({
        runId: run.id,
        result,
        metadata: { provider: PAYMENT_PROVIDER, source: "TRON indexed transfers" },
      });
      return { ...result, runId: run.id, skipped: false };
    } catch (error) {
      await failReconciliationRun({
        runId: run.id,
        error,
        metadata: { provider: PAYMENT_PROVIDER },
      }).catch((recordError) => {
        console.error(JSON.stringify({
          level: "error",
          event: "billing.reconciliation_run_record_failed",
          runId: run.id,
          error: recordError instanceof Error ? recordError.message : String(recordError),
        }));
      });
      throw error;
    }
  });
  if (!locked.acquired) {
    return { skipped: true, reason: "reconciliation_lock_busy" };
  }
  return locked.value;
}

export function startPaymentReconciliationWorker() {
  const run = () => processCryptoPaymentReconciliation().catch((error) => {
    console.error(JSON.stringify({
      level: "error",
      event: "billing.payment_reconciliation_unavailable",
      error: error instanceof Error ? error.message : String(error),
    }));
  });
  const timer = setInterval(run, config.billingReconciliationIntervalMs);
  timer.unref?.();
  run();
  return timer;
}
