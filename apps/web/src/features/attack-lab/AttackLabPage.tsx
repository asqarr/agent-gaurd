import { useState } from "react";
import {
  runAttackLab,
  type AttackLabResult,
  type AttackLabScenarioId,
} from "./attack-lab.api";
import { trackGrowthEvent } from "../analytics/growth";

const challenges: Array<{
  id: AttackLabScenarioId;
  number: string;
  category: string;
  title: string;
  description: string;
}> = [
  {
    id: "refund_policy",
    number: "01",
    category: "POLICY GATE",
    title: "Refund limit",
    description: "Change the amount. See the same policy allow or block it.",
  },
  {
    id: "argument_tampering",
    number: "02",
    category: "APPROVAL BINDING",
    title: "Change the arguments",
    description: "Alter an approved refund. The old approval must no longer match.",
  },
  {
    id: "approval_replay",
    number: "03",
    category: "REPLAY DEFENSE",
    title: "Replay an approval",
    description: "Use a valid approval twice. The second attempt must be rejected.",
  },
];

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(value));
}

export function AttackLabPage() {
  const [scenarioId, setScenarioId] = useState<AttackLabScenarioId>("refund_policy");
  const [amount, setAmount] = useState(120);
  const [changedAmount, setChangedAmount] = useState(21);
  const [result, setResult] = useState<AttackLabResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const selected = challenges.find((challenge) => challenge.id === scenarioId)!;

  async function runChallenge() {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await runAttackLab(scenarioId, {
        ...(scenarioId === "refund_policy" ? { amount } : {}),
        ...(scenarioId === "argument_tampering" ? { changedAmount } : {}),
      });
      setResult(next);
      trackGrowthEvent("attack_lab.challenge_run", {
        page: "attack_lab",
        scenarioId,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The challenge could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  async function copyProof() {
    if (!result) return;
    const proof = {
      product: "AgentGuard Attack Lab",
      label: "Synthetic demonstration — not a customer-agent security assessment",
      scenario: result.title,
      decision: result.decision,
      execution: result.execution,
      toolCall: result.toolCall,
      reasons: result.reasons,
      approval: result.approval,
      evidence: result.evidence,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(proof, null, 2));
      setNotice("Sanitized proof copied.");
    } catch {
      setNotice("Clipboard access is unavailable in this browser.");
    }
  }

  return (
    <main className="attack-lab">
      <header className="attack-lab__header">
        <a className="attack-lab__brand" href="/" aria-label="AgentGuard home">
          <span className="attack-lab__mark"><i /><i /><i /></span>
          <span>AGENT<span>GUARD</span></span>
          <small>SECURITY LAB</small>
        </a>
        <div className="attack-lab__header-right">
          <span className="attack-lab__header-note"><i /> PUBLIC SANDBOX</span>
          <a className="attack-lab__dashboard" href="/app.html">Test your own agent <b>↗</b></a>
        </div>
      </header>

      <section className="attack-lab__hero">
        <div className="attack-lab__hero-copy">
          <div className="attack-lab__eyebrow"><span>AG</span> PROOF-OF-ENFORCEMENT · 03 CHALLENGES</div>
          <h1>Make the risky call.<br /><em>Watch the policy decide.</em></h1>
          <p>
            Explore how AgentGuard evaluates a sensitive tool call, binds approval
            to its exact arguments, and rejects a replay—before an executor can act.
          </p>
          <p className="attack-lab__hero-note">
            This public lab intentionally contains 3 focused synthetic challenges.
            The authenticated dashboard unlocks the full 12-scenario suite by plan.
          </p>
          <div className="attack-lab__trust">
            <span><i /> Real AgentGuard policy code</span>
            <span><i /> Synthetic storefront data</span>
            <span><i /> Zero external side effects</span>
          </div>
        </div>
        <div className="attack-lab__hero-visual" aria-hidden="true">
          <div className="attack-lab__orbit attack-lab__orbit--outer" />
          <div className="attack-lab__orbit attack-lab__orbit--inner" />
          <div className="attack-lab__visual-core"><span>AG</span><small>POLICY GATE</small></div>
          <div className="attack-lab__visual-node attack-lab__visual-node--input">TOOL CALL<small>issue_refund</small></div>
          <div className="attack-lab__visual-node attack-lab__visual-node--policy">POLICY<small>≤ $50.00</small></div>
          <div className="attack-lab__visual-node attack-lab__visual-node--blocked">EXECUTOR<small>NOT REACHED</small></div>
          <div className="attack-lab__visual-wire" />
        </div>
      </section>

      <div className="attack-lab__environment" role="note">
        <span className="attack-lab__environment-icon">!</span>
        <span><strong>SIMULATED ENVIRONMENT</strong> — No live agent, order, payment API, or customer data is connected. “Allow” means policy-approved in this lab only; it does not execute a refund.</span>
        <span className="attack-lab__environment-count">SIDE EFFECTS <b>0</b></span>
      </div>

      <section className="attack-lab__workspace" aria-label="Interactive security challenges">
        <aside className="attack-lab__challenge-list">
          <div className="attack-lab__section-label">CHOOSE A CHALLENGE <span>01—03</span></div>
          {challenges.map((challenge) => (
            <button
              type="button"
              key={challenge.id}
              className={`attack-lab__challenge ${scenarioId === challenge.id ? "is-selected" : ""}`}
              onClick={() => { setScenarioId(challenge.id); setResult(null); setError(""); setNotice(""); }}
              aria-pressed={scenarioId === challenge.id}
            >
              <span className="attack-lab__challenge-number">{challenge.number}</span>
              <span className="attack-lab__challenge-copy">
                <small>{challenge.category}</small>
                <strong>{challenge.title}</strong>
                <span>{challenge.description}</span>
              </span>
              <b className="attack-lab__challenge-arrow">↗</b>
            </button>
          ))}

          <div className="attack-lab__policy-card">
            <div><span className="attack-lab__policy-icon">⌁</span><small>ACTIVE DEMO POLICY</small></div>
            <strong>Storefront refunds</strong>
            <dl>
              <div><dt>Maximum refund</dt><dd>USD 50.00</dd></div>
              <div><dt>Order age</dt><dd>≤ 14 days</dd></div>
              <div><dt>Unknown tools</dt><dd className="is-deny">DENY</dd></div>
            </dl>
            <span className="attack-lab__policy-foot"><i /> DETERMINISTIC · FAIL-CLOSED</span>
          </div>
        </aside>

        <section className="attack-lab__challenge-panel">
          <div className="attack-lab__section-label">INTERACTIVE TEST <span>NO LOGIN REQUIRED</span></div>
          <div className="attack-lab__challenge-heading">
            <div><small>{selected.category} / {selected.number}</small><h2>{selected.title}</h2></div>
            <span className="attack-lab__synthetic-tag"><i /> SYNTHETIC</span>
          </div>
          <p className="attack-lab__challenge-intro">{selected.description}</p>

          {scenarioId === "refund_policy" ? (
            <div className="attack-lab__controls">
              <label htmlFor="lab-refund-amount">Proposed refund amount <span>USD</span></label>
              <div className="attack-lab__amount-input">
                <span>$</span>
                <input
                  id="lab-refund-amount"
                  type="number"
                  min="0.01"
                  max="5000"
                  step="0.01"
                  value={amount}
                  onChange={(event) => setAmount(Number(event.target.value))}
                />
                <small>POLICY LIMIT&nbsp; $50.00</small>
              </div>
              <input
                className="attack-lab__range"
                aria-label="Adjust proposed refund amount"
                type="range"
                min="1"
                max="250"
                step="1"
                value={Number.isFinite(amount) ? Math.min(250, Math.max(1, amount)) : 1}
                onChange={(event) => setAmount(Number(event.target.value))}
              />
              <div className="attack-lab__range-labels"><span>$1</span><span>Move above the $50 policy limit</span><span>$250</span></div>
              <div className="attack-lab__quick-values">
                <button type="button" onClick={() => setAmount(20)}>Try valid · $20</button>
                <button type="button" onClick={() => setAmount(120)}>Try over limit · $120</button>
              </div>
              <div className="attack-lab__call-preview">
                <div><span>PROPOSED TOOL CALL</span><span className="attack-lab__method">POST · MOCK ONLY</span></div>
                <code><b>issue_refund</b>({`{`}<br />&nbsp;&nbsp;order_id: <i>"DEMO-ORDER-100"</i>,<br />&nbsp;&nbsp;amount: <i>{Number.isFinite(amount) ? amount : "—"}</i><br />{`}`})</code>
              </div>
            </div>
          ) : null}

          {scenarioId === "argument_tampering" ? (
            <div className="attack-lab__controls">
              <label htmlFor="lab-tampered-amount">Change the approved amount <span>USD</span></label>
              <div className="attack-lab__tamper-flow">
                <div><small>APPROVED CALL</small><strong>$20.00</strong><code>issue_refund</code></div>
                <span className="attack-lab__tamper-arrow">→</span>
                <div className="is-tampered"><small>MODIFIED CALL</small><strong>$</strong><input id="lab-tampered-amount" type="number" min="0.01" max="5000" step="0.01" value={changedAmount} onChange={(event) => setChangedAmount(Number(event.target.value))} /><code>arguments changed</code></div>
              </div>
              <p className="attack-lab__control-note">The original approval is signed for exactly $20. Change even one argument and the matching check should fail.</p>
              <div className="attack-lab__call-preview">
                <div><span>APPROVAL SCOPE</span><span className="attack-lab__method">SIGNED · SHORT-LIVED</span></div>
                <code>tool + arguments + actor + workspace<br />order + request time + expiry</code>
              </div>
            </div>
          ) : null}

          {scenarioId === "approval_replay" ? (
            <div className="attack-lab__controls">
              <label>One approval. Two consume attempts. <span>SECOND MUST FAIL</span></label>
              <div className="attack-lab__replay-flow">
                <div className="attack-lab__replay-ticket"><span>EPHEMERAL LAB APPROVAL</span><strong>issue_refund · USD 20.00</strong><small>DEMO-ORDER-100 · expires in 30s</small><i>● SIGNATURE VALID</i></div>
                <div className="attack-lab__replay-attempt"><b>01</b><span>First consume</span><strong>AUTHORIZED ONCE</strong></div>
                <div className="attack-lab__replay-attempt is-rejected"><b>02</b><span>Replay same approval</span><strong>REJECTED</strong></div>
              </div>
              <p className="attack-lab__control-note">This public challenge uses an ephemeral in-memory mock consumer. Production consumption is persisted and atomic; no refund is executed here.</p>
            </div>
          ) : null}

          {error ? <div className="attack-lab__error" role="alert">{error}</div> : null}
          <div className="attack-lab__run-row">
            <button type="button" className="attack-lab__run" onClick={() => void runChallenge()} disabled={busy || (scenarioId === "refund_policy" && !Number.isFinite(amount)) || (scenarioId === "argument_tampering" && !Number.isFinite(changedAmount))}>
              <span>{busy ? "EVALUATING POLICY…" : "Run safe challenge"}</span><b>{busy ? "◌" : "→"}</b>
            </button>
              <span>DETERMINISTIC · NO AI API</span>
          </div>
        </section>

        <section className="attack-lab__evidence" aria-live="polite">
          <div className="attack-lab__section-label">DECISION & EVIDENCE <span>{result ? "RUN COMPLETE" : "AWAITING TEST"}</span></div>
          {result ? (
            <>
              <div className={`attack-lab__result-status ${result.decision === "BLOCK" ? "is-blocked" : result.decision === "ALLOW" ? "is-allowed" : "is-error"}`}>
                <div className="attack-lab__result-symbol">{result.decision === "BLOCK" ? "×" : result.decision === "ALLOW" ? "✓" : "!"}</div>
                <div><small>POLICY DECISION</small><strong>{scenarioId === "approval_replay" && result.approval?.replayRejected ? "REPLAY BLOCKED" : result.decision === "BLOCK" ? "ACTION BLOCKED" : result.decision === "ALLOW" ? "POLICY ALLOWS" : "CHECK FAILED"}</strong></div>
                <span>{result.execution === "SIMULATION_ONLY" ? "SIMULATED" : "NOT EXECUTED"}</span>
              </div>
              <p className="attack-lab__result-summary">{result.summary}</p>
              <div className="attack-lab__timeline">
                {result.steps.map((step, index) => (
                  <div key={`${step.label}-${index}`} className={`attack-lab__timeline-step is-${step.status}`}>
                    <span>{step.status === "blocked" ? "×" : step.status === "safe" ? "✓" : step.status === "allowed" ? "✓" : String(index + 1).padStart(2, "0")}</span>
                    <strong>{step.label}</strong>
                    <small>{step.status === "blocked" ? "REJECTED" : step.status === "safe" ? "SAFE" : step.status === "allowed" ? "ALLOW" : "VERIFIED"}</small>
                  </div>
                ))}
              </div>
              {result.reasons.length ? <div className="attack-lab__reason"><small>WHY IT WAS BLOCKED</small><p>{result.reasons.join(" ")}</p></div> : null}
              <div className="attack-lab__evidence-grid">
                <div><small>REQUEST ID</small><code>{result.evidence.requestId}</code></div>
                <div><small>POLICY</small><strong>USD {result.policy.maxAmount} cap</strong></div>
                <div><small>EXECUTOR</small><strong>Not reached</strong></div>
                <div><small>SIDE EFFECTS</small><strong>0 · {formatTime(result.evidence.observedAt)}</strong></div>
              </div>
              {result.approval ? <div className="attack-lab__approval-proof"><span><i /> Signature valid</span>{result.approval.argumentsMatch === false ? <span className="is-no"><i /> Arguments mismatch</span> : null}{result.approval.replayRejected ? <span className="is-no"><i /> Replay rejected</span> : null}</div> : null}
              <button type="button" className="attack-lab__copy" onClick={() => void copyProof()}>Copy sanitized proof <b>↗</b></button>
              {notice ? <span className="attack-lab__notice" role="status">{notice}</span> : null}
            </>
          ) : (
            <div className="attack-lab__empty">
              <div className="attack-lab__empty-graphic"><span>AG</span><i /><i /><i /></div>
              <strong>Your proof appears here</strong>
              <p>Run a challenge to see the Policy decision, approval checks, and a sanitized evidence record.</p>
              <div className="attack-lab__empty-checks"><span><i /> Policy evaluated server-side</span><span><i /> No live executor configured</span><span><i /> Customer data never requested</span></div>
            </div>
          )}
        </section>
      </section>

      <section className="attack-lab__next-step">
        <div className="attack-lab__next-icon">↗</div>
        <div><small>FROM DEMO TO YOUR AGENT</small><h2>Now prove the integration boundary.</h2><p>Connect a staging agent and verify that sensitive tools cannot run without a matching, unexpired, single-use approval.</p></div>
        <a href="/app.html">Test your own agent <b>→</b></a>
      </section>

      <footer className="attack-lab__footer">
        <a className="attack-lab__brand" href="/"><span className="attack-lab__mark"><i /><i /><i /></span><span>AGENT<span>GUARD</span></span></a>
        <span>Policy demonstration only · not a customer-agent security assessment</span>
        <span>© 2026 AgentGuard</span>
        <button className="attack-lab__privacy-toggle" type="button" data-growth-analytics-toggle aria-pressed="true">Disable anonymous analytics</button>
        <span data-growth-analytics-status aria-live="polite" />
        <span>Anonymous first-party metrics only; no third-party tracking.</span>
      </footer>
    </main>
  );
}
