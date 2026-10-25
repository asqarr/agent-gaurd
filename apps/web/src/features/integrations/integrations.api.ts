import { request } from "../../shared/api/client";
import type { Tool } from "../../shared/types/api";

export async function getTools(): Promise<Tool[]> {
  const response = await request("/api/tools");
  return (await response.json()).tools;
}
