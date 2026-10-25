import { growthSessionHeader } from "../../features/analytics/growth";

// The dashboard and API are served from the same Render origin. Keeping this
// relative prevents production builds from depending on localhost, a fixed
// port, or a separate API hostname.
export const API_BASE_URL = "/api";

export function apiPath(path: string) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (normalized === API_BASE_URL || normalized.startsWith(`${API_BASE_URL}/`)) return normalized;
  return `${API_BASE_URL}${normalized}`;
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
