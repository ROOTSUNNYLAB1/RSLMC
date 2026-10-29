import { Router, json, validate, v, unauthorized, forbidden, badRequest, notFound, ApiException } from "../shared/http";
import { SESSION_COOKIE, login, validateSession, destroySession, sessionCookieOptions, publicUser, findUserById, changePassword, destroyAllSessionsForUser, isSecureRequest, createSessionForUser, hasPermission } from "../auth";
import { serializeCookie } from "../shared/http";
import { rateLimit } from "../security/ratelimit";
import { recordAudit } from "../services/audit";
import { generateTotpSecret, otpauthUrl, verifyTotp, generateRecoveryCodes } from "../security/totp";
import { hashPassword, verifyPassword, checkPasswordPolicy } from "../security/passwords";
import { query, queryOne, run } from "../database";
import { notify } from "../services/notifications";
import { MODE, PORT, DATA_DIR, APP_VERSION } from "../shared/config";
import { detectCgroups } from "../resources/cgroups";
import { describeEnforcement } from "../resources/enforcement";
import { needsSetup } from "../services/bootstrap";
import { publicRegistrationInfo, registerAccount } from "../services/registration";
import { saveAvatar, deleteAvatar, readAvatar, AVATAR_MAX_BYTES } from "../services/avatars";
import { THEMES, isThemeId, themeById } from "../shared/themes";
import {
  PROVIDERS, publicProviders, providerEnabled, createState, consumeState, authorizeUrl,
  fetchProfile, resolveOauthAccount, createTicket, consumeTicket, type Provider,
} from "../services/oauth";

/** Binds the OAuth redirect round-trip to the browser that started it. */
const OAUTH_STATE_COOKIE = "rslmc_oauth_state";

/** Issues a normal panel session for a user that was authenticated by a provider. */
async function issueSessionFor(user: any, ctx: any) {
  const session = createSessionForUser(user, { ip: ctx.clientIp, userAgent: ctx.req.headers.get("user-agent") ?? "unknown" });
  return { ...session, user: publicUser(findUserById(user.id)!) };
}

export function registerAuthRoutes(api: Router): void {
  api.post("/api/auth/login", async (ctx) => {
    const body = await ctx.body<{ username?: string; password?: string; totp?: string }>();
    const input = validate(
      {
        username: v.string({ min: 1, max: 64 }),
        password: v.string({ min: 1, max: 200 }),
        totp: v.string({ min: 6, max: 8, optional: true }),
      },
      body,
    );
    const username = input.username!;
    const password = input.password!;
    const limiter = rateLimit(`login:${ctx.clientIp}:${username.toLowerCase()}`, 8, 5 * 60 * 1000);
    if (!limiter.allowed) {
      recordAudit({
        actorName: username, action: "auth.login", result: "failure", ip: ctx.clientIp,
        targetType: "user", metadata: { reason: "rate_limited" },
      });
      throw new ApiException(429, "rate_limited", `Too many login attempts. Try again in ${limiter.retryAfterSeconds}s.`);
    }

    const result = await login(username, password, input.totp, {
      ip: ctx.clientIp,
      userAgent: ctx.headers.get("user-agent") ?? "unknown",
    });
    recordAudit({
      actorId: result.user.id, actorName: result.user.username, action: "auth.login",
      result: "success", ip: ctx.clientIp, targetType: "session",
      metadata: { userAgent: ctx.headers.get("user-agent")?.slice(0, 120) },
    });
    const response = json({
      user: result.user,
      csrfToken: result.csrfToken,
      expiresAt: result.expiresAt,
      securityNotice: result.user.mustChangePassword
        ? "Important: Change your default administrator password immediately to protect your account."
        : null,
    });
    response.headers.append("set-cookie", serializeCookie(SESSION_COOKIE, result.token, sessionCookieOptions(ctx.req)));
    return response;
  });

  /*
   * Self-registration. Both routes are in PUBLIC_ROUTES (see api/index.ts) so an anonymous visitor
   * can read the form's shape and submit it; everything that actually creates access is validated
   * server-side in services/registration.ts.
   */
  api.get("/api/auth/registration", async () => json(publicRegistrationInfo()));

  api.post("/api/auth/register", async (ctx) => {
    const body = await ctx.body<{ username?: string; password?: string; email?: string; code?: string }>();
    const input = validate(
      {
        username: v.string({ min: 3, max: 32 }),
        password: v.string({ min: 1, max: 200 }),
        email: v.string({ max: 200, optional: true }),
        code: v.string({ max: 128, optional: true }),
      },
      body,
    );
    // Same rate-limit bucket shape as login: registration floods must not be able to hammer Argon2.
    const limiter = rateLimit(`register:${ctx.clientIp}`, 10, 15 * 60 * 1000);
    if (!limiter.allowed) {
      throw new ApiException(429, "rate_limited", `Too many sign-up attempts. Try again in ${limiter.retryAfterSeconds}s.`);
    }

    const created = await registerAccount({
      username: input.username!,
      password: input.password!,
      email: input.email,
      code: input.code,
      ip: ctx.clientIp,
    });

    recordAudit({
      actorId: created.userId, actorName: created.username, action: "auth.register",
      result: "success", ip: ctx.clientIp,
      targetType: "user", targetId: created.userId,
      metadata: { role: created.role },
    });

    // Auto sign-in so a fresh account lands straight in the panel.
    const result = await login(created.username, input.password!, undefined, {
      ip: ctx.clientIp,
      userAgent: ctx.headers.get("user-agent") ?? "unknown",
    });
    const response = json({
      ok: true,
      status: "active",
      message: created.message,
      user: result.user,
      csrfToken: result.csrfToken,
      expiresAt: result.expiresAt,
      securityNotice: null,
    }, { status: 201 });
    response.headers.append("set-cookie", serializeCookie(SESSION_COOKIE, result.token, sessionCookieOptions(ctx.req)));
    return response;
  });

  /* ---------------- Preferences (theme) ---------------- */

  /** The full palette list, so the picker never hardcodes an id the server would reject. */
  api.get("/api/auth/themes", async () => json({
    data: THEMES,
    default: themeById(null).id,
  }));

  /**
   * Appearance preference. Only the account itself can change it — there is deliberately no
   * administrator path into somebody else's theme.
   */
  api.patch("/api/auth/preferences", async (ctx) => {
    if (!ctx.user) throw unauthorized();
    const body = await ctx.body<{ theme?: string }>();
    if (body.theme === undefined) throw badRequest("Nothing to change. Send { \"theme\": \"<id>\" }.");
    if (!isThemeId(body.theme)) {
      throw badRequest(`Unknown theme "${String(body.theme).slice(0, 40)}". Known themes: ${THEMES.map((theme) => theme.id).join(", ")}.`);
    }
    const previous = findUserById(ctx.user.id)?.theme ?? null;
    run("UPDATE users SET theme = ? WHERE id = ?", [body.theme, ctx.user.id]);
    if (previous !== body.theme) {
      recordAudit({
        actorId: ctx.user.id, actorName: ctx.user.username, action: "auth.theme_changed",
        ip: ctx.clientIp, metadata: { from: previous, to: body.theme },
      });
    }
    const refreshed = findUserById(ctx.user.id)!;
    return json({ ok: true, user: publicUser(refreshed) });
  });

  /* ---------------- Profile picture ---------------- */

  /**
   * Uploads (or replaces) the signed-in account's picture. The body is the raw image, not a
   * multipart form: no parser, no temp files, and the size is checked before anything is written.
   */
  api.post("/api/auth/avatar", async (ctx) => {
    if (!ctx.user) throw unauthorized();
    const declared = Number(ctx.req.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > AVATAR_MAX_BYTES + 1024) {
      throw new ApiException(413, "avatar_too_large", "Profile pictures must be 2 MB or smaller.");
    }
    const buffer = new Uint8Array(await ctx.req.arrayBuffer());
    if (buffer.length > AVATAR_MAX_BYTES) {
      throw new ApiException(413, "avatar_too_large", "Profile pictures must be 2 MB or smaller.");
    }
    const saved = saveAvatar(ctx.user.id, buffer);
    recordAudit({
      actorId: ctx.user.id, actorName: ctx.user.username, action: "auth.avatar_updated", ip: ctx.clientIp,
      metadata: { bytes: saved.bytes, width: saved.width, height: saved.height },
    });
    return json({ ok: true, avatarUrl: saved.url, bytes: saved.bytes, width: saved.width, height: saved.height });
  });

  api.delete("/api/auth/avatar", async (ctx) => {
    if (!ctx.user) throw unauthorized();
    deleteAvatar(ctx.user.id);
    recordAudit({ actorId: ctx.user.id, actorName: ctx.user.username, action: "auth.avatar_removed", ip: ctx.clientIp });
    return json({ ok: true, avatarUrl: null });
  });

  /**
   * Serves a picture to any signed-in account (the users list and the sidebar both need it).
   * `Cache-Control: private` plus an ETag keyed on the version means a replaced picture shows up
   * immediately instead of hiding behind a stale cache.
   */
  api.get("/api/users/:id/avatar", async (ctx) => {
    if (!ctx.user) throw unauthorized();
    const userId = Number(ctx.params.id);
    if (!Number.isInteger(userId) || userId <= 0) throw badRequest("Invalid account id");
    // Your own picture is always yours to see; anybody else's requires the right to browse accounts
    // (the users list is the only place the panel shows them). Otherwise ids would be enumerable.
    if (userId !== ctx.user.id && !hasPermission(ctx.user, "user.view")) throw forbidden();
    const avatar = readAvatar(userId);
    if (!avatar) throw notFound("This account has no profile picture.");
    const etag = `"v${avatar.version}-${avatar.bytes.length}"`;
    if (ctx.req.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    // Copied into a plain ArrayBuffer so the response body type is unambiguous.
    const body = new Uint8Array(avatar.bytes).slice().buffer;
    return new Response(new Blob([body], { type: avatar.type }), {
      headers: {
        "content-type": avatar.type,
        "content-length": String(avatar.bytes.length),
        "cache-control": "private, max-age=0, must-revalidate",
        etag,
        // An uploaded image is never rendered as a document.
        "content-disposition": "inline",
        "x-content-type-options": "nosniff",
      },
    });
  });

  /* ---------------- Single sign-on ---------------- */

  /** Which provider buttons the sign-in page should render. No secrets, no configuration detail. */
  api.get("/api/auth/oauth/providers", async () => json({ data: publicProviders() }));

  /**
   * Starts the redirect dance. The exact redirect URI is derived from the request that arrives here
   * (honouring a reverse proxy's X-Forwarded-*), stored with the state, and reused verbatim during the
   * callback — a mismatch there is the classic "invalid redirect_uri" failure behind a proxy.
   */
  api.get("/api/auth/oauth/:provider/start", async (ctx) => {
    const provider = String(ctx.params.provider ?? "") as Provider;
    if (!PROVIDERS.includes(provider)) throw badRequest("Unknown sign-in provider");
    if (!providerEnabled(provider)) throw new ApiException(404, "oauth_disabled", "That sign-in provider is not enabled.");

    const url = new URL(ctx.req.url);
    const forwardedHost = ctx.req.headers.get("x-forwarded-host");
    const forwardedProto = ctx.req.headers.get("x-forwarded-proto");
    const host = forwardedHost ?? url.host;
    const proto = (forwardedProto ?? url.protocol.replace(":", "")) === "http" ? "http" : "https";
    const redirectUri = `${proto}://${host}/api/auth/oauth/${provider}/callback`;

    const { state, challenge } = createState(provider, redirectUri);
    const response = new Response(null, { status: 302 });
    response.headers.set("location", authorizeUrl(provider, redirectUri, state, challenge));
    // The state cookie binds the callback to this browser even if the URL leaks.
    response.headers.append("set-cookie", serializeCookie(OAUTH_STATE_COOKIE, state, {
      maxAge: 600, httpOnly: true, secure: isSecureRequest(ctx.req), sameSite: "Lax", path: "/",
    }));
    return response;
  });

  api.get("/api/auth/oauth/:provider/callback", async (ctx) => {
    const provider = String(ctx.params.provider ?? "") as Provider;
    const failTo = (reason: string) => {
      const response = new Response(null, { status: 302 });
      response.headers.set("location", `/login?oauth_error=${encodeURIComponent(reason)}`);
      return response;
    };
    if (!PROVIDERS.includes(provider)) return failTo("Unknown sign-in provider.");
    if (!providerEnabled(provider)) return failTo("That sign-in provider is not enabled.");

    // The provider reports a refusal (user pressed cancel, app misconfigured …).
    const providerError = ctx.query("error");
    if (providerError) return failTo(ctx.query("error_description") ?? providerError);

    const code = ctx.query("code");
    const state = ctx.query("state");
    if (!code || !state) return failTo("The sign-in response was incomplete.");

    // CSRF: the state must exist, be unused, unexpired, and match the cookie set when we redirected.
    const cookieState = ctx.cookies[OAUTH_STATE_COOKIE];
    if (cookieState && cookieState !== state) return failTo("The sign-in request could not be verified (state mismatch).");
    const stored = consumeState(state, provider);
    if (!stored) return failTo("The sign-in link expired or was already used. Please try again.");

    let profile;
    try {
      profile = await fetchProfile(provider, code, stored.redirectUri, stored.verifier);
    } catch (error) {
      return failTo(error instanceof Error ? error.message : "The sign-in provider could not be reached.");
    }

    let resolved;
    try {
      resolved = resolveOauthAccount(profile, ctx.clientIp);
    } catch (error) {
      return failTo(error instanceof Error ? error.message : "This account cannot sign in.");
    }

    recordAudit({
      actorId: resolved.outcome.userId, actorName: resolved.outcome.username, action: "auth.oauth_login",
      result: "success", ip: ctx.clientIp, targetType: "session",
      metadata: { provider, created: resolved.created, linkedByEmail: resolved.linkedByEmail },
    });

    /*
     * A second factor must not be skipped just because the first one was a provider. Instead of a
     * session, hand the browser a short-lived ticket and let /login ask for the TOTP code.
     */
    if (resolved.outcome.requiresTotp) {
      const ticket = createTicket(resolved.outcome.userId);
      const response = new Response(null, { status: 302 });
      response.headers.set("location", `/login?oauth_2fa=${encodeURIComponent(ticket)}`);
      return response;
    }

    const user = findUserById(resolved.outcome.userId)!;
    const session = await issueSessionFor(user, ctx);
    const response = new Response(null, { status: 302 });
    response.headers.set("location", "/dashboard?welcome=" + (resolved.created ? "1" : "0"));
    response.headers.append("set-cookie", serializeCookie(SESSION_COOKIE, session.token, sessionCookieOptions(ctx.req)));
    response.headers.append("set-cookie", serializeCookie(OAUTH_STATE_COOKIE, "", { ...sessionCookieOptions(ctx.req), maxAge: 0 }));
    return response;
  });

  /**
   * Completes an OAuth sign-in for an account that has TOTP enabled. The ticket is unguessable,
   * single use, expires in five minutes, and is bound to the user the provider authenticated.
   */
  api.post("/api/auth/oauth/complete", async (ctx) => {
    const body = await ctx.body<{ ticket?: string; code?: string }>();
    const limiter = rateLimit(`oauth-2fa:${ctx.clientIp}`, 10, 5 * 60 * 1000);
    if (!limiter.allowed) {
      throw new ApiException(429, "rate_limited", `Too many attempts. Try again in ${limiter.retryAfterSeconds}s.`);
    }
    const userId = consumeTicket(String(body.ticket ?? ""));
    if (!userId) throw new ApiException(400, "ticket_expired", "That sign-in request expired. Please sign in again.");
    const user = findUserById(userId);
    if (!user || user.disabled) throw new ApiException(403, "account_disabled", "This account has been disabled.");

    const { verifyTotp } = await import("../security/totp");
    if (!verifyTotp(user.totp_secret ?? "", String(body.code ?? ""))) {
      recordAudit({ actorId: userId, actorName: user.username, action: "auth.oauth_login", result: "failure", ip: ctx.clientIp, metadata: { reason: "invalid_totp" } });
      throw new ApiException(401, "invalid_totp", "That two-factor code is not valid.");
    }

    const session = await issueSessionFor(user, ctx);
    recordAudit({ actorId: userId, actorName: user.username, action: "auth.oauth_login", result: "success", ip: ctx.clientIp, metadata: { secondFactor: true } });
    const response = json({ user: session.user, csrfToken: session.csrfToken, expiresAt: session.expiresAt, securityNotice: null });
    response.headers.append("set-cookie", serializeCookie(SESSION_COOKIE, session.token, sessionCookieOptions(ctx.req)));
    return response;
  });

  api.post("/api/auth/logout", async (ctx) => {
    const token = ctx.cookies[SESSION_COOKIE];
    if (token) {
      const session = validateSession(token);
      destroySession(token);
      if (session) {
        recordAudit({ actorId: session.user.id, actorName: session.user.username, action: "auth.logout", ip: ctx.clientIp });
      }
    }
    const response = json({ ok: true });
    response.headers.append("set-cookie", serializeCookie(SESSION_COOKIE, "", { ...sessionCookieOptions(ctx.req), maxAge: 0 }));
    return response;
  });

  api.get("/api/auth/me", async (ctx) => {
    if (!ctx.user) throw unauthorized();
    const unread = queryOne<{ c: number }>(
      "SELECT COUNT(*) AS c FROM notifications WHERE (user_id IS NULL OR user_id = ?) AND read_at IS NULL",
      [ctx.user.id],
    )?.c ?? 0;
    // The CSRF token is session-scoped and rotates on login. Returning it here lets a reloaded
    // page keep making authenticated mutations without forcing the user to sign in again.
    return json({ user: ctx.user, unreadNotifications: unread, csrfToken: ctx.session?.csrfToken ?? null });
  });

  api.post("/api/auth/password", async (ctx) => {
    if (!ctx.user) throw unauthorized();
    const body = await ctx.body();
    const input = validate(
      { currentPassword: v.string({ min: 1, max: 200 }), newPassword: v.string({ min: 10, max: 200 }) },
      body,
    );
    await changePassword(ctx.user.id, input.currentPassword!, input.newPassword!);
    destroyAllSessionsForUser(ctx.user.id);
    recordAudit({
      actorId: ctx.user.id, actorName: ctx.user.username, action: "auth.password_changed", ip: ctx.clientIp,
    });
    const refreshed = findUserById(ctx.user.id)!;
    const response = json({ ok: true, user: publicUser(refreshed), message: "Password updated. Other sessions were signed out." });
    response.headers.append("set-cookie", serializeCookie(SESSION_COOKIE, "", { ...sessionCookieOptions(ctx.req), maxAge: 0 }));
    return response;
  });

  api.post("/api/auth/password/check", async (ctx) => {
    const body = await ctx.body<{ password?: string }>();
    const password = String(body.password ?? "");
    return json(checkPasswordPolicy(password));
  });

  api.post("/api/auth/totp/setup", async (ctx) => {
    if (!ctx.user) throw unauthorized();
    const secret = generateTotpSecret();
    run("UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?", [secret, ctx.user.id]);
    return json({ secret, otpauthUrl: otpauthUrl(secret, ctx.user.username), issuer: "RSLMC" });
  });

  api.post("/api/auth/totp/enable", async (ctx) => {
    if (!ctx.user) throw unauthorized();
    const body = await ctx.body<{ code?: string }>();
    const code = String(body.code ?? "");
    const row = queryOne<{ totp_secret: string | null }>("SELECT totp_secret FROM users WHERE id = ?", [ctx.user.id]);
    if (!row?.totp_secret) throw badRequest("Start the two-factor setup first");
    if (!verifyTotp(row.totp_secret, code)) throw badRequest("That code is not valid. Check your authenticator app and try again.");
    const recoveryCodes = generateRecoveryCodes();
    run("UPDATE users SET totp_enabled = 1, totp_recovery = ? WHERE id = ?", [JSON.stringify(recoveryCodes), ctx.user.id]);
    recordAudit({ actorId: ctx.user.id, actorName: ctx.user.username, action: "auth.totp_enabled", ip: ctx.clientIp });
    return json({ ok: true, recoveryCodes });
  });

  api.post("/api/auth/totp/disable", async (ctx) => {
    if (!ctx.user) throw unauthorized();
    const body = await ctx.body<{ password?: string }>();
    const row = findUserById(ctx.user.id)!;
    const ok = await verifyPassword(String(body.password ?? ""), row.password_hash);
    if (!ok) throw badRequest("Password is incorrect");
    run("UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_recovery = NULL WHERE id = ?", [ctx.user.id]);
    recordAudit({ actorId: ctx.user.id, actorName: ctx.user.username, action: "auth.totp_disabled", ip: ctx.clientIp });
    return json({ ok: true });
  });

  api.get("/api/auth/sessions", async (ctx) => {
    if (!ctx.user) throw unauthorized();
    const rows = query(
      `SELECT id, ip, user_agent, created_at, last_seen_at, expires_at FROM sessions
       WHERE user_id = ? ORDER BY last_seen_at DESC`,
      [ctx.user.id],
    );
    return json({
      data: rows.map((row: any) => ({
        id: row.id, ip: row.ip, userAgent: row.user_agent, createdAt: row.created_at,
        lastSeenAt: row.last_seen_at, expiresAt: row.expires_at,
        current: row.id === ctx.session?.id,
      })),
    });
  });

  api.delete("/api/auth/sessions/:id", async (ctx) => {
    if (!ctx.user) throw unauthorized();
    run("DELETE FROM sessions WHERE user_id = ? AND id = ?", [ctx.user.id, ctx.params.id]);
    recordAudit({ actorId: ctx.user.id, actorName: ctx.user.username, action: "auth.session_revoked", ip: ctx.clientIp, targetId: ctx.params.id });
    return json({ ok: true });
  });

  api.get("/api/setup/status", async (ctx) => {
    // The absolute data directory is only useful to an administrator; an anonymous visitor gets the
    // same health information without the filesystem layout.
    const privileged = Boolean(ctx.user && (ctx.user.isRoot || ctx.user.permissions.includes("*")));
    const checks = [
      {
        id: "bun", label: "Bun runtime", status: "ok" as const,
        detail: `Bun ${Bun.version} on ${process.platform}/${process.arch}`,
      },
      {
        id: "database", label: "SQLite database", status: "ok" as const,
        detail: privileged ? DATA_DIR + "/database/rslmc.db" : "SQLite database is open and migrated",
      },
      {
        id: "java", label: "Java runtime manager",
        status: "ok" as const,
        detail: "Eclipse Temurin runtimes are downloaded on demand — no system Java required",
      },
      {
        id: "cgroups", label: "Kernel resource enforcement",
        status: detectCgroups().privileged ? ("ok" as const) : ("warn" as const),
        detail: detectCgroups().reason,
      },
      {
        id: "mode", label: "Panel mode",
        status: MODE === "production" ? ("ok" as const) : ("warn" as const),
        detail: MODE === "production" ? "Production mode" : "Development mode — secure cookies are disabled",
      },
    ];
    return json({
      needsSetup: needsSetup(),
      mode: MODE,
      version: APP_VERSION,
      port: PORT,
      checks,
      enforcement: describeEnforcement(),
    });
  });

  api.get("/api/setup/enforcement", async () => json(describeEnforcement()));
}
