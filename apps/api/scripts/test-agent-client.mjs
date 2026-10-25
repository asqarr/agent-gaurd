import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["--test", "test/agent-client.integration.test.mjs"], {
  env: { ...process.env, ALLOW_PRIVATE_AGENT_ENDPOINTS: "true" },
  stdio: "inherit",
});
process.exitCode = result.status ?? 1;
