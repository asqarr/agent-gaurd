# AgentGuard

AgentGuard is a storefront-agent security control plane. It tests whether an AI shopping/support agent can be manipulated into unsafe actions such as unauthorized refunds, then records the evidence and policy decision.

## Current phase

This repository now contains the first production-shaped backend slice:

- `apps/api`: Express API with PostgreSQL migrations, workspace-scoped authentication, encrypted customer API keys, persistent agents/policies/scans, and a database-backed asynchronous scan worker.
- `apps/web`: React + TypeScript dashboard with login/register, live workspace data, scan polling, and a dark security-console UI with a CSS 3D security orb.
- The Scans view loads persisted evidence on demand: scenario status, observed behavior, policy decision, execution state, reasons, and proposed tool arguments.
- The Scenarios view is a live Scenario Library backed by `GET /api/scenarios`, showing 12 scan fixtures across policy boundaries, indirect prompt injection, privilege escalation, BOLA/IDOR, data exfiltration, tool chaining, and argument smuggling with search and category filters.
- Billing is entitlement-first and usage-metered: Explorer includes 20 Scan Credits once (not monthly), Builder is $49/month, Pro is $149/month, and Agency is $399/month. Paid plans expose explicit manual renewal only; upgrades apply after verified payment, while downgrades are scheduled for the next period.
- Billing add-ons are provider-backed and separately metered: extra Scan Credits, Runtime Decisions, Agent slots, a $249 Agent Security Audit, and separately billed implementation support. Quota warnings appear at 70%, 90%, and 100%; included capacity never silently becomes unlimited overage.
- Current Usage Extensions are: extra Agent Slot $12/month, 10K Runtime Decisions $5, 100K Runtime Decisions $29, 200 Scan Credits $9, 1,000 Scan Credits $29, Agent Security Audit from $249, and Implementation Support from $199. Credit/Runtime packs never expire and survive plan renewal; Agent slots last through the current paid period. Audit and Support require explicit scope, delivery, and acceptance acknowledgement before checkout.
- Completed scans include a real Threat Replay: a timed, interactive playback of each persisted scenario from input through agent proposal, policy decision, and final execution outcome.
- Scan findings can open an evidence-grounded AI Remediation Copilot. It streams a schema-validated explanation and fix plan, stores the completed plan with that scan, and links back to the existing targeted retest. The AI provider is opt-in and receives only minimized, server-generated evidence; raw prompts, observations, tool arguments, customer agent URLs, customer/scan identifiers, and agent/customer credentials are excluded from the evidence payload.
- Live scans persist and stream per-scenario progress, so the dashboard shows the active test, elapsed time, and each scenario's queued/running/passed/blocked/finding state while the worker runs.
- Agent management is live: workspace owners/admins can edit connections, rotate or clear encrypted API keys, select allowed tools, test connectivity without running a scan, and delete agents with confirmation.
- Security response is live: workspace owners/admins can quarantine an agent with a reason. Quarantine persists in PostgreSQL, blocks new scans at the API boundary, is re-checked by the worker before execution, and can only be cleared with an explicit Restore action.
- Runtime protection is live: owners/admins can provision a scoped gateway token for an agent. Customer traffic sent to the Runtime Firewall is forwarded to the agent, inspected against the workspace policy and tool scope, and returned fail-closed when an unsafe tool call is proposed. Every decision is persisted as a runtime event with an OpenTelemetry trace timeline, correlated to a caller trace when the SDK has an active W3C trace context.
- Agent Security Autopilot is live: one assessment checks the endpoint, inventories configured and observed tools, runs the complete adversarial suite, produces a server-generated Security Blueprint, and lets an owner/admin review and apply Runtime Firewall protection without changing business policy values.
- Public SEO is separated from the authenticated dashboard: the root is a crawlable marketing page, `/agent-security-testing.html` and `/prompt-injection-testing.html` are indexable content pages, and `/app.html` is explicitly `noindex`.
- The public `/attack-lab.html` is a synthetic-only interactive demo backed by the same deterministic refund Policy Engine and approval-binding checks as Runtime Firewall. Its public API accepts only fixed challenge IDs and bounded numeric values, is rate-limited, and has no customer endpoint or side-effect executor; demo evidence is explicitly not a customer-agent assessment.
- `apps/api/src/features/agents/agent-client.mjs`: calls a customer's HTTP agent endpoint for each test scenario. Endpoints receive `{ input, metadata }` and may return `tool_calls` in direct or OpenAI-compatible function-call shape.
- `apps/api/src/features/policies/policy-guard.mjs`: server-side refund policy. The agent can propose an action, but it cannot authorize or execute the side effect.

The old root-level demo scripts and generated reports were removed. The remaining seed simulator is development-only so the local workspace can be exercised before a customer endpoint is connected; production scans always require a real customer endpoint.

## Feature-based structure

The source tree is organized by product capability rather than by technical file type:

- `apps/web/src/features/`: frontend feature APIs and feature components for auth, agents, scans, policies, integrations, and dashboard data.
- `apps/web/src/shared/`: reusable HTTP client, domain types, and UI primitives.
- `apps/web/src/app/`: application composition and route-level orchestration.
- `apps/api/src/features/`: backend agent connectivity, authentication, scan execution, policy evaluation, and catalog contracts.
- `apps/api/src/core/`: configuration, database lifecycle, and secret primitives.
- `apps/api/src/infrastructure/`: PostgreSQL repositories and development bootstrap.

`apps/web/src/api.ts` remains a compatibility barrel for external imports; new frontend code should import from the owning feature or shared module directly.

## Run locally

Prerequisites: Node.js 22.15+ (Node.js 24 LTS is the deployment runtime), Docker Desktop, and Docker Compose.

Install dependencies and copy environment settings:

```bash
npm install
copy .env.example .env
```

Start PostgreSQL and the local Jaeger trace viewer:

```bash
docker compose up -d postgres jaeger
```

Local API traces are sent to `http://localhost:4318` without authentication. Open `http://127.0.0.1:16686` to inspect them in Jaeger. The local Jaeger all-in-one uses in-memory storage, so its trace history is cleared when the container restarts. Production keeps OTLP export disabled by default; set the production endpoint and provider-specific headers only when connecting an external collector.

The API automatically creates the migration table, applies the files in `apps/api/migrations/`, seeds a development workspace, and starts the scan worker.

Run the API and web app in two terminals:

```bash
npm run dev:api
npm run dev:web
```

Open `http://127.0.0.1:5173`; the public interactive lab is at `http://127.0.0.1:5173/attack-lab.html`.

Development login defaults are in `.env`:

- Email: `demo@agentguard.local`
- Password: `change-me-locally`

Change these values before sharing the environment. Production also requires strong `JWT_SECRET` and `AGENT_SECRET` values.

Agent endpoints are restricted to public HTTP(S) destinations by default to prevent SSRF. For a local mock endpoint during development only, set `ALLOW_PRIVATE_AGENT_ENDPOINTS=true`; this flag is ignored in production.

Scan jobs retry transient worker failures up to `SCAN_MAX_ATTEMPTS` times, use exponential backoff from `SCAN_RETRY_BASE_MS`, and recover abandoned jobs after `SCAN_JOB_LEASE_MS` unless the worker heartbeat renews them.

## API lifecycle

1. A signed-in user creates or selects an agent in their workspace.
2. `POST /api/scans` creates a durable `queued` scan and a `scan_jobs` row, then returns HTTP `202`.
3. The worker claims jobs with PostgreSQL row locking, marks them `running`, and sends each scenario to the configured customer endpoint.
4. Tool calls are evaluated against the server-side refund policy.
5. Results are persisted in `scan_results`; the scan becomes `completed` or `failed`.
6. The dashboard polls the scan and updates the workspace posture.

Autopilot uses the same durable scan worker instead of a second test engine:

1. `POST /api/autopilot/assessments` validates the agent connection and creates an assessment linked to a queued scan.
2. `GET /api/autopilot/assessments/:id` returns live phase state, scan progress, and (after completion) the server-generated Security Blueprint.
3. `POST /api/autopilot/assessments/:id/apply` requires an owner/admin confirmation and enables fail-closed Runtime Firewall protection. It does not silently edit business policy values; the gateway token is returned once for server-side secret storage.

Sentinel continuously fingerprints each enabled agent against an owner-approved baseline. It stores no raw endpoint URL or API key, records structured drift evidence, and can quarantine an agent automatically when critical drift is detected. The background check interval is controlled by `SENTINEL_WORKER_INTERVAL_MS` and defaults to 60 seconds.

Incident Center persists security events from Sentinel, scans, quarantine actions, and Runtime Firewall blocks. Workspace owners can add HTTPS alert routes from the Incident Center; each delivery is HMAC-SHA256 signed, encrypted at rest, retried with backoff, and limited to public destinations. Agent endpoints and alert routes reject a hostname if any DNS answer is non-public, and outbound connections use a validated, pinned DNS address. Production agent endpoints and all webhook destinations require HTTPS. Webhook redirects are deliberately not followed; configure the final public destination URL directly. Administrative changes are also written to the workspace-scoped audit log and are available to owner/admin users through `/api/audit`.

If an agent is quarantined, `POST /api/scans` returns `409` until an owner/admin restores it. The worker also rejects already-queued jobs for quarantined agents, so the control remains effective even if state changes after a scan is queued.

Useful checks:

```bash
npm run test:api
npm run build
npm run test:integration
npm run test:billing-business
```

For the local HTTP contract test, run it in a development shell with `ALLOW_PRIVATE_AGENT_ENDPOINTS=true npm --workspace apps/api run test:agent-client`; production keeps private endpoints disabled.

Run `npm run test:integration` while PostgreSQL and the API are running. It exercises the live authenticated API, scan queue/worker, database persistence, and endpoint SSRF protection.

## Production deployment

The production stack is portable Docker Compose: PostgreSQL stays private, the API runs the worker, Nginx serves the built web app and proxies `/api`, and Caddy terminates TLS with automatically renewed HTTPS certificates. A dedicated PostgreSQL backup container streams custom-format dumps through age encryption, validates the resulting encrypted archive exists, prunes expired local backups, and reports stale/missing backups as unhealthy.

```bash
cp .env.production.example .env.production
# Edit .env.production: set the real domain, email, backup recipient, and unique secrets. Portfolio mode may keep REQUIRE_EMAIL_VERIFICATION=false temporarily.
docker compose --env-file .env.production -f docker-compose.prod.yml config
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

The web proxy resolves API container addresses dynamically and balances requests across API replicas. After sizing PostgreSQL, scale the stateless API with `docker compose --env-file .env.production -f docker-compose.prod.yml up -d --scale api=3`. `DATABASE_POOL_MAX` is per API process: keep `replicas × DATABASE_POOL_MAX` below the database connection budget and reserve connections for backups, migrations, monitoring, and administration. The default is 20; reduce it when adding replicas or using a managed database with a smaller connection limit. Load-test the target host and database before increasing replicas further.

Repeat a finite authenticated read-path smoke test with `LOAD_TEST_URL`, `LOAD_TEST_EMAIL`, `LOAD_TEST_PASSWORD`, `LOAD_TEST_PATH=/api/overview`, `LOAD_TEST_REQUESTS=1000`, and `LOAD_TEST_CONCURRENCY=1000`, then run `npm run load:smoke`. The tool prints status counts and p50/p95/p99 latency without printing credentials or response bodies.

Set `DOMAIN`, `WEB_ORIGIN`, and `VITE_SITE_URL` to the same public host, and provide a monitored operations email in `ACME_EMAIL`. Point the domain's A/AAAA records at the VPS and allow inbound TCP 80/443 plus UDP 443; Caddy obtains and renews HTTPS certificates and redirects HTTP to HTTPS. Do not publish PostgreSQL or enable `ALLOW_PRIVATE_AGENT_ENDPOINTS` in production.

`TRUST_PROXY` accepts a non-negative integer hop count (the production Compose default is `2` for the configured proxy chain), or the legacy boolean values `true`/`false`. Set it to the number of trusted proxies actually in front of the API; invalid values stop API startup with a configuration error.

Install `age` on a trusted machine, generate a backup keypair outside the repository and VPS with `age-keygen -o /secure/offline/agentguard-backup-identity.txt`, and copy only the output of `age-keygen -y /secure/offline/agentguard-backup-identity.txt` into `BACKUP_AGE_RECIPIENT`. Keep the private identity file offline and separate from the VPS. Backups are age-encrypted and retained locally for the configured period, but a backup on the same VPS is not disaster recovery: configure off-site copies and complete a restore drill before accepting customer data. Once a backup exists, test recovery into an automatically named disposable database with `bash scripts/restore-drill.sh agentguard-YYYYMMDDTHHMMSSZ.dump.age /secure/offline/agentguard-backup-identity.txt`; the script removes the temporary database and key copy when it finishes.

Build the API with `docker-compose.prod.yml` and run the production preflight from the API container after PostgreSQL is available and migrations have been applied:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml exec api node scripts/launch-preflight.mjs --production
```

The preflight checks all SQL migrations, production-only secrets, HTTPS/domain consistency, email delivery configuration, and the direct TRON payment wallet/indexers. It should pass before public traffic is enabled. Keep the `.env.production` file private; it is excluded from Git and Docker build contexts.

The dashboard waits up to 10 minutes for a scan to reach a terminal state, which covers the configured agent timeout and worker retries. Queued, running, and failed scans remain visible with their actual status.

### AI Remediation Copilot

The Copilot is an optional assistant on vulnerable or inconclusive scan findings. It uses the Vercel AI SDK with an OpenAI-compatible model endpoint, streams a bounded structured plan into the finding, and persists the validated result for the scan's retention period. It does not call tools, edit policies, apply changes, or make ALLOW/BLOCK decisions. The deterministic policy and Runtime Firewall remain the enforcement boundary.

### Evidence-based policy fixes

On a completed scan, AgentGuard can offer a deterministic policy change for a safe, vulnerable refund scenario when AgentGuard's scan policy guard allowed the recorded call. The current workflow supports the refund amount and trusted-order age limits only. An owner or admin reviews the workspace-wide impact, approves the version-bound change, then AgentGuard runs that exact scenario again and links the saved verification scan to its source evidence. Policy revisions and the approval are audited. Stale policy or contract versions are rejected; ambiguous or unsafe evidence gets no suggestion. This workflow changes AgentGuard's workspace policy only—it does not modify customer source code or prove the customer deployed AgentGuard's SDK or Gateway.

Workspace owners and admins can add their own OpenAI-compatible API key and model in **Workspace Settings → AI Remediation Copilot**. The key is encrypted at rest, never returned by the API, and used only for Copilot generation. When a workspace key is absent, the service can fall back to platform `AI_API_KEY` and `AI_MODEL`; leave both unset to keep generation disabled. `AI_BASE_URL` defaults to `https://api.openai.com/v1` and can point to another HTTPS OpenAI-compatible endpoint that supports structured JSON output. Workspace users cannot set a custom URL, so their key is sent only to the endpoint configured by the service operator. `AI_COPILOT_RATE_LIMIT_MAX` caps requests per workspace during `AI_COPILOT_RATE_LIMIT_WINDOW_MS`; successful results are cached per scan and scenario, with prompt and schema versions recorded for safe refreshes. A saved plan can be explicitly regenerated with the currently configured provider. The model receives the scenario catalog facts, verdict and execution boundary, the policy version and numeric limits, and AgentGuard's deterministic remediation guidance. It never receives raw agent output, customer messages, tool argument values, scan/order/customer identifiers, customer agent URLs, or agent/customer credentials.

### Runtime execution traces

Every admitted Runtime invocation gets an OpenTelemetry trace with safe spans for quota reservation, the customer-agent request, policy evaluation, and one-time approval issuance. The W3C `traceparent` from an instrumented caller is propagated through the AgentGuard SDK and onward to the customer endpoint. Trace summaries are stored with each workspace-scoped Runtime event and appear as expandable timelines in the agent dashboard. Timelines intentionally omit prompts, tool arguments, endpoint URLs, and customer secrets; the customer application performs the final tool execution after it consumes an approval, so AgentGuard does not claim to observe that external side effect.

The dashboard timeline works without an external telemetry service. Local development exports safe runtime spans to the Jaeger service in `docker-compose.yml` through OTLP HTTP/protobuf; set `OTEL_EXPORTER_OTLP_ENDPOINT` and optional `OTEL_EXPORTER_OTLP_HEADERS` to use another OpenTelemetry Collector or compatible backend. `OTEL_SERVICE_NAME` defaults to `agentguard-api`. Only the API's safe runtime spans are exported.

Main endpoints: `/api/health`, `/api/auth/register`, `/api/auth/login`, `/api/auth/me`, `/api/overview`, `/api/billing`, `/api/billing/plans`, `/api/billing/usage-metrics`, `/api/billing/service-orders`, `/api/billing/checkout`, `/api/billing/checkout/:id`, `/api/billing/verify-payment`, `/api/agents`, `/api/tools`, `/api/scenarios`, `/api/scans`, `/api/policies`, `/api/audit`, and `/api/autopilot/assessments`. Agent management uses `PATCH /api/agents/:id`, `POST /api/agents/:id/test-connection`, `POST /api/agents/:id/quarantine`, `POST /api/agents/:id/restore`, and `DELETE /api/agents/:id`.

Billing is a direct P2P USDT-TRC20 settlement flow. `/api/billing/checkout` creates a server-priced order and returns the fixed public TronLink address, exact six-decimal atomic amount, contract address, and a 30-minute expiry. The browser never activates an entitlement. `/api/billing/verify-payment` reads confirmed TRC-20 transfer history from TronGrid with TronScan fallback, requires the exact raw amount to the configured wallet after invoice creation and before expiry, and applies the payment plus subscription change in one PostgreSQL transaction. Transaction hashes are unique and payment timestamps are checked again while the checkout row is locked, preventing replay and race-condition activation. The API never stores or needs a private key. Blockchain network fees are still paid by the sender; direct settlement removes a hosted payment provider, not TRON resource costs.

Evidence retention is enforced server-side. The retention worker permanently deletes completed or failed scan records older than the active plan's retention window (7/30/90/180 days); the dashboard only reflects the database policy and does not merely hide expired evidence. Every cleanup pass is recorded and followed by a per-Workspace PostgreSQL storage snapshot.

Operational cost metering records the Scan Credit units and Runtime Decisions actually processed, wall duration, Node CPU counters when the runtime exposes them, RSS samples, logical Workspace storage, and database relation sizes. Owner/Admin users can review `/api/billing/usage-metrics`, including normalized estimates for 1,000 Scan Credits and 10,000 Runtime Decisions. Configure `USAGE_CPU_USD_PER_HOUR`, `USAGE_STORAGE_USD_PER_GB_MONTH`, and `USAGE_SNAPSHOT_RETENTION_DAYS`; estimates are intentionally labeled as configured infrastructure estimates rather than provider invoices.

Audit and Implementation Support are not unlimited SaaS features. A verified service payment creates a separate Service Order with a frozen scope, delivery window, acceptance terms, included-hour timebox, overage policy, target Agent, and lifecycle status. Owner/Admin users can review these engagements at `/api/billing/service-orders`. Run `npm run test:billing-business` to verify one-time credits, add-ons, quota alerts, manual downgrade scheduling, real evidence deletion, cost metering, and service-order creation.

There is no outgoing payout worker: customer funds settle directly to the configured TronLink address. Keep the public address in `MY_TRONLINK_PUBLIC_ADDRESS`; never put a seed phrase or private key in the API, Docker, or repository.

Runtime Firewall management uses `POST /api/agents/:id/runtime/enable`, `POST /api/agents/:id/runtime/disable`, and `GET /api/agents/:id/runtime/events`. Customer backends call `POST /api/runtime/agents/:id/invoke` with the one-time Bearer token returned by enable. The gateway returns the agent text, safe `tool_calls`, a `guard` decision, and any suppressed `blocked_tool_calls`. For refund policies, a trusted backend may include `trustedContext.orders` with `{ "ORDER-ID": { "ageDays": 5 } }`; untrusted or missing orders remain blocked by default.

## Customer agent contract

Configure an agent with an HTTP or HTTPS endpoint. AgentGuard sends one request per scenario:

```json
{
  "input": "Please refund 40 dollars for order TEST-001.",
  "metadata": { "scenarioId": "valid_refund" }
}
```

The endpoint can return:

```json
{
  "text": "I can help with that.",
  "tool_calls": [
    {
      "name": "issue_refund",
      "arguments": { "order_id": "TEST-001", "amount": 40 }
    }
  ]
}
```

The current scan engine evaluates storefront refund actions with production-safe fail-closed behavior. Future product layers are richer tool schemas, policy-as-code, and CI/CD checks; verified crypto checkout and shareable audit reports are already implemented behind their server-side entitlements.

The production web container adds security headers and a strict same-origin content policy. The API disables caching for `/api` responses, validates HTTPS `WEB_ORIGIN` in production, rejects unexpected browser origins for state-changing requests, emits an `X-Request-Id` on every response, and keeps private agent endpoints disabled. Authentication, scan, Runtime, and webhook routes have configurable per-process rate limits. If the API is scaled horizontally, move rate limiting to the edge or a shared Redis-backed limiter.

## Runtime Tool Gateway and SDK

Runtime protection has two separate contracts:

1. The customer backend sends the turn through `POST /api/runtime/agents/:agentId/invoke` with the scoped runtime token and an `executionContext` containing `actorId`, `tenantId`, `orderId`, and a current `issuedAt` for sensitive actions.
2. The customer backend executes only `approved_tool_calls` returned by AgentGuard. The raw model response must never reach the Tool executor.

The gateway signs each approval against the exact Tool name, arguments, Workspace, Agent, Request, Contract version, execution context, expiry, and a one-time approval ID. The Node.js/TypeScript SDK in `packages/agentguard-sdk` verifies the signature, atomically consumes the approval, and only then invokes the local Tool function. Gateway failure, timeout, expiry, replay, signature mismatch, or argument changes fail closed.

Workspace owners/admins on plans with Runtime Firewall can run `POST /api/agents/:id/runtime/verification` from Setup Center. This persists the latest workspace-scoped proof and checks the active refund ceiling, argument binding, concurrent PostgreSQL one-time consumption, SDK replay rejection, gateway outage/timeout (including timeout during approval consumption), and a valid synthetic approval. No customer endpoint, external provider, or real executor is called. The HTML report is available at `GET /api/agents/:id/runtime/verification/report`; it is authenticated, no-index, and shows reproducible checks, expected/observed behavior, remediation guidance, and explicit scope limitations. The proof becomes stale when the Agent endpoint, tools, Runtime state, policy, or contract changes. It verifies AgentGuard's control plane and bundled SDK—not the customer's deployed SDK, application source, alternate direct-tool routes, or production executor. Validate those separately in an isolated customer-owned Staging harness.

```ts
const guard = createAgentGuardClient({
  baseUrl: process.env.AGENTGUARD_URL!,
  agentId: process.env.AGENTGUARD_AGENT_ID!,
  token: process.env.AGENTGUARD_TOKEN!,
});

await guard.execute({
  input,
  executionContext: { actorId, tenantId, orderId, issuedAt: new Date().toISOString() },
  tools: { issue_refund: (args, auth) => refundService.issue(args, auth) },
});
```

This is an integration boundary, not an invisible network MITM. A customer that executes raw Tool Calls directly can bypass any external policy service; the SDK/tool-executor contract and the included bypass tests are therefore required for a real pre-execution guarantee.

## Launch safety gates

- Production scans are rejected for agents marked `Production` when they point directly at a customer endpoint. Use Mock/Staging or Runtime Firewall.
- Scan evidence records whether execution was simulated, unknown at the endpoint boundary, or explicitly reported as unsafe.
- Shareable HTML reports are available from completed scans for plans with report export entitlement.
- Owner/Admin MFA uses encrypted TOTP secrets; workspace deletion and secret/token rotation paths are API-enforced. Set REQUIRE_EMAIL_VERIFICATION=true with AUTH_EMAIL_WEBHOOK_URL before treating email identity as a production security control.
- Runtime decisions are metered per billing period. Direct TRON verification is read-only and never signs or broadcasts a transaction.
- Production Compose runs the backup worker automatically; verify that timestamped dump files are being created, keep encrypted copies off the VPS, and complete a restore drill against a disposable database before launch. The PowerShell backup/restore scripts are for the local development Compose stack only.

## First-party growth funnel

AgentGuard records a small allowlist of first-party funnel events for the public landing page, Attack Lab, signup, first Agent setup, first successful connection, first completed scan, a real one-time SDK approval consumption, verified crypto payments, and manually-started agency pilots. Public browser events are rate-limited and accept only fixed event names and small allowlisted dimensions; client code cannot report signup, SDK adoption, payment, or pilot milestones. Payment conversions are recorded only after the confirmed TRON transfer has passed the on-chain and PostgreSQL checks. Duplicate blockchain transfers are rejected by the transaction-hash uniqueness guard.

The browser uses a random tab-scoped session ID (cleared when the tab session ends). The API stores only its SHA-256 hash, never the raw ID or IP. No email, name, prompt, Agent endpoint, credential, order ID, Tool Call arguments, or full referrer URL is accepted. UTM values and referrer hostname are the only attribution dimensions. Events are purged after 180 days, and events associated with a workspace are removed when that workspace is deleted. Analytics writes are best-effort and cannot block registration, scans, SDK execution, or billing.

After starting the API/database and applying migrations, view a local funnel report with `npm run growth:report -- --days 30` (maximum 180 days). When an agency explicitly begins a pilot, record that milestone using `npm run growth:mark-pilot -- <workspace-id>`. This command is an operator attestation, not an automatically inferred event. Counts are directional and first-party; public session events are not an abuse-resistant billing or security signal.

## Public SEO deployment

The web build generates `robots.txt`, `sitemap.xml`, and `.well-known/security.txt` from `VITE_SITE_URL`. Set `VITE_SITE_URL` to the exact canonical HTTPS origin before building the production image; the production Compose file requires it as a build argument. After DNS and HTTPS are live, verify the domain in Google Search Console and submit `/sitemap.xml`. Search ranking is not guaranteed by metadata alone, so keep the public guides accurate and build legitimate references over time.
