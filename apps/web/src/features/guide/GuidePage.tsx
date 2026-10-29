import { useMemo, useState } from "react";
import { Icon, type IconName } from "../../shared/ui/Icon";

type GuideGroup = "Start here" | "Protect" | "Operate" | "Administer";

type GuideTopic = {
  id: string;
  title: string;
  group: GuideGroup;
  icon: IconName;
  summary: string;
  useFor: string;
  steps: string[];
  lookFor: string;
  keywords: string;
};

const groups: Array<"All sections" | GuideGroup> = [
  "All sections",
  "Start here",
  "Protect",
  "Operate",
  "Administer",
];

const topics: GuideTopic[] = [
  {
    id: "Overview",
    title: "Overview",
    group: "Start here",
    icon: "grid",
    summary: "A workspace-wide snapshot of your agents, recent security evidence, and items that need attention.",
    useFor: "Start here when you want to understand the current security posture or decide what to review next.",
    steps: [
      "Read the control score and scenario coverage together. Coverage tells you how much of the available test suite was evaluated.",
      "Check open findings and inconclusive evidence. Open the related scan to see the evidence behind each number.",
      "Use the recent scans and agent cards to move from the summary to a specific agent or result.",
    ],
    lookFor: "A score summarizes recorded evidence; it is not a guarantee that every behavior or execution path is safe. Inconclusive evidence means safety was not proven.",
    keywords: "dashboard posture score coverage metrics recent activity",
  },
  {
    id: "Launchpad",
    title: "Launchpad",
    group: "Start here",
    icon: "activity",
    summary: "A live checklist that recommends the next step from connection through verification and monitoring.",
    useFor: "Use it for your first setup or whenever you are unsure what to do next.",
    steps: [
      "Connect an agent, or run the isolated demo to see a synthetic policy decision without connecting your customer endpoint.",
      "Assess the selected agent and review its blueprint or scan evidence.",
      "Approve protection, verify the controls, then send traffic through the protected gateway and monitor runtime events.",
    ],
    lookFor: "The progress list reflects the selected agent and current workspace state. A completed synthetic check does not verify your own application executor.",
    keywords: "onboarding setup launch checklist first steps demo",
  },
  {
    id: "Agents",
    title: "Agents",
    group: "Start here",
    icon: "bot",
    summary: "The inventory of connected agents, their environments, allowed tools, latest posture, and protection state.",
    useFor: "Select an agent to inspect its connection, update its settings, test connectivity, or manage its security state.",
    steps: [
      "Select an agent card to see its details, tools, and latest assessment.",
      "Use the connection controls to edit endpoint metadata, replace or clear a stored key, or test the connection.",
      "Use quarantine to block new scans and protected workflows while investigating; restore only after review.",
    ],
    lookFor: "Keep a safe Staging agent for scans. A Production label does not make a direct scan safe; use the protected runtime path for production traffic.",
    keywords: "agent inventory endpoint status environment quarantine restore connection",
  },
  {
    id: "Integrations",
    title: "Integrations",
    group: "Start here",
    icon: "plug",
    summary: "Connect the HTTP endpoint that receives test inputs and inspect the registered tools and their risk metadata.",
    useFor: "Use this section to add an agent endpoint or confirm the tool definitions AgentGuard sees.",
    steps: [
      "Provide a reachable endpoint, a name, provider, model, and an optional API key.",
      "Use a mock or Staging executor for security scans. The scanner sends synthetic requests and reads proposed tool calls; a customer's endpoint could still have its own side effects.",
      "Open the tool registry and confirm names, risk levels, and which tools can cause side effects.",
    ],
    lookFor: "Credentials are stored encrypted. The endpoint contract accepts an input and metadata, then returns assistant content and proposed tool calls.",
    keywords: "connect endpoint integration tool registry api key staging http",
  },
  {
    id: "Autopilot",
    title: "Autopilot",
    group: "Protect",
    icon: "sparkle",
    summary: "A guided assessment that checks the endpoint, inventories tools, runs adversarial scenarios, and builds a reviewable security blueprint.",
    useFor: "Use it when you want one guided assessment and a clear plan for protecting an agent.",
    steps: [
      "Choose the agent and start the assessment. It runs through the durable scan queue and shows progress as it works.",
      "Review the readiness summary, tested tools, findings, and recommendations in the blueprint.",
      "Use Review & protect only after the plan is approved. Applying protection enables Runtime Firewall; it does not silently rewrite business policy values.",
    ],
    lookFor: "An assessment is evidence about the endpoint and scenarios that ran. Resolve findings and unclear results before relying on the agent in production.",
    keywords: "autopilot assessment blueprint readiness findings hardening",
  },
  {
    id: "Policies",
    title: "Policies",
    group: "Protect",
    icon: "shield",
    summary: "The workspace rules that evaluate an agent's proposed action before it can reach an executor.",
    useFor: "Use this section to review or update business guardrails such as refund limits and purchase-age windows.",
    steps: [
      "Read the active policy and its current limits before making a change.",
      "Edit the values to match the rules your business intends to enforce, then save.",
      "Run a scan or enforcement verification after a policy change and inspect the resulting evidence.",
    ],
    lookFor: "The policy checks trusted data after a tool call is proposed. The agent's text or customer-provided content cannot authorize a side effect by itself.",
    keywords: "policy refund amount age rule engine business guardrails",
  },
  {
    id: "Contracts",
    title: "Contracts",
    group: "Protect",
    icon: "shield",
    summary: "A versioned action boundary for an agent: allowed tools and ceilings that can narrow workspace policy.",
    useFor: "Use contracts when an agent needs a stricter tool allowlist or tighter limits than the workspace-wide policy.",
    steps: [
      "Select the agent and inspect which tools are allowed, blocked, read-only, or capable of side effects.",
      "Set contract limits and save a new version. A contract can narrow the workspace policy, never widen it.",
      "Replay the available multi-step attack paths and compare their evidence with the active contract.",
    ],
    lookFor: "A saved contract version is the boundary used for runtime and replay enforcement. Re-test after changing tools or limits.",
    keywords: "contract allowlist tool boundary versions attack paths replay",
  },
  {
    id: "Scans",
    title: "Scans",
    group: "Protect",
    icon: "scan",
    summary: "A history of security assessments with persisted scenario results and evidence you can inspect or retest.",
    useFor: "Use scans to find unsafe proposals, confirm policy behavior, investigate regressions, and verify a fix.",
    steps: [
      "Choose an agent and run a scan against its safe Staging or mock endpoint.",
      "Select a scan row to open its evidence, including scenario outcome, observed behavior, policy decision, and proposed tool arguments.",
      "For a finding, review the remediation plan if available, fix the behavior in your agent or executor, then run the targeted retest.",
    ],
    lookFor: "A finding means unsafe behavior was observed. Inconclusive means execution safety could not be proven. Simulated evidence is labeled and should not be treated as a live endpoint result.",
    keywords: "scan evidence result score finding blocked passed simulated inconclusive retest copilot",
  },
  {
    id: "Scenarios",
    title: "Scenarios",
    group: "Protect",
    icon: "library",
    summary: "The test library explains which normal behaviors and attack patterns the scanner checks.",
    useFor: "Use it to understand coverage before a scan, find a test by name or category, and see whether it is expected to pass or be blocked.",
    steps: [
      "Search by scenario name or filter by category.",
      "Read the description and expected outcome to understand the boundary being checked.",
      "Compare the selected scan's evidence with the scenario expectation; use coverage to spot tests that did not run.",
    ],
    lookFor: "The library describes test cases, not guarantees. Plan entitlements can limit which advanced scenarios are available.",
    keywords: "scenario library test cases prompt injection exfiltration categories coverage",
  },
  {
    id: "Sentinel",
    title: "Sentinel",
    group: "Operate",
    icon: "shield",
    summary: "Continuous drift monitoring that compares an agent's current security fingerprint with an approved baseline.",
    useFor: "Use Sentinel after reviewing an agent's configuration and establishing what the trusted posture should be.",
    steps: [
      "Review the selected agent's model, tools, endpoint posture, and policy, then create its baseline.",
      "Run checks and review each reported change before accepting it as the new baseline.",
      "Enable auto-quarantine only if your team wants critical drift to stop the agent automatically.",
    ],
    lookFor: "Drift means the current fingerprint differs from the approved baseline. It calls for review; it does not by itself explain whether the change was intentional.",
    keywords: "sentinel drift baseline fingerprint monitor quarantine changes",
  },
  {
    id: "Incidents",
    title: "Incidents",
    group: "Operate",
    icon: "bell",
    summary: "A response center for security events, delivery routes, and workspace audit history.",
    useFor: "Use it to triage open signals, review history, and route important events to your incident system.",
    steps: [
      "Start with open and critical events; open each record to understand the affected agent and evidence.",
      "Mark signals as read or resolve them after the team has taken the appropriate action.",
      "If needed, configure an HTTPS alert route and select which events it should receive. Use the test delivery to confirm it works.",
    ],
    lookFor: "The audit trail records sensitive operator changes. Alert webhooks are signed, and their signing secret belongs in your receiver's secret store.",
    keywords: "incident response alert webhook audit trail history events",
  },
  {
    id: "Plans",
    title: "Plans",
    group: "Administer",
    icon: "wallet",
    summary: "Plan entitlements, current usage, billing period, payments, and optional capacity or service add-ons.",
    useFor: "Use it to understand which features and capacity are available to the workspace and review billing activity.",
    steps: [
      "Check the active plan, current period, and included capacity before starting more scans or runtime traffic.",
      "Review usage warnings and the add-on terms before buying extra capacity or a service engagement.",
      "Use payment history and exception details to follow a payment through verification or resolution.",
    ],
    lookFor: "The page shows the current entitlement and usage model. Read the specific renewal and acceptance terms shown before confirming a purchase.",
    keywords: "plans billing subscription quota usage addons payments renewal",
  },
  {
    id: "Settings",
    title: "Settings",
    group: "Administer",
    icon: "settings",
    summary: "Your operator profile, workspace identity, password, sessions, and administrator security settings.",
    useFor: "Use it to maintain account details and secure administrator access to the workspace.",
    steps: [
      "Keep your display name and workspace name recognizable to teammates and audit readers.",
      "Use the password and session controls when access changes or a device should be signed out.",
      "Enable multi-factor authentication for owner and admin access when available to your workspace.",
    ],
    lookFor: "Settings apply to the signed-in operator or workspace. For agent endpoint credentials, use the Agents connection controls instead.",
    keywords: "settings profile workspace password session mfa administrator",
  },
];

const workflows = [
  {
    number: "01",
    title: "Assess and harden an agent",
    description: "A repeatable path from a new connection to verified protection.",
    steps: ["Connect a Staging endpoint", "Run Autopilot or a full scan", "Review findings and tighten policy or contract", "Approve Runtime Firewall", "Verify controls, then monitor traffic"],
    target: "Launchpad",
  },
  {
    number: "02",
    title: "Investigate a scan finding",
    description: "Use evidence to fix the behavior and confirm the result.",
    steps: ["Open the scan evidence", "Inspect the scenario and proposed tool call", "Apply the recommended fix in your agent or executor", "Run a targeted retest", "Keep unresolved or inconclusive results visible"],
    target: "Scans",
  },
  {
    number: "03",
    title: "Respond to unexpected drift",
    description: "Find what changed, decide whether it was intended, and contain risk.",
    steps: ["Open the Sentinel change evidence", "Compare the change with the approved release", "Quarantine the agent if critical risk needs containment", "Correct or approve the change", "Re-check and update the baseline only when approved"],
    target: "Sentinel",
  },
];

const glossary = [
  ["Finding", "Evidence that an unsafe behavior or policy failure was observed."],
  ["Inconclusive", "The run could not prove that execution was safe or unsafe. Investigate the evidence and repeat under controlled conditions."],
  ["Blocked", "A proposed action was stopped by a policy or enforcement boundary before reaching its executor."],
  ["Passed", "The observed result matched the expected control for that scenario. Read it with the scenario coverage and any inconclusive results."],
  ["Simulated", "A result produced by the isolated demo or simulator, rather than a live customer endpoint assessment."],
  ["Coverage", "How many of the relevant scenarios were evaluated. Partial coverage leaves behaviors untested."],
  ["Control score", "A summary of recorded control evidence. Use coverage and the individual scenario results to understand its limits."],
  ["Blueprint", "Autopilot's reviewable summary of the agent, assessment evidence, risks, and recommended protection."],
  ["Contract", "A versioned, agent-specific tool and action boundary that can narrow workspace policy."],
  ["Baseline / drift", "The approved security fingerprint / a difference between the current fingerprint and that approved state."],
  ["Runtime Firewall", "The enforcement gateway that checks a proposed tool call before it can be executed."],
];

export function GuidePage({ onNavigate, onQuickStart, quickStartBusy }: {
  onNavigate: (page: string) => void;
  onQuickStart: () => void;
  quickStartBusy: boolean;
}) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<(typeof groups)[number]>("All sections");
  const normalizedQuery = query.trim().toLowerCase();
  const visibleTopics = useMemo(() => topics.filter((topic) => {
    const matchesGroup = group === "All sections" || topic.group === group;
    const searchable = `${topic.title} ${topic.summary} ${topic.useFor} ${topic.steps.join(" ")} ${topic.lookFor} ${topic.keywords}`.toLowerCase();
    return matchesGroup && (!normalizedQuery || searchable.includes(normalizedQuery));
  }), [group, normalizedQuery]);

  return (
    <section className="workspace-view guide-page">
      <div className="workspace-view__heading guide-page__heading">
        <div>
          <span className="eyebrow eyebrow--cyan">AGENTGUARD FIELD GUIDE</span>
          <h2>Understand every section. Know what to do next.</h2>
          <p>Learn the workspace from first connection through assessment, enforcement, and ongoing response. Each section explains what it does, how to use it, and what its evidence means.</p>
        </div>
        <div className="guide-page__actions">
          <button type="button" className="button button--subtle" onClick={() => onNavigate("Launchpad")}>
            <Icon name="activity" size={15} /> Open Launchpad
          </button>
          <button type="button" className="button button--primary" onClick={onQuickStart} disabled={quickStartBusy}>
            <Icon name="shield" size={15} /> {quickStartBusy ? "Preparing demo…" : "Try safe demo"}
            {!quickStartBusy ? <Icon name="arrow" size={14} /> : null}
          </button>
        </div>
      </div>

      <section className="guide-start panel" aria-labelledby="guide-start-title">
        <div className="guide-start__intro">
          <span className="eyebrow eyebrow--cyan">START HERE</span>
          <h3 id="guide-start-title">A safe path from first demo to protected runtime</h3>
          <p>The demo is synthetic and isolated. When you connect a real agent, begin with a Staging endpoint and review the evidence before enabling production traffic.</p>
        </div>
        <ol className="guide-start__steps">
          <li><b>01</b><span><strong>Explore safely</strong><small>Run the demo or connect a Staging agent.</small></span></li>
          <li><b>02</b><span><strong>Assess behavior</strong><small>Use Autopilot or run a scan against the selected agent.</small></span></li>
          <li><b>03</b><span><strong>Review evidence</strong><small>Understand findings, coverage, and inconclusive results.</small></span></li>
          <li><b>04</b><span><strong>Approve protection</strong><small>Review policy and tools before applying the Runtime Firewall.</small></span></li>
          <li><b>05</b><span><strong>Verify and monitor</strong><small>Prove the configured controls and watch live events.</small></span></li>
        </ol>
      </section>

      <section className="guide-workflows" aria-labelledby="guide-workflows-title">
        <div className="guide-section-heading">
          <div><span className="eyebrow eyebrow--cyan">COMMON WORKFLOWS</span><h3 id="guide-workflows-title">Choose the job you need to do</h3></div>
          <span>Step-by-step paths</span>
        </div>
        <div className="guide-workflow-grid">
          {workflows.map((workflow) => (
            <article className="guide-workflow panel" key={workflow.number}>
              <div className="guide-workflow__top"><span>{workflow.number}</span><Icon name="arrow" size={15} /></div>
              <h4>{workflow.title}</h4>
              <p>{workflow.description}</p>
              <ol>{workflow.steps.map((step) => <li key={step}>{step}</li>)}</ol>
              <button type="button" className="text-button" onClick={() => onNavigate(workflow.target)}>Open {workflow.target} <Icon name="arrow" size={13} /></button>
            </article>
          ))}
        </div>
      </section>

      <section className="guide-topics" aria-labelledby="guide-topics-title">
        <div className="guide-section-heading">
          <div><span className="eyebrow eyebrow--cyan">PRODUCT REFERENCE</span><h3 id="guide-topics-title">Every workspace section</h3><p>Search the guide or filter by the kind of work you are doing.</p></div>
          <span>{visibleTopics.length} of {topics.length} sections</span>
        </div>
        <div className="guide-controls">
          <label className="guide-search"><Icon name="search" size={16} /><input aria-label="Search the product guide" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search features, terms, or tasks…" /></label>
          <div className="guide-filters" role="group" aria-label="Filter guide sections">
            {groups.map((item) => <button type="button" key={item} className={group === item ? "is-active" : ""} onClick={() => setGroup(item)}>{item}</button>)}
          </div>
        </div>
        {visibleTopics.length ? (
          <div className="guide-topic-grid">
            {visibleTopics.map((topic) => (
              <article className="guide-topic panel" key={topic.id} id={`guide-${topic.id.toLowerCase()}`}>
                <div className="guide-topic__heading">
                  <span className="guide-topic__icon"><Icon name={topic.icon} size={17} /></span>
                  <div><span className="eyebrow">{topic.group}</span><h4>{topic.title}</h4></div>
                </div>
                <p className="guide-topic__summary">{topic.summary}</p>
                <details>
                  <summary>How to use this section <Icon name="chevron" size={14} /></summary>
                  <div className="guide-topic__details">
                    <div><strong>Use it for</strong><p>{topic.useFor}</p></div>
                    <div><strong>Recommended steps</strong><ol>{topic.steps.map((step) => <li key={step}>{step}</li>)}</ol></div>
                    <div className="guide-topic__note"><Icon name="activity" size={14} /><p>{topic.lookFor}</p></div>
                  </div>
                </details>
                <button type="button" className="guide-topic__open" onClick={() => onNavigate(topic.id)}>
                  Open {topic.title} section <Icon name="arrow" size={14} />
                </button>
              </article>
            ))}
          </div>
        ) : (
          <div className="guide-empty panel"><Icon name="search" size={20} /><strong>No matching guide sections</strong><span>Try a feature name such as scans, policy, tools, or drift.</span><button type="button" className="text-button" onClick={() => { setQuery(""); setGroup("All sections"); }}>Clear search</button></div>
        )}
      </section>

      <section className="guide-glossary panel" aria-labelledby="guide-glossary-title">
        <div className="guide-section-heading"><div><span className="eyebrow eyebrow--cyan">PLAIN-LANGUAGE GLOSSARY</span><h3 id="guide-glossary-title">Terms you will see in the product</h3></div><Icon name="library" size={19} /></div>
        <dl>{glossary.map(([term, definition]) => <div key={term}><dt>{term}</dt><dd>{definition}</dd></div>)}</dl>
      </section>

      <div className="guide-help-note"><Icon name="lock" size={15} /><span>For a real launch, assess a Staging endpoint, review the exact evidence, verify your own executor in isolation, then route production traffic through the Runtime Firewall.</span><button type="button" className="text-button" onClick={() => onNavigate("Launchpad")}>Continue in Launchpad <Icon name="arrow" size={13} /></button></div>
    </section>
  );
}
