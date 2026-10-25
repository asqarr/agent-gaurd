import { useEffect, useState, type FormEvent } from "react";
import {
  changePassword,
  confirmMfa,
  deleteWorkspace,
  disableMfa,
  getSettings,
  startMfaSetup,
  updateProfile,
  updateWorkspace,
} from "./settings.api";
import type { SessionUser, WorkspaceSettings } from "../../shared/types/api";
import { Icon } from "../../shared/ui/Icon";

function formatDate(value: string | null | undefined) {
  if (!value) return "Not available";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return "Not available";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function roleLabel(role: string) {
  return role.slice(0, 1).toUpperCase() + role.slice(1);
}

function SettingsMessage({
  message,
  tone = "success",
}: {
  message: string;
  tone?: "success" | "error";
}) {
  if (!message) return null;
  return (
    <div
      className={`settings-feedback settings-feedback--${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <i />
      <span>{message}</span>
    </div>
  );
}

export function SettingsPage({
  authUser,
  onUserUpdated,
  onLogout,
}: {
  authUser: SessionUser;
  onUserUpdated: (user: SessionUser) => void;
  onLogout: () => void;
}) {
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [profileName, setProfileName] = useState(authUser.name);
  const [workspaceName, setWorkspaceName] = useState(authUser.workspaceName);
  const [profileBusy, setProfileBusy] = useState(false);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [profileMessage, setProfileMessage] = useState("");
  const [workspaceMessage, setWorkspaceMessage] = useState("");
  const [passwordMessage, setPasswordMessage] = useState("");
  const [profileError, setProfileError] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [mfaSecret, setMfaSecret] = useState("");
  const [mfaUri, setMfaUri] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [mfaCurrentPassword, setMfaCurrentPassword] = useState("");
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaMessage, setMfaMessage] = useState("");
  const [mfaError, setMfaError] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  async function load() {
    setLoading(true);
    setLoadError("");
    try {
      const next = await getSettings();
      setSettings(next);
      setProfileName(next.user.name);
      setWorkspaceName(next.workspace.name);
    } catch (caught) {
      setLoadError(
        caught instanceof Error
          ? caught.message
          : "Settings could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function submitProfile(event: FormEvent) {
    event.preventDefault();
    setProfileBusy(true);
    setProfileMessage("");
    setProfileError("");
    try {
      const user = await updateProfile(profileName);
      onUserUpdated(user);
      setSettings((current) => (current ? { ...current, user } : current));
      setProfileName(user.name);
      setProfileMessage("Your profile is up to date.");
    } catch (caught) {
      setProfileError(
        caught instanceof Error
          ? caught.message
          : "Profile could not be saved.",
      );
    } finally {
      setProfileBusy(false);
    }
  }

  async function submitWorkspace(event: FormEvent) {
    event.preventDefault();
    setWorkspaceBusy(true);
    setWorkspaceMessage("");
    setWorkspaceError("");
    try {
      const user = await updateWorkspace(workspaceName);
      onUserUpdated(user);
      setSettings((current) =>
        current
          ? {
              ...current,
              user,
              workspace: { ...current.workspace, name: user.workspaceName },
            }
          : current,
      );
      setWorkspaceName(user.workspaceName);
      setWorkspaceMessage("Workspace identity updated.");
    } catch (caught) {
      setWorkspaceError(
        caught instanceof Error
          ? caught.message
          : "Workspace could not be saved.",
      );
    } finally {
      setWorkspaceBusy(false);
    }
  }

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    setPasswordMessage("");
    setPasswordError("");
    if (newPassword !== confirmPassword) {
      setPasswordError("New password and confirmation do not match.");
      return;
    }
    setPasswordBusy(true);
    try {
      const user = await changePassword(currentPassword, newPassword);
      onUserUpdated(user);
      setSettings((current) =>
        current
          ? {
              ...current,
              user,
              security: {
                ...current.security,
                passwordChangedAt: new Date().toISOString(),
              },
            }
          : current,
      );
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordMessage(
        "Password changed. Other active sessions have been invalidated.",
      );
    } catch (caught) {
      setPasswordError(
        caught instanceof Error
          ? caught.message
          : "Password could not be changed.",
      );
    } finally {
      setPasswordBusy(false);
    }
  }

  async function beginMfa() {
    setMfaBusy(true);
    setMfaError("");
    setMfaMessage("");
    try {
      const setup = await startMfaSetup();
      setMfaSecret(setup.secret);
      setMfaUri(setup.otpAuthUri);
      setMfaMessage("Add the secret to your authenticator app, then enter the six-digit code below.");
    } catch (caught) {
      setMfaError(caught instanceof Error ? caught.message : "MFA setup could not start.");
    } finally {
      setMfaBusy(false);
    }
  }

  async function submitMfa(event: FormEvent) {
    event.preventDefault();
    setMfaBusy(true);
    setMfaError("");
    try {
      const result = await confirmMfa(mfaCode);
      setMfaMessage(result.message);
      setMfaSecret("");
      setMfaUri("");
      setMfaCode("");
      await load();
    } catch (caught) {
      setMfaError(caught instanceof Error ? caught.message : "MFA code could not be confirmed.");
    } finally {
      setMfaBusy(false);
    }
  }

  async function removeMfa(event: FormEvent) {
    event.preventDefault();
    setMfaBusy(true);
    setMfaError("");
    try {
      const result = await disableMfa(mfaCurrentPassword, mfaCode);
      setMfaMessage(result.message);
      setMfaCurrentPassword("");
      setMfaCode("");
      await load();
    } catch (caught) {
      setMfaError(caught instanceof Error ? caught.message : "MFA could not be disabled.");
    } finally {
      setMfaBusy(false);
    }
  }

  async function removeWorkspace(event: FormEvent) {
    event.preventDefault();
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await deleteWorkspace(deleteConfirmation, deletePassword);
      onLogout();
    } catch (caught) {
      setDeleteError(caught instanceof Error ? caught.message : "Workspace could not be deleted.");
    } finally {
      setDeleteBusy(false);
    }
  }

  if (loading) {
    return (
      <section className="workspace-view settings-page">
        <div className="settings-loading">
          <i />
          <span>Loading workspace settings…</span>
        </div>
      </section>
    );
  }

  if (loadError || !settings) {
    return (
      <section className="workspace-view settings-page">
        <div className="settings-error">
          <Icon name="activity" size={16} />
          <span>{loadError || "Settings are unavailable."}</span>
          <button className="button button--subtle" onClick={() => void load()}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  const canManageWorkspace = ["owner", "admin"].includes(settings.user.role);

  return (
    <section className="workspace-view settings-page">
      <div className="workspace-view__heading settings-page__heading">
        <div>
          <span className="eyebrow eyebrow--cyan">WORKSPACE SETTINGS</span>
          <h2>Make the control plane yours.</h2>
          <p>
            Manage your identity, workspace access, and session security from
            one calm, operational surface.
          </p>
        </div>
        <div className="settings-heading__status">
          <i />
          <div>
            <span>SECURITY STATE</span>
            <strong>Protected</strong>
          </div>
        </div>
      </div>

      <div className="settings-layout">
        <div className="settings-main">
          <form className="panel settings-card" onSubmit={submitProfile}>
            <div className="settings-card__heading">
              <div className="settings-card__icon">
                <Icon name="bot" size={18} />
              </div>
              <div>
                <span className="eyebrow">PROFILE</span>
                <h3>Your operator identity</h3>
                <p>This is the name your team sees in the workspace.</p>
              </div>
            </div>
            <div className="settings-form-grid">
              <label className="settings-field">
                <span>Display name</span>
                <input
                  value={profileName}
                  onChange={(event) => setProfileName(event.target.value)}
                  minLength={2}
                  maxLength={80}
                  required
                />
                <small>2–80 characters</small>
              </label>
              <label className="settings-field">
                <span>Email address</span>
                <input
                  value={settings.user.email}
                  readOnly
                  aria-describedby="settings-email-note"
                />
                <small id="settings-email-note">
                  Used for sign-in and workspace ownership.
                </small>
              </label>
            </div>
            <div className="settings-card__footer">
              <SettingsMessage message={profileError} tone="error" />
              <SettingsMessage message={profileMessage} />
              <button className="button button--primary" disabled={profileBusy}>
                {profileBusy ? "Saving…" : "Save profile"}
                <Icon name="arrow" size={15} />
              </button>
            </div>
          </form>

          <form className="panel settings-card" onSubmit={submitWorkspace}>
            <div className="settings-card__heading">
              <div className="settings-card__icon settings-card__icon--cyan">
                <Icon name="grid" size={18} />
              </div>
              <div>
                <span className="eyebrow">WORKSPACE</span>
                <h3>{settings.workspace.name}</h3>
                <p>
                  Use a clear workspace identity for your team and audit trail.
                </p>
              </div>
            </div>
            <div className="settings-form-grid">
              <label className="settings-field settings-field--wide">
                <span>Workspace name</span>
                <input
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  minLength={2}
                  maxLength={80}
                  disabled={!canManageWorkspace}
                  required
                />
                <small>
                  {canManageWorkspace
                    ? "Visible to every member of this workspace."
                    : "Only owners and admins can change workspace identity."}
                </small>
              </label>
            </div>
            <div className="settings-card__footer">
              <SettingsMessage message={workspaceError} tone="error" />
              <SettingsMessage message={workspaceMessage} />
              {canManageWorkspace ? (
                <button
                  className="button button--primary"
                  disabled={workspaceBusy}
                >
                  {workspaceBusy ? "Saving…" : "Save workspace"}
                  <Icon name="arrow" size={15} />
                </button>
              ) : null}
            </div>
          </form>

          <form className="panel settings-card" onSubmit={submitPassword}>
            <div className="settings-card__heading">
              <div className="settings-card__icon settings-card__icon--violet">
                <Icon name="lock" size={18} />
              </div>
              <div>
                <span className="eyebrow">AUTHENTICATION</span>
                <h3>Rotate your password</h3>
                <p>
                  A password change immediately invalidates older workspace
                  sessions.
                </p>
              </div>
            </div>
            <div className="settings-form-grid">
              <label className="settings-field">
                <span>Current password</span>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  autoComplete="current-password"
                  minLength={8}
                  required
                />
              </label>
              <label className="settings-field">
                <span>New password</span>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
                <small>At least 8 characters</small>
              </label>
              <label className="settings-field">
                <span>Confirm new password</span>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </label>
            </div>
            <div className="settings-card__footer">
              <SettingsMessage message={passwordError} tone="error" />
              <SettingsMessage message={passwordMessage} />
              <button
                className="button button--primary"
                disabled={passwordBusy}
              >
                {passwordBusy ? "Updating…" : "Change password"}
                <Icon name="arrow" size={15} />
              </button>
            </div>
          </form>
        </div>

        <aside className="settings-side">
          <div className="panel settings-card settings-card--security">
            <div className="settings-card__heading">
              <div className="settings-card__icon settings-card__icon--green">
                <Icon name="shield" size={18} />
              </div>
              <div>
                <span className="eyebrow">SECURITY POSTURE</span>
                <h3>Session security</h3>
              </div>
            </div>
            <div className="settings-facts">
              <div>
                <span>Session storage</span>
                <strong>HTTP-only cookie</strong>
              </div>
              <div>
                <span>Persistent session</span>
                <strong>{settings.security.sessionDurationDays} days</strong>
              </div>
              <div>
                <span>Access token rotation</span>
                <strong>
                  {settings.security.accessTokenDurationDays} days
                </strong>
              </div>
              <div>
                <span>Password changed</span>
                <strong>
                  {formatDate(settings.security.passwordChangedAt)}
                </strong>
              </div>
              <div>
                <span>Email verification</span>
                <strong>{settings.security.emailVerified ? "Verified" : "Pending"}</strong>
              </div>
              <div>
                <span>Administrator MFA</span>
                <strong>{settings.security.mfaEnabled ? "Enabled" : "Not enabled"}</strong>
              </div>
            </div>
            <div className="settings-security-note">
              <Icon name="lock" size={15} />
              <span>
                Browser JavaScript cannot read your session tokens. Access
                tokens rotate every 7 days, while the persistent session is
                rotated securely for up to 30 days. Password rotation revokes
                older tokens at the API boundary.
              </span>
            </div>
            {!settings.security.mfaEnabled ? (
              <div className="settings-security-alert" role="status">
                <Icon name="shield" size={15} />
                <span>Administrator MFA is not enabled. Turn on TOTP before inviting teammates or connecting production agents.</span>
              </div>
            ) : null}
          </div>

          <div className="panel settings-card settings-card--team">
            <div className="settings-card__heading">
              <div className="settings-card__icon settings-card__icon--orange">
                <Icon name="library" size={18} />
              </div>
              <div>
                <span className="eyebrow">TEAM ACCESS</span>
                <h3>
                  {settings.workspace.memberCount} member
                  {settings.workspace.memberCount === 1 ? "" : "s"}
                </h3>
                <p>
                  Roles are enforced by the API on every workspace mutation.
                </p>
              </div>
            </div>
            <div className="settings-member-list">
              {settings.members.map((member) => (
                <div className="settings-member" key={member.id}>
                  <div className="settings-member__avatar">
                    {member.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="settings-member__identity">
                    <strong>
                      {member.name}
                      {member.id === settings.user.id ? " · You" : ""}
                    </strong>
                    <span>{member.email}</span>
                  </div>
                  <span
                    className={`settings-role settings-role--${member.role}`}
                  >
                    {roleLabel(member.role)}
                  </span>
                </div>
              ))}
            </div>
            <div className="settings-team-footer">
              <span>
                {settings.workspace.agentCount} connected agent
                {settings.workspace.agentCount === 1 ? "" : "s"}
              </span>
              <span>Joined {formatDate(settings.workspace.createdAt)}</span>
            </div>
          </div>

          {canManageWorkspace ? (
            <div className="panel settings-card settings-card--security">
              <div className="settings-card__heading">
                <div className="settings-card__icon settings-card__icon--green"><Icon name="shield" size={18} /></div>
                <div><span className="eyebrow">ADMIN MFA</span><h3>{settings.security.mfaEnabled ? "Multi-factor protection is active" : "Protect administrator access"}</h3><p>Use a TOTP authenticator before an owner or admin session can enter the workspace.</p></div>
              </div>
              {!settings.security.mfaEnabled ? (
                <>
                  {!mfaSecret ? <button type="button" className="button button--primary" onClick={() => void beginMfa()} disabled={mfaBusy}>{mfaBusy ? "Preparing…" : "Set up authenticator"}<Icon name="arrow" size={15} /></button> : null}
                  {mfaSecret ? <form className="settings-mfa-setup" onSubmit={submitMfa}><label className="settings-field settings-field--wide"><span>Manual setup key</span><code>{mfaSecret}</code><small>Use the QR/URI importer if your authenticator supports it: {mfaUri}</small></label><label className="settings-field"><span>Six-digit code</span><input inputMode="numeric" pattern="[0-9]{6}" value={mfaCode} onChange={(event) => setMfaCode(event.target.value)} maxLength={6} required /></label><button className="button button--primary" disabled={mfaBusy}>{mfaBusy ? "Confirming…" : "Confirm MFA"}<Icon name="arrow" size={15} /></button></form> : null}
                </>
              ) : <form className="settings-mfa-setup" onSubmit={removeMfa}><label className="settings-field"><span>Current password</span><input type="password" value={mfaCurrentPassword} onChange={(event) => setMfaCurrentPassword(event.target.value)} required /></label><label className="settings-field"><span>Authenticator code</span><input inputMode="numeric" pattern="[0-9]{6}" value={mfaCode} onChange={(event) => setMfaCode(event.target.value)} maxLength={6} required /></label><button className="button button--subtle" disabled={mfaBusy}>Disable MFA</button></form>}
              <SettingsMessage message={mfaError} tone="error" />
              <SettingsMessage message={mfaMessage} />
            </div>
          ) : null}

          <div className="panel settings-card settings-card--danger">
            <div>
              <span className="eyebrow">SESSION CONTROL</span>
              <h3>Leave this device</h3>
              <p>
                Sign out from the current browser. Other sessions remain active
                until you rotate your password.
              </p>
            </div>
            <div className="settings-danger-actions"><button className="button button--subtle" onClick={onLogout}>
              <Icon name="unlock" size={15} /> Sign out
            </button>{canManageWorkspace ? <button type="button" className="button button--danger" onClick={() => { setDeleteOpen((value) => !value); setDeleteError(""); }}>Delete workspace</button> : null}</div>
            {deleteOpen && settings.user.role === "owner" ? <form className="settings-delete-form" onSubmit={removeWorkspace}><p>This permanently removes every agent, scan, incident, secret and billing record in this workspace.</p><label className="settings-field"><span>Type workspace name</span><input value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} placeholder={settings.workspace.name} required /></label><label className="settings-field"><span>Owner password</span><input type="password" value={deletePassword} onChange={(event) => setDeletePassword(event.target.value)} required /></label><SettingsMessage message={deleteError} tone="error" /><button className="button button--danger" disabled={deleteBusy}>{deleteBusy ? "Deleting…" : "Permanently delete workspace"}</button></form> : null}
          </div>
        </aside>
      </div>
    </section>
  );
}
