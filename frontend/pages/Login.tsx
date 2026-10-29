import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowLeft, ArrowRight, Check, CircleAlert, DatabaseBackup, Eye, EyeOff, KeyRound, Lock, LogIn,
  Mail, Server, ShieldAlert, ShieldCheck, Terminal, User, UserPlus,
} from "lucide-react";
import { Button, Field, Input, Pill } from "../components/ui";
import { useSession, useApi } from "../lib/app";
import { api, ApiError, errorMessage, setCsrfToken } from "../lib/api";
import { Link } from "../lib/router";
import type { UserPublic } from "../../src/shared/types";

interface SetupInfo {
  needsSetup: boolean;
  checks: { id: string; label: string; status: string; detail: string }[];
  version: string;
}

/* ------------------------------------------------------------------ */
/* Shared shells                                                       */
/* ------------------------------------------------------------------ */

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden>
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="3" width="8" height="8" rx="1.4" fill="#3ecf72" opacity="0.9" />
        <rect x="13" y="3" width="8" height="8" rx="1.4" fill="#3ecf72" opacity="0.45" />
        <rect x="3" y="13" width="8" height="8" rx="1.4" fill="#3ecf72" opacity="0.45" />
        <rect x="13" y="13" width="8" height="8" rx="1.4" fill="#3ecf72" opacity="0.22" />
      </svg>
    </span>
  );
}

const HERO_FEATURES: { icon: ReactNode; title: string; body: string }[] = [
  {
    icon: <Server size={14} />,
    title: "Every server flavour",
    body: "Vanilla, Paper, Purpur, Fabric, Forge, NeoForge, Quilt, Velocity and BungeeCord — real jars, real checksums, Java 8–25 fetched on demand.",
  },
  {
    icon: <Terminal size={14} />,
    title: "Live console",
    body: "A WebSocket console that streams actual process output with ANSI colours, plus typed command history.",
  },
  {
    icon: <DatabaseBackup size={14} />,
    title: "Backups and worlds",
    body: "tar.gz snapshots with restore, world switching, and a player inspector that edits the saved NBT directly.",
  },
  {
    icon: <ShieldCheck size={14} />,
    title: "Access control on the server",
    body: "Roles and permissions are enforced by the API on every request — not hidden buttons in the browser.",
  },
];

function AuthLayout({ setup, children }: { setup: SetupInfo | null; children: ReactNode }) {
  const warnings = (setup?.checks ?? []).filter((check) => check.status !== "ok");
  return (
    <div className="auth-shell">
      <div className="auth-frame">
        <aside className="auth-hero">
          <div className="auth-hero-top">
            <BrandMark />
            <div className="auth-hero-brand">
              <strong>RSLMC</strong>
              <span>Minecraft Server Panel</span>
            </div>
          </div>

          <div className="auth-hero-body">
            <h2>
              Your worlds,
              <br />
              one control room.
            </h2>
            <p>
              Start, watch and back up Minecraft servers without touching a terminal — while everything
              running behind the panel stays a real process you can inspect.
            </p>

            <ul className="auth-hero-list">
              {HERO_FEATURES.map((feature) => (
                <li key={feature.title}>
                  <span className="auth-hero-icon" aria-hidden>{feature.icon}</span>
                  <div>
                    <b>{feature.title}</b>
                    <span>{feature.body}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="auth-hero-foot">
            <span className="mono">v{setup?.version ?? "1.0.0"}</span>
            <span className="auth-hero-dot" aria-hidden />
            <span>Production panel</span>
            {warnings.map((check) => (
              <span key={check.id} className="auth-hero-dot-group" title={check.detail}>
                <span className="auth-hero-dot" aria-hidden />
                {/* "Development mode" is the normal state on a local install; anything else is a real warning. */}
                <Pill tone={check.id === "mode" ? "neutral" : "amber"}>{check.label}</Pill>
              </span>
            ))}
          </div>
        </aside>

        <main className="auth-main">{children}</main>
      </div>
    </div>
  );
}

/** Password field with a reveal toggle — long panel passwords are hard to type blind. */
function PasswordField({
  value, onChange, label, autoComplete, placeholder = "••••••••••", autoFocus, hint, error, loading,
}: {
  value: string; onChange: (value: string) => void; label: string; autoComplete: string;
  placeholder?: string; autoFocus?: boolean; hint?: ReactNode; error?: string | null; loading?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  // Typing a password blind is the usual reason a sign-in "just does not work": say it out loud.
  const [capsLock, setCapsLock] = useState(false);
  const trackCaps = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const on = event.getModifierState?.("CapsLock") ?? false;
    if (on !== capsLock) setCapsLock(on);
  };
  return (
    <Field label={label} hint={capsLock ? <span className="auth-caps">Caps Lock is on</span> : hint} error={error}>
      <span className="input-affix">
        <Input
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={trackCaps}
          onKeyUp={trackCaps}
          onBlur={() => setCapsLock(false)}
          autoComplete={autoComplete}
          placeholder={placeholder}
          autoFocus={autoFocus}
          required
          readOnly={loading}
        />
        <button
          type="button"
          className="input-affix-btn"
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? "Hide password" : "Show password"}
          tabIndex={0}
        >
          {visible ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </span>
    </Field>
  );
}

function AuthError({ children }: { children: ReactNode }) {
  return (
    <div className="banner error auth-error" role="alert">
      <ShieldAlert size={15} color="#f28b8b" className="ic" />
      <div>{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Single sign-on                                                      */
/* ------------------------------------------------------------------ */

interface Provider { id: "discord" | "google"; label: string; clientId: string }

/** Brand marks drawn inline: no external requests, so the strict CSP keeps working. */
function DiscordMark() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden focusable="false">
      <path fill="currentColor" d="M20.3 4.5A17.3 17.3 0 0 0 16 3.2l-.3.6a13 13 0 0 1 3.8 1.4 12.4 12.4 0 0 0-11-.4l-.6.4A13.7 13.7 0 0 1 12 3.8L11.7 3.2A17.3 17.3 0 0 0 7.4 4.5C4.6 8.6 3.8 12.6 4.2 16.5a17.4 17.4 0 0 0 5.3 2.7l.7-1.1a11 11 0 0 1-1.8-.9l.4-.3a12.4 12.4 0 0 0 10.4 0l.4.3c-.6.4-1.2.7-1.8.9l.7 1.1a17.4 17.4 0 0 0 5.3-2.7c.5-4.4-.7-8.4-3.5-12ZM9.5 14.1c-.9 0-1.6-.8-1.6-1.8s.7-1.8 1.6-1.8c1 0 1.7.8 1.6 1.8 0 1-.7 1.8-1.6 1.8Zm5 0c-.9 0-1.6-.8-1.6-1.8s.7-1.8 1.6-1.8c1 0 1.7.8 1.6 1.8 0 1-.7 1.8-1.6 1.8Z" />
    </svg>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden focusable="false">
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.4a5.5 5.5 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.6-5.2 3.6-8.7Z" />
      <path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.9-3a7.2 7.2 0 0 1-10.7-3.8H1.3v3.1A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8l4-3.1Z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.4.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1A7.2 7.2 0 0 1 12 4.8Z" />
    </svg>
  );
}

const PROVIDER_ICON: Record<Provider["id"], () => ReactNode> = {
  discord: DiscordMark,
  google: GoogleMark,
};

/**
 * "Continue with …" buttons. They are plain top-level navigations (not fetch) because the provider
 * needs to show its own consent screen; the callback then redirects back with a session cookie.
 */
function ProviderButtons({ providers, action }: { providers: Provider[]; action: "Sign in" | "Sign up" }) {
  if (providers.length === 0) return null;
  return (
    <div className="sso-block">
      <div className="sso-divider"><span>or continue with</span></div>
      <div className="sso-buttons">
        {providers.map((provider) => {
          const Icon = PROVIDER_ICON[provider.id];
          return (
            <a
              key={provider.id}
              className={`sso-btn sso-${provider.id}`}
              href={`/api/auth/oauth/${provider.id}/start`}
              data-provider={provider.id}
            >
              <span className="sso-icon"><Icon /></span>
              <span className="sso-label">{action} with {provider.label}</span>
            </a>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sign in                                                             */
/* ------------------------------------------------------------------ */

export function LoginPage({ setup }: { setup: SetupInfo | null }) {
  const { login } = useSession();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [requiresTotp, setRequiresTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set when an SSO sign-in came back for an account that also has 2FA enabled.
  const [ssoTicket, setSsoTicket] = useState<string | null>(null);
  const setupNote = Boolean(setup?.needsSetup);

  /*
   * The OAuth callback redirects here with one of:
   *   ?oauth_error=…      the provider (or our own checks) refused — show why
   *   ?oauth_2fa=<ticket> the identity was verified, but the account still owes a TOTP code
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ticket = params.get("oauth_2fa");
    const oauthError = params.get("oauth_error");
    if (ticket) setSsoTicket(ticket);
    if (oauthError) setError(oauthError);
    if (ticket || oauthError) {
      window.history.replaceState({}, "", "/login");
    }
  }, []);
  const registration = useApi<{ enabled: boolean }>(
    setupNote ? null : "/api/auth/registration",
  );
  const providers = useApi<{ data: Provider[] }>(setupNote ? null : "/api/auth/oauth/providers");
  // The default bootstrap credentials are only advertised while the panel has no other account.
  const showBootstrapHint = setupNote;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (ssoTicket) {
        // Finishing an SSO sign-in: the ticket identifies the account, the code proves the factor.
        const result = await api.post<{ csrfToken: string; user: UserPublic }>("/api/auth/oauth/complete", {
          ticket: ssoTicket, code: totp,
        });
        setCsrfToken(result.csrfToken);
        window.history.replaceState({}, "", "/dashboard");
        window.location.reload();
        return;
      }
      await login(username.trim(), password, requiresTotp ? totp : undefined);
      window.history.replaceState({}, "", "/dashboard");
      window.location.reload();
    } catch (err) {
      if (err instanceof ApiError && err.code === "totp_required") {
        setRequiresTotp(true);
        setError("Enter the 6-digit code from your authenticator app.");
      } else if (err instanceof ApiError && err.code === "invalid_totp") {
        setRequiresTotp(true);
        setError("That two-factor code is not valid.");
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout setup={setup}>
      <div className="auth-card">
        <header className="auth-card-head">
          <h1>Welcome back</h1>
          <p>Sign in to manage your servers, backups and players.</p>
        </header>

        {ssoTicket ? (
          <div className="auth-sso-pending">
            <span className="auth-sso-pending-icon" aria-hidden><ShieldCheck size={15} /></span>
            <div>
              <b>One more step</b>
              <span>Your sign-in provider authenticated you. This account also has two-factor authentication, so enter the code below.</span>
            </div>
          </div>
        ) : null}

        <form onSubmit={submit} className="auth-form">
          {ssoTicket ? null : (
            <>
              <Field label="Username">
                <span className="input-icon">
                  <User size={14} className="lead" aria-hidden />
                  <Input
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    autoComplete="username"
                    autoFocus
                    required
                    placeholder="admin"
                    spellCheck={false}
                  />
                </span>
              </Field>

              <PasswordField
                label="Password"
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
              />
            </>
          )}

          {requiresTotp || ssoTicket ? (
            <Field
              label="Two-factor code"
              hint={ssoTicket
                ? "Your provider sign-in worked — enter the 6-digit code from your authenticator app to finish."
                : "Six digits from your authenticator app."}
            >
              <span className="input-icon">
                <KeyRound size={14} className="lead" aria-hidden />
                <Input
                  value={totp}
                  onChange={(event) => setTotp(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="000000"
                  autoFocus
                  className="input-otp"
                />
              </span>
            </Field>
          ) : null}

          {error ? <AuthError>{error}</AuthError> : null}

          <Button
            type="submit"
            variant="primary"
            loading={busy}
            icon={<LogIn size={14} />}
            className="btn-block auth-submit"
          >
            {ssoTicket ? "Finish sign-in" : "Sign in"}
          </Button>
        </form>

        {ssoTicket ? null : <ProviderButtons providers={providers.data?.data ?? []} action="Sign in" />}

        {registration.data?.enabled ? (
          <div className="auth-switch">
            <span>New to this panel?</span>
            <Link to="/register" className="auth-link">
              Create an account <ArrowRight size={12} />
            </Link>
          </div>
        ) : null}

        {showBootstrapHint ? (
          <div className="auth-note">
            <strong>First run.</strong> The bootstrap administrator is <span className="mono">admin</span> with the
            initial password <span className="mono">admin123</span>. RSLMC requires you to change it immediately —
            sensitive operations stay locked until you do.
          </div>
        ) : (
          <div className="auth-note auth-note-quiet">
            <Lock size={13} />
            <span>Sessions expire after 12 hours of inactivity. Failed sign-ins are rate limited per account and address.</span>
          </div>
        )}
      </div>
    </AuthLayout>
  );
}

/* ------------------------------------------------------------------ */
/* Register                                                            */
/* ------------------------------------------------------------------ */

interface RegistrationInfo {
  enabled: boolean;
  requireCode: boolean;
  defaultRole: string;
  message: string | null;
  passwordPolicy: { minLength: number; requires: string[] };
}

interface PasswordCheck { ok: boolean; problems: string[] }

export function RegisterPage({ setup }: { setup: SetupInfo | null }) {
  const { user } = useSession();
  const info = useApi<RegistrationInfo>("/api/auth/registration");
  const providers = useApi<{ data: Provider[] }>("/api/auth/oauth/providers");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ pending: boolean; message: string } | null>(null);
  const [policy, setPolicy] = useState<PasswordCheck | null>(null);
  const policyRequest = useRef(0);

  // Signed-in visitors have no reason to be here; send them to the dashboard.
  useEffect(() => {
    if (user) {
      window.history.replaceState({}, "", "/dashboard");
      window.location.reload();
    }
  }, [user]);

  // The password policy lives on the server; asking it keeps the checklist honest instead of
  // duplicating (and eventually disagreeing with) the real rules in the browser.
  useEffect(() => {
    if (!password) { setPolicy(null); return; }
    const ticket = ++policyRequest.current;
    const timer = setTimeout(() => {
      api.post<PasswordCheck>("/api/auth/password/check", { password })
        .then((result) => { if (policyRequest.current === ticket) setPolicy(result); })
        .catch(() => { /* policy is advisory here; the submit path reports the real error */ });
    }, 260);
    return () => clearTimeout(timer);
  }, [password]);

  const mismatched = confirm.length > 0 && confirm !== password;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (mismatched) { setError("The two passwords do not match."); return; }
    setBusy(true);
    try {
      const result = await api.post<{
        status: "active"; message: string; csrfToken?: string; user?: UserPublic;
      }>("/api/auth/register", {
        username: username.trim(),
        email: email.trim() || undefined,
        password,
        code: code.trim() || undefined,
      });
      if (result.csrfToken) setCsrfToken(result.csrfToken);
      setDone({ pending: false, message: result.message });
      window.history.replaceState({}, "", "/dashboard");
      window.location.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const registrationClosed = info.data ? !info.data.enabled : false;

  return (
    <AuthLayout setup={setup}>
      <div className="auth-card">
        {done ? (
          <div className="auth-done">
            <span className={`auth-done-icon ${done.pending ? "pending" : "ok"}`} aria-hidden>
              {done.pending ? <CircleAlert size={18} /> : <Check size={18} />}
            </span>
            <h1>{done.pending ? "Account created" : "You're in"}</h1>
            <p>{done.message}</p>
            <Link to="/login" className="auth-link auth-link-block">
              <ArrowLeft size={12} /> Back to sign in
            </Link>
          </div>
        ) : (
          <>
            <header className="auth-card-head">
              <h1>Create your account</h1>
              <p>
                {info.data?.enabled
                  ? `Your account starts with the ${info.data.defaultRole} role — no administration access.`
                  : "Registration details are loading…"}
              </p>
            </header>

            {info.error ? <AuthError>{info.error}</AuthError> : null}

            {registrationClosed ? (
              <div className="auth-closed">
                <span className="auth-closed-icon" aria-hidden><Lock size={16} /></span>
                <div>
                  <b>Registration is closed</b>
                  <p>{info.data?.message ?? "An administrator has disabled self-registration for this panel."}</p>
                </div>
              </div>
            ) : (
              <form onSubmit={submit} className="auth-form">
                <Field label="Username">
                  <span className="input-icon">
                    <User size={14} className="lead" aria-hidden />
                    <Input
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      autoComplete="username"
                      required
                      autoFocus
                      minLength={3}
                      maxLength={32}
                      placeholder="steve"
                      spellCheck={false}
                    />
                  </span>
                </Field>

                <Field label="Email" hint="Optional — used only to identify your account.">
                  <span className="input-icon">
                    <Mail size={14} className="lead" aria-hidden />
                    <Input
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      autoComplete="email"
                      maxLength={200}
                      placeholder="steve@example.com"
                    />
                  </span>
                </Field>

                <PasswordField
                  label="Password"
                  value={password}
                  onChange={setPassword}
                  autoComplete="new-password"
                />

                {password.length > 0 ? (
                  <div className="pw-rules">
                    {(policy?.problems.length ?? 0) === 0 && policy?.ok ? (
                      <span className="pw-rule ok"><Check size={11} /> Meets the password policy</span>
                    ) : (
                      (policy?.problems ?? info.data?.passwordPolicy.requires ?? []).map((rule) => (
                        <span key={rule} className="pw-rule"><span className="dot" />{rule}</span>
                      ))
                    )}
                  </div>
                ) : null}

                <PasswordField
                  label="Confirm password"
                  value={confirm}
                  onChange={setConfirm}
                  autoComplete="new-password"
                  error={mismatched ? "The two passwords do not match." : null}
                />

                {info.data?.requireCode ? (
                  <Field label="Sign-up code" hint="This panel needs the code an administrator gave you.">
                    <span className="input-icon">
                      <KeyRound size={14} className="lead" aria-hidden />
                      <Input
                        value={code}
                        onChange={(event) => setCode(event.target.value)}
                        autoComplete="off"
                        required
                        placeholder="invite code"
                        spellCheck={false}
                      />
                    </span>
                  </Field>
                ) : null}

                {error ? <AuthError>{error}</AuthError> : null}

                <Button
                  type="submit"
                  variant="primary"
                  loading={busy}
                  icon={<UserPlus size={14} />}
                  className="btn-block auth-submit"
                  disabled={mismatched || (policy ? !policy.ok : false)}
                >
                  Create account
                </Button>
              </form>
            )}

            {registrationClosed ? null : (
              <ProviderButtons providers={providers.data?.data ?? []} action="Sign up" />
            )}

            <div className="auth-switch">
              <span>Already have an account?</span>
              <Link to="/login" className="auth-link">
                Sign in <ArrowRight size={12} />
              </Link>
            </div>
          </>
        )}
      </div>
    </AuthLayout>
  );
}
