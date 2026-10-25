import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

const baseUrl = process.env.AGENTGUARD_AUTH_API_URL ?? "http://127.0.0.1:4100";

function decodeBase32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let current = 0;
  const bytes = [];
  for (const character of value) {
    const index = alphabet.indexOf(character);
    current = (current << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((current >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function currentTotp(secret) {
  const counter = Math.floor(Date.now() / 1000 / 30);
  const digest = createHmac("sha1", decodeBase32(secret))
    .update(Buffer.from(counter.toString(16).padStart(16, "0"), "hex"))
    .digest();
  const offset = digest[digest.length - 1] & 15;
  const value = ((digest[offset] & 127) << 24) |
    ((digest[offset + 1] & 255) << 16) |
    ((digest[offset + 2] & 255) << 8) |
    (digest[offset + 3] & 255);
  return String(value % 1000000).padStart(6, "0");
}

function accessCookie(response) {
  const cookies = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  return cookies.find((value) => value.startsWith("agentguard_session="))?.split(";", 1)[0] ?? "";
}

test("password reset, admin MFA, and workspace deletion are enforced end to end", async (t) => {
  const email = `hardening-${Date.now()}@agentguard.local`;
  const password = "first-password-2026";
  const nextPassword = "second-password-2026";
  let cookie = "";
  let workspaceName = "Hardening Workspace";
  let deleted = false;
  const request = async (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set("Cookie", cookie);
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
    return { response, body: await response.json().catch(() => ({})) };
  };
  const cleanup = async () => {
    if (deleted || !cookie) return;
    await request("/api/settings/workspace/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: workspaceName, password: nextPassword }),
    }).catch(() => {});
  };
  t.after(cleanup);

  const registered = await request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name: "Hardening Owner", workspaceName }),
  });
  assert.equal(registered.response.status, 201);
  cookie = accessCookie(registered.response);
  workspaceName = registered.body.user.workspaceName;
  assert.ok(cookie);

  const forgot = await request("/api/auth/forgot-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  assert.equal(forgot.response.status, 202);
  assert.match(forgot.body.developmentToken, /^ag_reset_/);

  const reset = await request("/api/auth/reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: forgot.body.developmentToken, password: nextPassword }),
  });
  assert.equal(reset.response.status, 200);

  const loginAfterReset = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: nextPassword }),
  });
  assert.equal(loginAfterReset.response.status, 200);
  cookie = accessCookie(loginAfterReset.response);

  const setup = await request("/api/settings/mfa/setup", { method: "POST" });
  assert.equal(setup.response.status, 200);
  assert.match(setup.body.secret, /^[A-Z2-7]{32}$/);
  const confirm = await request("/api/settings/mfa/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: currentTotp(setup.body.secret) }),
  });
  assert.equal(confirm.response.status, 200);
  assert.equal(confirm.body.enabled, true);

  await request("/api/auth/logout", { method: "POST" });
  cookie = "";
  const mfaLogin = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: nextPassword }),
  });
  assert.equal(mfaLogin.response.status, 200);
  assert.equal(mfaLogin.body.mfaRequired, true);
  const verified = await request("/api/auth/mfa/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challenge: mfaLogin.body.challenge, code: currentTotp(setup.body.secret) }),
  });
  assert.equal(verified.response.status, 200);
  cookie = accessCookie(verified.response);

  const deletion = await request("/api/settings/workspace/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmation: workspaceName, password: nextPassword }),
  });
  assert.equal(deletion.response.status, 204);
  deleted = true;
});
