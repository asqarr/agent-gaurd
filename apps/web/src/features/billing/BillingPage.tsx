import { useEffect, useRef, useState } from "react";
import { getAgents } from "../agents/agents.api";
import {
  cancelScheduledPlanChange,
  createBillingAddonCheckout,
  createBillingCheckout,
  getBillingAddons,
  getBillingCheckout,
  getBillingPaymentExceptions,
  getBillingPaymentHistory,
  getDirectBillingCheckout,
  getBillingPlans,
  getBillingServiceOrders,
  getBillingState,
  getBillingUsageMetrics,
  attachBillingPaymentException,
  resolveBillingPaymentException,
  verifyBillingPayment,
} from "./billing.api";
import type { DirectBillingCheckout } from "./billing.api";
import type { Agent, BillingAddon, BillingPayment, BillingPaymentException, BillingPlan, BillingServiceOrder, BillingState, BillingUsageMetrics, SessionUser } from "../../shared/types/api";
import { Icon } from "../../shared/ui/Icon";

function formatPrice(plan: BillingPlan) {
  if (plan.priceUsdCents === 0) return "Free";
  return `$${(plan.priceUsdCents / 100).toFixed(0)} / month`;
}

function formatAddonPrice(addon: BillingAddon) {
  const price = `$${(addon.priceUsdCents / 100).toFixed(0)}`;
  if (addon.kind === "security_audit" || addon.kind === "support") return `${price} starting at`;
  return `${price} ${addon.billingInterval === "month" ? "/ month" : "one-time"}`;
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function shortPaymentValue(value: string) {
  return value.length > 14 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value;
}

function formatBytes(value: number) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / (1024 ** index)).toFixed(index > 1 ? 2 : 0)} ${units[index]}`;
}

function formatUsd(value: number) {
  return `$${value.toFixed(4)}`;
}

function serviceStatusLabel(status: BillingServiceOrder["status"]) {
  return status.replace("_", " ").toUpperCase();
}

function scanCapacity(plan: BillingPlan, fullScanCost: number) {
  const costPerScan = plan.scenarioLimit >= 12 ? fullScanCost : plan.scanCreditsPerScan;
  return costPerScan > 0 ? Math.floor(plan.monthlyScanCredits / costPerScan) : 0;
}

function scanCapacityLabel(plan: BillingPlan, fullScanCost: number) {
  const capacity = scanCapacity(plan, fullScanCost).toLocaleString();
  return plan.scenarioLimit >= 12
    ? `Up to ${capacity} full scans / month`
    : `Up to ${capacity} baseline scans / one-time allowance`;
}

function planRank(id: string) {
  return ({ free: 0, builder: 1, team: 2, agency: 3 } as Record<string, number>)[id] ?? 0;
}

function addonKindLabel(kind: BillingAddon["kind"]) {
  if (kind === "scan_credits") return "Scan capacity";
  if (kind === "runtime_decisions") return "Runtime capacity";
  if (kind === "agent_slot") return "Fleet capacity";
  return "Professional service";
}

function exceptionReasonLabel(reason: BillingPaymentException["reason"]) {
  return ({
    underpaid: "Underpaid transfer",
    overpaid: "Overpaid transfer",
    late_payment: "Payment after checkout expiry",
    unmatched_order: "Transfer without a matching order",
    wrong_token: "Wrong token",
    wrong_recipient: "Wrong recipient",
    duplicate_transaction: "Duplicate transaction",
    manual_review: "Manual review",
  } as Record<string, string>)[reason] ?? "Payment review";
}

function paymentStatusLabel(status: string) {
  return status.replaceAll("_", " ").toUpperCase();
}

const ACTIVE_CHECKOUT_STORAGE_KEY = "agentguard.active-billing-checkout";

function AgentPicker({
  agents,
  value,
  onChange,
}: {
  agents: Agent[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = agents.find((agent) => agent.id === value);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div className="billing-agent-picker" ref={rootRef}>
      <button
        type="button"
        className={`billing-agent-picker__trigger ${open ? "is-open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span><Icon name="bot" size={15} /><small>{selected ? "AUDIT TARGET" : "SELECT AGENT"}</small><strong>{selected?.name ?? "Choose an Agent"}</strong></span>
        <Icon name="chevron" size={15} />
      </button>
      {open ? (
        <div className="billing-agent-picker__menu" role="listbox" aria-label="Audit Agent">
          {agents.length ? agents.map((agent) => (
            <button
              type="button"
              role="option"
              aria-selected={agent.id === value}
              className={`billing-agent-picker__option ${agent.id === value ? "is-selected" : ""}`}
              key={agent.id}
              onClick={() => { onChange(agent.id); setOpen(false); }}
            >
              <span className="billing-agent-picker__avatar"><Icon name="bot" size={14} /></span>
              <span><strong>{agent.name}</strong><small>{agent.environment} · {agent.status}</small></span>
              {agent.id === value ? <Icon name="shield" size={14} /> : null}
            </button>
          )) : <span className="billing-agent-picker__empty">Connect an Agent before requesting an audit.</span>}
        </div>
      ) : null}
    </div>
  );
}

function PaymentSuccessDialog({
  payment,
  onClose,
  onCopy,
}: {
  payment: { planName: string; amount: string; orderId: string; txHash: string };
  onClose: () => void;
  onCopy: (value: string, label: string) => void;
}) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog payment-success-dialog" role="dialog" aria-modal="true" aria-labelledby="payment-success-title" aria-describedby="payment-success-description">
        <div className="payment-success-dialog__mark"><Icon name="shield" size={22} /></div>
        <div className="dialog__copy">
          <span className="eyebrow eyebrow--cyan">PAYMENT CONFIRMED</span>
          <h3 id="payment-success-title">Congratulations — {payment.planName} is active.</h3>
          <p id="payment-success-description">Your USDT payment was confirmed on TRON. The new entitlements are now available in this workspace.</p>
        </div>
        <div className="payment-success-dialog__details">
          <div><span>PLAN</span><strong>{payment.planName}</strong></div>
          <div><span>AMOUNT</span><strong>{payment.amount} USDT</strong></div>
          <div><span>TRANSACTION</span><strong>{payment.txHash === "confirmed-on-chain" ? "Confirmed on-chain" : shortPaymentValue(payment.txHash)}</strong>{payment.txHash === "confirmed-on-chain" ? null : <button type="button" className="text-button" onClick={() => onCopy(payment.txHash, "Transaction hash")}>Copy hash</button>}</div>
        </div>
        <div className="dialog__actions">
          <button type="button" className="button button--primary" onClick={onClose}>Continue to AgentGuard <Icon name="arrow" size={15} /></button>
        </div>
        <small className="payment-success-dialog__order">Order {shortPaymentValue(payment.orderId)}</small>
      </div>
    </div>
  );
}

export function BillingPage({ authUser }: { authUser: SessionUser | null }) {
  const [billing, setBilling] = useState<BillingState | null>(null);
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [addons, setAddons] = useState<BillingAddon[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [usageMetrics, setUsageMetrics] = useState<BillingUsageMetrics | null>(null);
  const [serviceOrders, setServiceOrders] = useState<BillingServiceOrder[]>([]);
  const [paymentHistory, setPaymentHistory] = useState<BillingPayment[]>([]);
  const [paymentExceptions, setPaymentExceptions] = useState<BillingPaymentException[]>([]);
  const [exceptionBusy, setExceptionBusy] = useState<string | null>(null);
  const [exceptionCheckoutIds, setExceptionCheckoutIds] = useState<Record<string, string>>({});
  const [auditAgentId, setAuditAgentId] = useState("");
  const [serviceAcknowledged, setServiceAcknowledged] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [checkoutError, setCheckoutError] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [checkoutMessage, setCheckoutMessage] = useState("");
  const [directCheckout, setDirectCheckout] = useState<DirectBillingCheckout | null>(null);
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [paymentSuccess, setPaymentSuccess] = useState<{
    planName: string;
    amount: string;
    orderId: string;
    txHash: string;
  } | null>(null);
  const checkoutPanelRef = useRef<HTMLElement>(null);
  const verificationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function rememberDirectCheckout(checkout: DirectBillingCheckout) {
    try {
      window.localStorage.setItem(ACTIVE_CHECKOUT_STORAGE_KEY, JSON.stringify({ orderId: checkout.order_id }));
    } catch {
      // Local storage can be disabled; the active in-memory checkout still works.
    }
  }

  function clearRememberedCheckout() {
    try {
      window.localStorage.removeItem(ACTIVE_CHECKOUT_STORAGE_KEY);
    } catch {
      // Ignore storage restrictions.
    }
  }

  function checkoutPlanName(checkout: DirectBillingCheckout) {
    if (checkout.checkout.checkoutType === "addon") return "your purchased capacity";
    return plans.find((plan) => plan.id === checkout.checkout.planId)?.name
      ?? ({ free: "Explorer", builder: "Builder", team: "Pro", agency: "Agency" } as Record<string, string>)[checkout.checkout.planId ?? ""]
      ?? "your selected plan";
  }

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [state, availablePlans, availableAddons, availableAgents] = await Promise.all([
        getBillingState(),
        getBillingPlans(),
        getBillingAddons(),
        getAgents(),
      ]);
      setBilling(state);
      setPlans(availablePlans);
      setAddons(availableAddons);
      setAgents(availableAgents);
      setAuditAgentId((current) => current || availableAgents[0]?.id || "");
      const [metrics, orders] = await Promise.all([
        getBillingUsageMetrics().catch(() => null),
        getBillingServiceOrders().catch(() => []),
      ]);
      setUsageMetrics(metrics);
      setServiceOrders(orders);
      const [history, exceptions] = await Promise.all([
        getBillingPaymentHistory().catch(() => []),
        getBillingPaymentExceptions().catch(() => []),
      ]);
      setPaymentHistory(history);
      setPaymentExceptions(exceptions);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Billing information could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const restoreCheckout = async () => {
      let savedOrderId = "";
      try {
        const saved = JSON.parse(window.localStorage.getItem(ACTIVE_CHECKOUT_STORAGE_KEY) ?? "null");
        savedOrderId = typeof saved?.orderId === "string" ? saved.orderId : "";
      } catch {
        clearRememberedCheckout();
      }
      if (!savedOrderId) return;
      try {
        const checkout = await getDirectBillingCheckout(savedOrderId);
        if (cancelled) return;
        if (["expired", "canceled", "failed"].includes(checkout.checkout.status)) {
          clearRememberedCheckout();
          return;
        }
        setDirectCheckout(checkout);
        if (["completed", "paid"].includes(checkout.checkout.status)) {
          clearRememberedCheckout();
          setCheckoutMessage("Payment confirmed while you were away. Your entitlement is active.");
          setPaymentSuccess({
            planName: checkoutPlanName(checkout),
            amount: checkout.amountUSDT,
            orderId: checkout.order_id,
            txHash: "confirmed-on-chain",
          });
        } else {
          setCheckoutMessage("This checkout is still being monitored. You can verify it manually after the transfer confirms.");
        }
      } catch {
        clearRememberedCheckout();
      }
    };
    void restoreCheckout();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const paymentStatus = params.get("payment");
    const checkoutId = params.get("checkout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let attempts = 0;
    if (paymentStatus === "success" && checkoutId) {
      setCheckoutMessage("Payment submitted. Verifying the on-chain confirmation…");
      const poll = async () => {
        if (cancelled) return;
        try {
          const checkout = await getBillingCheckout(checkoutId);
          if (["paid", "completed"].includes(checkout.status)) {
            setCheckoutMessage(checkout.checkoutType === "addon" ? "Payment confirmed. The purchased capacity is active." : "Payment confirmed. Your plan is active now.");
            await load();
            return;
          }
          if (["expired", "canceled", "failed"].includes(checkout.status)) {
            setCheckoutMessage("This checkout did not complete. No entitlement was changed.");
            return;
          }
        } catch {
          // Keep polling through a temporary network failure.
        }
        attempts += 1;
        if (!cancelled && attempts < 120) timer = setTimeout(() => void poll(), 5000);
      };
      void poll();
    } else if (paymentStatus === "success") {
      setCheckoutMessage("Payment submitted. Refresh shortly to see the verified entitlement status.");
      void load();
    } else if (params.get("payment") === "cancelled") {
      setCheckoutMessage("Checkout was cancelled. No entitlement was changed.");
    }
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!directCheckout) return;
    requestAnimationFrame(() => {
      checkoutPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [directCheckout?.order_id]);

  useEffect(() => () => {
    if (verificationTimerRef.current) clearTimeout(verificationTimerRef.current);
  }, []);

  async function startPlanChange(plan: BillingPlan) {
    if (!billing) return;
    setBusyKey(`plan:${plan.id}`);
    setCheckoutError("");
    setCheckoutMessage("");
    try {
      const result = await createBillingCheckout(plan.id, undefined, plan.name, plan.priceUsdCents / 100);
      if ("change" in result) {
        setCheckoutMessage(`${plan.name} is scheduled for ${formatDate(result.change.effectiveAt)}. Your current plan remains active until then.`);
        await load();
      } else {
        setPaymentSuccess(null);
        rememberDirectCheckout(result);
        setDirectCheckout(result);
        setCheckoutMessage(`Send exactly ${result.amountUSDT} USDT on TRC20 to the wallet below, then verify the transaction.`);
      }
    } catch (caught) {
      setCheckoutError(caught instanceof Error ? caught.message : "Crypto checkout could not be started.");
    } finally {
      setBusyKey(null);
    }
  }

  async function buyAddon(addon: BillingAddon) {
    if (addon.kind === "security_audit" && !auditAgentId) {
      setCheckoutError("Select an Agent before purchasing the Security Audit.");
      return;
    }
    if (["security_audit", "support"].includes(addon.kind) && !serviceAcknowledged[addon.id]) {
      setCheckoutError("Review and accept the service scope before opening payment.");
      return;
    }
    setBusyKey(`addon:${addon.id}`);
    setCheckoutError("");
    setCheckoutMessage("");
    try {
      const result = await createBillingAddonCheckout(addon.id, addon.kind === "security_audit" ? auditAgentId : undefined, serviceAcknowledged[addon.id] === true, addon.priceUsdCents / 100);
      setPaymentSuccess(null);
      rememberDirectCheckout(result);
      setDirectCheckout(result);
      setCheckoutMessage(`Send exactly ${result.amountUSDT} USDT on TRC20 to the wallet below, then verify the transaction.`);
    } catch (caught) {
      setCheckoutError(caught instanceof Error ? caught.message : "Add-on checkout could not be started.");
    } finally {
      setBusyKey(null);
    }
  }

  async function verifyDirectPayment({ orderId, autoRetry = false, attempt = 0 }: { orderId?: string; autoRetry?: boolean; attempt?: number } = {}) {
    const checkout = directCheckout;
    const currentOrderId = orderId ?? checkout?.order_id;
    if (!checkout || !currentOrderId) return;
    setVerificationBusy(true);
    setCheckoutError("");
    let retrying = false;
    try {
      const result = await verifyBillingPayment(currentOrderId);
      if (result.verified) {
        const planName = checkout.checkout.checkoutType === "plan"
          ? plans.find((plan) => plan.id === checkout.checkout.planId)?.name ?? "your selected plan"
          : "your purchased capacity";
        const txHash = result.txHash ?? "";
        setCheckoutMessage("Payment confirmed on-chain. Your entitlement is active.");
        setDirectCheckout((current) => current ? { ...current, checkout: { ...current.checkout, status: "completed" } } : current);
        setPaymentSuccess({ planName, amount: checkout.amountUSDT, orderId: currentOrderId, txHash: txHash || "confirmed-on-chain" });
        clearRememberedCheckout();
        await load();
      } else if (autoRetry && attempt < 12) {
        retrying = true;
        setCheckoutMessage(attempt === 0
          ? "Payment broadcasted. Waiting for a confirmed TRON transfer…"
          : `Still waiting for blockchain confirmation (${attempt + 1}/12)…`);
        verificationTimerRef.current = setTimeout(() => {
          void verifyDirectPayment({ orderId: currentOrderId, autoRetry: true, attempt: attempt + 1 });
        }, 5000);
      } else {
        setCheckoutMessage(result.message || "No matching confirmed transfer found yet. Wait for confirmation and try again.");
      }
    } catch (caught) {
      setCheckoutError(caught instanceof Error ? caught.message : "Payment verification could not be completed.");
    } finally {
      if (!retrying) setVerificationBusy(false);
    }
  }

  async function copyPaymentValue(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCheckoutMessage(`${label} copied.`);
    } catch {
      setCheckoutError(`Copy ${label.toLowerCase()} manually: ${value}`);
    }
  }

  async function cancelDowngrade() {
    setBusyKey("cancel-downgrade");
    try {
      setBilling(await cancelScheduledPlanChange());
      setCheckoutMessage("The scheduled downgrade was cancelled. No payment was taken.");
    } catch (caught) {
      setCheckoutError(caught instanceof Error ? caught.message : "The scheduled downgrade could not be cancelled.");
    } finally {
      setBusyKey(null);
    }
  }

  async function resolveException(exception: BillingPaymentException, action: "refund_required" | "resolved" | "ignored") {
    setExceptionBusy(`${exception.id}:${action}`);
    try {
      const updated = await resolveBillingPaymentException(exception.id, action, action === "refund_required" ? "Marked for manual refund review." : undefined);
      setPaymentExceptions((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (caught) {
      setCheckoutError(caught instanceof Error ? caught.message : "The payment exception could not be updated.");
    } finally {
      setExceptionBusy(null);
    }
  }

  async function attachException(exception: BillingPaymentException) {
    const checkoutId = exceptionCheckoutIds[exception.id]?.trim() || exception.checkoutSessionId || "";
    if (!checkoutId) {
      setCheckoutError("Enter the checkout ID before attaching this payment.");
      return;
    }
    setExceptionBusy(`${exception.id}:attach`);
    try {
      const result = await attachBillingPaymentException(exception.id, checkoutId, "Payment attached after workspace review.");
      setPaymentExceptions((current) => current.map((item) => item.id === result.exception.id ? result.exception : item));
      setPaymentHistory((current) => [result.payment, ...current.filter((item) => item.id !== result.payment.id)]);
      setBilling(await getBillingState());
      setCheckoutMessage("Payment attached securely. The checkout and entitlement are now active.");
    } catch (caught) {
      setCheckoutError(caught instanceof Error ? caught.message : "The payment could not be attached to this checkout.");
    } finally {
      setExceptionBusy(null);
    }
  }

  if (loading) return <section className="workspace-view billing-page"><div className="billing-loading"><i /><span>Loading plan entitlements…</span></div></section>;

  if (error || !billing) {
    return <section className="workspace-view billing-page"><div className="billing-error" role="alert"><Icon name="activity" size={16} /><span>{error || "Billing information is unavailable."}</span><button className="button button--subtle" onClick={() => void load()}>Retry</button></div></section>;
  }

  const hasPendingDowngrade = Boolean(billing.subscription.pendingPlanId);
  const pendingPlanName = plans.find((plan) => plan.id === billing.subscription.pendingPlanId)?.name ?? billing.subscription.pendingPlanId;
  const canManageBilling = ["owner", "admin"].includes(authUser?.role ?? "");
  return (
    <section className="workspace-view billing-page">
      {checkoutError && !directCheckout ? <div className="billing-error" role="alert"><Icon name="activity" size={16} /><span>{checkoutError}</span><button className="button button--subtle" onClick={() => setCheckoutError("")}>Dismiss</button></div> : null}
      {checkoutMessage && !directCheckout ? <div className="billing-success" role="status"><Icon name="shield" size={16} /><span>{checkoutMessage}</span><button className="button button--subtle" onClick={() => setCheckoutMessage("")}>Dismiss</button></div> : null}
      {directCheckout ? <section ref={checkoutPanelRef} className="billing-direct-checkout panel">
        <div className="billing-direct-checkout__heading"><div><span className="eyebrow eyebrow--cyan">DIRECT P2P SETTLEMENT</span><h3>Pay from any wallet on TRC20.</h3><p>Send the exact USDT amount directly to the AgentGuard wallet. No hosted invoice or wallet extension is required.</p></div><Icon name="wallet" size={20} /></div>
        <div className="billing-direct-checkout__grid">
          <div><span>Amount</span><strong>{directCheckout.amountUSDT} USDT</strong><small>Exact amount · {directCheckout.decimals} decimals</small></div>
          <div><span>Network</span><strong>{directCheckout.network}</strong><small>Contract: {directCheckout.tokenContract}</small></div>
          <div className="billing-direct-checkout__address"><span>Recipient wallet</span><strong>{directCheckout.walletAddress}</strong><button type="button" className="text-button" onClick={() => void copyPaymentValue(directCheckout.walletAddress, "Wallet address")}>Copy address</button></div>
          <div><span>Order ID</span><strong>{directCheckout.order_id}</strong><button type="button" className="text-button" onClick={() => void copyPaymentValue(directCheckout.order_id, "Order ID")}>Copy order ID</button></div>
        </div>
        <div className="billing-direct-checkout__footer">
          <div className="billing-direct-checkout__footer-copy">
            <small>Expires {formatDate(directCheckout.expiresAt)} · Blockchain confirmation can take a few minutes.</small>
            {checkoutMessage ? <span className="billing-direct-checkout__message" role="status">{checkoutMessage}</span> : null}
            {checkoutError ? <span className="billing-direct-checkout__error" role="alert">{checkoutError}</span> : null}
          </div>
          <div className="billing-direct-checkout__footer-right">
            <div className="billing-direct-checkout__actions">
              <button
                type="button"
                className="button button--primary"
                disabled={verificationBusy || directCheckout.checkout.status === "completed"}
                onClick={() => void verifyDirectPayment({ autoRetry: true })}
              >
                {verificationBusy ? "Checking blockchain…" : directCheckout.checkout.status === "completed" ? "Payment verified" : "I already paid"}
                <Icon name="shield" size={15} />
              </button>
            </div>
            <p className="billing-direct-checkout__wallet-help">You can send the exact USDT amount from ANY crypto wallet (Trust Wallet, Binance, Metamask, etc.) using the TRC20 network. Once sent, click 'I already paid' to verify your transaction via blockchain.</p>
          </div>
        </div>
      </section> : null}
      <div className="workspace-view__heading billing-page__heading">
        <div><span className="eyebrow eyebrow--cyan">PLANS & USAGE</span><h2>Protect more agents as your risk grows.</h2><p>Start with a controlled allowance, then scale by verified usage. Security controls never weaken on a cheaper plan.</p></div>
        <div className="billing-rail-badge"><Icon name="wallet" size={17} /><div><span>PAYMENT RAIL</span><strong>USDT on TRON</strong></div><small>Manual renewal only</small></div>
      </div>

      {billing.usage.alerts.map((alert) => <div className={`billing-usage-alert billing-usage-alert--${alert.severity}`} key={`${alert.resource}-${alert.threshold}`}><Icon name={alert.severity === "critical" ? "activity" : "shield"} size={15} /><span>{alert.message}</span>{alert.addonRemaining > 0 ? <small>{alert.addonRemaining.toLocaleString()} extra available</small> : null}</div>)}

      {paymentExceptions.some((exception) => !["resolved", "refunded", "ignored"].includes(exception.status)) ? <section className="billing-exception-center panel">
        <div className="billing-exception-center__heading"><div><span className="eyebrow eyebrow--cyan">PAYMENT EXCEPTION CENTER</span><h3>A transfer needs a safe decision.</h3><p>AgentGuard found a confirmed USDT transfer that could not be applied automatically. No entitlement changes are made until the payment is matched or explicitly resolved.</p></div><Icon name="activity" size={18} /></div>
        <div className="billing-exception-list">{paymentExceptions.filter((exception) => !["resolved", "refunded", "ignored"].includes(exception.status)).map((exception) => <article className="billing-exception" key={exception.id}>
          <div className="billing-exception__top"><div><span className="eyebrow">{exceptionReasonLabel(exception.reason)}</span><h4>{exception.amountUsdt ?? "—"} USDT <small>· {exception.network}</small></h4></div><b className={`billing-exception__status billing-exception__status--${exception.status}`}>{paymentStatusLabel(exception.status)}</b></div>
          <div className="billing-exception__meta"><span>Detected<strong>{formatDate(exception.transferTimestamp ?? exception.detectedAt)}</strong></span><span>Transaction<strong>{shortPaymentValue(exception.txHash)}</strong></span><span>Order<strong>{exception.checkoutSessionId ? shortPaymentValue(exception.checkoutSessionId) : "No matching order"}</strong></span></div>
          <button type="button" className="text-button" onClick={() => void copyPaymentValue(exception.txHash, "Transaction hash")}>Copy transaction hash</button>
          {canManageBilling ? <div className="billing-exception__actions"><label><span>Checkout ID for manual match</span><input value={exceptionCheckoutIds[exception.id] ?? exception.checkoutSessionId ?? ""} onChange={(event) => setExceptionCheckoutIds((current) => ({ ...current, [exception.id]: event.target.value }))} placeholder="checkout-…" /></label><div><button type="button" className="button button--primary" disabled={exceptionBusy !== null} onClick={() => void attachException(exception)}>{exceptionBusy === `${exception.id}:attach` ? "Attaching…" : "Attach & activate"}</button><button type="button" className="button button--subtle" disabled={exceptionBusy !== null} onClick={() => void resolveException(exception, "refund_required")}>{exceptionBusy === `${exception.id}:refund_required` ? "Saving…" : "Mark refund required"}</button><button type="button" className="button button--subtle" disabled={exceptionBusy !== null} onClick={() => void resolveException(exception, "ignored")}>Ignore</button></div></div> : <small className="billing-exception__note">Workspace admins are reviewing this transfer. If you sent the payment, keep the transaction hash available for support.</small>}
        </article>)}</div>
      </section> : null}

      {paymentHistory.length ? <section className="billing-payment-history panel">
        <div className="billing-payment-history__heading"><div><span className="eyebrow">PAYMENT HISTORY</span><h3>Every settlement stays traceable.</h3><p>Only confirmed blockchain payments appear here as completed billing events.</p></div><span className="billing-payment-history__count">{paymentHistory.length} record{paymentHistory.length === 1 ? "" : "s"}</span></div>
        <div className="billing-payment-history__list">{paymentHistory.slice(0, 8).map((payment) => <article className="billing-payment-history__row" key={payment.id}><div><strong>{payment.planName ?? payment.addonName ?? "AgentGuard purchase"}</strong><small>{formatDate(payment.paidAt ?? payment.createdAt)} · {payment.network ?? payment.currency}</small></div><span>{payment.amount} {payment.currency}</span><b className={`billing-payment-history__status billing-payment-history__status--${payment.status}`}>{paymentStatusLabel(payment.status)}</b>{payment.txHash ? <button type="button" className="text-button" onClick={() => void copyPaymentValue(payment.txHash ?? "", "Transaction hash")}>{shortPaymentValue(payment.txHash)}</button> : null}</article>)}</div>
      </section> : null}

      {hasPendingDowngrade ? <div className="billing-pending-change panel"><div><span className="eyebrow">SCHEDULED CHANGE</span><strong>Downgrade to {pendingPlanName}</strong><small>Effective {formatDate(billing.subscription.pendingPlanEffectiveAt)}. Current access remains unchanged until then.</small></div><button className="button button--subtle" disabled={busyKey !== null} onClick={() => void cancelDowngrade()}>{busyKey === "cancel-downgrade" ? "Cancelling…" : "Keep current plan"}</button></div> : null}

      <div className="billing-usage panel">
        <div className="billing-usage__heading"><div><span className="eyebrow">CURRENT ENTITLEMENT</span><h3>{billing.plan.name} plan <em>{billing.subscription.status}</em></h3></div><span className="billing-period">{billing.subscription.renewalMode === "manual" ? "Manual renewal · period ends" : "Renews"} {formatDate(billing.subscription.currentPeriodEnd)}</span></div>
        <div className="billing-usage__grid">
          <div><span>Scan credits</span><strong>{billing.usage.scanCreditsUsed} <small>/ {billing.usage.scanCreditsIncluded}</small></strong><i><b style={{ width: `${Math.min(100, billing.usage.scanCreditsIncluded ? (billing.usage.scanCreditsUsed / billing.usage.scanCreditsIncluded) * 100 : 0)}%` }} /></i><small>{billing.usage.scanCreditAddonsRemaining.toLocaleString()} extra available</small></div>
          <div><span>Agents</span><strong>{billing.entitlements.maxAgents}</strong><small>{billing.entitlements.agentAddons ? `${billing.entitlements.agentAddons} purchased slot` : "included maximum"}</small></div>
          <div><span>Full suite cost</span><strong>{billing.usage.fullScanCredits}</strong><small>12-scenario scan</small></div>
          <div><span>Scenario coverage</span><strong>{billing.plan.scenarioLimit}<small> / 12</small></strong><small>{billing.plan.scanCreditsPerScan} credits at this depth</small></div>
          <div><span>Evidence history</span><strong>{billing.entitlements.historyDays}d</strong><small>automatically purged after retention</small></div>
          <div><span>Runtime decisions</span><strong>{billing.usage.runtimeDecisionsUsed.toLocaleString()} <small>/ {billing.usage.runtimeDecisionsIncluded.toLocaleString()}</small></strong><small>{billing.usage.runtimeDecisionAddonsRemaining.toLocaleString()} extra available</small></div>
        </div>
        <p className="billing-usage__explanation">A full 12-scenario scan uses {billing.usage.fullScanCredits} Credits. Actual capacity depends on the scenarios selected; Explorer shows its 5-scenario baseline allowance.</p>
        <p className="billing-usage__fail-closed"><Icon name="shield" size={13} />At the Runtime quota limit, the Gateway returns 402 and no sensitive Tool is executed. Upgrade or purchase extra Runtime Decisions to continue.</p>
      </div>

      {usageMetrics ? <div className="billing-ops-grid">
        <section className="billing-ops-card panel">
          <div className="billing-ops-card__heading"><div><span className="eyebrow eyebrow--cyan">COST METERING</span><h3>Know the real cost of every customer.</h3><p>Measured from completed Scan and Runtime work in the current billing period.</p></div><Icon name="activity" size={18} /></div>
          <div className="billing-ops-card__metrics">
            <div><span>Scan credits measured</span><strong>{usageMetrics.measurement.scanCredits.toLocaleString()}</strong><small>{usageMetrics.measurement.operations.toLocaleString()} total operations</small></div>
            <div><span>Runtime decisions</span><strong>{usageMetrics.measurement.runtimeDecisions.toLocaleString()}</strong><small>{usageMetrics.measurement.averageDurationMs.toFixed(0)}ms average</small></div>
            <div><span>CPU time</span><strong>{usageMetrics.measurement.cpuAvailable ? `${usageMetrics.measurement.cpuMs.toLocaleString()}ms` : "Awaiting sample"}</strong><small>{usageMetrics.measurement.cpuAvailable ? `${usageMetrics.measurement.maxDurationMs.toLocaleString()}ms max operation` : "Runtime does not expose CPU counters yet"}</small></div>
            <div><span>Estimated compute</span><strong>{usageMetrics.costModel.cpuMeasurementAvailable ? formatUsd(usageMetrics.estimatedCostUsd.compute) : "Awaiting sample"}</strong><small>Configured CPU rate</small></div>
            <div><span>Per 1K Scan Credits</span><strong>{usageMetrics.costModel.cpuMeasurementAvailable ? formatUsd(usageMetrics.unitEconomics.per1000ScanCredits.estimatedComputeUsd) : "Awaiting sample"}</strong><small>{usageMetrics.unitEconomics.per1000ScanCredits.sampleUnits.toLocaleString()} credits in sample</small></div>
            <div><span>Per 10K Runtime Decisions</span><strong>{usageMetrics.costModel.cpuMeasurementAvailable ? formatUsd(usageMetrics.unitEconomics.per10000RuntimeDecisions.estimatedComputeUsd) : "Awaiting sample"}</strong><small>{usageMetrics.unitEconomics.per10000RuntimeDecisions.sampleUnits.toLocaleString()} decisions in sample</small></div>
          </div>
          <div className="billing-ops-card__footer"><span>Storage footprint</span><strong>{usageMetrics.storage ? formatBytes(usageMetrics.storage.logicalBytes) : "Awaiting snapshot"}</strong><small>{usageMetrics.storage ? `${formatUsd(usageMetrics.estimatedCostUsd.storageMonthlyRunRate)} monthly run-rate · ${formatDate(usageMetrics.storage.capturedAt)}` : "The retention worker will capture the first snapshot."}</small></div>
        </section>
        <section className="billing-ops-card panel">
          <div className="billing-ops-card__heading"><div><span className="eyebrow">RETENTION CONTROL</span><h3>Evidence is deleted, not hidden.</h3><p>Retention runs are recorded and storage is measured after cleanup.</p></div><Icon name="clock" size={18} /></div>
          {usageMetrics.retention ? <div className="billing-retention-status"><span className="billing-status-dot billing-status-dot--ok" /><div><strong>Last run {formatDate(usageMetrics.retention.lastRunAt)}</strong><small>{usageMetrics.retention.deletedScans.toLocaleString()} scans deleted from {usageMetrics.retention.candidates.toLocaleString()} candidates in {usageMetrics.retention.durationMs}ms.</small></div><b>{usageMetrics.retention.status}</b></div> : <div className="billing-retention-status billing-retention-status--empty"><span className="billing-status-dot" /><div><strong>No retention run recorded yet.</strong><small>The worker runs automatically and records every cleanup pass.</small></div></div>}
          <div className="billing-ops-card__footer"><span>Estimated current footprint cost</span><strong>{formatUsd(usageMetrics.estimatedCostUsd.total)}</strong><small>Compute for this period + monthly storage run-rate. Estimates use configured infrastructure rates.</small></div>
        </section>
      </div> : null}

      {serviceOrders.length ? <section className="billing-service-orders panel">
        <div className="billing-addons__heading"><div><span className="eyebrow eyebrow--cyan">SERVICE ENGAGEMENTS</span><h3>Human work stays scoped and trackable.</h3><p>Audit and implementation support are separate engagements with their own deliverables and acceptance terms.</p></div></div>
        <div className="billing-service-orders__list">{serviceOrders.map((order) => <article className="billing-service-order" key={order.id}><div className="billing-service-order__top"><div><span className="eyebrow">{order.kind === "security_audit" ? "SECURITY AUDIT" : "IMPLEMENTATION SUPPORT"}</span><h4>{order.addonName}</h4></div><b className={`billing-service-order__status billing-service-order__status--${order.status}`}>{serviceStatusLabel(order.status)}</b></div><div className="billing-service-order__meta"><span>Scope<strong>{order.scope}</strong></span><span>Timebox<strong>{order.includedHours} hours included</strong></span><span>Target<strong>{order.targetAgentName ?? "Workspace engagement"}</strong></span><span>Opened<strong>{formatDate(order.createdAt)}</strong></span></div><small>{order.deliveryWindow} {order.overagePolicy}</small></article>)}</div>
      </section> : null}

      <div className="billing-plan-grid">
        {plans.map((plan) => {
          const current = plan.id === billing.plan.id;
          const downgrade = !current && planRank(plan.id) < planRank(billing.plan.id) && billing.entitlements.active;
          const recommended = plan.id === "team";
          return <article className={`billing-plan-card ${current ? "billing-plan-card--current" : ""} ${recommended ? "billing-plan-card--recommended" : ""}`} key={plan.id}>
            {current ? <span className="billing-plan-card__current">CURRENT PLAN</span> : null}
            {recommended && !current ? <span className="billing-plan-card__recommended">BEST VALUE</span> : null}
            <div className="billing-plan-card__top"><div><span className="eyebrow">{plan.name}</span><h3>{formatPrice(plan)}</h3></div><Icon name={plan.runtimeFirewall ? "shield" : "lock"} size={19} /></div>
            <p>{plan.description}</p>
            <div className="billing-plan-card__limits"><span>{plan.maxAgents} agent{plan.maxAgents === 1 ? "" : "s"}</span><span>{plan.monthlyScanCredits.toLocaleString()} {plan.scanCreditMode === "one_time" ? "one-time credits" : "credits / month"}</span><span>{plan.runtimeDecisionsIncluded.toLocaleString()} runtime decisions</span><span>{scanCapacityLabel(plan, billing.usage.fullScanCredits)}</span><span>{plan.scenarioLimit}/12 scenarios</span><span>{plan.seatLimit} seat{plan.seatLimit === 1 ? "" : "s"}</span><span>{plan.historyDays} days evidence</span></div>
            <small className="billing-plan-card__scan-note">{plan.scenarioLimit >= 12 ? `Based on ${billing.usage.fullScanCredits} Credits per full 12-scenario scan.` : `Explorer scans use ${plan.scanCreditsPerScan} Credits for 5 baseline scenarios.`} Actual usage varies with selected scenarios.</small>
            <ul>{plan.features.map((feature) => <li key={feature}><i />{feature}</li>)}</ul>
            <div className="billing-plan-card__entitlements"><span className={plan.runtimeFirewall ? "is-on" : ""}><i />Runtime</span><span className={plan.autopilot ? "is-on" : ""}><i />Autopilot</span><span className={plan.sentinel ? "is-on" : ""}><i />Sentinel</span><span className={plan.incidentCenter ? "is-on" : ""}><i />Incidents</span><span className={plan.alertWebhooks ? "is-on" : ""}><i />Webhooks{plan.maxWebhooks ? ` · ${plan.maxWebhooks}` : ""}</span></div>
            {current && plan.priceUsdCents > 0 ? <small className="billing-plan-card__period">Current period ends {formatDate(billing.subscription.currentPeriodEnd)} · renewal is manual</small> : null}
            <button className={`button ${current ? "button--subtle" : "button--ghost"}`} disabled={(current && plan.priceUsdCents === 0) || busyKey !== null} onClick={() => void startPlanChange(plan)}>{current ? (plan.priceUsdCents === 0 ? "Active plan" : "Renew manually") : busyKey === `plan:${plan.id}` ? (downgrade ? "Scheduling…" : "Opening checkout…") : downgrade ? `Downgrade to ${plan.name}` : "Upgrade with USDT"}</button>
          </article>;
        })}
      </div>

      <div className="billing-addons panel">
        <div className="billing-addons__heading"><div><span className="eyebrow eyebrow--cyan">USAGE EXTENSIONS</span><h3>Buy only what you need.</h3><p>Extra capacity is one-time unless explicitly marked monthly. No silent overage and no automatic renewal.</p></div></div>
        <div className="billing-addon-grid">
          {addons.map((addon) => <article className={`billing-addon-card ${addon.serviceScope ? "billing-addon-card--service" : ""}`} key={addon.id}>
            <span className="eyebrow">{addonKindLabel(addon.kind)}</span><h4>{addon.name}</h4><strong>{formatAddonPrice(addon)}</strong><p>{addon.description}</p>
            {!addon.serviceScope ? <small className="billing-addon-card__carry">{addon.kind === "agent_slot" ? "Active through the current paid period." : "Remaining units never expire and carry over after renewal."}</small> : null}
            {addon.serviceScope ? <div className="billing-service-terms"><div><span>Scope</span><p>{addon.serviceScope}</p></div><div><span>Timebox</span><p>{addon.includedHours} included service hours. Additional work is separately quoted.</p></div><div><span>Delivery</span><p>{addon.deliveryWindow}</p></div><div><span>Acceptance</span><p>{addon.acceptanceTerms}</p></div><div><span>Overage</span><p>{addon.overagePolicy}</p></div></div> : null}
            {addon.kind === "security_audit" ? <AgentPicker agents={agents} value={auditAgentId} onChange={setAuditAgentId} /> : null}
            {addon.serviceScope ? <label className="billing-service-consent"><input type="checkbox" checked={serviceAcknowledged[addon.id] === true} onChange={(event) => setServiceAcknowledged((current) => ({ ...current, [addon.id]: event.target.checked }))} /><span>I reviewed the scope and acceptance terms.</span></label> : null}
            <button className="button button--ghost" disabled={busyKey !== null} onClick={() => void buyAddon(addon)}>{busyKey === `addon:${addon.id}` ? "Opening checkout…" : addon.serviceScope ? "Continue to USDT checkout" : "Buy with USDT"}</button>
          </article>)}
        </div>
      </div>

      <div className="billing-support-note"><Icon name="activity" size={14} /><span>Dedicated setup, implementation support and Security Audit are separate paid services. They are never silently included in the Builder or other subscription plans.</span></div>
      <p className="billing-note"><Icon name="shield" size={14} /> Payments are verified against confirmed USDT-TRC20 transfers. Browser redirects never activate a plan, and Runtime security controls remain fail-closed across every plan.</p>
      {paymentSuccess ? <PaymentSuccessDialog payment={paymentSuccess} onClose={() => setPaymentSuccess(null)} onCopy={copyPaymentValue} /> : null}
    </section>
  );
}
