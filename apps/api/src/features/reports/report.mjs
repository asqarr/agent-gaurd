import { buildRemediation } from "./remediation.mjs";
import { scenarios } from "../catalog/domain.mjs";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isProtected(result) {
  if (result?.verdict) return result.verdict === "PROTECTED";
  return result.status === "PASS" || (
    result.guard?.decision === "BLOCK" &&
    result.guard?.execution === "NOT_EXECUTED"
  );
}

function isInconclusive(result) {
  return result?.verdict === "INCONCLUSIVE" || result?.status === "ERROR";
}

function verdictFor(result) {
  if (result.verdict === "INCONCLUSIVE") return "INCONCLUSIVE";
  if (result.verdict === "VULNERABLE") return "VULNERABLE";
  if (result.status === "ERROR") return "ERROR";
  if (result.guard?.decision === "BLOCK" && result.guard?.execution === "NOT_EXECUTED") {
    return "BLOCKED SAFELY";
  }
  return isProtected(result) ? "PASS" : "FINDING";
}

function severityFor(result) {
  if (isProtected(result)) return "Protected";
  if (isInconclusive(result)) return "Needs review";
  if (result.category?.toLowerCase().includes("injection")) return "Critical";
  if (result.category?.toLowerCase().includes("authorization")) return "High";
  return result.status === "ERROR" ? "Needs review" : "High";
}

function amountFrom(result) {
  const value = result.call?.arguments?.amount;
  return typeof value === "number" ? value : null;
}

function businessImpactFor(result, policy) {
  if (isProtected(result)) {
    return "The expected control held. The proposal was either compliant or stopped before it could reach a customer executor. Keep the boundary in place and re-test after changes.";
  }
  const amount = amountFrom(result);
  const currency = policy?.currency ?? "USD";
  if (amount !== null && amount > Number(policy?.maxAmount ?? 50)) {
    return `Potential direct financial loss: the agent proposed a ${currency} ${amount} refund while the enforced ceiling is ${currency} ${policy?.maxAmount ?? 50}. If the customer executor is reachable without the Gateway, this control failure can authorize an over-limit payout.`;
  }
  const category = String(result.category ?? "").toLowerCase();
  if (category.includes("injection")) {
    return "An attacker-controlled instruction could influence a high-impact action. The commercial risk is unauthorized refunds, account abuse, or a loss of trust in the support channel.";
  }
  if (category.includes("authorization") || result.scenarioId === "cross_tenant_access") {
    return "The agent may cross a merchant or role boundary. This can expose another customer’s data and create unauthorized financial or operational actions.";
  }
  if (result.status === "ERROR") {
    return "The control could not reach a trustworthy verdict. Treat the action as unsafe until the endpoint, contract, and execution path are verified.";
  }
  return "The agent behavior differs from the approved control. A sensitive action may reach a customer system without the intended authorization boundary.";
}

function reproductionFor(result, scan) {
  const payload = result.call
    ? JSON.stringify(result.call, null, 2)
    : "No tool call was proposed.";
  return `1. Select agent ${scan.agentName || scan.agentId}. 2. Run scenario ${result.scenarioId} with contract version ${scan.contractVersion || 0}. 3. Compare the proposed call, Policy decision, and execution outcome with this evidence. Exact proposed payload: ${payload}`;
}

function remediationFor(result, policy) {
  if (isProtected(result)) {
    return `Keep the current policy boundary at ${policy?.currency ?? "USD"} ${policy?.maxAmount ?? 50}, keep the tool behind Runtime Firewall, and add a regression test for this scenario.`;
  }
  if (result.guard?.decision === "BLOCK") {
    return "Keep the Gateway decision fail-closed, do not forward blocked calls to the customer executor, and fix the agent or authorization source that produced the unsafe proposal. Re-run the same scenario before restoring the tool allowlist.";
  }
  return "Route the agent through Runtime Firewall, require a current identity/order context, keep the sensitive tool outside the allowlist until the finding is resolved, and verify remediation with a fresh scan.";
}

function resultRow(result, { policy, scan }) {
  const reason = result.reasons?.length ? result.reasons.join(" ") : "No additional reason recorded.";
  const callPayload = result.call ? JSON.stringify(result.call, null, 2) : "No tool call was proposed.";
  const remediation = result.remediation ?? buildRemediation({ result, policy });
  const recommendationList = (remediation?.recommendations ?? []).map((item) => `<li><b>${escapeHtml(item.priority)} · ${escapeHtml(item.title)}</b><span>${escapeHtml(item.action)}</span><small>Implementation: ${escapeHtml(item.implementation)}</small><small>Verify: ${escapeHtml(item.verify)}</small></li>`).join("");
  const copilot = result.copilotGuidance;
  const copilotPlan = copilot?.guidance;
  const copilotSteps = Array.isArray(copilotPlan?.fixPlan)
    ? copilotPlan.fixPlan.map((step) => `<li><b>${escapeHtml(step.title)}</b><p>${escapeHtml(step.rationale)}</p><p>${escapeHtml(step.implementation)}</p><small>Verify: ${escapeHtml(step.verify)}</small></li>`).join("")
    : "";
  const copilotSection = copilotPlan
    ? `<div class="section section--ai"><b>AI remediation plan · human review required</b><p>${escapeHtml(copilotPlan.summary)}</p><p><b>Likely root cause:</b> ${escapeHtml(copilotPlan.rootCause)}</p><ol class="remediation-list">${copilotSteps}</ol><ul class="remediation-list">${(copilotPlan.acceptanceCriteria ?? []).map((item) => `<li><span>${escapeHtml(item)}</span></li>`).join("")}</ul>${(copilotPlan.caveats ?? []).map((item) => `<p class="muted">Review note: ${escapeHtml(item)}</p>`).join("")}<small>Generated by ${escapeHtml(copilot.model)} at ${escapeHtml(copilot.generatedAt)} from minimized scan evidence. Recommendations are advisory and were not applied automatically.</small></div>`
    : "";
  return `<article class="finding ${isProtected(result) ? "finding--safe" : "finding--risk"}">
    <div class="finding__top"><span class="pill">${escapeHtml(severityFor(result))}</span><span class="status">${escapeHtml(verdictFor(result))}</span></div>
    <h3>${escapeHtml(result.title)}</h3>
    <p class="muted">${escapeHtml(result.category)} · scenario <code>${escapeHtml(result.scenarioId)}</code></p>
    <div class="grid"><div><b>Expected</b><span>${escapeHtml(result.expected)}</span></div><div><b>Observed</b><span>${escapeHtml(result.observed || "No tool call")}</span></div><div><b>Tool</b><span>${escapeHtml(result.call?.name || "None")}</span></div><div><b>Execution</b><span>${escapeHtml(result.guard?.execution || "Not executed")}</span></div></div>
    <div class="section section--impact"><b>Commercial impact</b><p>${escapeHtml(remediation?.businessImpact ?? businessImpactFor(result, policy))}</p></div>
    <div class="section"><b>Evidence</b><p>${escapeHtml(reason)}</p>${result.call ? `<pre>${escapeHtml(callPayload)}</pre>` : ""}</div>
    <div class="section"><b>Reproduction recipe</b><p>${escapeHtml(reproductionFor(result, scan))}</p></div>
    <div class="section"><b>Root cause</b><p>${escapeHtml(remediation?.rootCause)}</p><p>${escapeHtml(remediation?.summary)}</p></div>
    <div class="section"><b>Developer fix / Remediation</b><ul class="remediation-list">${recommendationList}</ul></div>
    <div class="section section--acceptance"><b>Acceptance check</b><ul class="remediation-list">${(remediation?.acceptanceCriteria ?? []).map((item) => `<li><span>${escapeHtml(item)}</span></li>`).join("")}</ul><p>Retest: ${escapeHtml(remediation?.retest?.label ?? "Run the same scenario again")}</p></div>
    ${copilotSection}
  </article>`;
}

export function renderScanReport({ scan, policy, preview = false }) {
  const results = scan.results ?? [];
  const findings = results.filter((result) => result.verdict === "VULNERABLE" || (!result.verdict && result.status === "FAIL" && !isProtected(result))).length;
  const inconclusive = results.filter(isInconclusive).length;
  const testedScenarioCount = Number(scan.scenarioCount ?? results.length);
  const requiredScenarioCount = scenarios.length;
  const coverageNotice = testedScenarioCount < requiredScenarioCount
    ? `<div class="notice"><b>Limited coverage:</b> This scan evaluated ${escapeHtml(testedScenarioCount)}/${escapeHtml(requiredScenarioCount)} scenarios. The score is a control score for the selected evidence, not a full security certification; advanced chains may be incomplete.</div>`
    : `<div class="notice notice--preview"><b>Full suite coverage:</b> All ${escapeHtml(requiredScenarioCount)} catalog scenarios were evaluated. The score still reflects only this scan and does not guarantee security against unknown attacks.</div>`;
  const generatedAt = new Date().toISOString();
  const previewNotice = preview
    ? `<div class="notice notice--preview"><b>Quickstart proof report:</b> This is an isolated synthetic run. It proves the pre-execution policy decision and contains no customer data or live side effect.</div>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentGuard report · ${escapeHtml(scan.agentName || scan.agentId)}</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;color:#e8f2f4;background:#071016}*{box-sizing:border-box}body{margin:0;padding:40px;background:linear-gradient(145deg,#071016,#0b1720);line-height:1.5}.report{max-width:1080px;margin:auto}.brand{letter-spacing:.18em;color:#64ead9;font-size:12px;font-weight:700}.header{display:flex;justify-content:space-between;gap:24px;align-items:end;border-bottom:1px solid #28404b;padding-bottom:26px}.header h1{font-size:36px;margin:8px 0 4px}.muted{color:#8ea5ae}.summary{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin:24px 0}.metric,.finding{background:#0d1b25;border:1px solid #213a46;border-radius:14px;padding:18px}.metric b,.grid b{display:block;color:#8ea5ae;font-size:11px;text-transform:uppercase;letter-spacing:.1em}.metric strong{display:block;font-size:26px;margin-top:7px;color:#64ead9}.notice{padding:14px 16px;border:1px solid #8c6b31;border-radius:12px;background:#241f12;color:#f4d38a;margin:18px 0}.notice--preview{border-color:#2f7771;background:#0c292e;color:#9fe8df}.finding{margin:14px 0}.finding--risk{border-color:#674043}.finding--safe{border-color:#225a58}.finding__top{display:flex;justify-content:space-between}.pill,.status{font-size:11px;text-transform:uppercase;letter-spacing:.08em}.pill{color:#f3c873}.status{color:#64ead9}.finding h3{margin:12px 0 0;font-size:20px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:18px 0}.grid span{display:block;margin-top:5px;color:#d3e0e3;word-break:break-word}.section{border-top:1px solid #1d3540;padding-top:12px;margin-top:12px}.section b{font-size:12px;color:#cde9e8}.section p{margin:5px 0;color:#a8bdc4}.section--impact{border-top-color:#6d4d36}.section--impact b{color:#f3c873}.section--acceptance{border-top-color:#225a58}.section--ai{border-top-color:#3c8177;background:linear-gradient(135deg,rgba(11,43,48,.35),transparent);padding:12px;border-radius:8px}.section--ai>b{color:#85ead7}.section--ai ol{padding-left:22px}.section--ai ol li{padding-left:5px;margin:10px 0}.section--ai small{display:block;color:#78969e;font-size:10px;line-height:1.5}.section pre{margin:9px 0 0;padding:12px;overflow:auto;border:1px solid #203944;border-radius:8px;color:#b9e9e2;background:#07141b;font:12px ui-monospace,SFMono-Regular,Consolas,monospace}code{color:#64ead9}@media(max-width:760px){body{padding:18px}.header{display:block}.summary,.grid{grid-template-columns:repeat(2,1fr)}}@media print{body{background:#fff;color:#111;padding:0}.metric,.finding{background:#fff;border-color:#bbb}.muted,.section p{color:#444}.notice{color:#624d1b;background:#fff8df}}
</style></head><body><main class="report">
<div class="brand">AGENTGUARD · SECURITY EVIDENCE</div><header class="header"><div><h1>${escapeHtml(scan.agentName || scan.agentId)}</h1><div class="muted">Scan ${escapeHtml(scan.id)} · ${escapeHtml(scan.trigger)} · generated ${escapeHtml(generatedAt)}</div></div><div class="muted">Contract v${escapeHtml(scan.contractVersion || 0)}</div></header>
<section class="summary"><div class="metric"><b>Control score</b><strong>${escapeHtml(scan.score ?? "—")}${scan.score == null ? "" : "/100"}</strong></div><div class="metric"><b>Coverage</b><strong>${escapeHtml(testedScenarioCount)}/${escapeHtml(requiredScenarioCount)}</strong></div><div class="metric"><b>Protected</b><strong>${escapeHtml(scan.passed ?? 0)}</strong></div><div class="metric"><b>Vulnerable</b><strong>${escapeHtml(findings)}</strong></div><div class="metric"><b>Inconclusive</b><strong>${escapeHtml(inconclusive)}</strong></div></section>
<div class="metric"><b>Effective policy snapshot</b><span>${escapeHtml(policy?.name || "Workspace policy")} · v${escapeHtml(scan.policyVersion ?? "—")} · refund ceiling ${escapeHtml(policy?.currency || "USD")} ${escapeHtml(policy?.maxAmount ?? "—")} · order window ${escapeHtml(policy?.maxAgeDays ?? "—")} days · blocked calls are not forwarded to execution.</span></div>
${previewNotice}${coverageNotice}${scan.safetyWarning ? `<div class="notice"><b>Scan safety warning:</b> ${escapeHtml(scan.safetyWarning)}</div>` : ""}
<section><h2>Findings and evidence</h2>${results.length ? results.map((result) => resultRow(result, { policy, scan })).join("") : `<div class="metric">No scenario evidence is available yet.</div>`}</section>
<footer class="muted" style="margin-top:30px">This report is evidence from the selected scan and is not a guarantee against every possible attack. Verify remediation with a fresh scan and confirm the customer executor rejects direct sensitive calls.</footer>
</main></body></html>`;
}
