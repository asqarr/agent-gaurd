import dotenv from "dotenv";
import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { closeDatabase, query } from "../src/core/db.mjs";
import { config } from "../src/core/config.mjs";
import * as repository from "../src/infrastructure/repository.mjs";

dotenv.config({
  path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env"),
});

const baseUrl = process.env.AGENTGUARD_API_URL ?? "http://127.0.0.1:4100";
const accessCookieName = config.authCookie;
const refreshCookieName = `${accessCookieName}_refresh`;

function setCookies(response) {
  return response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
}

function cookieValue(cookies, name) {
  return cookies.find((value) => value.startsWith(`${name}=`))?.split(";", 1)[0] ?? "";
}

function sessionCookie(cookies) {
  return [cookieValue(cookies, accessCookieName), cookieValue(cookies, refreshCookieName)]
    .filter(Boolean)
    .join("; ");
}

async function jsonRequest(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  return { response, body: await response.json().catch(() => ({})) };
}

test("signup, Pro activation, expired access refresh, and new login preserve the paid plan", async (t) => {
  const email = `auth-lifecycle-${randomUUID()}@agentguard.local`;
  const password = `Lifecycle-${randomUUID()}-2026!`;
  const workspaceName = `Auth lifecycle ${randomUUID().slice(0, 8)}`;
  let workspaceId;
  let currentCookie = "";

  t.after(async () => {
    if (workspaceId && currentCookie) {
      await jsonRequest("/api/settings/workspace/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: currentCookie },
        body: JSON.stringify({ confirmation: workspaceName, password }),
      }).catch(() => {});
    }
    await closeDatabase();
  });

  let registered = await jsonRequest("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name: "Lifecycle Owner", workspaceName }),
  });
  let user = registered.body.user;
  let cookies = setCookies(registered.response);

  if (registered.response.status === 202 && registered.body.verificationRequired) {
    assert.ok(registered.body.developmentToken, "local integration needs the delivered verification token");
    const verified = await jsonRequest("/api/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: registered.body.developmentToken }),
    });
    assert.equal(verified.response.status, 200);
    const login = await jsonRequest("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(login.response.status, 200, login.body.error);
    user = login.body.user;
    cookies = setCookies(login.response);
  } else {
    assert.equal(registered.response.status, 201, registered.body.error);
  }

  assert.ok(user?.workspaceId);
  workspaceId = user.workspaceId;
  currentCookie = sessionCookie(cookies);
  const accessPair = cookieValue(cookies, accessCookieName);
  const refreshPair = cookieValue(cookies, refreshCookieName);
  assert.ok(accessPair, "signup or login should issue an access cookie");
  assert.ok(refreshPair, "signup or login should issue a persistent refresh cookie");
  assert.match(cookies.find((value) => value.startsWith(`${refreshCookieName}=`)) ?? "", /Max-Age=2592000/);

  const initialBilling = await jsonRequest("/api/billing", { headers: { Cookie: currentCookie } });
  assert.equal(initialBilling.response.status, 200);
  assert.equal(initialBilling.body.plan.id, "free");

  const checkout = await jsonRequest("/api/billing/checkout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `auth-lifecycle-${randomUUID()}`,
      Cookie: currentCookie,
    },
    body: JSON.stringify({ planId: "team" }),
  });
  assert.equal(checkout.response.status, 201, checkout.body.error);
  const checkoutRecord = await repository.getCheckoutSession({
    workspaceId,
    checkoutSessionId: checkout.body.order_id,
  });
  assert.ok(checkoutRecord);

  // Simulate the verified payment callback after the checkout API created the order.
  await repository.applyVerifiedCryptoPayment({
    provider: "crypto",
    providerPaymentId: `auth-lifecycle-payment-${randomUUID()}`,
    checkoutSessionId: checkoutRecord.id,
    status: "confirmed",
    amount: checkoutRecord.quoteAmount,
    currency: "USDT",
    network: "TRON",
    walletAddress: checkoutRecord.payAddress,
    txHash: randomUUID().replaceAll("-", "").padEnd(64, "a"),
    confirmations: 6,
  });

  const activated = await jsonRequest("/api/billing", { headers: { Cookie: currentCookie } });
  assert.equal(activated.response.status, 200);
  assert.equal(activated.body.plan.id, "team");
  assert.equal(activated.body.plan.name, "Pro");
  assert.equal(activated.body.subscription.status, "active");

  const accessClaims = jwt.decode(accessPair.split("=", 2)[1]);
  assert.ok(accessClaims?.userId);
  const { iat: _issuedAt, exp: _expiresAt, ...claims } = accessClaims;
  const expiredAccess = jwt.sign(claims, config.jwtSecret, { expiresIn: -1 });
  const expiredCookie = `${accessCookieName}=${expiredAccess}; ${refreshPair}`;
  const simultaneousRefreshes = await Promise.all(
    Array.from({ length: 8 }, () => jsonRequest("/api/billing", { headers: { Cookie: expiredCookie } })),
  );
  assert.deepEqual(simultaneousRefreshes.map(({ response }) => response.status), Array(8).fill(200));
  const rotatedCookies = setCookies(simultaneousRefreshes[0].response);
  currentCookie = sessionCookie(rotatedCookies);
  assert.ok(cookieValue(rotatedCookies, accessCookieName));
  assert.ok(cookieValue(rotatedCookies, refreshCookieName));
  const rotatedClaims = jwt.decode(cookieValue(rotatedCookies, accessCookieName).split("=", 2)[1]);
  assert.equal(rotatedClaims.exp - rotatedClaims.iat, 7 * 24 * 60 * 60);
  assert.equal(simultaneousRefreshes[0].body.plan.id, "team");

  const reusedRefresh = await jsonRequest("/api/auth/me", { headers: { Cookie: refreshPair } });
  assert.equal(reusedRefresh.response.status, 200, "a concurrent request on another API replica must recover the same rotation");
  assert.equal(
    cookieValue(setCookies(reusedRefresh.response), refreshCookieName),
    cookieValue(rotatedCookies, refreshCookieName),
  );
  const oldRefreshToken = refreshPair.split("=", 2)[1];
  const oldRefreshHash = createHash("sha256").update(oldRefreshToken).digest("hex");
  await query(
    `UPDATE auth_refresh_sessions SET rotation_grace_until=NOW() - INTERVAL '1 second'
     WHERE token_hash=$1`,
    [oldRefreshHash],
  );
  const expiredRotationReplay = await jsonRequest("/api/auth/me", { headers: { Cookie: refreshPair } });
  assert.equal(expiredRotationReplay.response.status, 401, "the previous token must stop working after the brief retry grace");

  const logout = await jsonRequest("/api/auth/logout", {
    method: "POST",
    headers: { Cookie: currentCookie },
  });
  assert.equal(logout.response.status, 204);
  const revokedRefresh = cookieValue(rotatedCookies, refreshCookieName);
  const afterLogout = await jsonRequest("/api/auth/me", { headers: { Cookie: revokedRefresh } });
  assert.equal(afterLogout.response.status, 401);

  const freshLogin = await jsonRequest("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(freshLogin.response.status, 200, freshLogin.body.error);
  currentCookie = sessionCookie(setCookies(freshLogin.response));
  const afterRelogin = await jsonRequest("/api/billing", { headers: { Cookie: currentCookie } });
  assert.equal(afterRelogin.response.status, 200);
  assert.equal(afterRelogin.body.plan.id, "team");
  assert.equal(afterRelogin.body.plan.name, "Pro");
  assert.equal(afterRelogin.body.subscription.status, "active");
});
