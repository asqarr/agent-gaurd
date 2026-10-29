import { growthSessionHeader } from "../../features/analytics/growth";

export function remediationCopilotEndpoint(scanId: string, scenarioId: string) {
  return `/api/scans/${encodeURIComponent(scanId)}/copilot/${encodeURIComponent(scenarioId)}`;
}

export const remediationCopilotFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  const growthSession = growthSessionHeader();
  if (growthSession) headers.set("X-AgentGuard-Growth-Session", growthSession);
  const response = await fetch(input, {
    ...init,
    headers,
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.error === "string" ? body.error : `AI plan request failed (${response.status}).`);
  }
  return response;
};
