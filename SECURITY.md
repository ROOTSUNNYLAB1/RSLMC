# RSLMC — security audit

An adversarial review of the panel: the code was read for dangerous patterns, and then the running
panel was attacked over HTTP/WebSocket by an automated harness (`tests/security/pentest.ts`).
Everything below was executed against a real instance, not inferred.

```
bun run tests/security/pentest.ts          # 101 checks, exit code 1 if any fail
bun run tests/security/pentest.ts --json   # machine readable, also written to last-run.json
```

Last run: **101 / 101 checks pass, 0 fail** (plus `bun test`: 106 pass / 640 assertions, `tsc --noEmit` clean).

---

## 1. What was found and fixed

Seven real defects were found by the harness (and one inconsistency while fixing them). All are
fixed, regression-tested, and every one now has a permanent check in the suite.

| # | Severity | Finding | Impact | Fix |
|---|---|---|---|---|
| 1 | **High** | **Cross-server schedule execution (IDOR).** `POST /api/servers/<A>/schedules/<id>/run` looked the schedule up by id only, so an id belonging to server **B** was executed. | A plain `User` with `server.schedules` on their own server could `stop`, `restart` or send console commands to **anyone else's** server. | `executeSchedule()` now takes the caller's `serverId` and the lookup is `WHERE id = ? AND server_id = ?`; a foreign id is a flat 404. `runHistory()` was scoped the same way (it leaked other servers' execution logs). |
| 2 | **High** | **Privilege escalation through user management.** An account with `user.manage` but not root could `PATCH /api/users/<self>` `{isRoot:true}`, create a root account, reset the root administrator's password, or assign itself a role more powerful than its own. | Full panel takeover by a delegated account manager. | Root-ness can only be granted/changed by a root actor; a root account cannot be modified by a non-root actor; assigning roles is limited to permissions the actor already holds (`assertCanGrantRoles`). All four paths return 403 and are covered by `authz.14–17`. |
| 3 | **Medium** | **No security headers on the HTML document.** The API branch set `x-frame-options`/`referrer-policy`, but the page itself had neither — and there was no CSP at all. | Panel could be framed by any site (clickjacking), and any future injected script had no second line of defence. | `applySecurityHeaders()` now runs for API, asset and document responses: `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `nosniff`, `Permissions-Policy`, and a strict CSP (`script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `form-action 'self'`). Verified in a real browser: zero CSP violations across 10 pages. |
| 4 | **Medium** | **Raw file editor bypassed the managed-property rule.** The typed Properties editor reserves `server-port`/`server-ip`, but `PUT …/files/content` on `server.properties` wrote whatever it was given. | A plain account could move its server onto a port the panel does not own (colliding with another server or the SSH port), silently breaking the allocation model. | `enforceManagedProperties()` restores the allocation-owned keys on every write of `server.properties` and the API returns a `notice`; the Files UI shows it as an honest warning toast instead of pretending the edit was saved. |
| 5 | **Medium** | **Compression-bomb denial of service.** Tar/zip extraction wrote until the disk was full; no size or entry budget existed. | A 200 KB upload could fill the host disk and take the whole panel (all servers) offline, not just one server. | Shared extraction budget: 4 GB uncompressed and 200k entries by default (`RSLMC_EXTRACT_MAX_MB` raises it). Zip entries are charged with their *declared* uncompressed size before inflation. |
| 6 | **Low** | **Absolute data-directory path disclosed anonymously.** `GET /api/setup/status` returned `/opt/rslmc/database/rslmc.db` to any visitor. | Fingerprinting / information disclosure for an unauthenticated attacker. | The path is only returned to an administrator; anonymous visitors get a neutral description. |

| 7 | **Medium** | **Typed Properties editor was inconsistent with the file manager.** `PUT …/properties` required `server.settings`, so a plain account could edit `server.properties` by hand in the file manager but every field in the typed editor was disabled. | Either the account could change everything (by hand) or nothing (in the editor) — the UI was misleading, and it also accepted a reserved key silently instead of explaining. | The typed editor now needs `server.files` (the same permission the raw editor needs). A reserved key that would actually *change* is refused by name (`server-port is managed by RSLMC…`), while the editor's habit of posting the whole value map is still ignored. Saving `motd`-style keys works for the account that owns the server. |

Additionally hardened while reviewing: the public-address field now refuses loopback, RFC1918,
CGNAT, multicast and link-local literals (**including `169.254.169.254`**, the cloud metadata
endpoint) with an explanation, instead of silently storing an address no player can reach.


---

## 1b. Single sign-on (added after the round above, reviewed the same way)

Eleven new checks (`sso.1`–`sso.11`) attack the Discord/Google-Firebase flow. What they assert:

| Check | Guards against |
|---|---|
| `sso.1` / `sso.2` | A provider that is not fully configured is neither advertised by `GET /api/auth/oauth/providers` nor able to start a redirect (no half-built button that can only fail). |
| `sso.3` | The client secret and Firebase key never appear in the public provider list, the admin view or the audit log — the API only reports *whether* a secret is stored. |
| `sso.4` | The authorization redirect goes to the provider's own origin, carries a ≥20-char `state` and `code_challenge_method=S256`, and the state cookie is `HttpOnly; SameSite=Lax`. |
| `sso.5` | A callback arriving without the matching state cookie is refused (login CSRF). |
| `sso.6` | A `redirect_uri` supplied in the callback query cannot turn the panel into an open redirect: the error path is always a relative `/login?…`. |
| `sso.7` | A state is single-use even when the first attempt fails at the token exchange — replay lands on "expired or already used". |
| `sso.8` | A state minted by one provider is refused by the other. |
| `sso.9` | A forged two-factor ticket never yields a session, and repeated guesses hit the rate limiter (429). |
| `sso.10` | `GET/PUT /api/system/oauth` requires `system.manage` (anonymous 401, `User` 403) **and** a valid CSRF token. |
| `sso.11` | A plain user cannot unlink another account's provider identity. |

Design decisions that the checks protect: accounts created through a provider get the registration
default role (`User`), no servers, and an unusable password hash (`!oauth:<uuid>`); an identity is
only ever linked to an existing account when the provider marks the email **verified**; unlinking the
last identity of a password-less account is refused. Unit coverage for the same logic lives in
`tests/oauth.test.ts` (20 tests: config gating, PKCE derivation, single-use state, account mapping,
email-collision handling, tickets, unlinking).

Honest limit: **no real Discord or Google application was available in this environment**, so the
token/profile exchange is exercised only up to the provider's HTTP error (which the harness asserts
is handled as a clean `/login?oauth_error=…` redirect, never a stack trace or a 500). Everything
before and after that network boundary is tested for real.


---

## 1c. Profile pictures (upload surface)

Eight checks (`avatar.1`–`avatar.8`) cover the only place in the panel where a user hands the server
arbitrary bytes.

| Check | Guards against |
|---|---|
| `avatar.1` | A real image is accepted and returns a URL with a version query, so a replacement is never masked by the browser cache. |
| `avatar.2` | The picture is served back with its image MIME type and `nosniff` — an uploaded file can never be executed as a document. |
| `avatar.3` | An SVG/HTML payload or a PHP script renamed to `.png` is refused: the format is decided by **magic bytes**, never by the extension or the browser-supplied content type. |
| `avatar.4` | A 3 MB upload is rejected with 413 before anything is parsed or written. |
| `avatar.5` | Uploading requires a session **and** a CSRF token (anonymous → 401, no token → 403). |
| `avatar.6` | A plain user cannot read another account's picture, so account ids cannot be enumerated through avatars. |
| `avatar.7` | The file that is served is chosen server-side; a `?file=../../secrets/...` in the URL has no effect. |
| `avatar.8` | Removing a picture really deletes the bytes, not just the row. |

Storage rules worth stating: the filename is generated by the server (`u<id>-<sha256 prefix>.<ext>`),
the previous file is deleted on replace, writes are staged in the same directory and renamed (so a
half-written file can never go live), `..` can never appear in a served name, and leftovers from
deleted accounts are pruned at boot. Unit coverage: `tests/avatars.test.ts` (11 tests, including a
hand-assembled PNG/JPEG/WebP so the detector is tested against real headers).

Honest limit: the image is stored byte-for-byte and never re-encoded, so a technically valid but
huge dimension image is only bounded by the 4096×4096 header check and the 2 MB size limit.


---

## 1d. Appearance (theme preference)

Five checks (`theme.1`–`theme.5`) cover the small per-account write behind *My Profile → Appearance*:

| Check | Guards against |
|---|---|
| `theme.1` | The catalogue is readable by a signed-in account (and it is the server's list, so the UI can never offer an id the API would reject). |
| `theme.2` | A choice is persisted on the account and returned by `/api/auth/me` — it is not a browser-only cosmetic. |
| `theme.3` | An unknown or hostile theme id (`"><img src=x onerror=…>`, `neon-overdrive`) is rejected with 400 and the stored value is untouched. Theme ids are a closed set, never free text. |
| `theme.4` | Changing it needs a session **and** a CSRF token (anonymous → 401, no token → 403). |
| `theme.5` | The endpoint takes no user id: a caller cannot repaint somebody else's account. |

The values are rendered as a `data-theme` attribute on `<html>`, which only selects a CSS block —
nothing from the request is ever interpolated into markup or a style attribute. `tests/themes.test.ts`
(8 tests) additionally asserts the palette stays dark and non-neon (accent saturation and lightness
bands, background lightness) and that every accent clears 4:1 contrast against its own background.

---

## 2. What the harness proves is already right

| Area | Checks | Detail |
|---|---|---|
| Authentication | 6 | Anonymous API access, forged cookies and anonymous console reads are refused. Login answers *identically* for "no such user" and "wrong password" (no username enumeration), and repeated failures end in `429`. |
| Session | 6 | Cookie is `HttpOnly`, `SameSite=Lax`, ≥32 random bytes; a new token is minted on login (no fixation); revoked sessions die immediately; a password change kills the session that made it. |
| CSRF | 3 | Mutation without a token → 403, wrong token → 403, valid token but a foreign `Origin` → 403. |
| Authorization (IDOR) | 16 | Another account's server is a flat **404** (not "forbidden", which would confirm it exists) for read, power, files and backups. A plain user is refused `/api/users`, `/api/roles`, `/api/audit`, `/api/system`, `/api/admin/overview`, `/api/nodes`. Allocation and infra settings are 403. |
| Privilege escalation | 8 | Self-promotion to root, self-role-escalation, creating a root account, resetting the root password, creating roles, creating admin accounts — all 403. |
| Path traversal | 6 | Six traversal/absolute-path variants against read, download, listing and player-data lookup; plus a **real symlink to `/etc`** placed inside the server folder (refused). |
| Zip-slip | 1 | A tar.gz whose entry is `../../../../tmp/…` is rejected; no file appears outside the server folder. |
| SQL injection | 1 | Five injection payloads through `search`, `actor` and `perPage` — no 500s, no dropped tables; all queries are parameter-bound. |
| Prototype pollution | 2 | `__proto__` in a JSON body does not touch `Object.prototype`. |
| SSRF | 2 | The public-host field cannot carry a URL/metadata endpoint; marketplace project ids cannot rewrite the upstream API URL. |
| Command injection | 1 | Console commands go to the JVM's stdin, never through a shell. |
| Cross-object access | 7 | Backup, schedule and run-history ids from another server are 404. |
| Secrets | 4 | `/api/system` returns setting *keys* only; the agent secret is never serialised; the RCON password comes back as `rconPasswordSet: true` only; passwords never appear in the audit log. |
| Information leak | 3 | Error bodies carry no stack trace or absolute path; unknown routes are a flat 404; anonymous setup status no longer leaks paths. |
| Headers | 7 | CSP, X-Frame-Options, nosniff, referrer policy, `no-store` on API responses, and no wildcard CORS for credentialed requests. |
| WebSocket | 2 | Anonymous upgrades refused; a socket cannot be opened for a server the user does not own (access is re-checked on every `subscribe`). |
| Resource limits | 2 | A 12 MB JSON body is rejected; extraction has a byte/entry budget. |
| Destructive actions | 1 | Deleting a server requires typing its name. |

### Reviewed by reading the code, too

* **No XSS sinks.** `dangerouslySetInnerHTML` / `innerHTML` appear nowhere in `frontend/` or `src/`;
  console output, filenames, MOTDs and player names are rendered as React text nodes.
* **Rate limiting cannot be bypassed with headers.** The client address comes from the socket
  (`srv.requestIP()`), not from `X-Forwarded-For`, so rotating the header does not reset a bucket.
* **Argon2id everywhere** (`memoryCost 19456`, `timeCost 2`), including the dummy hash used for
  unknown usernames so login timing does not leak account existence.
* **Downloads cannot inject headers**: filenames with CR/LF are rejected before the
  `Content-Disposition` header is built.

---

## 3. Known limits of this audit (stated honestly)

* The harness runs against a **development-mode** instance on localhost with `RSLMC_COOKIE_SECURE=never`.
  In production behind TLS the cookie is `Secure` (verified by the `isSecureRequest` tests), but I have
  not run the panel behind nginx/Caddy in this round.
* **Not tested:** multi-node agent transport (no agent exists yet), the Modrinth download path with a
  hostile upstream response, Java runtime archives from Adoptium (checksums are verified in code but not
  fuzzed), and long-running resource exhaustion.
* **Not covered:** physical/host compromise, a malicious *administrator* (root can do anything by
  design), and third-party plugins installed on a Minecraft server — a plugin runs inside that server's
  JVM with the panel's user, which is a real boundary that RSLMC does not sandbox. That is the same
  trade-off Pterodactyl makes and is called out in the README.
* The panel is a **local-trust** tool: anyone who can write to the data directory can replace the
  database. File permissions on `%ProgramData%\RSLMC` / `/opt/rslmc` are the operator's job.

---

## 4. Reproducing

```bash
cd rslmc
bun install
bun test                              # 106 unit/integration tests (11 files)
bun run tests/security/pentest.ts     # 101 adversarial checks against a throwaway instance
```

The harness creates its own data directory in `$TMPDIR`, boots the panel on port 3941, seeds two
plain users and two servers, runs every check, and deletes nothing outside its temp folder. Exit code
is non-zero when a check fails, so it can gate a release.
