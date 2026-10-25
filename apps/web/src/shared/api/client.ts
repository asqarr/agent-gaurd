import { growthSessionHeader } from "../../features/analytics/growth";

export async function request(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  const growthSession = growthSessionHeader();
  if (growthSession) headers.set("X-AgentGuard-Growth-Session", growthSession);
  const response = await fetch(path, { ...init, headers, credentials: "include" });
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
