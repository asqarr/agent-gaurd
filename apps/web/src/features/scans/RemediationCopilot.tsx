import { useObject } from "@ai-sdk/react";
import { useState } from "react";
import { Icon } from "../../shared/ui/Icon";
import { remediationCopilotEndpoint, remediationCopilotFetch } from "./copilot.api";
import { remediationCopilotSchema, type RemediationCopilotPlan } from "./copilot-schema";

export function RemediationCopilot({
  scanId,
  scenarioId,
  verdict,
  policyVersion,
  storedGuidance,
  onRetest,
}: {
  scanId: string;
  scenarioId: string;
  verdict?: string | null;
  policyVersion?: number;
  storedGuidance?: {
    guidance: RemediationCopilotPlan;
    model: string;
  };
  onRetest?: (scenarioId: string) => void;
}) {
  const [requested, setRequested] = useState(Boolean(storedGuidance));
  const { object, submit, isLoading, stop, clear, error } = useObject({
    id: `scan-copilot-${scanId}-${scenarioId}`,
    api: remediationCopilotEndpoint(scanId, scenarioId),
    schema: remediationCopilotSchema,
    initialValue: storedGuidance?.guidance,
    fetch: remediationCopilotFetch,
    credentials: "include",
  });

  function generatePlan() {
    clear();
    setRequested(true);
    submit({});
  }

  function stopGeneration() {
    stop();
    clear();
    setRequested(false);
  }

  const hasPlan = Boolean(object?.summary || object?.rootCause || object?.fixPlan?.length);

  return (
    <section className="remediation-copilot" aria-live="polite">
      <div className="remediation-copilot__heading">
        <div className="remediation-copilot__mark"><Icon name="sparkle" size={15} /></div>
        <div>
          <span className="eyebrow eyebrow--cyan">AI REMEDIATION COPILOT</span>
          <strong>Turn this evidence into a fix plan.</strong>
        </div>
        <span className="remediation-copilot__stream">{isLoading ? "LIVE ANALYSIS" : "EVIDENCE GROUNDED"}</span>
      </div>

      <div className="remediation-copilot__evidence" aria-label="Evidence used">
        <span>{scenarioId}</span>
        <span>{verdict ?? "INCONCLUSIVE"}</span>
        {policyVersion ? <span>Policy v{policyVersion}</span> : null}
      </div>

      {!hasPlan && !isLoading ? (
        <p className="remediation-copilot__intro">Get a plain-language explanation and implementation steps based on this scan's verdict and the deterministic remediation guidance.</p>
      ) : null}

      {object?.summary ? <div className="remediation-copilot__answer"><span>WHAT THIS MEANS</span><p>{object.summary}</p></div> : null}
      {object?.rootCause ? <div className="remediation-copilot__answer"><span>LIKELY ROOT CAUSE</span><p>{object.rootCause}</p></div> : null}

      {object?.fixPlan?.length ? (
        <div className="remediation-copilot__steps">
          <span className="remediation-copilot__section-label">IMPLEMENTATION PLAN</span>
          {object.fixPlan.map((step, index) => (
            <article key={`${scenarioId}-copilot-step-${index}`}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                {step?.title ? <strong>{step.title}</strong> : null}
                {step?.rationale ? <p>{step.rationale}</p> : null}
                {step?.implementation ? <pre>{step.implementation}</pre> : null}
                {step?.verify ? <small><b>Verify:</b> {step.verify}</small> : null}
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {object?.acceptanceCriteria?.length ? (
        <div className="remediation-copilot__answer">
          <span>DONE WHEN</span>
          <ul>{object.acceptanceCriteria.map((item, index) => item ? <li key={`${scenarioId}-copilot-criteria-${index}`}>{item}</li> : null)}</ul>
        </div>
      ) : null}

      {object?.caveats?.length ? (
        <div className="remediation-copilot__caveats"><strong>Review notes</strong>{object.caveats.map((item, index) => item ? <span key={`${scenarioId}-copilot-caveat-${index}`}>{item}</span> : null)}</div>
      ) : null}

      {isLoading ? (
        <div className="remediation-copilot__loading"><span className="remediation-copilot__pulse" />Building a structured plan from minimized scan evidence...<button type="button" className="text-button" onClick={stopGeneration}>Stop</button></div>
      ) : null}

      {error ? <div className="remediation-copilot__error" role="alert"><Icon name="activity" size={14} /><span>{error.message || "The AI plan could not be generated."}</span></div> : null}

      <div className="remediation-copilot__footer">
        {!requested || error ? (
          <button type="button" className="button button--subtle" onClick={generatePlan} disabled={isLoading}>
            <Icon name="sparkle" size={14} />{error ? "Retry AI plan" : "Generate AI fix plan"}
          </button>
        ) : null}
        {hasPlan && !isLoading ? <span className="remediation-copilot__saved"><Icon name="shield" size={12} />Saved{storedGuidance?.model ? ` | ${storedGuidance.model}` : " to this scan"}</span> : null}
        {onRetest ? <button type="button" className="button button--subtle" onClick={() => onRetest(scenarioId)}><Icon name="scan" size={13} />{hasPlan ? "Verify after fix" : "Retest this scenario"}</button> : null}
      </div>

      <p className="remediation-copilot__notice">Advisory only. The evidence excludes raw prompts, observed text, tool arguments, customer/scan IDs, customer agent URLs, and agent or customer secrets. The configured AI provider is authenticated with AI_API_KEY. Review every change; policy decisions remain with the deterministic guard.</p>
    </section>
  );
}
