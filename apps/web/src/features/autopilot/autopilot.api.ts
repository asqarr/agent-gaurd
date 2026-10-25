import { request } from "../../shared/api/client";
import type { Agent, AutopilotAssessment } from "../../shared/types/api";

export async function startAutopilotAssessment(agentId: string): Promise<AutopilotAssessment> {
  const response = await request("/api/autopilot/assessments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId }),
  });
  return response.json().then((body) => body.assessment);
}

export async function getAutopilotAssessment(assessmentId: string): Promise<AutopilotAssessment> {
  return request(`/api/autopilot/assessments/${assessmentId}`)
    .then((response) => response.json())
    .then((body) => body.assessment);
}

export async function applyAutopilotProtection(assessmentId: string): Promise<{
  assessment: AutopilotAssessment;
  agent: Agent;
  protection: {
    applied: boolean;
    alreadyApplied: boolean;
    token: string | null;
    gateway: { method: string; path: string } | null;
  };
}> {
  const response = await request(`/api/autopilot/assessments/${assessmentId}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  return response.json();
}
