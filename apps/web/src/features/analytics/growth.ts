export type PublicGrowthEvent =
  | "marketing.landing_view"
  | "marketing.connect_cta_clicked"
  | "marketing.demo_cta_clicked"
  | "attack_lab.challenge_run"
  | "auth.signup_started";

type GrowthProperties = {
  page?: "home" | "attack_lab" | "security_guide" | "prompt_injection_guide" | "app";
  scenarioId?: "refund_policy" | "argument_tampering" | "approval_replay";
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  referrer?: string;
};

type GrowthSession = {
  id: string;
  attribution: Pick<GrowthProperties, "utmSource" | "utmMedium" | "utmCampaign" | "referrer">;
};

const sessionStorageKey = "agentguard:growth:v1";
const optOutStorageKey = "agentguard:growth:opt-out";
const safeUtmValue = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

function uuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function firstTouchAttribution(): GrowthSession["attribution"] {
  const params = new URLSearchParams(window.location.search);
  const result: GrowthSession["attribution"] = {};
  for (const [param, key] of [
    ["utm_source", "utmSource"],
    ["utm_medium", "utmMedium"],
    ["utm_campaign", "utmCampaign"],
  ] as const) {
    const value = params.get(param)?.trim().slice(0, 80);
    if (value && safeUtmValue.test(value)) result[key] = value.toLowerCase();
  }
  if (document.referrer) {
    try {
      const host = new URL(document.referrer).hostname.toLowerCase().replace(/^www\./, "").slice(0, 180);
      if (host && host !== window.location.hostname) result.referrer = host;
    } catch {
      // Ignore malformed referrers; never retain the full URL.
    }
  }
  return result;
}

function getGrowthSession(): GrowthSession | null {
  try {
    if (!isGrowthAnalyticsEnabled()) return null;
    const saved = sessionStorage.getItem(sessionStorageKey);
    if (saved) {
      const parsed = JSON.parse(saved) as GrowthSession;
      if (typeof parsed.id === "string" && /^[0-9a-f-]{36}$/i.test(parsed.id)) return parsed;
    }
    const session: GrowthSession = { id: uuid(), attribution: firstTouchAttribution() };
    sessionStorage.setItem(sessionStorageKey, JSON.stringify(session));
    return session;
  } catch {
    // Respect browser privacy settings: analytics becomes unavailable if session storage is blocked.
    return null;
  }
}

export function isGrowthAnalyticsEnabled() {
  try {
    return localStorage.getItem(optOutStorageKey) !== "1";
  } catch {
    return false;
  }
}

export function setGrowthAnalyticsEnabled(enabled: boolean) {
  try {
    if (enabled) localStorage.removeItem(optOutStorageKey);
    else {
      localStorage.setItem(optOutStorageKey, "1");
      sessionStorage.removeItem(sessionStorageKey);
    }
    return true;
  } catch {
    return false;
  }
}

export function growthSessionHeader(): string | null {
  return getGrowthSession()?.id ?? null;
}

export function trackGrowthEvent(eventName: PublicGrowthEvent, properties: GrowthProperties = {}) {
  const session = getGrowthSession();
  if (!session) return;
  const eventId = uuid();
  const safeProperties = { ...session.attribution, ...properties };
  void fetch("/api/growth/events", {
    method: "POST",
    credentials: "omit",
    cache: "no-store",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventName, eventId, sessionId: session.id, properties: safeProperties }),
  }).catch(() => {});
}

export function installGrowthTracking(page: NonNullable<GrowthProperties["page"]>) {
  if (page !== "app") {
    trackGrowthEvent("marketing.landing_view", { page });
  }

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const preferenceButton = target.closest<HTMLButtonElement>("[data-growth-analytics-toggle]");
    if (preferenceButton) {
      const enabled = !isGrowthAnalyticsEnabled();
      if (!setGrowthAnalyticsEnabled(enabled)) return;
      for (const button of document.querySelectorAll<HTMLButtonElement>("[data-growth-analytics-toggle]")) {
        button.textContent = enabled ? "Disable anonymous analytics" : "Enable anonymous analytics";
        button.setAttribute("aria-pressed", String(enabled));
      }
      const status = document.querySelector<HTMLElement>("[data-growth-analytics-status]");
      if (status) status.textContent = enabled
        ? "Anonymous analytics enabled for this browser."
        : "Anonymous analytics disabled for this browser.";
      return;
    }
    const anchor = target.closest<HTMLAnchorElement>("a[href]");
    if (!anchor) return;
    let destination: URL;
    try {
      destination = new URL(anchor.href, window.location.href);
    } catch {
      return;
    }
    if (destination.origin !== window.location.origin) return;
    if (destination.pathname === "/app.html") {
      trackGrowthEvent("marketing.connect_cta_clicked", { page });
    } else if (destination.pathname === "/attack-lab.html" && page !== "app") {
      trackGrowthEvent("marketing.demo_cta_clicked", { page });
    }
  }, { passive: true });

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-growth-analytics-toggle]")) {
    const enabled = isGrowthAnalyticsEnabled();
    button.textContent = enabled ? "Disable anonymous analytics" : "Enable anonymous analytics";
    button.setAttribute("aria-pressed", String(enabled));
  }
}
