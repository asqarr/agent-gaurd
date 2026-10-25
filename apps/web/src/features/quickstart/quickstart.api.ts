import { request } from "../../shared/api/client";
import type { Agent, Scan, SecurityDemoProof } from "../../shared/types/api";

export type QuickstartDemo = {
  agent: Agent;
  scan: Scan;
  proof: SecurityDemoProof;
  demo: {
    isolated: boolean;
    execution: string;
    message: string;
  };
};

export async function startQuickstartDemo(): Promise<QuickstartDemo> {
  const response = await request("/api/quickstart/demo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  return response.json();
}
