import { config } from "../../core/config.mjs";
import * as repository from "../../infrastructure/repository.mjs";
import { hashGrowthSourceKey, normalizePaymentGrowthProperties } from "../growth-analytics/domain.mjs";
import { recordGrowthEvent } from "../growth-analytics/repository.mjs";
import {
  atomicToUsdt,
  fetchIncomingUsdtTransfers,
  getTronPaymentConfig,
  isMatchingIncomingTransfer,
  usdtCentsToAtomic,
} from "./tron-payment.mjs";

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
  return Boolean(
    transfer?.txHash
      && transfer?.amountAtomic
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

function exceptionReason(transfer, candidates, settledCheckoutIds) {
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

export async function processCryptoPaymentReconciliation() {
  const expired = await repository.expirePendingTronCheckouts();
  const pending = await repository.listPendingTronCheckouts({ limit: config.billingReconciliationBatchSize });

  const tron = getTronPaymentConfig();
  const earliestCreatedAt = pending.reduce((earliest, checkout) => {
    const createdAt = new Date(checkout.createdAt);
    return createdAt < earliest ? createdAt : earliest;
  }, new Date(Date.now() - config.tron.maxLookbackMs));
  const candidates = await repository.listRecentTronCheckoutCandidates({
    sinceMs: earliestCreatedAt.getTime(),
    untilMs: Date.now(),
    limit: Math.max(100, config.billingReconciliationBatchSize * 10),
  });
  const knownHashes = await repository.listKnownTronTransactionHashes({ sinceMs: earliestCreatedAt.getTime() });
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
      const classified = exceptionReason(transfer, candidates, settledCheckoutIds);
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
