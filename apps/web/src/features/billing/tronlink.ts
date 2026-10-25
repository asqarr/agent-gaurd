type TronProvider = {
  isTronLink?: boolean;
  tronWeb?: TronWebLike | false;
  request: (request: { method: string; params?: unknown }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

type TronWebLike = {
  ready?: boolean;
  defaultAddress?: { base58?: string };
  fullNode?: { host?: string };
  trx: {
    getBalance: (address: string) => Promise<number>;
  };
  contract: () => {
    at: (address: string) => Promise<Trc20Contract>;
  };
};

type Trc20Contract = {
  balanceOf: (address: string) => { call: () => Promise<unknown> };
  transfer: (recipient: string, amountAtomic: string) => {
    send: (options: {
      feeLimit: number;
      callValue: number;
      shouldPollResponse: boolean;
    }) => Promise<unknown>;
  };
};

declare global {
  interface Window {
    tron?: TronProvider;
    tronLink?: TronProvider;
  }
}

export type TronLinkWallet = {
  provider: TronProvider;
  tronWeb: TronWebLike;
  address: string;
};

function providerFromAnnouncement(event: Event) {
  const detail = (event as CustomEvent<{ provider?: TronProvider }>).detail;
  return detail?.provider;
}

async function discoverProvider(timeoutMs = 800): Promise<TronProvider | null> {
  if (window.tron?.request) return window.tron;
  if (window.tronLink?.request) return window.tronLink;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (provider: TronProvider | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("TIP6963:announceProvider", handleAnnouncement);
      window.clearTimeout(timer);
      resolve(provider);
    };
    const handleAnnouncement = (event: Event) => finish(providerFromAnnouncement(event) ?? null);
    const timer = window.setTimeout(() => finish(window.tron ?? window.tronLink ?? null), timeoutMs);
    window.addEventListener("TIP6963:announceProvider", handleAnnouncement);
    window.dispatchEvent(new Event("TIP6963:requestProvider"));
  });
}

export function tronLinkErrorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return "The TronLink request could not be completed.";
}

function isUnsupportedRequest(error: unknown) {
  return error && typeof error === "object" && "code" in error && Number(error.code) === 4200;
}

async function requestAccounts(provider: TronProvider) {
  try {
    const result = await provider.request({ method: "eth_requestAccounts" });
    if (Array.isArray(result) && typeof result[0] === "string") return result[0];
  } catch (error) {
    if (!isUnsupportedRequest(error)) throw error;
  }

  const legacyResult = await provider.request({ method: "tron_requestAccounts" });
  if (legacyResult && typeof legacyResult === "object" && "code" in legacyResult && Number(legacyResult.code) !== 200) {
    throw new Error(String((legacyResult as { message?: unknown }).message ?? "TronLink connection was not approved."));
  }
  const address = provider.tronWeb && typeof provider.tronWeb !== "boolean"
    ? provider.tronWeb.defaultAddress?.base58
    : undefined;
  if (!address) throw new Error("TronLink did not return an approved wallet address.");
  return address;
}

export async function connectTronLink(): Promise<TronLinkWallet> {
  const provider = await discoverProvider();
  if (!provider) throw new Error("TronLink was not detected. Install the TronLink browser extension or use the manual wallet option.");
  const approvedAddress = await requestAccounts(provider);
  const tronWeb = provider.tronWeb && typeof provider.tronWeb !== "boolean" ? provider.tronWeb : null;
  const address = tronWeb?.defaultAddress?.base58 ?? approvedAddress;
  if (!tronWeb || !tronWeb.ready || !address) throw new Error("Unlock TronLink and approve this site, then try again.");
  return { provider, tronWeb, address };
}

function assertMainnet(tronWeb: TronWebLike) {
  const host = tronWeb.fullNode?.host?.toLowerCase() ?? "";
  if (/(shasta|nile|testnet|tronex)/i.test(host)) {
    throw new Error("TronLink is connected to a TRON test network. Switch to TRON Mainnet before paying.");
  }
}

function atomicBalance(value: unknown) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (value && typeof value === "object" && "toString" in value) {
    const stringValue = String(value.toString());
    if (/^\d+$/.test(stringValue)) return BigInt(stringValue);
  }
  throw new Error("TronLink returned an invalid USDT balance.");
}

function transactionId(value: unknown): string | null {
  if (typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = transactionId(item);
      if (id) return id;
    }
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["txID", "txid", "transactionId", "transaction_id"]) {
      const id = transactionId(record[key]);
      if (id) return id;
    }
  }
  return null;
}

export async function sendUsdtWithTronLink({
  recipient,
  tokenContract,
  amountAtomic,
}: {
  recipient: string;
  tokenContract: string;
  amountAtomic: string;
}) {
  const wallet = await connectTronLink();
  assertMainnet(wallet.tronWeb);
  if (wallet.address === recipient) throw new Error("The connected wallet is the receiving wallet. Connect the wallet you want to pay from.");

  const trxBalance = await wallet.tronWeb.trx.getBalance(wallet.address);
  if (Number.isFinite(trxBalance) && trxBalance <= 0) {
    throw new Error("Your wallet needs a small TRX balance for the TRC20 network fee.");
  }

  const contract = await wallet.tronWeb.contract().at(tokenContract);
  const balance = atomicBalance(await contract.balanceOf(wallet.address).call());
  if (balance < BigInt(amountAtomic)) throw new Error("This wallet does not have enough USDT for this payment.");

  const result = await contract.transfer(recipient, amountAtomic).send({
    feeLimit: 100_000_000,
    callValue: 0,
    shouldPollResponse: false,
  });
  const txHash = transactionId(result);
  if (!txHash) throw new Error("TronLink broadcasted an unexpected response. Check the wallet activity before trying again.");
  return { txHash, address: wallet.address };
}

export function shortTronAddress(address: string) {
  return address.length > 14 ? `${address.slice(0, 7)}…${address.slice(-5)}` : address;
}
