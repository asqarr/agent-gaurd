import { request } from "../../shared/api/client";
import type { ScenarioCatalog } from "../../shared/types/api";

export async function getScenarioCatalog(): Promise<ScenarioCatalog> {
  const response = await request("/api/scenarios");
  return response.json();
}
