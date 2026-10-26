import { growthSessionHeader } from "../../features/analytics/growth";

// The dashboard and API are served from the same Render origin. An empty base
// URL makes the browser resolve every request against the current site rather
// than a localhost, fixed-port, or separate API hostname.
export const API_BASE_URL = "";
const API_PREFIX = "/api";

export const UPGRADE_REQUIRED_EVENT = "agentguard:upgrade-required";

export type UpgradeRequest = {
  status: number;
  code: string;
  message: string;
  entitlement?: string;
  currentPlan?: string;
  requiredPlan?: string;
  requiredPlanName?: string;
  nextActions?: string[];
  requestId?: string;
};

export class ApiError extends Error implements UpgradeRequest {
  status: number;
  code: string;
  entitlement?: string;
  currentPlan?: string;
  requiredPlan?: string;
  requiredPlanName?: string;
  nextActions?: string[];
  requestId?: string;

  constructor(request: UpgradeRequest) {
    super(request.message);
    this.name = "ApiError";
    this.status = request.status;
    this.code = request.code;
    this.entitlement = request.entitlement;
    this.currentPlan = request.currentPlan;
    this.requiredPlan = request.requiredPlan;
    this.requiredPlanName = request.requiredPlanName;
    this.nextActions = request.nextActions;
    this.requestId = request.requestId;
  }
}

const upgradeCodes = new Set([
  "PLAN_UPGRADE_REQUIRED",
  "WEBHOOK_LIMIT_REACHED",
  "RUNTIME_PLAN_REQUIRED",
  "RUNTIME_QUOTA_EXCEEDED",
  "SCAN_QUOTA_EXCEEDED",
  "SUBSCRIPTION_REQUIRED",
  "SCENARIO_PLAN_REQUIRED",
  "AGENT_LIMIT_REACHED",
]);

export function isUpgradeRequest(value: unknown): value is UpgradeRequest {
  return value instanceof ApiError && (value.status === 402 || upgradeCodes.has(value.code));
}

export function apiPath(path: string) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (normalized === API_PREFIX || normalized.startsWith(`${API_PREFIX}/`)) return normalized;
  return `${API_PREFIX}${normalized}`;
}

export async function request(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  const growthSession = growthSessionHeader();
  if (growthSession) headers.set("X-AgentGuard-Growth-Session", growthSession);
  const response = await fetch(apiPath(path), { ...init, headers, credentials: "include" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new ApiError({
      status: response.status,
      code: typeof body.code === "string" ? body.code : "REQUEST_FAILED",
      message: body.error ?? `Request failed (${response.status})`,
      entitlement: typeof body.entitlement === "string" ? body.entitlement : undefined,
      currentPlan: typeof body.currentPlan === "string" ? body.currentPlan : undefined,
      requiredPlan: typeof body.requiredPlan === "string" ? body.requiredPlan : undefined,
      requiredPlanName: typeof body.requiredPlanName === "string" ? body.requiredPlanName : undefined,
      nextActions: Array.isArray(body.nextActions) ? body.nextActions.filter((item: unknown): item is string => typeof item === "string") : undefined,
      requestId: typeof body.requestId === "string" ? body.requestId : undefined,
    });
    if (isUpgradeRequest(error) && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent<UpgradeRequest>(UPGRADE_REQUIRED_EVENT, { detail: error }));
    }
    throw error;
  }
  return response;
}
