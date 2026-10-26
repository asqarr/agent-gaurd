import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { logout, getSession } from "../features/auth/auth.api";
import { AuthScreen } from "../features/auth/AuthScreen";
import { createAgent, deleteAgent, disableRuntimeFirewall, enableRuntimeFirewall, getRuntimeEvents, quarantineAgent, restoreAgent, testAgentConnection, updateAgent } from "../features/agents/agents.api";
import { RuntimeShield } from "../features/agents/RuntimeShield";
import { getDashboard } from "../features/dashboard/dashboard.api";
import { getTools } from "../features/integrations/integrations.api";
import { updatePolicy } from "../features/policies/policies.api";
import { getScan, runScan, waitForScan } from "../features/scans/scans.api";
import { startQuickstartDemo } from "../features/quickstart/quickstart.api";
import { ScenarioLibrary } from "../features/scenarios/ScenarioLibrary";
import { BillingPage } from "../features/billing/BillingPage";
import { PlanGate } from "../features/billing/PlanGate";
import { getBillingState } from "../features/billing/billing.api";
import { AutopilotPage } from "../features/autopilot/AutopilotPage";
import { SentinelPage } from "../features/sentinel/SentinelPage";
import { IncidentCenterPage } from "../features/incidents/IncidentCenterPage";
import { SecurityContractPage } from "../features/contracts/SecurityContractPage";
import { getIncidentSummary, markIncidentRead } from "../features/incidents/incidents.api";
import { SetupCenter } from "../features/setup/SetupCenter";
import { SettingsPage } from "../features/settings/SettingsPage";
import type {
  Agent,
  AgentConnection,
  Overview,
  Scan,
  RuntimeEvent,
  SessionUser,
  SecurityDemoProof,
  Tool,
  Incident,
} from "../shared/types/api";
import { Icon, type IconName } from "../shared/ui/Icon";
import { Dialog, type DialogRequest } from "../shared/ui/Dialog";
import { UPGRADE_REQUIRED_EVENT, type UpgradeRequest } from "../shared/api/client";
import { UpgradePrompt } from "../features/billing/UpgradePrompt";
import { LiveScanPanel, ScanEvidencePanel } from "../features/scans/ScanPanels";

const fallbackOverview: Overview = {
  metrics: {
    securityScore: 82,
    protectedActions: 0,
    openFindings: 2,
    scansThisMonth: 18,
  },
  recentScans: [
    {
      id: "scan-7d2a",
      agentId: "storefront-copilot",
      agentName: "Storefront Support Copilot",
      status: "completed",
      score: 96,
      passed: 6,
      failed: 0,
      blocked: 0,
      simulated: 2,
      durationMs: 18240,
      createdAt: "2026-10-02T17:42:00.000Z",
      trigger: "Scheduled",
    },
    {
      id: "scan-2bf1",
      agentId: "returns-lab",
      agentName: "Returns Lab Agent",
      status: "completed",
      score: 68,
      passed: 4,
      failed: 2,
      blocked: 2,
      simulated: 4,
      durationMs: 24680,
      createdAt: "2026-10-01T09:18:00.000Z",
      trigger: "Pull request",
    },
  ],
  policy: {
    id: "storefront-refunds-v1",
    name: "Storefront refunds",
    maxAmount: 50,
    maxAgeDays: 14,
    currency: "USD",
  },
  posture: { scenarioPassRate: 0, agentCoverage: 0, blockedLast7Days: 0 },
};

const fallbackAgents: Agent[] = [
  {
    id: "storefront-copilot",
    name: "Storefront Support Copilot",
    description: "Customer support agent with refund and order lookup tools.",
    environment: "Production",
    provider: "Inception AI",
    model: "mercury-2.5",
    mode: "protected",
    status: "connected",
    lastScan: "2026-10-02T17:42:00.000Z",
    score: 96,
    tools: ["get_order", "issue_refund", "create_ticket"],
  },
  {
    id: "returns-lab",
    name: "Returns Lab Agent",
    description: "Staging agent used to validate new return workflows.",
    environment: "Staging",
    provider: "OpenAI-compatible API",
    model: "gpt-4.1-mini",
    mode: "needs_attention",
    status: "connected",
    lastScan: "2026-10-01T09:18:00.000Z",
    score: 68,
    tools: ["get_order", "issue_refund", "cancel_order"],
  },
];

function formatRelativeDate(value: string) {
  const date = new Date(value);
  const hours = Math.max(
    1,
    Math.round((Date.now() - date.getTime()) / 3600000),
  );
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function formatDuration(durationMs: number | null) {
  return durationMs == null ? "—" : `${(durationMs / 1000).toFixed(1)}s`;
}

function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "AG"
  );
}

function ScoreRing({ score }: { score: number }) {
  return (
    <div
      className="score-ring"
      style={{ "--score": `${score * 3.6}deg` } as CSSProperties}
    >
      <div className="score-ring__inner">
        <strong>{score}</strong>
        <span>/100</span>
      </div>
    </div>
  );
}

function SecurityOrb({ score }: { score: number }) {
  return (
    <div
      className="orb-scene"
      aria-label={`Security score ${score} out of 100`}
    >
      <div className="orb-halo orb-halo--one" />
      <div className="orb-halo orb-halo--two" />
      <div className="orb-core">
        <div className="orb-core__grid" />
        <span>AG</span>
      </div>
      <div className="orb-ring orb-ring--one" />
      <div className="orb-ring orb-ring--two" />
      <div className="orb-node orb-node--one">
        <Icon name="lock" size={13} />
      </div>
      <div className="orb-node orb-node--two">
        <Icon name="activity" size={13} />
      </div>
      <div className="orb-node orb-node--three">
        <Icon name="shield" size={13} />
      </div>
      <div className="orb-caption">
        <span>Security posture</span>
        <strong>{score}% healthy</strong>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  delta,
  icon,
  tone = "cyan",
}: {
  label: string;
  value: string | number;
  delta: string;
  icon: IconName;
  tone?: string;
}) {
  return (
    <div className="metric-card">
      <div className={`metric-icon metric-icon--${tone}`}>
        <Icon name={icon} />
      </div>
      <div>
        <span className="eyebrow">{label}</span>
        <strong className="metric-value">{value}</strong>
        <span className="metric-delta">{delta}</span>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const label =
    status === "completed"
      ? "Completed"
      : status === "needs_attention"
        ? "Needs attention"
        : status === "queued"
          ? "Queued"
          : status === "running"
            ? "Running"
            : status;
  return (
    <span className={`status-pill status-pill--${status}`}>
      <i />
      {label}
    </span>
  );
}

function WorkspaceView({
  active,
  agents,
  overview,
  selectedAgent,
  setSelectedAgent,
  onScan,
  scanning,
  onAgentCreated,
  onAgentUpdated,
  onAgentDeleted,
  showConnectForm,
  setShowConnectForm,
  onOpenConnect,
  onQuickStart,
  quickStartBusy,
  onNavigate,
  onPolicyUpdated,
  authUser,
  onUserUpdated,
  onLogout,
}: {
  active: string;
  agents: Agent[];
  overview: Overview;
  selectedAgent: string;
  setSelectedAgent: (id: string) => void;
  onScan: () => void;
  scanning: boolean;
  onAgentCreated: (agent: Agent) => void;
  onAgentUpdated: (agent: Agent) => void;
  onAgentDeleted: (agentId: string) => void;
  showConnectForm: boolean;
  setShowConnectForm: (value: boolean) => void;
  onOpenConnect: () => void;
  onQuickStart: () => void;
  quickStartBusy: boolean;
  onNavigate: (page: string) => void;
  onPolicyUpdated: (policy: Overview["policy"]) => void;
  authUser: SessionUser;
  onUserUpdated: (user: SessionUser) => void;
  onLogout: () => void;
}) {
  const [agentName, setAgentName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [provider, setProvider] = useState("OpenAI-compatible API");
  const [model, setModel] = useState("Unknown");
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectError, setConnectError] = useState("");
  const [tools, setTools] = useState<Tool[]>([]);
  const [showToolRegistry, setShowToolRegistry] = useState(false);
  const [toolsBusy, setToolsBusy] = useState(false);
  const [toolError, setToolError] = useState("");
  const [showPolicyForm, setShowPolicyForm] = useState(false);
  const [policyName, setPolicyName] = useState(overview.policy.name);
  const [policyAmount, setPolicyAmount] = useState(
    String(overview.policy.maxAmount),
  );
  const [policyAge, setPolicyAge] = useState(
    String(overview.policy.maxAgeDays),
  );
  const [policyCurrency, setPolicyCurrency] = useState(
    overview.policy.currency,
  );
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyError, setPolicyError] = useState("");
  const [selectedScanId, setSelectedScanId] = useState<string | null>(null);
  const [selectedScan, setSelectedScan] = useState<Scan | null>(null);
  const [scanDetailBusy, setScanDetailBusy] = useState(false);
  const [scanDetailError, setScanDetailError] = useState("");
  const [editingAgent, setEditingAgent] = useState(false);
  const [editAgentName, setEditAgentName] = useState("");
  const [editEndpoint, setEditEndpoint] = useState("");
  const [editApiKey, setEditApiKey] = useState("");
  const [clearAgentApiKey, setClearAgentApiKey] = useState(false);
  const [editProvider, setEditProvider] = useState("");
  const [editModel, setEditModel] = useState("");
  const [editEnvironment, setEditEnvironment] = useState("");
  const [selectedToolIds, setSelectedToolIds] = useState<string[]>([]);
  const [agentEditBusy, setAgentEditBusy] = useState(false);
  const [agentEditError, setAgentEditError] = useState("");
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connectionResult, setConnectionResult] = useState<AgentConnection | null>(null);
  const [quarantineBusy, setQuarantineBusy] = useState(false);
  const [agentDeleteBusy, setAgentDeleteBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const [dialogId, setDialogId] = useState(0);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [runtimeToken, setRuntimeToken] = useState("");
  const [runtimeEvents, setRuntimeEvents] = useState<RuntimeEvent[]>([]);
  const [runtimeError, setRuntimeError] = useState("");
  const selected =
    agents.find((agent) => agent.id === selectedAgent) ?? agents[0];

  useEffect(() => {
    setPolicyName(overview.policy.name);
    setPolicyAmount(String(overview.policy.maxAmount));
    setPolicyAge(String(overview.policy.maxAgeDays));
    setPolicyCurrency(overview.policy.currency);
  }, [
    overview.policy.id,
    overview.policy.name,
    overview.policy.maxAmount,
    overview.policy.maxAgeDays,
    overview.policy.currency,
  ]);

  useEffect(() => {
    if ((active === "Integrations" || active === "Agents") && tools.length === 0) void loadTools();
  }, [active]);

  useEffect(() => {
    setEditingAgent(false);
    setConnectionResult(null);
    setAgentEditError("");
  }, [selectedAgent]);

  useEffect(() => {
    setRuntimeToken("");
    setRuntimeError("");
    setRuntimeEvents([]);
    if (!selected?.runtimeEnabled) return undefined;
    let activeRequest = true;
    getRuntimeEvents(selected.id)
      .then((events) => {
        if (activeRequest) setRuntimeEvents(events);
      })
      .catch((caught) => {
        if (activeRequest) setRuntimeError(caught instanceof Error ? caught.message : "Runtime events could not be loaded.");
      });
    return () => {
      activeRequest = false;
    };
  }, [selectedAgent, selected?.runtimeEnabled]);

  useEffect(() => {
    if (
      !selectedScanId ||
      !selectedScan ||
      !["queued", "running"].includes(selectedScan.status)
    ) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      getScan(selectedScanId)
        .then((nextScan) => setSelectedScan(nextScan))
        .catch((caught) => {
          setScanDetailError(
            caught instanceof Error
              ? caught.message
              : "Scan evidence could not be refreshed.",
          );
        });
    }, 1200);

    return () => window.clearTimeout(timer);
  }, [selectedScanId, selectedScan?.status]);

  async function loadTools() {
    setToolsBusy(true);
    setToolError("");
    try {
      setTools(await getTools());
    } catch (caught) {
      setToolError(
        caught instanceof Error
          ? caught.message
          : "Tool registry is unavailable.",
      );
    } finally {
      setToolsBusy(false);
    }
  }

  async function submitPolicy(event: FormEvent) {
    event.preventDefault();
    setPolicyBusy(true);
    setPolicyError("");
    try {
      const policy = await updatePolicy({
        id: overview.policy.id,
        name: policyName,
        maxAmount: Number(policyAmount),
        maxAgeDays: Number(policyAge),
        currency: policyCurrency.toUpperCase(),
      });
      onPolicyUpdated(policy);
      setShowPolicyForm(false);
    } catch (caught) {
      setPolicyError(
        caught instanceof Error ? caught.message : "Policy update failed.",
      );
    } finally {
      setPolicyBusy(false);
    }
  }

  async function submitAgent(event: FormEvent) {
    event.preventDefault();
    setConnectBusy(true);
    setConnectError("");
    try {
      const agent = await createAgent({
        name: agentName,
        endpoint,
        apiKey,
        provider,
        model,
      });
      onAgentCreated(agent);
      setAgentName("");
      setEndpoint("");
      setApiKey("");
      setShowConnectForm(false);
    } catch (caught) {
      setConnectError(
        caught instanceof Error ? caught.message : "Agent connection failed.",
      );
    } finally {
      setConnectBusy(false);
    }
  }

  function beginAgentEdit(agent: Agent) {
    setEditAgentName(agent.name);
    setEditEndpoint(agent.endpoint ?? "");
    setEditApiKey("");
    setClearAgentApiKey(false);
    setEditProvider(agent.provider);
    setEditModel(agent.model);
    setEditEnvironment(agent.environment);
    setSelectedToolIds(agent.tools);
    setAgentEditError("");
    setEditingAgent(true);
  }

  async function submitAgentEdit(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setAgentEditBusy(true);
    setAgentEditError("");
    try {
      const agent = await updateAgent({
        id: selected.id,
        name: editAgentName,
        endpoint: editEndpoint,
        apiKey: editApiKey || undefined,
        clearApiKey: clearAgentApiKey,
        environment: editEnvironment,
        provider: editProvider,
        model: editModel,
        toolIds: selectedToolIds,
      });
      onAgentUpdated(agent);
      setEditingAgent(false);
      setEditApiKey("");
      setConnectionResult(null);
    } catch (caught) {
      setAgentEditError(
        caught instanceof Error ? caught.message : "Agent update failed.",
      );
    } finally {
      setAgentEditBusy(false);
    }
  }

  async function checkAgentConnection() {
    if (!selected) return;
    setConnectionBusy(true);
    setConnectionResult(null);
    setAgentEditError("");
    try {
      const result = await testAgentConnection(selected.id);
      setConnectionResult(result.connection);
      onAgentUpdated(result.agent);
    } catch (caught) {
      setAgentEditError(
        caught instanceof Error
          ? caught.message
          : "Connection test failed.",
      );
    } finally {
      setConnectionBusy(false);
    }
  }

  function openDialog(request: Omit<DialogRequest, "id">) {
    const nextId = dialogId + 1;
    setDialogId(nextId);
    setDialog({ ...request, id: nextId });
  }

  async function enableRuntimeProtection() {
    if (!selected || runtimeBusy) return;
    setRuntimeBusy(true);
    setRuntimeError("");
    try {
      const result = await enableRuntimeFirewall(selected.id);
      setRuntimeToken(result.token);
      onAgentUpdated(result.agent);
      setRuntimeEvents(await getRuntimeEvents(selected.id));
    } catch (caught) {
      setRuntimeError(caught instanceof Error ? caught.message : "Runtime Firewall could not be enabled.");
    } finally {
      setRuntimeBusy(false);
    }
  }

  async function applyRuntimeDisable() {
    if (!selected || runtimeBusy) return;
    setRuntimeBusy(true);
    setRuntimeError("");
    try {
      const agent = await disableRuntimeFirewall(selected.id);
      setRuntimeToken("");
      onAgentUpdated(agent);
    } catch (caught) {
      setRuntimeError(caught instanceof Error ? caught.message : "Runtime Firewall could not be disabled.");
    } finally {
      setRuntimeBusy(false);
    }
  }

  function requestRuntimeDisable() {
    if (!selected || runtimeBusy) return;
    openDialog({
      kind: "confirm",
      title: "Disable Runtime Firewall",
      description: `Live tool-call protection for ${selected.name} will stop immediately. Scheduled scans will remain available.`,
      confirmLabel: "Disable firewall",
      tone: "danger",
      onConfirm: () => {
        setDialog(null);
        void applyRuntimeDisable();
      },
    });
  }

  async function applyAgentQuarantine(reason: string) {
    if (!selected || quarantineBusy) return;
    setQuarantineBusy(true);
    try {
      const agent = await quarantineAgent(selected.id, reason.trim() || "Manual security response");
      onAgentUpdated(agent);
      setConnectionResult(null);
      setAgentEditError("");
    } catch (caught) {
      setAgentEditError(caught instanceof Error ? caught.message : "Could not quarantine agent.");
    } finally {
      setQuarantineBusy(false);
    }
  }

  async function applyAgentRestore() {
    if (!selected || quarantineBusy) return;
    setQuarantineBusy(true);
    try {
      const agent = await restoreAgent(selected.id);
      onAgentUpdated(agent);
      setAgentEditError("");
    } catch (caught) {
      setAgentEditError(caught instanceof Error ? caught.message : "Could not restore agent.");
    } finally {
      setQuarantineBusy(false);
    }
  }

  function toggleAgentQuarantine() {
    if (!selected || quarantineBusy) return;
    const quarantined = selected.status === "quarantined";
    if (!quarantined) {
      openDialog({
        kind: "input",
        title: "Quarantine agent",
        description: `${selected.name} will be blocked from new scans until an administrator restores it.`,
        inputLabel: "Security reason",
        placeholder: "Suspicious behavior found during review",
        defaultValue: "Suspicious behavior found during review",
        confirmLabel: "Quarantine agent",
        tone: "danger",
        onConfirm: (reason) => {
          setDialog(null);
          void applyAgentQuarantine(reason ?? "Manual security response");
        },
      });
      return;
    }
    openDialog({
      kind: "confirm",
      title: "Restore agent",
      description: `${selected.name} will be allowed to receive new scans again.`,
      confirmLabel: "Restore agent",
      onConfirm: () => {
        setDialog(null);
        void applyAgentRestore();
      },
    });
  }

  async function applyAgentDelete() {
    if (!selected || agentDeleteBusy) return;
    setAgentDeleteBusy(true);
    setAgentEditError("");
    try {
      await deleteAgent(selected.id);
      onAgentDeleted(selected.id);
      setEditingAgent(false);
      setConnectionResult(null);
    } catch (caught) {
      setAgentEditError(
        caught instanceof Error ? caught.message : "Agent deletion failed.",
      );
    } finally {
      setAgentDeleteBusy(false);
    }
  }

  function removeSelectedAgent() {
    if (!selected || agentDeleteBusy) return;
    openDialog({
      kind: "confirm",
      title: "Delete agent",
      description: `${selected.name} and its scans and evidence will be permanently removed.`,
      confirmLabel: "Delete agent",
      tone: "danger",
      onConfirm: () => {
        setDialog(null);
        void applyAgentDelete();
      },
    });
  }

  function toggleTool(toolId: string) {
    setSelectedToolIds((current) =>
      current.includes(toolId)
        ? current.filter((id) => id !== toolId)
        : [...current, toolId],
    );
  }

  async function openScanEvidence(scanId: string) {
    setSelectedScanId(scanId);
    setSelectedScan(null);
    setScanDetailError("");
    setScanDetailBusy(true);
    try {
      setSelectedScan(await getScan(scanId));
    } catch (caught) {
      setScanDetailError(
        caught instanceof Error
          ? caught.message
          : "Scan evidence could not be loaded.",
      );
    } finally {
      setScanDetailBusy(false);
    }
  }

  if (active === "Settings") {
    return (
      <SettingsPage
        authUser={authUser}
        onUserUpdated={onUserUpdated}
        onLogout={onLogout}
      />
    );
  }

  if (active === "Scenarios") {
    return <ScenarioLibrary onUpgrade={() => onNavigate("Plans")} />;
  }

  if (active === "Contracts") {
    return (
      <SecurityContractPage
        agents={agents}
        selectedAgentId={selectedAgent}
        onSelectAgent={setSelectedAgent}
        onUpgrade={() => onNavigate("Plans")}
      />
    );
  }

  if (active === "Autopilot") {
    return (
      <PlanGate entitlement="autopilot" onUpgrade={() => onNavigate("Plans")}>
        <AutopilotPage
          agents={agents}
          selectedAgentId={selectedAgent}
          onAgentUpdated={onAgentUpdated}
          onConnect={onOpenConnect}
        />
      </PlanGate>
    );
  }

  if (active === "Sentinel") {
    return (
      <PlanGate entitlement="sentinel" onUpgrade={() => onNavigate("Plans")}>
        <SentinelPage
          agents={agents}
          selectedAgentId={selectedAgent}
          onSelectAgent={setSelectedAgent}
        />
      </PlanGate>
    );
  }

  if (active === "Incidents") {
    return (
      <PlanGate entitlement="incidentCenter" onUpgrade={() => onNavigate("Plans")}>
        <IncidentCenterPage authUser={authUser} />
      </PlanGate>
    );
  }

  if (active === "Launchpad") {
    return (
      <SetupCenter
        agents={agents}
        overview={overview}
        selectedAgentId={selectedAgent}
        onSelectAgent={setSelectedAgent}
        onNavigate={onNavigate}
        onConnect={onOpenConnect}
        onQuickStart={onQuickStart}
        quickStartBusy={quickStartBusy}
        onRunScan={onScan}
        scanBusy={scanning}
      />
    );
  }

  if (active === "Plans") {
    return <BillingPage authUser={authUser} />;
  }

  if (active === "Agents") {
    return (
      <>
      <section className="workspace-view">
        <div className="workspace-view__heading">
          <div>
            <span className="eyebrow eyebrow--cyan">AGENT INVENTORY</span>
            <h2>Every agent. One security posture.</h2>
            <p>
              Connect storefront agents and understand which actions they can
              propose, access, and execute.
            </p>
          </div>
          <button className="button button--primary" onClick={onOpenConnect}>
            <Icon name="plus" size={16} /> Connect agent
          </button>
        </div>
        {editingAgent && selected ? (
          <form className="panel agent-editor" onSubmit={submitAgentEdit}>
            <div className="agent-editor__heading">
              <div>
                <span className="eyebrow">EDIT CONNECTION</span>
                <h3>{selected.name}</h3>
                <p>Credentials are encrypted and never returned.</p>
              </div>
              <button type="button" className="more-button" onClick={() => setEditingAgent(false)} aria-label="Close agent editor">×</button>
            </div>
            <div className="agent-editor__grid">
              <label>Agent name<input value={editAgentName} onChange={(event) => setEditAgentName(event.target.value)} required /></label>
              <label>Endpoint URL<input type="url" value={editEndpoint} onChange={(event) => setEditEndpoint(event.target.value)} placeholder="https://agent.example/chat (optional)" /></label>
              <label>Provider<input value={editProvider} onChange={(event) => setEditProvider(event.target.value)} required /></label>
              <label>Model<input value={editModel} onChange={(event) => setEditModel(event.target.value)} required /></label>
              <label>Environment<select value={editEnvironment} onChange={(event) => setEditEnvironment(event.target.value)}><option>Production</option><option>Staging</option><option>Development</option></select></label>
              <label>Replace API key <span>(optional)</span><input type="password" value={editApiKey} onChange={(event) => { setEditApiKey(event.target.value); setClearAgentApiKey(false); }} placeholder={selected.apiKeyConfigured ? "Leave blank to keep current" : "No key configured"} /></label>
            </div>
            <div className="agent-tools-editor"><span>Allowed tools</span>{tools.length ? <div>{tools.map((tool) => <label key={tool.id}><input type="checkbox" checked={selectedToolIds.includes(tool.id)} onChange={() => toggleTool(tool.id)} />{tool.label}<small>{tool.risk}</small></label>)}</div> : <small>Loading tool definitions…</small>}</div>
            {selected.apiKeyConfigured ? <label className="agent-clear-key"><input type="checkbox" checked={clearAgentApiKey} onChange={(event) => { setClearAgentApiKey(event.target.checked); if (event.target.checked) setEditApiKey(""); }} /> Clear stored API key</label> : null}
            {agentEditError ? <div className="auth-error">{agentEditError}</div> : null}
            <div className="agent-editor__actions"><button type="button" className="button button--subtle" onClick={() => setEditingAgent(false)}>Cancel</button><button className="button button--primary" disabled={agentEditBusy}>{agentEditBusy ? "Saving…" : "Save changes"}<Icon name="arrow" size={15} /></button></div>
          </form>
        ) : null}
        <div className="fleet-layout">
          <div className="fleet-grid">
            {agents.map((agent) => (
              <button
                key={agent.id}
                className={`fleet-card ${selectedAgent === agent.id ? "fleet-card--selected" : ""}`}
                onClick={() => setSelectedAgent(agent.id)}
              >
                <div className="fleet-card__top">
                  <div className="agent-icon">
                    <Icon name="bot" size={18} />
                  </div>
                  <span className={`agent-status agent-status--${agent.status === "quarantined" ? "quarantined" : agent.mode}`}>
                    <i />
                    {agent.status === "quarantined" ? "Quarantined" : agent.mode === "protected" ? "Protected" : "Review"}
                  </span>
                </div>
                <strong>{agent.name}</strong>
                <span>
                  {agent.environment} · {agent.provider}
                </span>
                <div className="fleet-card__score">
                  <b>{agent.score ?? "—"}</b>
                  <small>/100 security score</small>
                </div>
                <div className="tool-chips">
                  {agent.tools.map((tool) => (
                    <em key={tool}>{tool}</em>
                  ))}
                </div>
              </button>
            ))}
          </div>
          <div className="panel inspector-panel">
            <span className="eyebrow">SELECTED AGENT</span>
            {selected ? (
              <>
                <h3>{selected.name}</h3>
                <p>{selected.description}</p>
                <div className="inspector-score">
                  <ScoreRing score={selected.score ?? 0} />
                  <div>
                    <span>Current posture</span>
                    <strong>
                      {selected.status === "quarantined"
                        ? "Quarantined"
                        : selected.mode === "protected"
                        ? "Protected"
                        : "Needs attention"}
                    </strong>
                    <small>
                      Last scan{" "}
                      {selected.lastScan
                        ? formatRelativeDate(selected.lastScan)
                        : "Never"}
                    </small>
                  </div>
                </div>
                <div className="inspector-row">
                  <span>Model</span>
                  <strong>{selected.model}</strong>
                </div>
                <div className="inspector-row">
                  <span>Environment</span>
                  <strong>{selected.environment}</strong>
                </div>
                <div className="inspector-row">
                  <span>Connection</span>
                  <strong className={`connection-badge connection-badge--${selected.status}`}>
                    <i /> {selected.status === "quarantined" ? "Quarantined" : selected.status === "connected" ? "Connected" : selected.status === "unreachable" ? "Unreachable" : "Pending"}
                  </strong>
                </div>
                <div className="inspector-actions">
                  <button type="button" className="button button--subtle" onClick={() => beginAgentEdit(selected)}>
                    Edit agent
                  </button>
                  <button type="button" className="button button--subtle" onClick={checkAgentConnection} disabled={connectionBusy}>
                    {connectionBusy ? "Testing…" : "Test connection"}
                  </button>
                </div>
                {connectionResult ? (
                  <div className={`connection-result connection-result--${connectionResult.ok ? "ok" : "error"}`}>
                    <strong>{connectionResult.ok ? "Connection accepted" : "Connection check failed"}</strong>
                    <span>{connectionResult.message} {connectionResult.latencyMs ? `(${connectionResult.latencyMs} ms)` : ""}</span>
                  </div>
                ) : null}
                {selected.status === "quarantined" ? (
                  <div className="quarantine-banner">
                    <div className="quarantine-banner__icon"><Icon name="shield" size={16} /></div>
                    <div>
                      <strong>Agent quarantined</strong>
                      <span>{selected.quarantineReason ?? "New scans and workflows are blocked until restored."}</span>
                    </div>
                  </div>
                ) : null}
                <button
                  type="button"
                  className={selected.status === "quarantined" ? "restore-agent-button" : "quarantine-agent-button"}
                  onClick={toggleAgentQuarantine}
                  disabled={quarantineBusy}
                >
                  <Icon name={selected.status === "quarantined" ? "unlock" : "shield"} size={14} />
                  {quarantineBusy ? "Updating security state…" : selected.status === "quarantined" ? "Restore agent" : "Quarantine agent"}
                </button>
                <RuntimeShield
                  agent={selected}
                  events={runtimeEvents}
                  token={runtimeToken}
                  busy={runtimeBusy}
                  error={runtimeError}
                  onEnable={() => void enableRuntimeProtection()}
                  onDisable={requestRuntimeDisable}
                  onUpgrade={() => onNavigate("Plans")}
                />
                {agentEditError ? <div className="auth-error">{agentEditError}</div> : null}
                <button type="button" className="danger-text-button" onClick={removeSelectedAgent} disabled={agentDeleteBusy}>
                  {agentDeleteBusy ? "Deleting…" : "Delete agent"}
                </button>
                <button
                  className="button button--wide button--subtle"
                  onClick={onScan}
                  disabled={scanning || selected.status === "quarantined"}
                >
                  <Icon name="scan" size={15} />{" "}
                  {selected.status === "quarantined" ? "Restore agent to scan" : scanning ? "Scanning…" : "Run scan for this agent"}
                </button>
              </>
            ) : (
              <p>No agent selected.</p>
            )}
          </div>
        </div>
      </section>
      {dialog ? <Dialog request={dialog} onClose={() => setDialog(null)} /> : null}
      </>
    );
  }

  if (active === "Scans") {
    return (
      <section className="workspace-view">
        <div className="workspace-view__heading">
          <div>
            <span className="eyebrow eyebrow--cyan">SECURITY SCANS</span>
            <h2>Evidence, not assumptions.</h2>
            <p>
              Track policy regressions and see exactly which proposed actions
              were allowed, blocked, or simulated.
            </p>
          </div>
          <button
            className="button button--primary"
            onClick={onScan}
            disabled={scanning || selected?.status === "quarantined"}
          >
            <Icon name="scan" size={16} />{" "}
            {selected?.status === "quarantined" ? "Restore agent to scan" : scanning ? "Scanning…" : "Run new scan"}
          </button>
        </div>
        <div className="panel wide-panel">
          <div className="scan-table scan-table--large">
            <div className="scan-table__head">
              <span>Agent</span>
              <span>Score</span>
              <span>Passed</span>
              <span>Findings</span>
              <span>Trigger</span>
            </div>
            {overview.recentScans.map((scan) => (
              <button
                type="button"
                className="scan-table__row scan-table__row--button"
                key={scan.id}
                onClick={() => void openScanEvidence(scan.id)}
                aria-label={`Open evidence for ${scan.agentName ?? scan.agentId}`}
              >
                <div className="scan-agent">
                  <div className="mini-agent-icon">
                    <Icon name="scan" size={14} />
                  </div>
                  <div>
                    <strong>{scan.agentName ?? scan.agentId}</strong>
                    <span>
                      {formatRelativeDate(scan.createdAt)} ·{" "}
                      {formatDuration(scan.durationMs)}
                    </span>
                  </div>
                </div>
                <strong
                  className={
                    scan.score != null && scan.score > 85
                      ? "score-good"
                      : "score-warn"
                  }
                >
                  {scan.score ?? "—"}
                </strong>
                <span className="table-value">{scan.passed}/{scanScenarioTotal(scan)}</span>
                <span className={scan.failed ? "finding-count" : "table-value"}>
                  {scan.failed || "None"}
                </span>
                <span className="scan-duration scan-row__action">
                  <span>{scan.trigger}</span>
                  <Icon name="arrow" size={13} />
                </span>
              </button>
            ))}
          </div>
          {selectedScanId ? (
            <div className="scan-evidence-wrap">
              {scanDetailBusy ? (
                <div className="scan-evidence__loading">
                  <Icon name="clock" size={16} /> Loading persisted evidence…
                </div>
              ) : null}
              {scanDetailError ? (
                <div className="scan-evidence__error">
                  <strong>Could not load evidence</strong>
                  <span>{scanDetailError}</span>
                </div>
              ) : null}
              {selectedScan ? (
                <ScanEvidencePanel
                  scan={selectedScan}
                  onClose={() => {
                    setSelectedScanId(null);
                    setSelectedScan(null);
                    setScanDetailError("");
                  }}
                />
              ) : null}
            </div>
          ) : (
            <div className="scan-list-hint">
              <Icon name="arrow" size={14} /> Select a scan to inspect its complete evidence.
            </div>
          )}
        </div>
      </section>
    );
  }

  if (active === "Policies") {
    return (
      <section className="workspace-view">
        <div className="workspace-view__heading">
          <div>
            <span className="eyebrow eyebrow--cyan">POLICY ENGINE</span>
            <h2>Turn intent into enforceable rules.</h2>
            <p>
              Policies run after the model proposes an action and before a side
              effect can reach your systems.
            </p>
          </div>
          <button
            className="button button--primary"
            onClick={() => {
              setPolicyError("");
              setShowPolicyForm((current) => !current);
            }}
          >
            <Icon name="plus" size={16} />{" "}
            {showPolicyForm ? "Close editor" : "Edit active policy"}
          </button>
        </div>
        {showPolicyForm ? (
          <form className="panel policy-form" onSubmit={submitPolicy}>
            <div className="connect-form__grid">
              <label>
                Policy name
                <input
                  value={policyName}
                  onChange={(event) => setPolicyName(event.target.value)}
                  required
                />
              </label>
              <label>
                Currency
                <input
                  value={policyCurrency}
                  onChange={(event) => setPolicyCurrency(event.target.value)}
                  maxLength={3}
                  required
                />
              </label>
              <label>
                Maximum refund
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={policyAmount}
                  onChange={(event) => setPolicyAmount(event.target.value)}
                  required
                />
              </label>
              <label>
                Purchase window (days)
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={policyAge}
                  onChange={(event) => setPolicyAge(event.target.value)}
                  required
                />
              </label>
            </div>
            {policyError ? (
              <div className="auth-error">{policyError}</div>
            ) : null}
            <div className="connect-form__actions">
              <button
                type="button"
                className="button button--subtle"
                onClick={() => setShowPolicyForm(false)}
              >
                Cancel
              </button>
              <button className="button button--primary" disabled={policyBusy}>
                {policyBusy ? "Saving…" : "Save policy"}
                <Icon name="arrow" size={15} />
              </button>
            </div>
          </form>
        ) : null}
        <div className="policy-layout">
          <div className="panel policy-detail">
            <div className="policy-detail__title">
              <div className="policy-card__icon">
                <Icon name="shield" size={20} />
              </div>
              <div>
                <span className="eyebrow">ACTIVE POLICY</span>
                <h3>{overview.policy.name}</h3>
              </div>
              <span className="policy-live">
                <i />
                Enforcing
              </span>
            </div>
            <div className="rule-list">
              <div>
                <span>Refund amount</span>
                <strong>0 &lt; amount ≤ ${overview.policy.maxAmount}</strong>
                <em>Block violations</em>
              </div>
              <div>
                <span>Trusted purchase age</span>
                <strong>age ≤ {overview.policy.maxAgeDays} days</strong>
                <em>Never trust customer overrides</em>
              </div>
              <div>
                <span>Tool execution</span>
                <strong>One authorized action per turn</strong>
                <em>Log every decision</em>
              </div>
            </div>
          </div>
          <div className="panel policy-detail">
            <span className="eyebrow">DECISION FLOW</span>
            <h3>Propose → evaluate → execute</h3>
            <div className="flow-steps">
              <div>
                <b>01</b>
                <span>
                  Agent proposes
                  <br />a tool call
                </span>
              </div>
              <div>
                <b>02</b>
                <span>
                  Policy checks
                  <br />
                  trusted data
                </span>
              </div>
              <div>
                <b>03</b>
                <span>
                  Action is allowed
                  <br />
                  or blocked
                </span>
              </div>
            </div>
            <div className="posture-note">
              <Icon name="lock" size={15} />
              <span>
                The model never receives direct authority over refund execution.
              </span>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="workspace-view">
      <div className="workspace-view__heading">
        <div>
          <span className="eyebrow eyebrow--cyan">INTEGRATIONS</span>
          <h2>Bring your storefront agent.</h2>
          <p>
            Connect an HTTP endpoint today. SDKs, CI triggers, and native
            platform connectors follow the same contract.
          </p>
        </div>
      </div>
      {showConnectForm ? (
        <form className="panel connect-form" onSubmit={submitAgent}>
          <div className="panel-heading">
            <div>
              <span className="eyebrow">NEW CONNECTION</span>
              <h2>Connect a customer endpoint</h2>
            </div>
            <button
              type="button"
              className="more-button"
              onClick={() => setShowConnectForm(false)}
            >
              ×
            </button>
          </div>
          <div className="connect-form__grid">
            <label>
              Agent name
              <input
                value={agentName}
                onChange={(event) => setAgentName(event.target.value)}
                placeholder="Storefront Support Agent"
                required
              />
            </label>
            <label>
              Endpoint URL
              <input
                type="url"
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                placeholder="https://agent.example/chat"
                required
              />
            </label>
            <label>
              Provider
              <input
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
                placeholder="OpenAI-compatible API"
              />
            </label>
            <label>
              Model
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="gpt-4.1-mini"
              />
            </label>
            <label className="connect-form__wide">
              API key <span>(optional)</span>
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="Stored encrypted at rest"
              />
            </label>
          </div>
          {connectError ? (
            <div className="auth-error">{connectError}</div>
          ) : null}
          <div className="connect-form__actions">
            <button
              type="button"
              className="button button--subtle"
              onClick={() => setShowConnectForm(false)}
            >
              Cancel
            </button>
            <button className="button button--primary" disabled={connectBusy}>
              {connectBusy ? "Saving…" : "Save connection"}
              <Icon name="arrow" size={15} />
            </button>
          </div>
        </form>
      ) : null}
      <div className="integration-layout">
        <div className="panel integration-panel">
          <div className="integration-number">01</div>
          <h3>Connect an endpoint</h3>
          <p>
            Give AgentGuard a safe staging endpoint that can receive synthetic
            requests. The scanner reads assistant text and proposed tool calls;
            it does not execute them. Your endpoint could still execute
            internally, so Production scans are blocked by default. Use a mock
            or Staging executor, or route the agent through Runtime Firewall.
            Credentials are encrypted at rest and never returned to the dashboard.
          </p>
          <div className="code-block">
            <span>POST</span> https://your-agent.example/chat
            <br />
            <small>{`{ "input": "{{attack_payload}}" }`}</small>
          </div>
          <button className="button button--subtle" onClick={onOpenConnect}>
            Configure endpoint <Icon name="arrow" size={15} />
          </button>
        </div>
        <div className="panel integration-panel">
          <div className="integration-number">02</div>
          <h3>Tool registry</h3>
          <p>
            Live tool definitions from the API, including risk and side-effect
            metadata.
          </p>
          <div className="integration-tool-list">
            {toolsBusy ? (
              <span>Loading tool registry…</span>
            ) : tools.length ? (
              tools.map((tool) => (
                <span key={tool.id}>
                  <i
                    className={`tool-dot tool-dot--${tool.risk === "critical" ? "red" : tool.risk === "high" ? "orange" : "green"}`}
                  />
                  {tool.name}
                  <small>{tool.risk}</small>
                </span>
              ))
            ) : (
              <span>No tools returned.</span>
            )}
          </div>
          {toolError ? <div className="auth-error">{toolError}</div> : null}
          <button
            className="button button--subtle"
            onClick={() => {
              setShowToolRegistry((current) => !current);
              void loadTools();
            }}
          >
            {showToolRegistry ? "Refresh tool registry" : "Open tool registry"}{" "}
            <Icon name="arrow" size={15} />
          </button>
          {showToolRegistry ? (
            <div className="tool-registry-detail">
              {tools.map((tool) => (
                <div key={tool.id}>
                  <strong>{tool.label}</strong>
                  <span>
                    {tool.name} · {tool.risk} ·{" "}
                    {tool.sideEffect ? "side effect" : "read only"}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function scanScenarioTotal(scan: Scan) {
  return scan.scenarioCount ?? scan.progress?.length ?? scan.passed + scan.failed;
}

function mergeScanIntoOverview(current: Overview, scan: Scan): Overview {
  return {
    ...current,
    metrics: {
      ...current.metrics,
      securityScore:
        scan.status === "completed" && scan.score != null
          ? scan.score
          : current.metrics.securityScore,
    },
    recentScans: [
      scan,
      ...current.recentScans
        .filter((item) => item.id !== scan.id)
        .slice(0, 5),
    ],
  };
}

function App() {
  const [overview, setOverview] = useState<Overview>(fallbackOverview);
  const [agents, setAgents] = useState<Agent[]>(fallbackAgents);
  const [active, setActive] = useState("Overview");
  const [selectedAgent, setSelectedAgent] = useState(fallbackAgents[0].id);
  const [scanning, setScanning] = useState(false);
  const [quickStartBusy, setQuickStartBusy] = useState(false);
  const [activeScan, setActiveScan] = useState<Scan | null>(null);
  const [demoProof, setDemoProof] = useState<SecurityDemoProof | null>(null);
  const [connected, setConnected] = useState(false);
  const [toast, setToast] = useState("Ready");
  const [authState, setAuthState] = useState<
    "loading" | "authenticated" | "unauthenticated" | "offline"
  >("loading");
  const [authUser, setAuthUser] = useState<SessionUser | null>(null);
  const [showConnectForm, setShowConnectForm] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState<Incident[]>([]);
  const [incidentSummary, setIncidentSummary] = useState({ open: 0, unread: 0, critical: 0 });
  const [upgradeRequest, setUpgradeRequest] = useState<UpgradeRequest | null>(null);

  useEffect(() => {
    const handleUpgradeRequired = (event: Event) => {
      const request = (event as CustomEvent<UpgradeRequest>).detail;
      if (request?.message && request.code) setUpgradeRequest(request);
    };
    window.addEventListener(UPGRADE_REQUIRED_EVENT, handleUpgradeRequired);
    return () => window.removeEventListener(UPGRADE_REQUIRED_EVENT, handleUpgradeRequired);
  }, []);

  async function refreshDashboard() {
    const { overview: nextOverview, agents: nextAgents } = await getDashboard();
    setOverview(nextOverview);
    setAgents(nextAgents);
    setSelectedAgent((current) =>
      nextAgents.some((agent) => agent.id === current)
        ? current
        : nextAgents[0]?.id ?? "",
    );
    setConnected(true);
    return { overview: nextOverview, agents: nextAgents };
  }

  useEffect(() => {
    if (authState !== "authenticated") return;
    refreshDashboard()
      .catch(() => setToast("Demo mode · API is not connected yet"));
  }, [authState]);

  useEffect(() => {
    if (authState !== "authenticated") return;
    let cancelled = false;
    let timer: number | undefined;
    void getBillingState()
      .then((billing) => {
        if (cancelled || !billing.entitlements.incidentCenter) return;
        const refresh = () => {
          void getIncidentSummary()
            .then((next) => {
              if (cancelled) return;
              setNotifications(next.incidents);
              setIncidentSummary(next.summary);
            })
            .catch(() => {});
        };
        refresh();
        timer = window.setInterval(refresh, 30000);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [authState]);

  useEffect(() => {
    getSession()
      .then((user) => {
        setAuthUser(user);
        setAuthState("authenticated");
      })
      .catch((caught) => {
        if ((caught as Error & { status?: number }).status === 401)
          setAuthState("unauthenticated");
        else {
          setAuthState("offline");
          setToast(
            "Offline preview · start PostgreSQL and the API for live data",
          );
        }
      });
  }, []);

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedAgent) ?? agents[0],
    [agents, selectedAgent],
  );

  async function handleScan() {
    if (!selected) return;
    setDemoProof(null);
    setScanning(true);
    setToast("Running agent security scan…");
    try {
      const scan = await runScan(selected.id, (nextScan) => {
        setActiveScan(nextScan);
        const runningScenario = nextScan.progress?.find(
          (item) => item.status === "running",
        );
        if (runningScenario) setToast(`Testing ${runningScenario.title}…`);
      });
      const refreshed = await refreshDashboard().catch(() => null);
      if (!refreshed) setOverview((current) => mergeScanIntoOverview(current, scan));
      if (scan.status === "completed") {
        setToast(`Scan complete · ${scan.score}/100 security score`);
      } else if (scan.status === "failed") {
        setToast(`Scan failed · ${scan.error ?? "worker error"}`);
      } else {
        setToast(`Scan ${scan.status} · still processing`);
      }
      setConnected(true);
    } catch (caught) {
      setToast(
        caught instanceof Error ? caught.message : "Scan request failed",
      );
    } finally {
      setScanning(false);
    }
  }

  async function handleQuickStart() {
    if (quickStartBusy) return;
    setQuickStartBusy(true);
    setActive("Launchpad");
    setToast("Preparing an isolated Gateway proof…");
    try {
      const result = await startQuickstartDemo();
      setAgents((current) => {
        const withoutDemo = current.filter((agent) => agent.id !== result.agent.id);
        return [result.agent, ...withoutDemo];
      });
      setSelectedAgent(result.agent.id);
      setDemoProof(result.proof);
      setActiveScan(result.scan);
      setToast("Gateway proof ready · running the first five scenarios…");
      const scan = await waitForScan(result.scan, (nextScan) => {
        setActiveScan(nextScan);
        const runningScenario = nextScan.progress?.find((item) => item.status === "running");
        if (runningScenario) setToast(`Testing ${runningScenario.title}…`);
      });
      const refreshed = await refreshDashboard().catch(() => null);
      if (!refreshed) {
        setOverview((current) => mergeScanIntoOverview(current, scan));
        setAgents((current) => current.map((agent) => agent.id === result.agent.id
          ? { ...agent, score: scan.score, lastScan: scan.createdAt }
          : agent));
      }
      setToast(scan.status === "completed"
        ? `Demo complete · ${scan.score}/100 · $100 refund blocked before execution`
        : `Demo scan ${scan.status} · review the evidence panel`);
      setConnected(true);
    } catch (caught) {
      setToast(caught instanceof Error ? caught.message : "Quickstart demo failed");
    } finally {
      setQuickStartBusy(false);
    }
  }

  async function handleLogout() {
    await logout().catch(() => {});
    setAuthUser(null);
    setAuthState("unauthenticated");
  }

  function handleAgentCreated(agent: Agent) {
    setAgents((current) => [agent, ...current]);
    setSelectedAgent(agent.id);
    setConnected(true);
    setToast(`${agent.name} connected securely`);
  }

  function handleAgentUpdated(agent: Agent) {
    setAgents((current) =>
      current.map((item) => (item.id === agent.id ? agent : item)),
    );
    setToast(`${agent.name} updated`);
  }

  function handleAgentDeleted(agentId: string) {
    const remaining = agents.filter((agent) => agent.id !== agentId);
    setAgents(remaining);
    setSelectedAgent((selected) =>
      selected === agentId ? remaining[0]?.id ?? "" : selected,
    );
    setToast("Agent deleted");
  }

  function openConnect() {
    setActive("Integrations");
    setShowConnectForm(true);
    setSearchOpen(false);
  }

  function openUpgradePlans() {
    setUpgradeRequest(null);
    setActive("Plans");
    setSearchOpen(false);
    setNotificationsOpen(false);
    window.setTimeout(() => {
      document.getElementById("billing-plans")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }

  function handlePolicyUpdated(nextPolicy: Overview["policy"]) {
    setOverview((current) => ({ ...current, policy: nextPolicy }));
    setToast("Policy saved and now enforced");
  }

  const nav = [
    { label: "Overview", icon: "grid" as IconName },
    { label: "Launchpad", icon: "activity" as IconName },
    { label: "Agents", icon: "bot" as IconName, count: agents.length },
    { label: "Autopilot", icon: "activity" as IconName },
    { label: "Sentinel", icon: "shield" as IconName },
    { label: "Incidents", icon: "bell" as IconName, count: incidentSummary.unread },
    { label: "Scans", icon: "scan" as IconName },
    { label: "Scenarios", icon: "library" as IconName },
    { label: "Contracts", icon: "shield" as IconName },
    { label: "Plans", icon: "wallet" as IconName },
    { label: "Policies", icon: "shield" as IconName },
    { label: "Integrations", icon: "plug" as IconName },
    { label: "Settings", icon: "settings" as IconName },
  ];
  const searchText = searchQuery.trim().toLowerCase();
  const searchMatches = [
    ...nav.map((item) => ({
      key: `page-${item.label}`,
      label: item.label,
      detail: "Workspace section",
      page: item.label,
      agentId: null,
    })),
    ...agents.map((agent) => ({
      key: `agent-${agent.id}`,
      label: agent.name,
      detail: `Agent · ${agent.environment}`,
      page: "Agents",
      agentId: agent.id,
    })),
    ...overview.recentScans.map((scan) => ({
      key: `scan-${scan.id}`,
      label: scan.agentName ?? scan.agentId,
      detail: `Scan · ${scan.status}`,
      page: "Scans",
      agentId: scan.agentId,
    })),
  ]
    .filter(
      (item) =>
        !searchText ||
        `${item.label} ${item.detail}`.toLowerCase().includes(searchText),
    )
    .slice(0, 8);
  const toolCount = new Set(agents.flatMap((agent) => agent.tools)).size;

  if (authState === "loading")
    return (
      <div className="auth-loading">
        <div className="brand-mark">
          <span />
          <span />
          <span />
        </div>
        <span>Loading secure workspace…</span>
      </div>
    );
  if (authState === "unauthenticated")
    return (
      <AuthScreen
        onAuthenticated={(user) => {
          setAuthUser(user);
          setAuthState("authenticated");
        }}
      />
    );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <span />
            <span />
            <span />
          </div>
          <span>
            AGENT<span className="brand-accent">GUARD</span>
          </span>
          <small>OS</small>
        </div>
        <div className="workspace-switcher">
          <div className="workspace-avatar">
            {initials(authUser?.workspaceName ?? "Workspace").slice(0, 1)}
          </div>
          <div>
            <span>Workspace</span>
            <strong>{authUser?.workspaceName ?? "Workspace"}</strong>
          </div>
          <Icon name="chevron" size={15} />
        </div>
        <nav className="main-nav">
          <span className="nav-label">Control plane</span>
          {nav.map((item) => (
            <button
              key={item.label}
              className={
                active === item.label ? "nav-item nav-item--active" : "nav-item"
              }
              onClick={() => setActive(item.label)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {item.count ? <em>{item.count}</em> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="system-health">
            <div className="pulse-dot" />
            <div>
              <span>System health</span>
              <strong>All systems normal</strong>
            </div>
          </div>
          <button
            className="user-card"
            onClick={() => setActive("Settings")}
            title="Open settings"
          >
            <div className="user-avatar">
              {initials(authUser?.name ?? "AgentGuard")}
            </div>
            <div>
              <strong>{authUser?.name ?? "Workspace owner"}</strong>
              <span>{authUser?.role ?? "Owner"} · Settings</span>
            </div>
            <Icon name="chevron" size={15} />
          </button>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>Workspace</span>
            <Icon name="chevron" size={14} />
            <strong>{active}</strong>
          </div>
          <div className="topbar-actions">
            <div className="api-state">
              <i
                className={
                  connected
                    ? "api-state__dot api-state__dot--live"
                    : "api-state__dot"
                }
              />
              {connected ? "API connected" : "Local preview"}
            </div>
            <button
              className="icon-button"
              onClick={() => {
                setSearchOpen((current) => !current);
                setNotificationsOpen(false);
              }}
              aria-label="Search workspace"
            >
              <Icon name="search" />
            </button>
            <button
              className={`icon-button ${incidentSummary.unread ? "has-dot" : ""}`}
              onClick={() => {
                setNotificationsOpen((current) => !current);
                setSearchOpen(false);
              }}
              aria-label="Open notifications"
            >
              <Icon name="bell" />
            </button>
            <div className="top-avatar">
              {initials(authUser?.name ?? "AgentGuard")}
            </div>
          </div>
        </header>
        {activeScan ? (
          <LiveScanPanel
            scan={activeScan}
            demoProof={demoProof}
            onClose={() => setActiveScan(null)}
          />
        ) : null}
        {searchOpen ? (
          <div className="utility-popover search-popover">
            <input
              autoFocus
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search agents, scans, or sections"
            />
            {searchMatches.length ? (
              <div className="utility-results">
                {searchMatches.map((item) => (
                  <button
                    key={item.key}
                    onClick={() => {
                      setActive(item.page);
                      if (item.agentId) setSelectedAgent(item.agentId);
                      setSearchOpen(false);
                      setSearchQuery("");
                    }}
                  >
                    {item.label}
                    <small>{item.detail}</small>
                  </button>
                ))}
              </div>
            ) : (
              <p>No matching workspace data.</p>
            )}
          </div>
        ) : null}
        {notificationsOpen ? (
          <div className="utility-popover notification-popover">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">WORKSPACE ALERTS</span>
                <h2>
                  {notifications.length
                    ? `${notifications.length} open incident${notifications.length > 1 ? "s" : ""}`
                    : "No open alerts"}
                </h2>
              </div>
              <button
                className="text-button"
                onClick={() => {
                  setActive("Incidents");
                  setNotificationsOpen(false);
                }}
              >
                Open incident center
              </button>
            </div>
            {notifications.length ? (
              notifications.map((incident) => { const scan = incident; return (
                <button
                  className="utility-notification"
                  key={incident.id}
                  onClick={() => {
                    void markIncidentRead(incident.id).catch(() => {});
                    setNotifications((current) => current.map((item) => item.id === incident.id ? { ...item, readAt: item.readAt ?? new Date().toISOString() } : item));
                    setIncidentSummary((current) => ({ ...current, unread: Math.max(0, current.unread - (incident.readAt ? 0 : 1)) }));
                    setActive("Incidents");
                    setNotificationsOpen(false);
                  }}
                >
                  <strong>{incident.title}</strong>
                  <span>
                    {incident.agentName ?? "Workspace"} · {incident.severity}
                    · {scan.status}
                  </span>
                </button>
              )})
            ) : (
              <p>Everything is quiet. New security events will appear here.</p>
            )}
          </div>
        ) : null}

        <section className="page-heading">
          <div>
            <span className="eyebrow eyebrow--cyan">
              SECURITY CONTROL PLANE{" "}
              <span className="live-indicator">● LIVE</span>
            </span>
            <h1>
              Protect every action
              <br />
              <span>your agent takes.</span>
            </h1>
            <p>
              Continuously test, monitor, and enforce security policies across
              your storefront agents.
            </p>
          </div>
          <div className="heading-actions">
            <button className="button button--ghost" onClick={openConnect}>
              <Icon name="plus" size={16} /> Connect agent
            </button>
            <button
              className="button button--primary"
              onClick={handleScan}
              disabled={scanning}
            >
              <Icon name="scan" size={16} />{" "}
              {scanning ? "Scanning…" : "Run security scan"}
              <Icon name="arrow" size={16} />
            </button>
          </div>
        </section>

        <section className="metrics-grid">
          <MetricCard
            label="Security score"
            value={`${overview.metrics.securityScore}/100`}
            delta="Expected outcomes across completed scans"
            icon="shield"
            tone="cyan"
          />
          <MetricCard
            label="Protected actions"
            value={overview.metrics.protectedActions}
            delta="Stopped before tool execution"
            icon="lock"
            tone="violet"
          />
          <MetricCard
            label="Open findings"
            value={overview.metrics.openFindings}
            delta="Unsafe proposals that were not blocked"
            icon="activity"
            tone="orange"
          />
          <MetricCard
            label="Scans this month"
            value={overview.metrics.scansThisMonth}
            delta="Live workspace count"
            icon="clock"
            tone="blue"
          />
        </section>

        {active === "Overview" ? (
          <SetupCenter
            compact
            agents={agents}
            overview={overview}
            selectedAgentId={selectedAgent}
            onSelectAgent={setSelectedAgent}
            onNavigate={setActive}
            onConnect={openConnect}
            onQuickStart={handleQuickStart}
            quickStartBusy={quickStartBusy}
            onRunScan={handleScan}
            scanBusy={scanning}
          />
        ) : null}

        {active === "Overview" ? (
          <section className="dashboard-grid">
            <div className="panel hero-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">WORKSPACE POSTURE</span>
                  <h2>Agent security at a glance</h2>
                </div>
                <button
                  className="more-button"
                  onClick={() => setActive("Scans")}
                >
                  View scans
                </button>
              </div>
              <div className="hero-panel__body">
                <SecurityOrb score={overview.metrics.securityScore} />
                <div className="posture-breakdown">
                  <div className="posture-row">
                    <span>
                      <i className="legend-dot legend-dot--cyan" />
                      Scenario pass rate
                    </span>
                    <strong>{overview.posture.scenarioPassRate}%</strong>
                  </div>
                  <div className="progress">
                    <i
                      style={{ width: `${overview.posture.scenarioPassRate}%` }}
                    />
                  </div>
                  <div className="posture-row">
                    <span>
                      <i className="legend-dot legend-dot--violet" />
                      Agent scan coverage
                    </span>
                    <strong>{overview.posture.agentCoverage}%</strong>
                  </div>
                  <div className="progress progress--violet">
                    <i
                      style={{ width: `${overview.posture.agentCoverage}%` }}
                    />
                  </div>
                  <div className="posture-row">
                    <span>
                      <i className="legend-dot legend-dot--orange" />
                      Policy blocks
                    </span>
                    <strong>{overview.metrics.protectedActions}</strong>
                  </div>
                  <div className="posture-note">
                    <Icon name="shield" size={15} />
                    <span>
                      Guardrails blocked{" "}
                      <strong>
                        {overview.posture.blockedLast7Days} unauthorized actions
                      </strong>{" "}
                      in the last 7 days.
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="panel agents-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">CONNECTED AGENTS</span>
                  <h2>Your fleet</h2>
                </div>
                <button
                  className="text-button"
                  onClick={() => setActive("Agents")}
                >
                  View all <Icon name="arrow" size={14} />
                </button>
              </div>
              <div className="agent-list">
                {agents.map((agent) => (
                  <button
                    key={agent.id}
                    className={`agent-row ${selectedAgent === agent.id ? "agent-row--selected" : ""}`}
                    onClick={() => setSelectedAgent(agent.id)}
                  >
                    <div className="agent-icon">
                      <Icon name="bot" size={17} />
                    </div>
                    <div className="agent-info">
                      <strong>{agent.name}</strong>
                      <span>
                        {agent.environment} · {agent.model}
                      </span>
                    </div>
                    <div className="agent-score">
                      <strong>{agent.score ?? "—"}</strong>
                      <span>score</span>
                    </div>
                    <span
                      className={`agent-status agent-status--${agent.status === "quarantined" ? "quarantined" : agent.mode}`}
                    >
                      <i />
                      {agent.status === "quarantined" ? "Quarantined" : agent.mode === "protected" ? "Protected" : "Review"}
                    </span>
                  </button>
                ))}
              </div>
              <button className="add-agent-button" onClick={openConnect}>
                <Icon name="plus" size={15} /> Connect another agent
              </button>
            </div>

            <div className="panel scans-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">RECENT ACTIVITY</span>
                  <h2>Security scans</h2>
                </div>
                <button
                  className="text-button"
                  onClick={() => setActive("Scans")}
                >
                  All scans <Icon name="arrow" size={14} />
                </button>
              </div>
              <div className="scan-table">
                <div className="scan-table__head">
                  <span>Agent</span>
                  <span>Score</span>
                  <span>Result</span>
                  <span>Run</span>
                </div>
                {overview.recentScans.map((scan) => (
                  <div className="scan-table__row" key={scan.id}>
                    <div className="scan-agent">
                      <div className="mini-agent-icon">
                        <Icon name="scan" size={14} />
                      </div>
                      <div>
                        <strong>{scan.agentName ?? scan.agentId}</strong>
                        <span>
                          {scan.trigger} · {formatRelativeDate(scan.createdAt)}
                        </span>
                      </div>
                    </div>
                    <strong
                      className={
                        scan.score != null && scan.score > 85
                          ? "score-good"
                          : "score-warn"
                      }
                    >
                      {scan.score ?? "—"}
                    </strong>
                    <StatusPill status={scan.status} />
                    <span className="scan-duration">
                      {formatDuration(scan.durationMs)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="panel policy-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">ACTIVE POLICY</span>
                  <h2>{overview.policy.name}</h2>
                </div>
                <span className="policy-version">
                  {overview.policy.enforcement ?? "block_and_log"}
                </span>
              </div>
              <div className="policy-card">
                <div className="policy-card__icon">
                  <Icon name="shield" size={19} />
                </div>
                <div>
                  <strong>Refund action policy</strong>
                  <span>Applied to {toolCount} registered tools</span>
                </div>
                <span className="policy-live">
                  <i />
                  Enforcing
                </span>
              </div>
              <div className="policy-rules">
                <div>
                  <span>Maximum amount</span>
                  <strong>
                    ${overview.policy.maxAmount} {overview.policy.currency}
                  </strong>
                </div>
                <div>
                  <span>Purchase window</span>
                  <strong>{overview.policy.maxAgeDays} days</strong>
                </div>
                <div>
                  <span>Unauthorized actions</span>
                  <strong>Block + log</strong>
                </div>
              </div>
              <button
                className="button button--wide button--subtle"
                onClick={() => setActive("Policies")}
              >
                Manage policy <Icon name="arrow" size={15} />
              </button>
            </div>
          </section>
        ) : (
          <WorkspaceView
            active={active}
            agents={agents}
            overview={overview}
            selectedAgent={selectedAgent}
            setSelectedAgent={setSelectedAgent}
            onScan={handleScan}
            scanning={scanning}
            onAgentCreated={handleAgentCreated}
            onAgentUpdated={handleAgentUpdated}
            onAgentDeleted={handleAgentDeleted}
            showConnectForm={showConnectForm}
            setShowConnectForm={setShowConnectForm}
            onOpenConnect={openConnect}
            onQuickStart={handleQuickStart}
            quickStartBusy={quickStartBusy}
            onNavigate={setActive}
            onPolicyUpdated={handlePolicyUpdated}
            authUser={authUser ?? {
              id: "offline-preview",
              email: "preview@agentguard.local",
              name: "Preview operator",
              workspaceId: "offline-preview",
              workspaceName: "Preview workspace",
              role: "member",
            }}
            onUserUpdated={(user) => {
              setAuthUser(user);
              setToast("Account settings saved");
            }}
            onLogout={() => void handleLogout()}
          />
        )}
        <footer className="page-footer">
          <span>AgentGuard OS · Storefront security preview</span>
          <span className="footer-status">
            <i />
            {toast}
          </span>
        </footer>
      </main>
      {upgradeRequest ? (
        <UpgradePrompt
          request={upgradeRequest}
          onClose={() => setUpgradeRequest(null)}
          onUpgrade={openUpgradePlans}
        />
      ) : null}
    </div>
  );
}

export default App;
