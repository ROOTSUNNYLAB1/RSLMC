import { useEffect, useRef, useState } from "react";
import { Bell, Check, CircleUser, ImagePlus, KeyRound, LogOut, Monitor, Palette, ShieldCheck, Smartphone, Trash2, Upload, X } from "lucide-react";
import { Avatar, Banner, Button, Card, Field, Input, Loading, Modal, PageHeader, Pill } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { useSession, useToast } from "../lib/app";
import { Link } from "../lib/router";
import { formatDateTime, relativeTime } from "../lib/format";
import { THEMES } from "../../src/shared/themes";

export function AccountPage() {
  const { user, refresh, securityNotice, logout, setTheme } = useSession();
  const toast = useToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [policy, setPolicy] = useState<{ ok: boolean; problems: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [totpSetup, setTotpSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [sessions, setSessions] = useState<any[] | null>(null);

  /* Profile picture: local preview while the bytes are in flight, then the served URL. */
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarDragging, setAvatarDragging] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  /* Theme: applied instantly on click, then confirmed by the account. */
  const [theme, setThemeLocal] = useState<string | null>(null);
  const [themeBusy, setThemeBusy] = useState<string | null>(null);
  const activeTheme = theme ?? user?.theme ?? "charcoal";

  const chooseTheme = async (id: string) => {
    if (id === activeTheme) return;
    const previous = activeTheme;
    setThemeLocal(id);
    setThemeBusy(id);
    try {
      const saved = await setTheme(id);
      setThemeLocal(saved);
      toast.success(`${THEMES.find((entry) => entry.id === saved)?.label ?? "Theme"} applied`);
    } catch (err) {
      setThemeLocal(previous);
      toast.fromError(err, "Could not save the theme");
    } finally {
      setThemeBusy(null);
    }
  };
  const previewUrl = useRef<string | null>(null);

  const clearPreview = () => {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = null;
    setAvatarPreview(null);
  };
  useEffect(() => clearPreview, []);

  const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
  const ACCEPTED = ["image/png", "image/jpeg", "image/webp"];

  const uploadAvatar = async (file: File | undefined) => {
    if (!file) return;
    setAvatarError(null);
    if (!ACCEPTED.includes(file.type)) {
      setAvatarError("Pick a PNG, JPEG or WebP image — that is what the panel can check reliably.");
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setAvatarError(`That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 2 MB.`);
      return;
    }
    clearPreview();
    previewUrl.current = URL.createObjectURL(file);
    setAvatarPreview(previewUrl.current);
    setAvatarBusy(true);
    try {
      const result = await api.postBlob<{ avatarUrl: string }>("/api/auth/avatar", file);
      await refresh();
      toast.success("Profile picture updated", "It shows in the sidebar and next to your name.");
      void result;
      clearPreview();
    } catch (err) {
      clearPreview();
      const message = errorMessage(err);
      setAvatarError(message);
      toast.error("Could not use that image", message);
    } finally {
      setAvatarBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const removeAvatar = async () => {
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      await api.delete("/api/auth/avatar");
      await refresh();
      clearPreview();
      toast.success("Profile picture removed");
    } catch (err) {
      toast.fromError(err, "Could not remove the picture");
    } finally {
      setAvatarBusy(false);
    }
  };

  useEffect(() => {
    api.get<{ data: any[] }>("/api/auth/sessions").then((result) => setSessions(result.data)).catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    if (!newPassword) { setPolicy(null); return; }
    api.post<{ ok: boolean; problems: string[] }>("/api/auth/password/check", { password: newPassword })
      .then(setPolicy)
      .catch(() => setPolicy(null));
  }, [newPassword]);

  const changePassword = async () => {
    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }
    setSaving(true);
    try {
      await api.post("/api/auth/password", { currentPassword, newPassword });
      toast.success("Password changed", "You were signed out everywhere else. Please sign in again.");
      setTimeout(() => { window.location.href = "/login"; }, 1200);
    } catch (err) {
      toast.fromError(err, "Could not change the password");
    } finally {
      setSaving(false);
    }
  };

  if (!user) return <Loading label="Loading your account…" />;

  return (
    <>
      <PageHeader
        title="My Profile"
        icon={<CircleUser size={19} />}
        subtitle={<>Signed in as <strong style={{ color: "var(--text)" }}>{user.username}</strong> · {user.roles.join(", ") || "no role"}</>}
        actions={<Button icon={<LogOut size={14} />} onClick={() => void logout()}>Sign out</Button>}
      />

      {user.mustChangePassword || securityNotice ? (
        <Banner tone="warning" title="Important: change your default administrator password">
          This account still uses the bootstrap password. Until you change it, RSLMC keeps sensitive administrative operations restricted.
        </Banner>
      ) : null}

      {/* Appearance — the whole picker is one compact grid of swatches. */}
      <Card
        title="Appearance"
        icon={<Palette size={12} />}
        actions={<span className="text-xs faint">{THEMES.length} themes · saved to your account</span>}
      >
        <div className="theme-grid" role="radiogroup" aria-label="Colour theme">
          {THEMES.map((entry) => {
            const selected = entry.id === activeTheme;
            return (
              <button
                key={entry.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`theme-swatch${selected ? " is-active" : ""}`}
                onClick={() => void chooseTheme(entry.id)}
                title={entry.mood}
                disabled={themeBusy !== null}
                style={{
                  ["--swatch-bg" as string]: entry.swatch.bg,
                  ["--swatch-surface" as string]: entry.swatch.surface,
                  ["--swatch-accent" as string]: entry.swatch.accent,
                  ["--swatch-on" as string]: entry.swatch.onAccent,
                }}
              >
                <span className="theme-preview" aria-hidden>
                  <span className="theme-preview-bar" />
                  <span className="theme-preview-body">
                    <span className="theme-preview-pill" />
                    <span className="theme-preview-line" />
                    <span className="theme-preview-line short" />
                  </span>
                  <span className="theme-preview-accent" />
                  {selected ? <span className="theme-preview-check"><Check size={11} /></span> : null}
                </span>
                <span className="theme-name">
                  {entry.label}
                  {themeBusy === entry.id ? <span className="theme-saving">…</span> : null}
                </span>
              </button>
            );
          })}
        </div>
        <p className="theme-hint">
          Themes change the chrome only — surfaces, borders and the interface accent. Status colours
          stay fixed: <span className="theme-legend running">running</span>
          <span className="theme-legend warning">warning</span>
          <span className="theme-legend error">error</span> mean the same thing in every theme.
        </p>
      </Card>

      {/* Profile picture — compact: preview, buttons, one line of guidance. */}
      <Card
        title="Profile picture"
        icon={<ImagePlus size={12} />}
      >
        <div className="avatar-editor">
          <div
            className={`avatar-drop${avatarDragging ? " is-dragging" : ""}${avatarBusy ? " is-busy" : ""}`}
            onDragOver={(event) => { event.preventDefault(); setAvatarDragging(true); }}
            onDragLeave={() => setAvatarDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setAvatarDragging(false);
              void uploadAvatar(event.dataTransfer.files[0]);
            }}
            onClick={() => { if (!avatarBusy) fileInput.current?.click(); }}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") { event.preventDefault(); fileInput.current?.click(); }
            }}
            title="Click or drop an image here"
          >
            <Avatar
              name={user.username}
              color={user.avatarColor}
              url={avatarPreview ?? user.avatarUrl}
              size={72}
            />
            {avatarBusy ? <span className="avatar-drop-overlay">Saving…</span> : null}
          </div>

          <div className="avatar-editor-side">
            <div className="avatar-editor-actions">
              <Button
                variant="primary"
                icon={<Upload size={13} />}
                loading={avatarBusy}
                onClick={() => fileInput.current?.click()}
              >
                {user.avatarUrl ? "Replace picture" : "Upload picture"}
              </Button>
              {user.avatarUrl && !avatarBusy ? (
                <Button variant="ghost" icon={<X size={13} />} onClick={() => void removeAvatar()}>Remove</Button>
              ) : null}
            </div>
            <p className="avatar-editor-hint">
              PNG, JPEG or WebP · up to 2 MB · square looks best. Click the circle or drop a file on it.
            </p>
            {avatarError ? <p className="avatar-editor-error">{avatarError}</p> : null}
          </div>

          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            onChange={(event) => void uploadAvatar(event.target.files?.[0])}
          />
        </div>
      </Card>

      <div className="grid grid-2">
        <Card title="Account" icon={<CircleUser size={12} />} bodyClass="tight">
          <div className="info-list">
            <div className="info-row"><span className="k">Username</span><span className="v">{user.username}</span></div>
            <div className="info-row"><span className="k">Roles</span><span className="v">{user.roles.map((role) => <Pill key={role} tone="neutral">{role}</Pill>)}</span></div>
            <div className="info-row"><span className="k">Root administrator</span><span className="v">{user.isRoot ? <Pill tone="green">yes</Pill> : "no"}</span></div>
            <div className="info-row"><span className="k">Two-factor</span><span className="v">{user.totpEnabled ? <Pill tone="green">enabled</Pill> : <Pill tone="amber">not enabled</Pill>}</span></div>
            <div className="info-row"><span className="k">Created</span><span className="v text-xs">{formatDateTime(user.createdAt)}</span></div>
            <div className="info-row"><span className="k">Last sign-in</span><span className="v text-xs">{user.lastLoginAt ? relativeTime(user.lastLoginAt) : "—"}</span></div>
          </div>
        </Card>

        <Card title="Change password" icon={<KeyRound size={12} />}>
          <div className="stack">
            <Field label="Current password">
              <Input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" />
            </Field>
            <Field label="New password" hint="At least 10 characters with upper and lower case, a number and a symbol.">
              <Input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" />
            </Field>
            {policy ? (
              <div className="text-xs" style={{ color: policy.ok ? "var(--green)" : "#e8c46a" }}>
                {policy.ok ? "Password meets the policy." : policy.problems.join(" ")}
              </div>
            ) : null}
            <Field label="Confirm new password">
              <Input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" />
            </Field>
            <Button
              variant="primary"
              loading={saving}
              onClick={() => void changePassword()}
              disabled={!currentPassword || !newPassword || newPassword !== confirmPassword || !policy?.ok}
            >
              Update password
            </Button>
          </div>
        </Card>

        <Card title="Two-factor authentication" icon={<ShieldCheck size={12} />}>
          {user.totpEnabled ? (
            <div className="stack">
              <Banner tone="success" title="Two-factor authentication is active">
                Sign-in requires a 6-digit code from your authenticator app.
              </Banner>
              <Button
                variant="danger"
                onClick={async () => {
                  const password = window.prompt("Enter your password to disable two-factor authentication");
                  if (!password) return;
                  try {
                    await api.post("/api/auth/totp/disable", { password });
                    toast.success("Two-factor disabled");
                    await refresh();
                  } catch (err) { toast.fromError(err, "Could not disable two-factor"); }
                }}
              >
                Disable two-factor
              </Button>
            </div>
          ) : (
            <>
              <div className="stack">
                <div className="text-xs faint" style={{ lineHeight: 1.6 }}>
                  TOTP works with any standard authenticator app. The secret never leaves this panel and codes are verified locally.
                </div>
                <Button
                  icon={<Smartphone size={14} />}
                  onClick={async () => {
                    try {
                      const result = await api.post<{ secret: string; otpauthUrl: string }>("/api/auth/totp/setup");
                      setTotpSetup(result);
                    } catch (err) { toast.fromError(err, "Could not start two-factor setup"); }
                  }}
                >
                  Set up two-factor
                </Button>
              </div>
            </>
          )}
        </Card>

        <Card title="Active sessions" icon={<Monitor size={12} />} bodyClass="tight">
          {sessions === null ? <Loading label="Loading sessions…" minHeight={80} /> : (
            <table className="table">
              <thead><tr><th>Address</th><th>Client</th><th>Last seen</th><th className="actions" /></tr></thead>
              <tbody>
                {sessions.filter((session) => !session.current).map((session) => (
                  <tr key={session.id}>
                    <td className="mono text-xs">{session.ip ?? "unknown"}</td>
                    <td className="text-xs truncate" style={{ maxWidth: 220 }}>{session.userAgent?.slice(0, 60) ?? "—"}</td>
                    <td className="text-xs">{relativeTime(session.lastSeenAt)}</td>
                    <td className="actions">
                      <Button
                        size="sm" variant="danger" icon={<Trash2 size={12} />}
                        onClick={async () => {
                          await api.delete(`/api/auth/sessions/${session.id}`);
                          setSessions((current) => current?.filter((entry) => entry.id !== session.id) ?? null);
                          toast.success("Session revoked");
                        }}
                      >
                        Revoke
                      </Button>
                    </td>
                  </tr>
                ))}
                {sessions.filter((session) => !session.current).length === 0 ? (
                  <tr><td colSpan={4} className="faint text-xs">This is your only active session.</td></tr>
                ) : null}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Modal
        open={totpSetup !== null}
        onClose={() => { setTotpSetup(null); setTotpCode(""); }}
        title="Set up two-factor authentication"
        footer={<>
          <Button onClick={() => { setTotpSetup(null); setTotpCode(""); }}>Cancel</Button>
          <Button
            variant="primary"
            disabled={totpCode.length !== 6}
            onClick={async () => {
              try {
                const result = await api.post<{ recoveryCodes: string[] }>("/api/auth/totp/enable", { code: totpCode });
                setRecoveryCodes(result.recoveryCodes);
                setTotpSetup(null);
                await refresh();
                toast.success("Two-factor enabled", "Store your recovery codes somewhere safe.");
              } catch (err) { toast.fromError(err, "Could not enable two-factor"); }
            }}
          >
            Verify and enable
          </Button>
        </>}
      >
        {totpSetup ? (
          <div className="stack">
            <div className="text-xs faint">Add this secret to your authenticator app, then enter the generated 6-digit code.</div>
            <div className="code-block" style={{ fontSize: 13, letterSpacing: "0.1em" }}>{totpSetup.secret}</div>
            <div className="text-xs faint mono truncate">{totpSetup.otpauthUrl}</div>
            <Field label="Verification code">
              <Input value={totpCode} onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" placeholder="000000" />
            </Field>
          </div>
        ) : null}
      </Modal>

      <Modal open={recoveryCodes !== null} onClose={() => setRecoveryCodes(null)} title="Recovery codes" footer={<Button variant="primary" onClick={() => setRecoveryCodes(null)}>I have saved them</Button>}>
        <Banner tone="warning" title="Store these now">
          Each code can be used once if you lose your authenticator. They are shown only once.
        </Banner>
        <div className="code-block">{recoveryCodes?.join("\n")}</div>
      </Modal>
    </>
  );
}

export function NotificationsPage() {
  const toast = useToast();
  const { setUnread } = useSession();
  const [items, setItems] = useState<any[] | null>(null);

  const load = async () => {
    try {
      const result = await api.get<{ items: any[]; unread: number }>("/api/notifications");
      setItems(result.items);
      setUnread(result.unread);
    } catch (err) {
      toast.fromError(err, "Could not load notifications");
      setItems([]);
    }
  };

  useEffect(() => { void load(); }, []);

  const toneFor = (severity: string) => severity === "error" ? "red" : severity === "warning" ? "amber" : severity === "success" ? "green" : "blue";

  return (
    <>
      <PageHeader
        title="Notifications"
        icon={<Bell size={19} />}
        subtitle="Security notices, crashes, backup failures and panel warnings."
        actions={
          <Button
            onClick={async () => {
              await api.post("/api/notifications/read-all");
              setUnread(0);
              await load();
            }}
          >
            Mark all as read
          </Button>
        }
      />
      <Card bodyClass="tight">
        {items === null ? <Loading label="Loading notifications…" /> : items.length === 0 ? (
          <div className="empty"><h4>You are all caught up</h4><p>Notifications appear here when something needs your attention.</p></div>
        ) : (
          <div className="info-list">
            {items.map((notification) => (
              <div className="info-row" key={notification.id} style={{ alignItems: "flex-start", padding: "12px 14px" }}>
                <Pill tone={toneFor(notification.severity) as any}>{notification.severity}</Pill>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <strong style={{ fontSize: 12.5 }}>{notification.title}</strong>
                    {!notification.readAt ? <span className="live-dot" style={{ background: "var(--blue)" }} /> : null}
                  </div>
                  {notification.body ? <div className="text-xs faint" style={{ marginTop: 2, lineHeight: 1.55 }}>{notification.body}</div> : null}
                  <div className="text-xs faint" style={{ marginTop: 4 }}>
                    {relativeTime(notification.createdAt)}
                    {notification.link ? (
                      <> · <Link to={notification.link} style={{ textDecoration: "underline" }}>Open</Link></>
                    ) : null}
                  </div>
                </div>
                <div className="row" style={{ gap: 4 }}>
                  {!notification.readAt ? (
                    <Button size="sm" variant="ghost" onClick={async () => { await api.post(`/api/notifications/${notification.id}/read`); await load(); }}>Read</Button>
                  ) : null}
                  <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={async () => { await api.delete(`/api/notifications/${notification.id}`); await load(); }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
