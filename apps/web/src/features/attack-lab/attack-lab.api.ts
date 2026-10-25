export type AttackLabScenarioId =
  | "refund_policy"
  | "argument_tampering"
  | "approval_replay";

export type AttackLabStep = {
  label: string;
  status: "complete" | "allowed" | "blocked" | "safe";
};

export type AttackLabResult = {
  id: string;
  scenarioId: AttackLabScenarioId;
  title: string;
  decision: "ALLOW" | "BLOCK" | "ERROR";
  execution: "NOT_EXECUTED" | "SIMULATION_ONLY";
  reasons: string[];
  summary: string;
  toolCall: { name: string; arguments: Record<string, unknown> };
  policy: {
    name: string;
    maxAmount: number;
    currency: string;
    maxOrderAgeDays: number;
  };
  steps: AttackLabStep[];
  evidence: {
    requestId: string;
    orderId: string;
    observedAt: string;
    environment: "SYNTHETIC_SANDBOX";
    customerEndpointCalled: false;
    externalToolCalls: 0;
    financialSideEffects: 0;
  };
  approval?: {
    signatureValid: boolean;
    argumentsMatch?: boolean;
    firstAttemptAuthorized?: boolean;
    replayRejected?: boolean;
    consumer?: string;
    boundTo?: string[];
  };
};

export async function runAttackLab(
  scenarioId: AttackLabScenarioId,
  values: { amount?: number; changedAmount?: number } = {},
): Promise<AttackLabResult> {
  const response = await fetch("/api/attack-lab/run", {
    method: "POST",
    credentials: "omit",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenarioId, ...values }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error ?? `Attack Lab request failed (${response.status}).`);
  }
  return body.result as AttackLabResult;
}
