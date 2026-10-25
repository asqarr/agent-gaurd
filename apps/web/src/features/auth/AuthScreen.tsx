import { useEffect, useState, type FormEvent } from "react";
import { login, register, requestPasswordReset, resetPassword, verifyEmail, verifyMfa } from "./auth.api";
import { Icon } from "../../shared/ui/Icon";
import type { SessionUser } from "../../shared/types/api";
import { trackGrowthEvent } from "../analytics/growth";
import { isGrowthAnalyticsEnabled, setGrowthAnalyticsEnabled } from "../analytics/growth";

export function AuthScreen({
  onAuthenticated,
}: {
  onAuthenticated: (user: SessionUser) => void;
}) {
  const isDevelopment = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState(isDevelopment ? "demo@agentguard.local" : "");
  const [password, setPassword] = useState(isDevelopment ? "change-me-locally" : "");
  const [workspaceName, setWorkspaceName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [mfaChallenge, setMfaChallenge] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [forgot, setForgot] = useState(false);
  const [resetToken, setResetToken] = useState("");
  const [resetPasswordValue, setResetPasswordValue] = useState("");
  const [resetConfirm, setResetConfirm] = useState("");
  const [analyticsEnabled, setAnalyticsEnabled] = useState(isGrowthAnalyticsEnabled);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("verify");
    const reset = new URLSearchParams(window.location.search).get("reset");
    if (reset) setResetToken(reset);
    if (token) {
      verifyEmail(token)
        .then((result) => setMessage(result.message))
        .catch((caught) => setError(caught instanceof Error ? caught.message : "Email verification failed."));
    }
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = mode === "login"
        ? await login(email, password)
        : await register(name, email, password, workspaceName);
      if (result.mfaRequired && result.challenge) {
        setMfaChallenge(result.challenge);
      } else if (result.verificationRequired) {
        setMessage(`${result.message ?? "Verify your email before signing in."}${result.developmentToken ? ` Development token: ${result.developmentToken}` : ""}`);
      } else if (result.user) {
        onAuthenticated(result.user);
      } else {
        setError("Authentication response was incomplete.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Authentication failed.");
    } finally {
      setBusy(false);
    }
  }

  async function submitMfa(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onAuthenticated(await verifyMfa(mfaChallenge, mfaCode));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "MFA verification failed.");
    } finally {
      setBusy(false);
    }
  }

  async function submitForgot(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await requestPasswordReset(email);
      setMessage(`${result.message}${result.developmentToken ? ` Development token: ${result.developmentToken}` : ""}`);
      setForgot(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Reset request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function submitReset(event: FormEvent) {
    event.preventDefault();
    if (resetPasswordValue !== resetConfirm) {
      setError("New password and confirmation do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await resetPassword(resetToken, resetPasswordValue);
      setMessage(result.message);
      setResetToken("");
      setResetPasswordValue("");
      setResetConfirm("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Password reset failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-glow auth-glow--one" />
      <div className="auth-glow auth-glow--two" />
      <div className="auth-card">
        <div className="auth-brand">
          <div className="brand-mark"><span /><span /><span /></div>
          <span>AGENT<span className="brand-accent">GUARD</span></span>
        </div>
        <span className="eyebrow eyebrow--cyan">SECURITY CONTROL PLANE</span>
        <h1>{mfaChallenge ? "Confirm administrator access." : resetToken ? "Choose a new password." : forgot ? "Reset your password." : mode === "login" ? "Welcome back." : "Create your workspace."}</h1>
        <p>{mode === "login" ? "Sign in to inspect and protect your storefront agents." : "Start with a secure workspace for your AI operations."}</p>
        {mfaChallenge ? (
          <form onSubmit={submitMfa}>
            <label>Authenticator code<input inputMode="numeric" pattern="[0-9]{6}" value={mfaCode} onChange={(event) => setMfaCode(event.target.value)} placeholder="000000" maxLength={6} required /></label>
            {error ? <div className="auth-error">{error}</div> : null}
            <button className="button button--primary button--wide" disabled={busy}>{busy ? "Verifying…" : "Verify and enter"}<Icon name="arrow" size={15} /></button>
          </form>
        ) : resetToken ? (
          <form onSubmit={submitReset}>
            <label>New password<input type="password" value={resetPasswordValue} onChange={(event) => setResetPasswordValue(event.target.value)} minLength={12} autoComplete="new-password" required /></label>
            <label>Confirm password<input type="password" value={resetConfirm} onChange={(event) => setResetConfirm(event.target.value)} minLength={12} autoComplete="new-password" required /></label>
            {error ? <div className="auth-error">{error}</div> : null}
            {message ? <div className="auth-message">{message}</div> : null}
            <button className="button button--primary button--wide" disabled={busy}>{busy ? "Updating…" : "Set new password"}<Icon name="arrow" size={15} /></button>
          </form>
        ) : forgot ? (
          <form onSubmit={submitForgot}>
            <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" required /></label>
            {error ? <div className="auth-error">{error}</div> : null}
            {message ? <div className="auth-message">{message}</div> : null}
            <button className="button button--primary button--wide" disabled={busy}>{busy ? "Sending…" : "Send reset link"}<Icon name="arrow" size={15} /></button>
          </form>
        ) : <form onSubmit={submit}>
          {mode === "register" ? (
            <>
              <label>Full name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Arman K." required /></label>
              <label>Workspace name<input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} placeholder="Northstar Labs" required /></label>
            </>
          ) : null}
          <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" required /></label>
          <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} required /></label>
          {error ? <div className="auth-error">{error}</div> : null}
          {message ? <div className="auth-message">{message}</div> : null}
          <button className="button button--primary button--wide" disabled={busy}>
            {busy ? "Authenticating…" : mode === "login" ? "Enter workspace" : "Create workspace"}
            <Icon name="arrow" size={15} />
          </button>
        </form>}
        {!mfaChallenge && !forgot && !resetToken ? <>
          {mode === "login" ? <button className="auth-switch" onClick={() => { setForgot(true); setError(""); }}>Forgot your password?</button> : null}
          <button className="auth-switch" onClick={() => {
            if (mode === "login") trackGrowthEvent("auth.signup_started", { page: "app" });
            setMode(mode === "login" ? "register" : "login"); setError(""); setMessage("");
          }}>
            {mode === "login" ? "Need a new workspace? Create one" : "Already have an account? Sign in"}
          </button>
        </> : null}
        {forgot || resetToken ? <button className="auth-switch" onClick={() => { setForgot(false); setResetToken(""); setError(""); }}>Back to sign in</button> : null}
        <div className="auth-footnote"><Icon name="lock" size={14} /> HttpOnly session · workspace-isolated data</div>
        <div className="auth-analytics-note">
          Anonymous, first-party session metrics only; no third-party tracking.
          <button type="button" onClick={() => {
            const next = !analyticsEnabled;
            if (setGrowthAnalyticsEnabled(next)) setAnalyticsEnabled(next);
          }}>
            {analyticsEnabled ? "Disable anonymous analytics" : "Enable anonymous analytics"}
          </button>
          <span aria-live="polite">{analyticsEnabled ? "Analytics enabled for this browser." : "Analytics disabled for this browser."}</span>
        </div>
      </div>
    </div>
  );
}
