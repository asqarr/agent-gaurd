import { timingSafeEqual } from "node:crypto";

export const TRON_USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
export const TRON_USDT_DECIMALS = 6;
const DEFAULT_GRID_URL = "https://api.trongrid.io";
const DEFAULT_SCAN_URL = "https://apilist.tronscanapi.com";
const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const TX_HASH_PATTERN = /^[a-f0-9]{64}$/i;
const TRON_ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

function configuration() {
  return {
    walletAddress: process.env.MY_TRONLINK_PUBLIC_ADDRESS?.trim() ?? "",
    usdtContract: process.env.TRON_USDT_CONTRACT?.trim() || TRON_USDT_CONTRACT,
    gridUrl: (process.env.TRON_GRID_URL?.trim() || DEFAULT_GRID_URL).replace(/\/$/, ""),
    scanUrl: (process.env.TRONSCAN_API_URL?.trim() || DEFAULT_SCAN_URL).replace(/\/$/, ""),
    apiKey: process.env.TRON_PRO_API_KEY?.trim() ?? "",
    lookbackMs: parseBoundedInteger(process.env.TRON_MAX_LOOKBACK_MS, DEFAULT_LOOKBACK_MS, 60_000, 90 * 24 * 60 * 60 * 1000),
    timeoutMs: parseBoundedInteger(process.env.TRON_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 60_000),
  };
}

function parseBoundedInteger(value, fallback, min, max) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function providerError(message, code = "TRON_PROVIDER_ERROR") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isValidTronAddress(value) {
  return typeof value === "string" && TRON_ADDRESS_PATTERN.test(value);
}

function normalizeUrl(value, name) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS.`);
    return url;
  } catch (error) {
    throw providerError(error instanceof Error ? error.message : `${name} is invalid.`, "TRON_CONFIGURATION_ERROR");
  }
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) return date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeRawAmount(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^\d+$/.test(normalized) ? normalized : null;
}

function normalizeTransfer(item, source) {
  if (!item || typeof item !== "object") return null;
  const tokenInfo = item.token_info ?? item.tokenInfo ?? {};
  const txHash = String(item.transaction_id ?? item.transactionId ?? item.hash ?? item.transactionHash ?? "").trim().toLowerCase();
  const contract = String(
    tokenInfo.address
      ?? tokenInfo.contract_address
      ?? tokenInfo.tokenId
      ?? item.contract_address
      ?? item.contractAddress
      ?? item.trc20Id
      ?? item.id
      ?? "",
  ).trim();
  const timestamp = normalizeTimestamp(
    item.block_timestamp
      ?? item.block_ts
      ?? item.blockTimestamp
      ?? item.timestamp
      ?? item.time,
  );
  const decimals = Number(tokenInfo.decimals ?? item.decimals ?? TRON_USDT_DECIMALS);
  const reverted = item.revert === true
    || item.revert === 1
    || item.revert === "1"
    || String(item.finalResult ?? "").toUpperCase() === "FAIL";
  const status = reverted
    ? "REVERT"
    : String(item.contract_ret ?? item.contractRet ?? item.status ?? "SUCCESS").toUpperCase();

  return {
    txHash,
    from: String(item.from ?? item.from_address ?? item.fromAddress ?? "").trim(),
    to: String(item.to ?? item.to_address ?? item.toAddress ?? "").trim(),
    amountAtomic: normalizeRawAmount(item.value ?? item.quant ?? item.amount),
    contract,
    decimals,
    timestamp,
    confirmed: item.confirmed === undefined
      ? source === "trongrid-confirmed"
      : item.confirmed === true || item.confirmed === 1 || item.confirmed === "true",
    status,
    source,
    raw: item,
  };
}

function responseItems(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.transfers)) return payload.transfers;
  if (Array.isArray(payload.token_transfers)) return payload.token_transfers;
  if (Array.isArray(payload.result)) return payload.result;
  return null;
}

async function fetchJson(url, { apiKey, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(apiKey ? { "TRON-PRO-API-KEY": apiKey, "X-API-KEY": apiKey } : {}),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw providerError("The TRON indexer returned invalid JSON.", "TRON_INVALID_RESPONSE");
    }
    if (!response.ok) {
      throw providerError(`The TRON indexer returned HTTP ${response.status}.`, `TRON_HTTP_${response.status}`);
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") throw providerError("The TRON indexer request timed out.", "TRON_TIMEOUT");
    if (error?.code) throw error;
    throw providerError("The TRON indexer could not be reached.", "TRON_PROVIDER_ERROR");
  } finally {
    clearTimeout(timeout);
  }
}

function isRetryableProviderError(error) {
  return error?.code === "TRON_TIMEOUT"
    || error?.code === "TRON_INVALID_RESPONSE"
    || [401, 403, 404, 429, 500, 502, 503, 504].includes(Number(String(error?.code ?? "").replace("TRON_HTTP_", "")));
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function buildGridUrl({ address, contract, sinceMs, untilMs, baseUrl }) {
  const url = normalizeUrl(baseUrl, "TRON_GRID_URL");
  url.pathname = `/v1/accounts/${encodeURIComponent(address)}/transactions/trc20`;
  url.search = new URLSearchParams({
    only_confirmed: "true",
    limit: "200",
    order_by: "block_timestamp,asc",
    contract_address: contract,
    min_timestamp: String(sinceMs),
    max_timestamp: String(untilMs),
  }).toString();
  return url.toString();
}

function buildScanUrl({ address, contract, sinceMs, untilMs, baseUrl }) {
  const url = normalizeUrl(baseUrl, "TRONSCAN_API_URL");
  url.pathname = "/api/transfer/trc20";
  url.search = new URLSearchParams({
    address,
    trc20Id: contract,
    direction: "2",
    start_timestamp: String(sinceMs),
    end_timestamp: String(untilMs),
    limit: "50",
    reverse: "false",
  }).toString();
  return url.toString();
}

export function getTronPaymentConfig() {
  const current = configuration();
  if (!isValidTronAddress(current.walletAddress)) {
    throw providerError("MY_TRONLINK_PUBLIC_ADDRESS is not a valid TRON address.", "TRON_CONFIGURATION_ERROR");
  }
  if (current.usdtContract !== TRON_USDT_CONTRACT) {
    throw providerError("TRON_USDT_CONTRACT must be the official USDT contract on TRON mainnet.", "TRON_CONFIGURATION_ERROR");
  }
  return Object.freeze({
    walletAddress: current.walletAddress,
    usdtContract: current.usdtContract,
    decimals: TRON_USDT_DECIMALS,
    gridUrl: current.gridUrl,
    scanUrl: current.scanUrl,
  });
}

export function getPublicTronAddress() {
  return getTronPaymentConfig().walletAddress;
}

export function usdtCentsToAtomic(cents) {
  if (!Number.isSafeInteger(Number(cents)) || Number(cents) <= 0) {
    throw providerError("The USDT amount must be a positive integer number of cents.", "TRON_AMOUNT_ERROR");
  }
  return (BigInt(cents) * (10n ** BigInt(TRON_USDT_DECIMALS - 2))).toString();
}

export function usdtToAtomic(value) {
  const normalized = typeof value === "number" ? String(value) : String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,12})?$/.test(normalized)) {
    throw providerError("The USDT amount must use no more than six decimals.", "TRON_AMOUNT_ERROR");
  }
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > TRON_USDT_DECIMALS && /[^0]/.test(fraction.slice(TRON_USDT_DECIMALS))) {
    throw providerError("The USDT amount must use no more than six decimals.", "TRON_AMOUNT_ERROR");
  }
  const atomic = BigInt(whole) * (10n ** BigInt(TRON_USDT_DECIMALS))
    + BigInt(fraction.slice(0, TRON_USDT_DECIMALS).padEnd(TRON_USDT_DECIMALS, "0") || "0");
  if (atomic <= 0n) throw providerError("The USDT amount must be positive.", "TRON_AMOUNT_ERROR");
  return atomic.toString();
}

export function atomicToUsdt(atomic) {
  const value = normalizeRawAmount(atomic);
  if (!value) throw providerError("The on-chain USDT amount is invalid.", "TRON_AMOUNT_ERROR");
  const units = BigInt(value);
  const scale = 10n ** BigInt(TRON_USDT_DECIMALS);
  const whole = units / scale;
  const fraction = (units % scale).toString().padStart(TRON_USDT_DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export async function fetchIncomingUsdtTransfers({
  address = getPublicTronAddress(),
  sinceMs,
  untilMs = Date.now(),
} = {}) {
  const current = configuration();
  if (!isValidTronAddress(address)) throw providerError("The TRON recipient address is invalid.", "TRON_CONFIGURATION_ERROR");
  const end = Math.min(Number(untilMs), Date.now() + 5 * 60 * 1000);
  const start = Math.max(Number(sinceMs ?? (end - current.lookbackMs)), end - current.lookbackMs);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    throw providerError("The TRON payment time window is invalid.", "TRON_TIME_WINDOW_ERROR");
  }
  const contract = current.usdtContract;
  if (contract !== TRON_USDT_CONTRACT) {
    throw providerError("TRON_USDT_CONTRACT must be the official USDT contract on TRON mainnet.", "TRON_CONFIGURATION_ERROR");
  }
  let items;
  let source;
  try {
    const payload = await fetchJson(buildGridUrl({ address, contract, sinceMs: start, untilMs: end, baseUrl: current.gridUrl }), current);
    items = responseItems(payload);
    if (!items) throw providerError("The TRON Grid response has no transfer list.", "TRON_INVALID_RESPONSE");
    source = "trongrid-confirmed";
  } catch (error) {
    if (!isRetryableProviderError(error)) throw error;
    const payload = await fetchJson(buildScanUrl({ address, contract, sinceMs: start, untilMs: end, baseUrl: current.scanUrl }), current);
    items = responseItems(payload);
    if (!items) throw providerError("The TronScan response has no transfer list.", "TRON_INVALID_RESPONSE");
    source = "tronscan";
  }
  return items.map((item) => normalizeTransfer(item, source)).filter(Boolean);
}

function isEligibleIncomingTransfer(transfer, {
  address,
  createdAt,
  now = new Date(),
} = {}) {
  const recipient = String(address ?? "").trim();
  const created = normalizeTimestamp(createdAt);
  const current = normalizeTimestamp(now) ?? new Date();
  const config = configuration();
  if (!isValidTronAddress(recipient) || !created) return false;
  if (!TX_HASH_PATTERN.test(transfer?.txHash ?? "")) return false;
  if (!safeEqual(transfer?.to, recipient)) return false;
  if (!transfer?.from || safeEqual(transfer.from, recipient)) return false;
  if (!safeEqual(transfer.contract, config.usdtContract)) return false;
  if (transfer.decimals !== TRON_USDT_DECIMALS) return false;
  if (!normalizeRawAmount(transfer.amountAtomic) || BigInt(transfer.amountAtomic) <= 0n) return false;
  if (!transfer.timestamp || transfer.timestamp < created) return false;
  if (transfer.timestamp > new Date(current.getTime() + 5 * 60 * 1000)) return false;
  if (!transfer.confirmed || ["REVERT", "FAILED", "FAIL"].includes(transfer.status)) return false;
  return true;
}

export function isEligibleIncomingUsdtTransfer(transfer, options = {}) {
  return isEligibleIncomingTransfer(transfer, options);
}

export function isMatchingIncomingTransfer(transfer, {
  address,
  expectedAtomic,
  createdAt,
  expiresAt,
  now = new Date(),
} = {}) {
  const recipient = String(address ?? "").trim();
  const expected = normalizeRawAmount(expectedAtomic);
  const created = normalizeTimestamp(createdAt);
  const expiry = normalizeTimestamp(expiresAt);
  const current = normalizeTimestamp(now) ?? new Date();
  if (!expected || !isEligibleIncomingTransfer(transfer, { address: recipient, createdAt: created, now: current })) return false;
  if (transfer.amountAtomic !== expected) return false;
  if (expiry && transfer.timestamp > expiry) return false;
  return true;
}

export async function findMatchingIncomingTransfer({
  address = getPublicTronAddress(),
  expectedAtomic,
  createdAt,
  expiresAt,
  now = new Date(),
} = {}) {
  const recipient = String(address ?? "").trim();
  const expected = normalizeRawAmount(expectedAtomic);
  const created = normalizeTimestamp(createdAt);
  const expiry = normalizeTimestamp(expiresAt);
  const current = normalizeTimestamp(now) ?? new Date();
  if (!isValidTronAddress(recipient) || !expected || !created) {
    throw providerError("The TRON payment verification input is invalid.", "TRON_VERIFICATION_INPUT_ERROR");
  }
  const transfers = await fetchIncomingUsdtTransfers({
    address: recipient,
    sinceMs: created.getTime(),
    untilMs: Math.min(expiry?.getTime() ?? current.getTime(), current.getTime()),
  });
  return transfers.find((transfer) => isMatchingIncomingTransfer(transfer, {
    address: recipient,
    expectedAtomic: expected,
    createdAt: created,
    expiresAt: expiry,
    now: current,
  })) ?? null;
}

/**
 * Finds a specific confirmed transfer for the customer-report flow. This is
 * deliberately amount-agnostic: the caller may report an under/overpayment,
 * but the transfer must still be an eligible official USDT-TRC20 transfer to
 * the AgentGuard wallet and must have happened after the checkout was created.
 */
export async function findIncomingTransferByHash({
  address = getPublicTronAddress(),
  txHash,
  createdAt,
  now = new Date(),
} = {}) {
  const normalizedHash = String(txHash ?? "").trim().toLowerCase();
  const recipient = String(address ?? "").trim();
  const created = normalizeTimestamp(createdAt);
  const current = normalizeTimestamp(now) ?? new Date();
  if (!isValidTronAddress(recipient) || !TX_HASH_PATTERN.test(normalizedHash) || !created) {
    throw providerError("The TRON transaction report input is invalid.", "TRON_REPORT_INPUT_ERROR");
  }
  const transfers = await fetchIncomingUsdtTransfers({
    address: recipient,
    sinceMs: created.getTime(),
    untilMs: current.getTime(),
  });
  return transfers.find((transfer) => transfer.txHash === normalizedHash
    && isEligibleIncomingTransfer(transfer, { address: recipient, createdAt: created, now: current })) ?? null;
}

