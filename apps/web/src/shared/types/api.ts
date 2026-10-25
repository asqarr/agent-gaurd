export type ScanStatus = "queued" | "running" | "completed" | "failed";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
  role: string;
  emailVerified?: boolean;
  mfaEnabled?: boolean;
};

export type WorkspaceMember = {
  id: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member" | string;
  joinedAt: string;
};

export type WorkspaceSettings = {
  user: SessionUser;
  workspace: {
    id: string;
    name: string;
    createdAt: string;
    memberCount: number;
    agentCount: number;
  };
  members: WorkspaceMember[];
  security: {
    passwordChangedAt: string | null;
    sessionDurationDays: number;
    accessTokenDurationDays: number;
    sessionStorage: "httpOnly_cookie" | string;
    emailVerified: boolean;
    mfaEnabled: boolean;
  };
};

export type Agent = {
  id: string;
  name: string;
  description: string;
  environment: string;
  provider: string;
  model: string;
  mode: string;
  status: string;
  lastScan: string | null;
  score: number | null;
  endpoint?: string | null;
  apiKeyConfigured?: boolean;
  quarantinedAt?: string | null;
  quarantineReason?: string | null;
  isQuarantined?: boolean;
  runtimeEnabled?: boolean;
  runtimeBlockedCount?: number;
  runtimeLastEventAt?: string | null;
  tools: string[];
};

export type SentinelSeverity = "none" | "low" | "medium" | "high" | "critical";

export type SentinelChange = {
  id: string;
  category: string;
  field: string;
  from: unknown;
  to: unknown;
  severity: Exclude<SentinelSeverity, "none">;
  impact: string;
};

export type SentinelState = {
  agentId: string;
  agentName: string;
  agentStatus: string;
  status: "protected" | "drifted" | "unbaselined" | "disabled";
  severity: SentinelSeverity;
  baseline: {
    id: string;
    fingerprint: string;
    source: string;
    createdAt: string;
    createdBy: string | null;
  } | null;
  currentFingerprint: string;
  changes: SentinelChange[];
  lastCheckedAt: string | null;
  settings: {
    enabled: boolean;
    autoQuarantine: boolean;
  };
  openEvent: {
    id: string;
    baselineId: string | null;
    fingerprint: string;
    severity: Exclude<SentinelSeverity, "none">;
    status: "open" | "resolved";
    changes: SentinelChange[];
    detectedAt: string;
    resolvedAt: string | null;
  } | null;
};

export type SentinelOverview = {
  summary: {
    totalAgents: number;
    protected: number;
    drifted: number;
    unbaselined: number;
    disabled: number;
    openDrifts: number;
  };
  agents: SentinelState[];
};

export type IncidentSeverity = "info" | "low" | "medium" | "high" | "critical";
export type IncidentEventType = "sentinel_drift" | "agent_quarantined" | "scan_finding" | "scan_failed" | "runtime_block";

export type Incident = {
  id: string;
  agentId: string | null;
  agentName: string | null;
  eventType: IncidentEventType;
  severity: IncidentSeverity;
  title: string;
  message: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  status: "open" | "resolved";
  readAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
};

export type IncidentSummary = {
  summary: { open: number; unread: number; critical: number };
  incidents: Incident[];
};

export type AuditEvent = {
  id: string;
  actorType: "user" | "system" | "runtime";
  actor: { name: string | null; email: string | null } | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  requestId: string | null;
  ipAddress: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type AlertWebhook = {
  id: string;
  name: string;
  endpointHost: string;
  eventTypes: string[];
  enabled: boolean;
  failureCount: number;
  lastError: string | null;
  lastDeliveredAt: string | null;
  createdAt: string;
};

export type RuntimeEvent = {
  id: string;
  requestId: string;
  decision: "ALLOW" | "BLOCK";
  toolName: string;
  reasons: string[];
  latencyMs: number;
  outcome?: "decision" | "error" | "quota";
  errorCode?: string | null;
  failureStage?: string | null;
  createdAt: string;
};

export type RuntimeHealthIssue = {
  outcome: "error" | "quota";
  errorCode: string | null;
  failureStage: string | null;
  latencyMs: number;
  createdAt: string;
};

export type RuntimeHealth = {
  window: "24h" | "7d";
  observationStatus: "disabled" | "no_data" | "quota_limited" | "no_recent_traffic" | "degraded" | "observed";
  sampleCount: number;
  decisionCount: number;
  allowCount: number;
  blockCount: number;
  errorCount: number;
  quotaRejectedCount: number;
  errorRatePercent: number;
  p50Ms: number | null;
  p95Ms: number | null;
  lastEventAt: string | null;
  lastDecisionAt: string | null;
  lastErrorAt: string | null;
  recentIssues: RuntimeHealthIssue[];
  observedOnly: true;
  observedAt: string;
};

export type EnforcementVerificationCheck = {
  id: string;
  title: string;
  tool: string;
  status: "passed" | "failed";
  expected: string;
  observed: string;
  reproduction: string;
  remediation: string;
  evidence: Record<string, unknown>;
};

export type EnforcementVerification = {
  id: string;
  status: "passed" | "failed";
  verifierVersion: string;
  testedAt: string;
  scope: {
    agentId: string;
    agentName: string;
    policy: { name: string; maxAmount: number; maxAgeDays: number; currency: string };
    contractVersion: number;
    allowedToolIds: string[];
    environment: string;
  };
  summary: {
    passed: number;
    failed: number;
    total: number;
    customerEndpointCalls: number;
    externalToolCalls: number;
    financialSideEffects: number;
  };
  checks: EnforcementVerificationCheck[];
  notTested: string[];
  limitations: string[];
  fingerprint: string;
  isCurrent?: boolean;
};

export type AgentConnection = {
  ok: boolean;
  status: "reachable" | "not_configured" | "unsafe_endpoint" | "invalid_endpoint" | "unreachable" | "rejected" | "invalid_response";
  latencyMs: number;
  httpStatus?: number;
  responseFormat?: string;
  executionSafety?: "safe" | "unknown" | "unsafe" | string;
  message: string;
};

export type Tool = {
  id: string;
  name: string;
  label: string;
  risk: "read" | "low" | "high" | "critical";
  sideEffect: boolean;
};

export type Scenario = {
  id: string;
  title: string;
  category: string;
  description: string;
  risk: "controlled" | "medium" | "high" | "critical";
  attackClass: string;
  objective: string;
  control: string;
  orderId: string;
  amount: number;
  expected: "allow" | "block";
};

export type ScenarioCatalog = {
  scenarios: Scenario[];
  policy: Pick<Overview["policy"], "name" | "maxAmount" | "maxAgeDays" | "currency">;
  entitlements: {
    scenarioLimit: number;
    fullScenarioSuite: boolean;
    lockedScenarioCount: number;
  };
};

export type BillingPlan = {
  id: string;
  name: string;
  description: string;
  billingInterval: "month" | "year";
  priceUsdCents: number;
  maxAgents: number;
  monthlyScanCredits: number;
  scanCreditMode: "monthly" | "one_time";
  historyDays: number;
  seatLimit: number;
  runtimeFirewall: boolean;
  scenarioLimit: number;
  scanCreditsPerScan: number;
  autopilot: boolean;
  sentinel: boolean;
  incidentCenter: boolean;
  alertWebhooks: boolean;
  exportReports: boolean;
  maxWebhooks: number;
  runtimeDecisionsIncluded: number;
  whiteLabelReports: boolean;
  multiClientManagement: boolean;
  features: string[];
};

export type BillingState = {
  plan: BillingPlan;
  subscription: {
    id: string;
    planId: string;
    status: "trialing" | "active" | "past_due" | "canceled" | "incomplete";
    billingProvider: string;
    providerCustomerId: string | null;
    providerSubscriptionId: string | null;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    renewalMode: "manual" | "automatic";
    pendingPlanId: string | null;
    pendingPlanEffectiveAt: string | null;
    lastExpiryFallback: {
      fromPlanId: string;
      fromPlanName: string;
      at: string;
    } | null;
  };
  usage: {
    periodStart: string;
    periodEnd: string;
    scanCreditsUsed: number;
    scanCreditsIncluded: number;
    scanCreditsRemaining: number;
    scanCreditAddonsRemaining: number;
    totalScanCreditsRemaining: number;
    fullScanCredits: number;
    runtimeDecisionsUsed: number;
    runtimeDecisionsIncluded: number;
    runtimeDecisionsRemaining: number;
    runtimeDecisionAddonsRemaining: number;
    totalRuntimeDecisionsRemaining: number;
    alerts: Array<{
      resource: "scan_credits" | "runtime_decisions";
      threshold: 70 | 90 | 100;
      severity: "notice" | "warning" | "critical";
      message: string;
      addonRemaining: number;
    }>;
  };
  entitlements: {
    active: boolean;
    maxAgents: number;
    runtimeFirewall: boolean;
    scenarioLimit: number;
    fullScenarioSuite: boolean;
    autopilot: boolean;
    sentinel: boolean;
    incidentCenter: boolean;
    alertWebhooks: boolean;
    exportReports: boolean;
    maxWebhooks: number;
    historyDays: number;
    seatLimit: number;
    agentAddons: number;
    whiteLabelReports: boolean;
    multiClientManagement: boolean;
  };
};

export type BillingUsageMetrics = {
  period: { start: string; end: string };
  measurement: {
    scanCredits: number;
    runtimeDecisions: number;
    operations: number;
    durationMs: number;
    cpuMs: number;
    averageDurationMs: number;
    maxDurationMs: number;
    cpuAvailable: boolean;
  };
  unitEconomics: {
    per1000ScanCredits: {
      sampleUnits: number;
      durationMs: number;
      cpuMs: number;
      estimatedComputeUsd: number;
    };
    per10000RuntimeDecisions: {
      sampleUnits: number;
      durationMs: number;
      cpuMs: number;
      estimatedComputeUsd: number;
    };
  };
  storage: {
    capturedAt: string;
    databaseSizeBytes: number;
    logicalBytes: number;
    scansBytes: number;
    scanResultsBytes: number;
    scanProgressBytes: number;
    runtimeEventsBytes: number;
    measurementsBytes: number;
  } | null;
  costModel: {
    cpuUsdPerHour: number;
    storageUsdPerGbMonth: number;
    configuredEstimate: boolean;
    cpuMeasurementAvailable: boolean;
  };
  estimatedCostUsd: {
    compute: number;
    storageMonthlyRunRate: number;
    total: number;
  };
  retention: {
    lastRunAt: string;
    candidates: number;
    deletedScans: number;
    durationMs: number;
    status: "completed" | "failed";
  } | null;
};

export type BillingServiceOrder = {
  id: string;
  addonId: string;
  addonName: string;
  kind: "security_audit" | "support";
  status: "queued" | "in_progress" | "delivered" | "accepted" | "canceled";
  targetAgentId: string | null;
  targetAgentName: string | null;
  scope: string;
  deliveryWindow: string;
  acceptanceTerms: string;
  includedHours: number;
  overagePolicy: string;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
  acceptedAt: string | null;
};

export type BillingAddon = {
  id: string;
  name: string;
  description: string;
  kind: "scan_credits" | "runtime_decisions" | "agent_slot" | "security_audit" | "support";
  units: number;
  priceUsdCents: number;
  billingInterval: "one_time" | "month";
  includedHours: number;
  overagePolicy: string;
  serviceScope: string;
  deliveryWindow: string;
  acceptanceTerms: string;
};

export type BillingCheckout = {
  id: string;
  workspaceId: string;
  planId: string | null;
  checkoutType: "plan" | "addon";
  addonId: string | null;
  provider: string;
  status: "created" | "waiting" | "awaiting_payment" | "confirming" | "paid" | "completed" | "expired" | "canceled" | "failed";
  providerCheckoutId: string | null;
  providerUrl: string | null;
  amountUsdCents: number;
  quoteAmount: string | null;
  quoteCurrency: string | null;
  network: string | null;
  payAddress: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BillingPayment = {
  id: string;
  workspaceId: string;
  checkoutSessionId: string | null;
  checkoutType: "plan" | "addon" | null;
  planId: string | null;
  planName: string | null;
  addonId: string | null;
  addonName: string | null;
  provider: string;
  providerPaymentId: string | null;
  status: "pending" | "confirming" | "confirmed" | "failed" | "expired" | "refunded" | string;
  amount: string;
  netAmount: string | null;
  currency: string;
  network: string | null;
  walletAddress: string | null;
  txHash: string | null;
  confirmations: number;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BillingPaymentException = {
  id: string;
  workspaceId: string | null;
  checkoutSessionId: string | null;
  provider: string;
  network: string;
  txHash: string;
  providerPaymentId: string | null;
  senderAddress: string | null;
  recipientAddress: string | null;
  tokenContract: string | null;
  amountAtomic: string | null;
  amountUsdt: string | null;
  decimals: number;
  detectedAt: string;
  transferTimestamp: string | null;
  reason: "underpaid" | "overpaid" | "late_payment" | "unmatched_order" | "wrong_token" | "wrong_recipient" | "duplicate_transaction" | "manual_review" | string;
  status: "open" | "assigned" | "refund_required" | "refunded" | "resolved" | "ignored";
  resolutionNote: string | null;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  rawPayload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ScanToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type ScanProgress = {
  scenarioId: string;
  ordinal: number;
  title: string;
  category: string;
  expected: string;
  status: "queued" | "running" | "passed" | "blocked" | "failed" | "error";
  observed?: string | null;
  guard?: { decision: string; execution: string | null } | null;
  reasons: string[];
  call?: ScanToolCall | null;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
};

export type Scan = {
  id: string;
  agentId: string;
  agentName?: string;
  status: ScanStatus;
  score: number | null;
  passed: number;
  failed: number;
  blocked: number;
  simulated: number;
  durationMs: number | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  trigger: string;
  executionMode?: "simulation" | string;
  safetyStatus?: "safe" | "unknown_endpoint" | "unsafe" | string;
  safetyWarning?: string | null;
  contractVersion?: number;
  scenarioCount?: number;
  error?: string | null;
  progress?: ScanProgress[];
  results?: Array<{
    scenarioId: string;
    title: string;
    category: string;
    expected: string;
    observed: string;
    status: "PASS" | "FAIL" | "ERROR";
    guard: { decision: string; execution: string } | null;
    reasons: string[];
    call?: ScanToolCall | null;
    source?: string;
  }>;
  attackPaths?: AttackPathResult[];
};

export type SecurityDemoProof = {
  id: string;
  title: string;
  requestId: string;
  attemptedToolCall: ScanToolCall;
  policy: {
    name: string;
    maxAmount: number;
    currency: string;
  };
  guard: {
    decision: "ALLOW" | "BLOCK" | string;
    execution: "NOT_EXECUTED" | "PASS_THROUGH" | string;
    reasons: string[];
  };
  evidence: {
    sideEffectExecuted: boolean;
    toolReachedCustomerExecutor: boolean;
    orderId: string;
    observedAt: string;
  };
};

export type AttackPath = {
  id: string;
  title: string;
  description: string;
  severity: "high" | "critical";
  scenarioIds: string[];
  objective: string;
  locked?: boolean;
  requiredPlan?: string;
};

export type AttackPathResult = AttackPath & {
  status: "protected" | "vulnerable" | "incomplete";
  steps: Array<{
    scenarioId: string;
    title: string;
    status: "PASS" | "FAIL" | "ERROR" | "PENDING";
    observed: string | null;
    guard: { decision: string; execution: string } | null;
    reasons: string[];
  }>;
};

export type SecurityContract = {
  id: string | null;
  agentId: string;
  version: number;
  status: "active" | "derived" | "superseded" | "historical";
  allowedToolIds: string[];
  maxRefundAmount: number;
  maxOrderAgeDays: number;
  notes: string;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ContractComparison = {
  agentId: string;
  fromVersion: number | null;
  toVersion: number | null;
  before: SecurityContract | null;
  after: SecurityContract | null;
  contractDiff: {
    status: "baseline_missing" | "weakened" | "hardened" | "unchanged";
    risk: "unknown" | "high" | "low" | "none";
    addedTools: string[];
    removedTools: string[];
    boundaryChanges: Array<{
      field: string;
      before: number;
      after: number;
      delta: number;
      unit: string;
      direction: "widened" | "narrowed";
    }>;
    notesChanged: boolean;
    warnings: string[];
  };
  evidence: {
    status: "compared" | "baseline_missing" | "pending";
    verdict: "regressed" | "improved" | "unchanged" | "unknown";
    beforeScan: Scan | null;
    afterScan: Scan | null;
    scenarioChanges: Array<{ scenarioId: string; before: string | null; after: string | null; status: string }>;
    attackPathChanges: Array<{ pathId: string; before: string | null; after: string | null; status: string }>;
    regressedCount: number;
    fixedCount: number;
    unchangedCount: number;
    unknownCount: number;
    scoreDelta: number | null;
  };
  history: Array<{ version: number; createdAt: string; hasScan: boolean }>;
};

export type Overview = {
  metrics: {
    securityScore: number;
    protectedActions: number;
    openFindings: number;
    scansThisMonth: number;
  };
  posture: {
    scenarioPassRate: number;
    agentCoverage: number;
    blockedLast7Days: number;
  };
  recentScans: Scan[];
  policy: {
    id: string;
    name: string;
    maxAmount: number;
    maxAgeDays: number;
    currency: string;
    enforcement?: string;
  };
};

export type AutopilotPhase = "connecting" | "inventory" | "testing" | "blueprint" | "protected";

export type AutopilotBlueprint = {
  readinessScore: number;
  readinessLabel: string;
  summary: string;
  connection: {
    status: string;
    responseFormat: string | null;
    latencyMs: number | null;
    message: string;
    simulated: boolean;
  };
  stats: {
    scenarios: number;
    passed: number;
    findings: number;
    criticalFindings: number;
    sideEffectTools: number;
    unknownTools: number;
  };
  toolInventory: Array<{
    id: string;
    name: string;
    label: string;
    risk: string;
    sideEffect: boolean;
    configured: boolean;
    observed: boolean;
    posture: string;
  }>;
  findings: Array<{
    id: string;
    title: string;
    category: string;
    severity: string;
    impact: string;
    observed: string;
    recommendation: string;
    reasons: string[];
  }>;
  recommendations: Array<{
    id: string;
    title: string;
    description: string;
    severity: string;
    status: string;
    automatic: boolean;
  }>;
};

export type AutopilotAssessment = {
  id: string;
  agentId: string;
  agentName: string;
  scanId: string;
  status: "queued" | "running" | "completed" | "applied" | "failed";
  phase: AutopilotPhase;
  connection: AgentConnection;
  appliedAt: string | null;
  appliedBy: string | null;
  createdAt: string;
  scan: Scan | null;
  blueprint: AutopilotBlueprint | null;
  agent: {
    id: string;
    name: string;
    runtimeEnabled: boolean;
    status: string;
  } | null;
};
