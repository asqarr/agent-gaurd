import { useState } from "react";
import type { PolicyFixProposal, Scan, ScanVerificationRun, WorkspacePolicy } from "../../shared/types/api";
import { Icon } from "../../shared/ui/Icon";
import { applyScanPolicyFix, runScan } from "./scans.api";

type ScanResult = NonNullable<Scan["results"]>[number];

function formatValue(proposal: PolicyFixProposal, value: number) {
  return proposal.field === "maxAmount"
    ? `${proposal.currency} ${value.toFixed(2)}`
    : `${value} days`;
}

function verificationSummary(run: Scan | ScanVerificationRun | null) {
  if (!run) return null;
  const scenario = "results" in run
    ? run.results?.find((item) => item.scenarioId === run.remediationVerification?.scenarioId)
    : null;
  const status = run.status;
  const verdict = scenario?.verdict ?? ("scenarioVerdict" in run ? run.scenarioVerdict : null);
  const safety = scenario?.executionSafety ?? ("executionSafety" in run ? run.executionSafety : null);
  const guard = scenario?.guard ?? ("guard" in run ? run.guard : null);
  const scanId = "scanId" in run ? run.scanId : run.id;
  const verified = status === "completed" && verdict === "PROTECTED" && safety === "safe" && guard?.decision === "BLOCK" && guard.execution === "NOT_EXECUTED";
  const active = status === "queued" || status === "running";
  const inconclusive = !active && (verdict === "INCONCLUSIVE" || safety !== "safe" || !verdict || !guard);
  return {
    status,
    scanId,
    verdict,
    safety,
    guard,
    verified,
    label: active
      ? "Verification is running"
      : verified
        ? "AgentGuard policy blocked this scenario"
        : inconclusive
          ? "Result is inconclusive; do not treat this as verified"
          : "The scenario is still not protected",
    tone: active ? "running" : verified ? "verified" : inconclusive ? "inconclusive" : "failed",
  };
}

export function PolicyFixWorkflow({
  scan,
  result,
  proposal,
  policy,
  canManage,
  scanning,
  onPolicyUpdated,
  onBusyChange,
  onScanProgress,
  onVerificationComplete,
}: {
  scan: Scan;
  result: ScanResult;
  proposal: PolicyFixProposal;
  policy: WorkspacePolicy;
  canManage: boolean;
  scanning: boolean;
  onPolicyUpdated: (policy: WorkspacePolicy) => void;
  onBusyChange: (busy: boolean) => void;
  onScanProgress: (scan: Scan) => void;
  onVerificationComplete: () => void | Promise<void>;
}) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [verificationScan, setVerificationScan] = useState<Scan | null>(null);
  const currentVersion = Number(policy.version ?? 0);
  const currentValue = Number(policy[proposal.field]);
  const alreadyApplied = currentVersion === proposal.expectedPolicyVersion + 1 && currentValue === proposal.proposedValue;
  const proposalIsFresh = currentVersion === proposal.expectedPolicyVersion;
  const latestSavedVerification = scan.verificationRuns?.find((run) =>
    run.scenarioId === result.scenarioId &&
    run.policyVersionBefore === proposal.expectedPolicyVersion,
  ) ?? null;
  const savedVerificationIsCurrent = Boolean(latestSavedVerification && latestSavedVerification.policyVersionAfter === currentVersion);
  const currentVerification = verificationScan ?? (savedVerificationIsCurrent ? latestSavedVerification : null);
  const summary = verificationSummary(currentVerification);
  const currentReasons = currentVerification && "reasons" in currentVerification
    ? currentVerification.reasons
    : [];
  const isBusy = busy || scanning;

  async function startVerification() {
    if (isBusy) return;
    setBusy(true);
    onBusyChange(true);
    setError("");
    setNotice("");
    let policyWasApplied = alreadyApplied;
    try {
      if (!alreadyApplied) {
        const applied = await applyScanPolicyFix(scan.id, result.scenarioId, proposal.expectedPolicyVersion);
        onPolicyUpdated(applied.policy);
        policyWasApplied = true;
      }
      setReviewOpen(false);
      setNotice("The workspace policy is saved. Running the exact scenario against the new policy now.");
      const verification = await runScan(
        scan.agentId,
        (nextScan) => {
          setVerificationScan(nextScan);
          onScanProgress(nextScan);
        },
        [result.scenarioId],
        {
          trigger: "Policy fix verification",
          remediationVerification: {
            sourceScanId: scan.id,
            scenarioId: result.scenarioId,
            policyVersionBefore: proposal.expectedPolicyVersion,
          },
        },
      );
      setVerificationScan(verification);
      await onVerificationComplete();
      setNotice(verification.status === "completed"
        ? "The retest is saved and linked to the original scan. Review the result below."
        : "The policy is saved, but the verification scan did not complete. You can retry the same scenario.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Policy fix verification failed.");
      if (policyWasApplied) {
        setNotice("The policy change is already saved. The scenario still needs a completed verification scan.");
      }
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  return (
    <section className="policy-fix-workflow" aria-labelledby={`policy-fix-title-${result.scenarioId}`}>
      <div className="policy-fix-workflow__heading">
        <span className="policy-fix-workflow__mark"><Icon name="shield" size={15} /></span>
        <div>
          <span className="eyebrow eyebrow--cyan">EVIDENCE-BASED POLICY FIX</span>
          <h5 id={`policy-fix-title-${result.scenarioId}`}>{proposal.title}</h5>
        </div>
        <span className="policy-fix-workflow__scope">WORKSPACE POLICY</span>
      </div>

      <p className="policy-fix-workflow__rationale">{proposal.rationale}</p>
      <div className="policy-fix-workflow__change" aria-label="Policy change preview">
        <div><span>Current {proposal.label}</span><strong>{formatValue(proposal, proposal.currentValue)}</strong></div>
        <Icon name="arrow" size={15} />
        <div><span>Proposed</span><strong>{formatValue(proposal, proposal.proposedValue)}</strong></div>
      </div>
      <p className="policy-fix-workflow__impact"><Icon name="activity" size={13} />{proposal.warning}</p>
      <p className="policy-fix-workflow__proof">Retest target: {formatValue(proposal, proposal.evidenceValue)} from scenario <code>{proposal.scenarioId}</code>. The result verifies the AgentGuard policy boundary; it does not prove the customer's source code changed.</p>

      {summary ? (
        <div className={`policy-fix-workflow__result policy-fix-workflow__result--${summary.tone}`} role="status">
          <strong>{summary.label}</strong>
          <span>
            {summary.status === "completed"
              ? `Scenario verdict: ${summary.verdict ?? "unavailable"} | Policy: ${summary.guard?.decision ?? "not evaluated"} | Execution: ${summary.guard?.execution ?? "not recorded"}`
              : `Verification scan: ${summary.status}`}
          </span>
          <small>Saved verification evidence: <code>{summary.scanId}</code></small>
          {currentReasons.length ? <small>{currentReasons.slice(0, 3).join(" ")}</small> : null}
        </div>
      ) : null}

      {notice ? <p className="policy-fix-workflow__notice" role="status">{notice}</p> : null}
      {error ? <p className="policy-fix-workflow__error" role="alert">{error}</p> : null}

      {canManage ? (
        <div className="policy-fix-workflow__actions">
          {!reviewOpen ? (
            <button type="button" className="button button--subtle" onClick={() => setReviewOpen(true)} disabled={isBusy || (!proposalIsFresh && !alreadyApplied && !savedVerificationIsCurrent)}>
              <Icon name="shield" size={13} />{alreadyApplied ? "Retry verification" : savedVerificationIsCurrent ? "Run verification again" : "Review policy change"}
            </button>
          ) : (
            <>
              <button type="button" className="button button--subtle" onClick={() => setReviewOpen(false)} disabled={isBusy}>Cancel</button>
              <button type="button" className="button button--primary" onClick={() => void startVerification()} disabled={isBusy || (!proposalIsFresh && !alreadyApplied)}>
                <Icon name="scan" size={13} />{isBusy ? "Verifying..." : alreadyApplied ? "Run verification" : "Apply policy and verify"}
              </button>
            </>
          )}
        </div>
      ) : (
        <p className="policy-fix-workflow__permission">Only a workspace owner or admin can approve this policy change and start its verification.</p>
      )}
      {!proposalIsFresh && !alreadyApplied && !savedVerificationIsCurrent ? <p className="policy-fix-workflow__stale">This proposal is stale because the workspace policy changed after the source scan. Run a fresh scan to get a current recommendation.</p> : null}
    </section>
  );
}
