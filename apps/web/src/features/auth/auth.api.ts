import { request } from "../../shared/api/client";
import type { SessionUser } from "../../shared/types/api";

export type AuthResult = {
  user?: SessionUser;
  mfaRequired?: boolean;
  challenge?: string;
  verificationRequired?: boolean;
  message?: string;
  developmentToken?: string;
};

export async function getSession(): Promise<SessionUser> {
  return (await request("/api/auth/me")).json().then((body) => body.user);
}

export async function login(email: string, password: string): Promise<AuthResult> {
  return (
    await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    })
  ).json();
}

export async function register(
  name: string,
  email: string,
  password: string,
  workspaceName: string,
): Promise<AuthResult> {
  return (
    await request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password, workspaceName }),
    })
  ).json();
}

export async function verifyMfa(challenge: string, code: string): Promise<SessionUser> {
  return (await request("/api/auth/mfa/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challenge, code }),
  })).json().then((body) => body.user);
}

export async function requestPasswordReset(email: string): Promise<{ message: string; developmentToken?: string }> {
  return (await request("/api/auth/forgot-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  })).json();
}

export async function verifyEmail(token: string): Promise<{ verified: boolean; message: string }> {
  return (await request("/api/auth/verify-email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  })).json();
}

export async function resetPassword(token: string, password: string): Promise<{ reset: boolean; message: string }> {
  return (await request("/api/auth/reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, password }),
  })).json();
}

export async function logout() {
  await request("/api/auth/logout", { method: "POST" });
}
