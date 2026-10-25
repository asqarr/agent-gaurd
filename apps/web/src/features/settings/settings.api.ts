import { request } from "../../shared/api/client";
import type { SessionUser, WorkspaceSettings } from "../../shared/types/api";

export async function getSettings(): Promise<WorkspaceSettings> {
  const response = await request("/api/settings");
  return response.json();
}

export async function updateProfile(name: string): Promise<SessionUser> {
  const response = await request("/api/settings/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return (await response.json()).user;
}

export async function updateWorkspace(name: string): Promise<SessionUser> {
  const response = await request("/api/settings/workspace", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return (await response.json()).user;
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<SessionUser> {
  const response = await request("/api/settings/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  return (await response.json()).user;
}

export async function startMfaSetup(): Promise<{ secret: string; otpAuthUri: string; message: string }> {
  return (await request("/api/settings/mfa/setup", { method: "POST" })).json();
}

export async function confirmMfa(code: string): Promise<{ enabled: boolean; message: string }> {
  return (await request("/api/settings/mfa/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  })).json();
}

export async function disableMfa(currentPassword: string, code: string): Promise<{ enabled: boolean; message: string }> {
  return (await request("/api/settings/mfa/disable", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword, code }),
  })).json();
}

export async function deleteWorkspace(confirmation: string, password: string): Promise<void> {
  await request("/api/settings/workspace/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmation, password }),
  });
}
