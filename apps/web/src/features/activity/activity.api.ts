import { request } from "../../shared/api/client";
import type { WorkspaceActivity } from "../../shared/types/api";

export async function getWorkspaceActivity({ beforeId, limit = 50 }: { beforeId?: string; limit?: number } = {}): Promise<{ events: WorkspaceActivity[]; hasMore: boolean }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (beforeId) params.set("beforeId", beforeId);
  const response = await request(`/api/activity?${params.toString()}`);
  return response.json();
}
