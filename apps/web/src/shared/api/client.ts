import { growthSessionHeader } from "../../features/analytics/growth";

// The dashboard and API are served from the same Render origin. An empty base
// URL makes the browser resolve every request against the current site rather
// than a localhost, fixed-port, or separate API hostname.
export const API_BASE_URL = "";
const API_PREFIX = "/api";

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
    const error = new Error(
      body.error ?? `Request failed (${response.status})`,
    );
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return response;
}
