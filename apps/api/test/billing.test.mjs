import assert from "node:assert/strict";
import test from "node:test";
import { normalizeVerifiedCryptoPayment } from "../src/features/billing/payment-provider.mjs";
import { billingPlans, fullScanCredits, scanCreditsForScenarios, scenariosForPlan } from "../src/features/billing/domain.mjs";
import { atomicToUsdt, findIncomingTransferByHash, findMatchingIncomingTransfer, getTronPaymentConfig, usdtCentsToAtomic } from "../src/features/billing/tron-payment.mjs";

test("crypto payment events are normalized without losing decimal precision", () => {
  const event = normalizeVerifiedCryptoPayment({
    provider: "crypto",
    providerPaymentId: "provider-payment-1",
    checkoutSessionId: "checkout-1",
    providerCheckoutId: "provider-checkout-1",
    status: "confirmed",
    amount: "29.990000000001",
    currency: "USDT",
    network: "TRON",
    txHash: "tx-1",
    confirmations: 12,
    rawPayload: { source: "verified-adapter" },
  });

  assert.equal(event.amount, "29.990000000001");
  assert.equal(event.providerCheckoutId, "provider-checkout-1");
  assert.equal(event.confirmations, 12);
});

test("browser-shaped or unsigned payment data is not accepted by the billing core", () => {
  assert.throws(
    () => normalizeVerifiedCryptoPayment({ provider: "crypto", status: "confirmed", amount: "29.99", currency: "USDT" }),
    { code: "INVALID_PAYMENT_EVENT" },
  );
  assert.throws(
    () => normalizeVerifiedCryptoPayment({ provider: "stripe", providerPaymentId: "x", status: "confirmed", amount: "29.99", currency: "USDT" }),
    { code: "INVALID_PAYMENT_EVENT" },
  );
});

test("direct TRON amounts use exact USDT six-decimal atomic units", () => {
  assert.equal(usdtCentsToAtomic(4900), "49000000");
  assert.equal(usdtCentsToAtomic(14900), "149000000");
  assert.equal(atomicToUsdt("49000000"), "49");
  assert.equal(atomicToUsdt("123456"), "0.123456");
});

test("direct TRON payments reject a non-official token contract", () => {
  const previousAddress = process.env.MY_TRONLINK_PUBLIC_ADDRESS;
  const previousContract = process.env.TRON_USDT_CONTRACT;
  process.env.MY_TRONLINK_PUBLIC_ADDRESS = "TDg6Vo6pkvKLy1jPpD4LBSLa3EwrVEk2JP";
  process.env.TRON_USDT_CONTRACT = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
  try {
    assert.throws(() => getTronPaymentConfig(), { code: "TRON_CONFIGURATION_ERROR" });
  } finally {
    if (previousAddress === undefined) delete process.env.MY_TRONLINK_PUBLIC_ADDRESS;
    else process.env.MY_TRONLINK_PUBLIC_ADDRESS = previousAddress;
    if (previousContract === undefined) delete process.env.TRON_USDT_CONTRACT;
    else process.env.TRON_USDT_CONTRACT = previousContract;
  }
});

test("direct TRON verification accepts only an exact confirmed incoming USDT transfer", async () => {
  const originalFetch = globalThis.fetch;
  const address = "TDg6Vo6pkvKLy1jPpD4LBSLa3EwrVEk2JP";
  const contract = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  const createdAt = new Date(Date.now() - 60_000);
  process.env.MY_TRONLINK_PUBLIC_ADDRESS = address;
  process.env.TRON_USDT_CONTRACT = contract;
  process.env.TRON_GRID_URL = "https://grid.test";
  process.env.TRONSCAN_API_URL = "https://scan.test";
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [
    { transaction_id: "a".repeat(64), token_info: { address: contract, decimals: 6 }, from: "Tsender", to: address, value: "49000001", block_timestamp: Date.now(), confirmed: true },
    { transaction_id: "b".repeat(64), token_info: { address: contract, decimals: 6 }, from: "Tsender", to: address, value: "49000000", block_timestamp: Date.now(), confirmed: true },
  ] }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const transfer = await findMatchingIncomingTransfer({ address, expectedAtomic: "49000000", createdAt, expiresAt: new Date(Date.now() + 600_000) });
    assert.equal(transfer?.txHash, "b".repeat(64));
    assert.equal(transfer?.amountAtomic, "49000000");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.MY_TRONLINK_PUBLIC_ADDRESS;
    delete process.env.TRON_USDT_CONTRACT;
    delete process.env.TRON_GRID_URL;
    delete process.env.TRONSCAN_API_URL;
  }
});

test("direct TRON verification falls back to TronScan and rejects transfers before the invoice", async () => {
  const originalFetch = globalThis.fetch;
  const address = "TDg6Vo6pkvKLy1jPpD4LBSLa3EwrVEk2JP";
  const contract = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  const createdAt = new Date(Date.now() - 60_000);
  let calls = 0;
  process.env.MY_TRONLINK_PUBLIC_ADDRESS = address;
  process.env.TRON_USDT_CONTRACT = contract;
  process.env.TRON_GRID_URL = "https://grid.test";
  process.env.TRONSCAN_API_URL = "https://scan.test";
  globalThis.fetch = async (url) => {
    calls += 1;
    if (String(url).startsWith("https://grid.test")) return new Response("rate limited", { status: 429 });
    return new Response(JSON.stringify({ data: [
      { hash: "c".repeat(64), id: contract, from: "Tsender", to: address, amount: "49000000", block_timestamp: createdAt.getTime() - 1, confirmed: 1, revert: 0, contract_ret: "SUCCESS" },
    ] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const transfer = await findMatchingIncomingTransfer({ address, expectedAtomic: "49000000", createdAt, expiresAt: new Date(Date.now() + 600_000) });
    assert.equal(calls, 2);
    assert.equal(transfer, null);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.MY_TRONLINK_PUBLIC_ADDRESS;
    delete process.env.TRON_USDT_CONTRACT;
    delete process.env.TRON_GRID_URL;
    delete process.env.TRONSCAN_API_URL;
  }
});

test("direct TRON verification accepts the current TronScan transfer shape", async () => {
  const originalFetch = globalThis.fetch;
  const address = "TDg6Vo6pkvKLy1jPpD4LBSLa3EwrVEk2JP";
  const contract = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  const createdAt = new Date(Date.now() - 60_000);
  process.env.MY_TRONLINK_PUBLIC_ADDRESS = address;
  process.env.TRON_USDT_CONTRACT = contract;
  process.env.TRON_GRID_URL = "https://grid.test";
  process.env.TRONSCAN_API_URL = "https://scan.test";
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("https://grid.test")) return new Response("rate limited", { status: 429 });
    return new Response(JSON.stringify({ data: [
      {
        hash: "f".repeat(64),
        id: contract,
        from: "Tsender",
        to: address,
        amount: "49000000",
        block_timestamp: Date.now(),
        confirmed: 1,
        revert: 0,
        finalResult: "SUCCESS",
        contract_ret: "SUCCESS",
        decimals: 6,
      },
    ] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const transfer = await findMatchingIncomingTransfer({
      address,
      expectedAtomic: "49000000",
      createdAt,
      expiresAt: new Date(Date.now() + 600_000),
    });
    assert.equal(transfer?.txHash, "f".repeat(64));
    assert.equal(transfer?.contract, contract);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.MY_TRONLINK_PUBLIC_ADDRESS;
    delete process.env.TRON_USDT_CONTRACT;
    delete process.env.TRON_GRID_URL;
    delete process.env.TRONSCAN_API_URL;
  }
});

test("direct TRON verification does not trust an unconfirmed TronScan transfer", async () => {
  const originalFetch = globalThis.fetch;
  const address = "TDg6Vo6pkvKLy1jPpD4LBSLa3EwrVEk2JP";
  const contract = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  process.env.MY_TRONLINK_PUBLIC_ADDRESS = address;
  process.env.TRON_USDT_CONTRACT = contract;
  process.env.TRON_GRID_URL = "https://grid.test";
  process.env.TRONSCAN_API_URL = "https://scan.test";
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("https://grid.test")) return new Response("rate limited", { status: 429 });
    return new Response(JSON.stringify({ data: [
      { hash: "h".repeat(64), id: contract, from: "Tsender", to: address, amount: "49000000", block_timestamp: Date.now(), contract_ret: "SUCCESS" },
    ] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const transfer = await findMatchingIncomingTransfer({
      address,
      expectedAtomic: "49000000",
      createdAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 600_000),
    });
    assert.equal(transfer, null);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.MY_TRONLINK_PUBLIC_ADDRESS;
    delete process.env.TRON_USDT_CONTRACT;
    delete process.env.TRON_GRID_URL;
    delete process.env.TRONSCAN_API_URL;
  }
});

test("direct TRON payment reports can locate a confirmed wrong-amount transfer for review", async () => {
  const originalFetch = globalThis.fetch;
  const address = "TDg6Vo6pkvKLy1jPpD4LBSLa3EwrVEk2JP";
  const contract = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  process.env.MY_TRONLINK_PUBLIC_ADDRESS = address;
  process.env.TRON_USDT_CONTRACT = contract;
  process.env.TRON_GRID_URL = "https://grid.test";
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [
    { transaction_id: "a".repeat(64), token_info: { address: contract, decimals: 6 }, from: "Tsender", to: address, value: "48000000", block_timestamp: Date.now(), confirmed: true },
  ] }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const transfer = await findIncomingTransferByHash({
      address,
      txHash: "a".repeat(64),
      createdAt: new Date(Date.now() - 60_000),
    });
    assert.equal(transfer?.amountAtomic, "48000000");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.MY_TRONLINK_PUBLIC_ADDRESS;
    delete process.env.TRON_USDT_CONTRACT;
    delete process.env.TRON_GRID_URL;
  }
});

test("direct TRON verification rejects TronScan reverted transfers", async () => {
  const originalFetch = globalThis.fetch;
  const address = "TDg6Vo6pkvKLy1jPpD4LBSLa3EwrVEk2JP";
  const contract = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  process.env.MY_TRONLINK_PUBLIC_ADDRESS = address;
  process.env.TRON_USDT_CONTRACT = contract;
  process.env.TRON_GRID_URL = "https://grid.test";
  process.env.TRONSCAN_API_URL = "https://scan.test";
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("https://grid.test")) return new Response("rate limited", { status: 429 });
    return new Response(JSON.stringify({ data: [
      {
        hash: "g".repeat(64),
        id: contract,
        from: "Tsender",
        to: address,
        amount: "49000000",
        block_timestamp: Date.now(),
        confirmed: 1,
        revert: 1,
        finalResult: "FAIL",
      },
    ] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const transfer = await findMatchingIncomingTransfer({
      address,
      expectedAtomic: "49000000",
      createdAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 600_000),
    });
    assert.equal(transfer, null);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.MY_TRONLINK_PUBLIC_ADDRESS;
    delete process.env.TRON_USDT_CONTRACT;
    delete process.env.TRON_GRID_URL;
    delete process.env.TRONSCAN_API_URL;
  }
});

test("direct TRON amount conversion rejects unsafe or non-positive values", () => {
  assert.throws(() => usdtCentsToAtomic(0), { code: "TRON_AMOUNT_ERROR" });
  assert.throws(() => usdtCentsToAtomic(-1), { code: "TRON_AMOUNT_ERROR" });
  assert.throws(() => usdtCentsToAtomic(1.5), { code: "TRON_AMOUNT_ERROR" });
});

test("direct TRON verification rejects unconfirmed and reverted transfers", async () => {
  const originalFetch = globalThis.fetch;
  const address = "TDg6Vo6pkvKLy1jPpD4LBSLa3EwrVEk2JP";
  const contract = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  process.env.MY_TRONLINK_PUBLIC_ADDRESS = address;
  process.env.TRON_USDT_CONTRACT = contract;
  process.env.TRON_GRID_URL = "https://grid.test";
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [
    { transaction_id: "d".repeat(64), token_info: { address: contract, decimals: 6 }, from: "Tsender", to: address, value: "49000000", block_timestamp: Date.now(), confirmed: false },
    { transaction_id: "e".repeat(64), token_info: { address: contract, decimals: 6 }, from: "Tsender", to: address, value: "49000000", block_timestamp: Date.now(), confirmed: true, contract_ret: "REVERT" },
  ] }), { status: 200 });
  try {
    assert.equal(await findMatchingIncomingTransfer({ address, expectedAtomic: "49000000", createdAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 600_000) }), null);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.MY_TRONLINK_PUBLIC_ADDRESS;
    delete process.env.TRON_USDT_CONTRACT;
    delete process.env.TRON_GRID_URL;
  }
});

test("verified crypto events retain an on-chain payment timestamp", () => {
  const event = normalizeVerifiedCryptoPayment({
    provider: "crypto",
    providerPaymentId: "tron-tx-1",
    status: "confirmed",
    amount: "49",
    currency: "USDT",
    paymentTimestamp: "2026-10-25T10:00:00.000Z",
  });
  assert.equal(event.paymentTimestamp, "2026-10-25T10:00:00.000Z");
});

test("advanced plans scale security depth and operational entitlements", () => {
  assert.deepEqual(billingPlans.map((plan) => plan.id), ["free", "builder", "team", "agency"]);
  const explorer = billingPlans[0];
  const builder = billingPlans[1];
  const pro = billingPlans[2];
  const agency = billingPlans[3];

  assert.equal(scenariosForPlan(explorer).length, 5);
  assert.equal(scanCreditsForScenarios(scenariosForPlan(explorer)), 9);
  assert.equal(explorer.monthlyScanCredits, 20);
  assert.equal(explorer.scanCreditMode, "one_time");
  assert.equal(scenariosForPlan(builder).length, 12);
  assert.equal(builder.monthlyScanCredits, 200);
  assert.equal(builder.maxAgents, 2);
  assert.equal(builder.autopilot, false);
  assert.equal(builder.sentinel, false);
  assert.equal(builder.incidentCenter, true);
  assert.equal(builder.exportReports, true);
  assert.equal(builder.alertWebhooks, false);
  assert.equal(pro.alertWebhooks, true);
  assert.equal(pro.maxWebhooks, 3);
  assert.equal(pro.monthlyScanCredits, 1000);
  assert.equal(agency.maxAgents, 15);
  assert.equal(agency.monthlyScanCredits, 4000);
  assert.equal(agency.whiteLabelReports, true);
  assert.equal(agency.multiClientManagement, true);
  assert.equal(agency.maxWebhooks, 25);
  assert.ok(pro.priceUsdCents < agency.priceUsdCents);
});

test("scan capacity messaging has an explicit full-suite baseline", () => {
  assert.equal(fullScanCredits, 30);
  assert.equal(Math.floor(billingPlans[0].monthlyScanCredits / scanCreditsForScenarios(scenariosForPlan(billingPlans[0]))), 2);
  assert.equal(Math.floor(billingPlans[1].monthlyScanCredits / fullScanCredits), 6);
  assert.equal(Math.floor(billingPlans[2].monthlyScanCredits / fullScanCredits), 33);
  assert.equal(Math.floor(billingPlans[3].monthlyScanCredits / fullScanCredits), 133);
  assert.equal(billingPlans[2].priceUsdCents, 14900);
});
