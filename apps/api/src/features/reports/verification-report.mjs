function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderEnforcementVerificationReport({ verification, isCurrent = false }) {
  const state = verification?.status === "passed" ? "PASSED" : "FAILED";
  const checks = (verification?.checks ?? []).map((item) => `
    <article class="check check--${escapeHtml(item.status)}">
      <div class="check__head"><h2>${escapeHtml(item.title)}</h2><strong>${escapeHtml(item.status)}</strong></div>
      <p><b>Tool:</b> ${escapeHtml(item.tool)}</p>
      <p><b>Expected:</b> ${escapeHtml(item.expected)}</p>
      <p><b>Observed:</b> ${escapeHtml(item.observed)}</p>
      <p><b>Reproduce:</b> ${escapeHtml(item.reproduction)}</p>
      <p><b>Next step:</b> ${escapeHtml(item.remediation)}</p>
    </article>`).join("");
  const limitations = (verification?.limitations ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const notTested = (verification?.notTested ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const staleNotice = isCurrent
    ? "This proof matches the agent's current endpoint configuration, policy, contract, tool scope, status, and Runtime Firewall state."
    : "Configuration has changed since this proof was created. Rerun verification before relying on it.";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>AgentGuard enforcement verification · ${escapeHtml(verification?.scope?.agentName)}</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#080d18;color:#e6eef8}*{box-sizing:border-box}body{margin:0;padding:32px;background:radial-gradient(circle at 80% 0,rgba(47,122,143,.16),transparent 35rem),#080d18;line-height:1.55}.report{max-width:900px;margin:auto}.eyebrow{color:#69e2d5;font:11px ui-monospace,monospace;letter-spacing:.12em}.head{display:flex;justify-content:space-between;align-items:end;gap:20px;padding:12px 0 24px;border-bottom:1px solid #26364c}.head h1{margin:7px 0 4px;font-size:clamp(24px,5vw,38px);letter-spacing:-.04em}.muted{color:#91a1b9}.state{padding:7px 11px;border:1px solid #347d70;border-radius:999px;color:#88e8c9;font:11px ui-monospace,monospace;text-transform:uppercase}.state--failed{border-color:#874a4c;color:#ffab9b}.notice{padding:14px 16px;margin:20px 0;border:1px solid #735d32;border-radius:9px;background:#201e16;color:#ecd49b}.summary,.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:18px 0}.tile,.check{padding:15px;border:1px solid #25394d;border-radius:9px;background:#0d1725}.tile span{display:block;color:#8698b3;font-size:11px}.tile strong{display:block;margin-top:5px;color:#73e2d5;font:18px ui-monospace,monospace}.check{margin:11px 0}.check--failed{border-color:#83484a}.check__head{display:flex;justify-content:space-between;align-items:center;gap:12px}.check h2{margin:0;font-size:15px}.check__head strong{color:#7ee0be;font:10px ui-monospace,monospace;text-transform:uppercase}.check--failed .check__head strong{color:#ff9e8e}.check p{margin:9px 0 0;color:#9aabc1;font-size:12px;overflow-wrap:anywhere}h3{margin:25px 0 8px;font-size:16px}ul{padding-left:21px;color:#aab8cb;font-size:12px}li+li{margin-top:6px}.footer{margin-top:25px;padding-top:15px;border-top:1px solid #26364c;color:#8394ad;font-size:11px}@media(max-width:600px){body{padding:18px}.head{align-items:flex-start;flex-direction:column}}
</style></head><body><main class="report">
<header class="head"><div><span class="eyebrow">AGENTGUARD · ENFORCEMENT VERIFICATION</span><h1>Runtime enforcement proof</h1><div class="muted">${escapeHtml(verification?.scope?.agentName)} · ${escapeHtml(verification?.testedAt)}</div></div><strong class="state ${state === "FAILED" ? "state--failed" : ""}">${state}</strong></header>
<div class="notice"><b>Scope:</b> ${escapeHtml(staleNotice)} This is a synthetic AgentGuard control-plane and bundled SDK conformance run. It does not inspect your application source code or production executor.</div>
<section class="summary"><div class="tile"><span>Checks passed</span><strong>${Number(verification?.summary?.passed ?? 0)}/${Number(verification?.summary?.total ?? 0)}</strong></div><div class="tile"><span>Customer endpoint calls</span><strong>${Number(verification?.summary?.customerEndpointCalls ?? 0)}</strong></div><div class="tile"><span>External tool calls</span><strong>${Number(verification?.summary?.externalToolCalls ?? 0)}</strong></div><div class="tile"><span>Financial side effects</span><strong>${Number(verification?.summary?.financialSideEffects ?? 0)}</strong></div></section>
<section class="meta"><div class="tile"><span>Policy</span><strong>${escapeHtml(verification?.scope?.policy?.name)}</strong></div><div class="tile"><span>Refund ceiling</span><strong>${escapeHtml(verification?.scope?.policy?.currency)} ${escapeHtml(verification?.scope?.policy?.maxAmount)}</strong></div><div class="tile"><span>Contract version</span><strong>${Number(verification?.scope?.contractVersion ?? 0)}</strong></div><div class="tile"><span>Verifier</span><strong>${escapeHtml(verification?.verifierVersion)}</strong></div><div class="tile"><span>Proof ID</span><strong>${escapeHtml(verification?.id)}</strong></div><div class="tile"><span>Config fingerprint</span><strong>${escapeHtml(verification?.fingerprint?.slice(0, 16))}</strong></div></section>
<h3>Reproducible checks</h3>${checks || "<p>No verification evidence is available.</p>"}
<h3>Not tested</h3><ul>${notTested}</ul><h3>Limitations</h3><ul>${limitations}</ul>
<footer class="footer">This report is a scoped conformance result, not a penetration test or security certification. Before production, run a customer-owned safe harness in Staging and verify every path to sensitive executors.</footer>
</main></body></html>`;
}
