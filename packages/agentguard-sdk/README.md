# `@agentguard/sdk`

The SDK is the customer-side execution boundary for AgentGuard Runtime Firewall.
It invokes the gateway, verifies the signed approval, consumes the one-time approval, and only then calls the local Tool executor.

```ts
import { createAgentGuardClient } from "@agentguard/sdk";

const guard = createAgentGuardClient({
  baseUrl: process.env.AGENTGUARD_URL!,
  agentId: process.env.AGENTGUARD_AGENT_ID!,
  token: process.env.AGENTGUARD_TOKEN!,
});

await guard.execute({
  input: customerMessage,
  executionContext: {
    actorId: customer.id,
    tenantId: merchant.id,
    orderId: order.id,
    issuedAt: new Date().toISOString(),
  },
  tools: {
    issue_refund: (args, authorization) => refundService.issue(args, authorization),
  },
});
```

Never execute the model's raw `tool_calls`. If AgentGuard is unavailable, the approval expires, the signature is invalid, or one argument changes, `execute()` throws before any Tool function is called.
