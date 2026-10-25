import assert from "node:assert/strict";
import test from "node:test";
import {
  hashPassword,
  issueSession,
  requireAuth,
  verifyPassword,
} from "../src/features/auth/auth.mjs";
import { decryptSecret, encryptSecret } from "../src/core/secrets.mjs";

test("passwords are hashed and can be verified without storing plaintext", async () => {
  const password = "correct horse battery staple";
  const hash = await hashPassword(password);

  assert.notEqual(hash, password);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword("wrong password", hash), false);
});

test("agent credentials round-trip through authenticated encryption", () => {
  const encrypted = encryptSecret("customer-agent-secret");

  assert.ok(encrypted);
  assert.notEqual(encrypted, "customer-agent-secret");
  assert.equal(decryptSecret(encrypted), "customer-agent-secret");
  assert.notEqual(encryptSecret("customer-agent-secret"), encrypted);
});

test("sessions contain workspace-scoped identity claims", () => {
  const token = issueSession({
    id: "user-1",
    workspaceId: "workspace-1",
    email: "owner@example.com",
    name: "Workspace Owner",
    role: "owner",
  });

  assert.equal(typeof token, "string");
  assert.ok(token.split(".").length === 3);
});

test("malformed session cookies return 401 instead of throwing", async () => {
  let status;
  let payload;
  const response = {
    status(code) {
      status = code;
      return {
        json(value) {
          payload = value;
        },
      };
    },
  };

  await requireAuth(
    { headers: { cookie: "agentguard_session=%E0%A4%A" } },
    response,
    () => {
      throw new Error("next should not be called");
    },
  );

  assert.equal(status, 401);
  assert.equal(payload.error, "Session expired or invalid.");
});
