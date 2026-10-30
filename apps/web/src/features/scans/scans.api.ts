import { request } from "../../shared/api/client";
import type { PolicyFixProposal, Scan, WorkspacePolicy } from "../../shared/types/api";

export type ScanRunOptions = {
  trigger?: string;
  remediationVerification?: NonNullable<Scan["remediationVerification"]>;
};

export async function runScan(
  agentId: string,
  onProgress?: (scan: Scan) => void,
  scenarioIds?: string[],
  options: ScanRunOptions = {},
): Promise<Scan> {
  const response = await request("/api/scans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentId,
      trigger: options.trigger ?? (scenarioIds?.length ? `Remediation retest · ${scenarioIds.join(", ")}` : "Manual"),
      scenarioIds,
      remediationVerification: options.remediationVerification,
    }),
  });
  const scan: Scan = (await response.json()).scan;
  return waitForScan(scan, onProgress);
}

export async function waitForScan(
  initialScan: Scan,
  onProgress?: (scan: Scan) => void,
): Promise<Scan> {
  let scan = initialScan;
  onProgress?.(scan);
  const maxPollAttempts = 1200;
  for (
    let attempt = 0;
    attempt < maxPollAttempts &&
    (scan.status === "queued" || scan.status === "running");
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    scan = await getScan(scan.id);
    onProgress?.(scan);
  }
  return scan;
}

export async function getScan(scanId: string): Promise<Scan> {
  return (await request(`/api/scans/${scanId}`)).json().then((body) => body.scan);
}

export async function applyScanPolicyFix(
  scanId: string,
  scenarioId: string,
  expectedPolicyVersion: number,
): Promise<{ policy: WorkspacePolicy; proposal: PolicyFixProposal }> {
  return request(`/api/scans/${encodeURIComponent(scanId)}/policy-fixes/${encodeURIComponent(scenarioId)}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedPolicyVersion }),
  }).then((response) => response.json());
}
