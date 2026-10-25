import { useEffect, useMemo, useState } from "react";
import { getScan } from "../scans/scans.api";
import { getAttackPaths, getSecurityContract, getSecurityContractComparison, replayAttackPath, updateSecurityContract } from "./contracts.api";
import type { Agent, AttackPath, AttackPathResult, ContractComparison, SecurityContract, Tool } from "../../shared/types/api";
import { Icon } from "../../shared/ui/Icon";

function pathTone(status: AttackPathResult["status"] | "unrun") {
  return status === "protected" ? "protected" : status === "vulnerable" ? "vulnerable" : status === "incomplete" ? "incomplete" : "unrun";
}

function comparisonTone(comparison: ContractComparison | null) {
  if (!comparison) return "pending";
  if (comparison.evidence.verdict === "regressed" || comparison.contractDiff.status === "weakened") return "danger";
  if (comparison.evidence.verdict === "improved" || comparison.contractDiff.status === "hardened") return "good";
  return "neutral";
}

function ContractComparisonPanel({ comparison }: { comparison: ContractComparison | null }) {
  const tone = comparisonTone(comparison);
  if (!comparison) return null;
  const evidence = comparison.evidence;
  const diff = comparison.contractDiff;
  const verdict = evidence.verdict === "regressed"
    ? "Regression detected"
    : evidence.verdict === "improved"
      ? "Security improved"
      : evidence.status === "compared"
        ? "No security drift detected"
        : "Verification baseline is incomplete";

  return (
    <section className={`panel contract-comparison contract-comparison--${tone}`}>
      <div className="contract-comparison__heading">
        <div><span className="eyebrow eyebrow--cyan">CONTRACT REGRESSION CENTER</span><h3>{verdict}</h3><p>Version {comparison.fromVersion ?? "—"} → {comparison.toVersion ?? "—"} · compares immutable contract snapshots and persisted scan evidence.</p></div>
        <span className="contract-comparison__verdict">{evidence.status === "compared" ? evidence.verdict.toUpperCase() : "VERIFYING"}</span>
      </div>
      <div className="contract-comparison__stats">
        <div><small>Score delta</small><strong>{evidence.scoreDelta == null ? "—" : `${evidence.scoreDelta > 0 ? "+" : ""}${evidence.scoreDelta}`}</strong></div>
        <div><small>Fixed</small><strong className="is-good">{evidence.fixedCount}</strong></div>
        <div><small>Regressed</small><strong className={evidence.regressedCount ? "is-danger" : ""}>{evidence.regressedCount}</strong></div>
        <div><small>Unverified</small><strong>{evidence.unknownCount}</strong></div>
      </div>
      <div className="contract-comparison__changes">
        <div><span className="eyebrow">BOUNDARY DIFF</span><p>{diff.status === "baseline_missing" ? "Save and verify one more version to establish a trustworthy baseline." : diff.status === "weakened" ? diff.warnings.join(" ") : diff.status === "hardened" ? "The action boundary became narrower." : "No action boundary change detected."}</p></div>
        {diff.boundaryChanges.length ? <div className="contract-comparison__boundary-list">{diff.boundaryChanges.map((change) => <span key={change.field} className={change.direction === "widened" ? "is-danger" : "is-good"}>{change.field} {change.direction === "widened" ? "↑" : "↓"} {Math.abs(change.delta)} {change.unit}</span>)}</div> : null}
        {diff.addedTools.length || diff.removedTools.length ? <div className="contract-comparison__tool-diff">{diff.addedTools.map((tool) => <span className="is-danger" key={`added-${tool}`}>+ {tool}</span>)}{diff.removedTools.map((tool) => <span className="is-good" key={`removed-${tool}`}>− {tool}</span>)}</div> : null}
      </div>
      {evidence.status === "compared" ? <div className="contract-comparison__evidence"><span className="eyebrow">EVIDENCE CHANGES</span><div>{[...evidence.scenarioChanges.filter((change) => change.status !== "unchanged"), ...evidence.attackPathChanges.filter((change) => change.status !== "unchanged")].slice(0, 8).map((change) => <span key={"scenarioId" in change ? change.scenarioId : change.pathId} className={`contract-comparison__evidence-item is-${change.status}`}><i />{"scenarioId" in change ? change.scenarioId : change.pathId}<b>{change.before ?? "—"} → {change.after ?? "—"}</b></span>)}</div></div> : <div className="contract-comparison__empty">The new version is saved. Its verification scan will appear here once a completed scan exists for both versions.</div>}
    </section>
  );
}

export function SecurityContractPage({
  agents,
  selectedAgentId,
  onSelectAgent,
  onUpgrade,
}: {
  agents: Agent[];
  selectedAgentId: string;
  onSelectAgent: (id: string) => void;
  onUpgrade: () => void;
}) {
  const [agentId, setAgentId] = useState(selectedAgentId || agents[0]?.id || "");
  const [contract, setContract] = useState<SecurityContract | null>(null);
  const [tools, setTools] = useState<Tool[]>([]);
  const [paths, setPaths] = useState<AttackPath[]>([]);
  const [runs, setRuns] = useState<Record<string, AttackPathResult>>({});
  const [comparison, setComparison] = useState<ContractComparison | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const selectedAgent = useMemo(() => agents.find((agent) => agent.id === agentId), [agents, agentId]);

  useEffect(() => {
    if (!agentId && agents[0]) setAgentId(agents[0].id);
  }, [agentId, agents]);

  useEffect(() => {
    if (!agentId) return;
    let active = true;
    setLoading(true);
    setError("");
    Promise.all([getSecurityContract(agentId), getAttackPaths(), getSecurityContractComparison(agentId)])
      .then(([contractResponse, pathResponse, comparisonResponse]) => {
        if (!active) return;
        setContract(contractResponse.contract);
        setTools(contractResponse.tools);
        setPaths(pathResponse.paths);
        setComparison(comparisonResponse);
        setRuns({});
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : "Security contract could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [agentId]);

  function chooseAgent(value: string) {
    setAgentId(value);
    onSelectAgent(value);
  }

  function toggleTool(toolId: string) {
    setContract((current) => {
      if (!current) return current;
      const allowed = current.allowedToolIds.includes(toolId)
        ? current.allowedToolIds.filter((id) => id !== toolId)
        : [...current.allowedToolIds, toolId];
      return { ...current, allowedToolIds: allowed };
    });
  }

  async function saveContract() {
    if (!contract || !agentId || !contract.allowedToolIds.length || busy) return;
    setBusy("save");
    setError("");
    setNotice("");
    try {
      const saved = await updateSecurityContract(agentId, contract);
      setContract(saved.contract);
      if (saved.verificationScan) {
        let verification = saved.verificationScan;
        for (let attempt = 0; attempt < 180 && ["queued", "running"].includes(verification.status); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          verification = await getScan(verification.id);
        }
        setComparison(await getSecurityContractComparison(agentId));
        setNotice(verification.status === "completed"
          ? `Contract v${saved.contract.version} verified. Regression evidence is ready.`
          : `Contract v${saved.contract.version} saved, but verification ended with status: ${verification.status}. Review the scan evidence.`);
      } else {
        setComparison(await getSecurityContractComparison(agentId));
        setNotice(saved.verificationError
          ? `Contract v${saved.contract.version} saved. Verification needs attention: ${saved.verificationError.message}`
          : `Contract v${saved.contract.version} is now active. New replays will use this boundary.`);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Security contract could not be saved.");
    } finally {
      setBusy("");
    }
  }

  async function replay(path: AttackPath) {
    if (path.locked || busy || !agentId) return;
    setBusy(`replay:${path.id}`);
    setError("");
    setNotice("");
    try {
      const { scan } = await replayAttackPath(agentId, path.id);
      let current = scan;
      for (let attempt = 0; attempt < 180 && ["queued", "running"].includes(current.status); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        current = await getScan(scan.id);
      }
      const result = current.attackPaths?.find((item) => item.id === path.id);
      if (result) setRuns((existing) => ({ ...existing, [path.id]: result }));
      setNotice(`${path.title} replay completed with contract v${current.contractVersion ?? contract?.version ?? 0}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Attack path replay failed.");
    } finally {
      setBusy("");
    }
  }

  if (loading) {
    return <section className="workspace-view contract-page"><div className="contract-loading"><i /><span>Loading the agent security contract…</span></div></section>;
  }

  return (
    <section className="workspace-view contract-page">
      <div className="workspace-view__heading contract-page__heading">
        <div>
          <span className="eyebrow eyebrow--cyan">SECURITY CONTRACT</span>
          <h2>Prove the agent can do only what it is allowed to do.</h2>
          <p>Define a versioned action boundary, then replay realistic multi-step attack paths against the exact contract that protects production.</p>
        </div>
        <div className="contract-version-badge"><Icon name="shield" size={16} /><span>ACTIVE CONTRACT<strong>v{contract?.version ?? 0}</strong></span></div>
      </div>

      {error ? <div className="contract-alert contract-alert--error"><Icon name="activity" size={15} /><span>{error}</span></div> : null}
      {notice ? <div className="contract-alert contract-alert--ok"><Icon name="shield" size={15} /><span>{notice}</span></div> : null}

      <ContractComparisonPanel comparison={comparison} />

      <div className="contract-layout">
        <section className="panel contract-editor">
          <div className="panel-heading">
            <div><span className="eyebrow">ACTION BOUNDARY</span><h3>Contract for this agent</h3></div>
            <select value={agentId} onChange={(event) => chooseAgent(event.target.value)} aria-label="Select agent">
              {agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}
            </select>
          </div>
          <p className="contract-editor__intro">A tool outside this allowlist is blocked before execution. Contract ceilings can only narrow the workspace policy, never widen it.</p>
          <div className="contract-tool-list">
            {tools.map((tool) => (
              <button type="button" key={tool.id} className={`contract-tool ${contract?.allowedToolIds.includes(tool.id) ? "contract-tool--allowed" : ""}`} onClick={() => toggleTool(tool.id)}>
                <span className="contract-tool__check"><Icon name={contract?.allowedToolIds.includes(tool.id) ? "shield" : "lock"} size={13} /></span>
                <span><strong>{tool.label}</strong><small>{tool.name} · {tool.risk}{tool.sideEffect ? " · side effect" : " · read only"}</small></span>
                <em>{contract?.allowedToolIds.includes(tool.id) ? "ALLOWED" : "BLOCKED"}</em>
              </button>
            ))}
          </div>
          <div className="contract-fields">
            <label>Maximum refund amount<input type="number" min="1" step="0.01" value={contract?.maxRefundAmount ?? ""} onChange={(event) => setContract((current) => current ? { ...current, maxRefundAmount: Number(event.target.value) } : current)} /></label>
            <label>Maximum order age (days)<input type="number" min="0" step="1" value={contract?.maxOrderAgeDays ?? ""} onChange={(event) => setContract((current) => current ? { ...current, maxOrderAgeDays: Number(event.target.value) } : current)} /></label>
          </div>
          <label className="contract-notes">Contract note<textarea value={contract?.notes ?? ""} maxLength={500} onChange={(event) => setContract((current) => current ? { ...current, notes: event.target.value } : current)} placeholder="Why this boundary exists…" /></label>
          <div className="contract-editor__footer"><span><i /> {selectedAgent?.status === "quarantined" ? "Agent quarantined" : "Runtime and replay enforcement use this boundary"}</span><button type="button" className="button button--primary" onClick={() => void saveContract()} disabled={busy === "save" || !contract?.allowedToolIds.length}>{busy === "save" ? "Versioning…" : "Save contract"}<Icon name="arrow" size={14} /></button></div>
        </section>

        <section className="contract-paths">
          <div className="contract-paths__heading"><div><span className="eyebrow eyebrow--cyan">ATTACK PATH REPLAY</span><h3>Test the chain, not just the prompt.</h3></div><span>{paths.length} paths</span></div>
          <p className="contract-paths__intro">Each replay executes the path’s complete scenario chain and persists every step. Advanced paths unlock with the full adversarial suite.</p>
          <div className="contract-path-grid">
            {paths.map((path) => {
              const result = runs[path.id];
              const status: AttackPathResult["status"] | "unrun" = result?.status ?? "unrun";
              const statusLabel = result ? result.status.toUpperCase() : "NOT RUN";
              return <article className={`contract-path-card contract-path-card--${pathTone(status)}`} key={path.id}>
                <div className="contract-path-card__top"><span className={`contract-path-card__severity contract-path-card__severity--${path.severity}`}><i />{path.severity}</span><span className="contract-path-card__status">{statusLabel}</span></div>
                <h4>{path.title}</h4><p>{path.description}</p>
                <div className="contract-path-card__meta"><span>{path.scenarioIds.length} linked scenarios</span><span>{path.locked ? `${path.requiredPlan}+` : "Available now"}</span></div>
                <button type="button" className="button button--subtle" onClick={() => path.locked ? onUpgrade() : void replay(path)} disabled={Boolean(busy)}>{busy === `replay:${path.id}` ? "Replaying attack path…" : path.locked ? `Unlock with ${path.requiredPlan}` : "Replay attack path"}<Icon name={path.locked ? "lock" : "arrow"} size={13} /></button>
                {result?.steps.length ? <div className="contract-path-card__steps">{result.steps.map((step) => <span key={step.scenarioId} className={step.status === "PASS" ? "is-pass" : step.status === "PENDING" ? "is-pending" : "is-fail"}><i />{step.scenarioId}</span>)}</div> : null}
              </article>;
            })}
          </div>
        </section>
      </div>
    </section>
  );
}
