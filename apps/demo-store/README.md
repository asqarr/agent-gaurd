# AgentGuard sample store

This is an isolated synthetic storefront showing where the SDK belongs: the customer-facing refund route calls AgentGuard, and the local refund executor accepts only an unexpired, signed, one-time execution receipt bound to the exact agent, tool, arguments, request, order, and merchant.

The store policy independently caps refunds at USD 50. Its only order, `DEMO-ORDER-100`, and every refund are synthetic; no payment processor or real customer data is used. The synthetic refund ledger is persisted in PostgreSQL under the isolated `agentguard_demo_store` schema, so a restart does not erase replay protection or demo evidence.

## Run it locally

1. Start PostgreSQL and the AgentGuard API. For local-only testing, the API must permit the sample service's loopback endpoint with `ALLOW_PRIVATE_AGENT_ENDPOINTS=true`.
2. In a second terminal, start the sample store without credentials. This starts its synthetic agent endpoint so AgentGuard can connect and run a safe Scan:

```powershell
npm --workspace apps/demo-store start
```

3. In AgentGuard, connect a Staging agent to `http://127.0.0.1:4200/agent/propose`, enable Runtime Firewall, and copy the runtime token once. Stop the sample process, then restart it with server-side credentials:

```powershell
$env:AGENTGUARD_URL = "http://127.0.0.1:4100"
$env:AGENTGUARD_AGENT_ID = "<agent-id>"
$env:AGENTGUARD_TOKEN = "<runtime-token>"
# Optional: use a dedicated database/role for the sample instead of DATABASE_URL.
# When omitted, the sample uses DATABASE_URL but only creates its own schema.
# $env:DEMO_STORE_DATABASE_URL = "<postgres-connection-string>"
npm --workspace apps/demo-store start
```

4. Submit a USD 100 refund to `http://127.0.0.1:4200/api/refunds`. The API should return `BLOCK` / `NOT_EXECUTED`; then try `/internal/tools/issue_refund` directly without a receipt and observe HTTP 403. A USD 40 request demonstrates the allowed path. The sample health route reports whether the Gateway credentials are configured.

The sample binds to `127.0.0.1` by default. Keep the internal executor private in any adapted deployment. If the API runs inside Docker while the sample runs on the host, use a host-reachable address (for example `host.docker.internal`) for the agent endpoint and configure the local network policy accordingly.

The sample consumes each approval ID with a PostgreSQL primary-key constraint and inserts the synthetic refund in the same transaction. Concurrent reuse can create at most one ledger entry, and a committed approval remains consumed after process restarts. For a real payment processor, a database transaction cannot atomically roll back an external network side effect: use the processor's idempotency key plus a transactional outbox/reconciliation flow. This reference sample is not a substitute for securing the customer's actual refund executor.

Run the live end-to-end test against PostgreSQL with this command. It creates a temporary workspace and isolated random schema, tests concurrent replay and replay after a store restart, then removes only those test-created records:

```powershell
npm run test:demo-store
```
