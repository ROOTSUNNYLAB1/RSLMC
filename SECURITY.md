# RSLMC — security audit

An adversarial review of the panel: the code was read for dangerous patterns, and then the running
panel was attacked over HTTP/WebSocket by an automated harness (`tests/security/pentest.ts`).
Everything below was executed against a real instance, not inferred.

```
bun run tests/security/pentest.ts          # 125 checks, exit code 1 if any fail
bun run tests/security/pentest.ts --json   # machine readable, also written to last-run.json
```

Last run: **127 / 127 checks pass, 0 fail** (plus `bun test`: 31 files, 265 tests, 0 fail; `tsc --noEmit` clean).

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
| 8 | **Low** | **One render error blanked the entire panel.** `CreateServer.tsx` read its `form` state above the `useState` that declares it, so the first render threw `Cannot access 'form' before initialization`; React then unmounted the whole tree and the operator got a black window with no navigation and no message. Triggered simply by opening *Servers → New Server*. | The wizard — and with it the only way to create a server — was unusable, with no way to see why. | The read was moved below its declaration, and every route is now wrapped in an `ErrorBoundary` keyed by pathname: the shell survives, the failing view names the error and offers reload / try again / back to the dashboard. Guarded by `tests/page-render.test.ts`, which renders the pages in happy-dom and asserts the boundary keeps the surrounding tree mounted. |

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


## 1e. Same-origin check behind a proxy (hardening, reported from a real deployment)

Every non-GET request carries a CSRF token; the `Origin` check is the second lock. It compared whole
origin strings against the address the panel itself received, so on any deployment where TLS ends at
a proxy the panel saw `http://panel.example.com` while the browser sent
`https://panel.example.com` — and *every* write came back `403 origin_invalid`. The lock was jammed,
not doing its job.

`src/security/origin.ts` now compares **hosts** (case-insensitive, default ports normalised) against
the URL host, `X-Forwarded-Host`, and the optional `RSLMC_PUBLIC_URL`. Still refused: another
hostname, a lookalike subdomain (no suffix matching), a different port, `null`, and unparsable
origins — all covered by `tests/origin.test.ts` (11 cases). A rejection is now diagnosable: the
response names the origin it received and the hosts it accepts, and the same line is written to the
panel log.

Related, also from that deployment: a `403` produced by Cloudflare or nginx (HTML block page, `cf-ray`
header, no `x-rslmc-version`) is reported in the UI as an edge refusal with the method and path to
allow, instead of the misleading "Request failed with HTTP 403" that sends an operator hunting for a
permission problem inside the panel. The CSP stays `script-src 'self'`; a proxy that injects
Cloudflare Web Analytics is blocked by design, and `RSLMC_CSP_SCRIPT_SRC` is an explicit, logged
opt-in for operators who want that script anyway.

---

## 1f. External review, 2 November 2026 (K1, H1–H9, M1–M14, L1–L12)

An independent review of `2b99ac7` reported one critical, nine high, fourteen medium and twelve low
findings. This round fixed every critical and high finding, and the medium/low findings that are
reachable from the HTTP surface. Each fix has a check in `tests/security/pentest.ts`
(`audit.*`) or in the unit suites, so it cannot quietly regress.

**Fixed**

| ID | What was wrong | What it is now |
|---|---|---|
| K1 | `extract=true` uploads built the temp path from the multipart `filename`, so `filename="/../../victim/pwned"` wrote outside the temp folder | temp path is `randomUUID()` + a whitelisted extension; cleaned up in `finally` |
| H1 | `assertCanGrantRoles` returned early for an unknown role name, and the caller skipped that name — `["Administrator","ghost"]` granted Administrator to a plain `user.manage` holder | unknown names are a `400`; one resolution path (`resolveRoleIds`) for create *and* patch |
| H2 | `level-name` was joined onto the server directory in four places | `isSafeLevelName` (single segment, no `..`) enforced on write and used at every read site; world folder names validated before `rename`/`rm` |
| H3 | A `role.manage` holder could add any permission to a role it already had | `assertCanWritePermissions`: you cannot write a permission you do not hold |
| H4 | `DELETE /api/users/:id` skipped the root guard that PATCH and password reset enforce | root accounts are only deletable by a root administrator |
| H5 | `registration.defaultRole` accepted `Administrator` | refused when the role grants anything from `DANGEROUS_PERMISSIONS`; the least-privilege fallback also skips such roles |
| H6 | The node proxy mapped unlisted writes to `server.view`, decided `/power` from the URL, and skipped the Origin check | explicit table, deny-by-default for unlisted writes, body-aware power action, Origin check and rate limit applied to forwarded writes |
| H7 | `/api/servers/:id/map/web/*` served user-written HTML on the panel origin — stored XSS with the viewer's session | served with `Content-Security-Policy: sandbox` (opaque origin, no `allow-same-origin`), `X-Frame-Options: SAMEORIGIN` so the Map page can embed it, and the iframe repeats the sandbox |
| H8 | The updater skipped verification when the checksum file was missing or unreadable, and used the first hash in the file | fail closed, hash matched **by asset name**, four redirect hops re-validated against a GitHub-only host list |
| H9 | `install.sh` sourced `.rslmc-install` from a service-writable directory and executed `rslmc-ctl` from it as root | state file is parsed (four known keys, absolute paths only, `.env` suffix), never sourced; the control script is installed root-owned in `/usr/local/sbin`; the updater never replaces `.rslmc-install`, `rslmc-ctl` or `install.sh` |
| M2 | An OAuth callback with **no** state cookie skipped the comparison (login CSRF) | both halves required |
| M3 | A WebSocket kept the permissions it was opened with, and stayed open after the account was disabled | session re-validated on every message and every heartbeat; socket closed on revocation |
| M4 | `/api/agent/*` had no permission check | controller-only (`nodeControllerUser`), everything else `403` |
| M5 | `POST /api/auth/totp/setup` disabled an existing second factor with no password | current password required when 2FA is already on |
| M6 | `-XX:MaxHeapSize` / `-XX:MaxRAMPercentage` in `jvmArgs` overrode the panel's `-Xmx` | refused in both create and update, like `-Xms`/`-Xmx` already were |
| M7 | `gunzipSync` inflated the whole archive before the extraction budget ran | bounded decompression at the documented `RSLMC_EXTRACT_MAX_MB` ceiling |
| M8 | Extraction wrote through a pre-existing symlink; `resolveServerPath` followed *dangling* links | links inside the destination are refused; dangling links cannot be written through |
| M9 | `--path /opt/../etc` bypassed the deny-list and reached `chown -R`/`mv`/`rm -rf` as root | both paths canonicalised first; `/`, `/etc`, `/usr/*`, `/var/*` … refused for the install path, `/` refused for the data folder, install path inside the data folder refused |
| M11 | An unreachable `SHASUMS256.txt` for Bun warned and installed anyway | installing Bun now requires a matching checksum (`RSLMC_SKIP_BUN_CHECKSUM=1` is a deliberate, logged opt-out) |
| M12 | The updater accepted any HTTPS host and used `redirect: "follow"` | GitHub-only host list, redirects followed manually and re-validated per hop |
| L1 | Current-password verification had only the generic 120/min limiter | 10 attempts/minute per account on password change and 2FA disable |
| L2 | `buckets.clear()` at 20 000 keys was a global fail-open | expired/LRU eviction instead |
| L4 | `/api/panel/about` returned absolute host paths to any signed-in account | admin-only (`system.manage`); the About page renders "hidden for your role" |
| L5 | Login answered `account_disabled`/`account_locked` before checking the password, enumerating accounts | password verified first; an unknown caller always sees the same `401` |
| L6 | `POST /api/servers` accepted any `ownerId` from a `server.create` holder | assigning another owner needs `user.manage`/`system.manage` |
| L8 | Relay token compared with `!==` | constant-time compare |
| L9 | `/ws` skipped the Origin check and had no frame cap | `checkOrigin` applied, 64 KB frame limit, oversized frames closed with `1009` |
| L11 | Downloads validated the first host, then followed redirects blindly | every hop re-validated (`http:`, internal hosts, unknown domains all refused) |
| L12 | Windows device names (`CON`, `NUL`, `aux.txt`) and trailing dots/spaces were accepted | refused with an explicit message |
| M10 | `${{ steps.version.outputs.version }}` (a tag name) was interpolated into `run:` in a `contents: write` job | the version is validated as CalVer and passed through `env`; `ci.yml` has `permissions: contents: read`; Bun is pinned |
| M1 | The startup banner and the login notice claimed the panel *forces* a password change; it never did | no forced change is added (by the operator's explicit decision) — the claim is gone, and both messages now say what is true |

**Deliberately not changed**

* **M1, forced password change.** The operator's instruction for this round is that the bootstrap
  `admin`/`admin123` account must stay usable with no forced reset. What M1 also asked for — that the
  panel stop *claiming* an enforcement it does not perform — **is** done.
* **M1, `HOST` default.** Still `0.0.0.0`, because changing the default would silently make existing
  installs unreachable. The installer asks which interface to bind and `RSLMC_HOST` overrides it.

**Still open (tracked, not fixed in this round)**

* **M13/M14** — PID reuse when re-adopting a running server (`startedAt` is read but not compared) and
  the 1500 ms `forceKill` timer that can clobber a Start in the same window. Both need a redesign of the
  lifecycle lock, not a patch.
* **L3** — TOTP codes have no used-code ledger, TOTP failures do not count toward the lockout, and the
  generated recovery codes are never accepted anywhere. The UI does not currently promise recovery.
* **L7** — `server_subusers.permissions` is stored but never read: a sub-user gets the full server.
  Sub-user scoping is a feature, not a one-line check.
* **L10** — a node `fqdn` is admin-controlled and re-probed every 15 s (SSRF by an administrator, who
  can already do anything) and the agent key is not scoped per endpoint.
* **§5 dead code** — the review lists ~330 lines of unreferenced exports. Removing them is safe but
  touches many files; it is queued rather than rushed into a security release.

---

## 1g. Follow-up review, 2 November 2026 (R1–R4, O1–O6)

A second review looked at `3b6efdd` and found four regressions — three of them mine — plus the
round-one items that had been deferred. All of them are fixed here, and each one has a test that
fails without the fix.

| ID | Type | What was wrong | What it is now | Test |
|---|---|---|---|---|
| **R1** | Blocker | `install.sh` called `canonical_path` 200 lines before it was defined, so **every** install and upgrade aborted at step `[2/14]`. `bash -n` and shellcheck both pass on that | the helper is defined above its first use; `scripts/installer-smoke.sh` runs the real installer in `--dry-run --unattended` mode (four path shapes) and checks the definition order of every helper. Wired into CI and into `bun run test` | `tests/installer.test.ts` |
| **R2** | High | The node proxy demanded `server.settings` for the EULA, the startup preset and BlueMap setup, while the local routes ask for `server.start`, `server.startup` and `server.plugins`. The built-in `User` role has the latter and not the former, so the same account could accept the EULA locally and got 403 on a remote server | one table, `src/shared/server-permissions.ts`, shared by both paths; `tests/server-permissions.test.ts` parses `api/server-routes.ts` and fails if they ever disagree again; `tests/nodes.test.ts` drives the real proxy as a plain `User` | `tests/server-permissions.test.ts`, `tests/nodes.test.ts` |
| **R3** | Low | "Deny by default" was actually "default to `server.settings`": the trailing `{ prefix: "" }` row matched everything, so the `if (!hit)` branch was unreachable | the catch-all row is gone; an unlisted write is refused with `unsupported_action`, and the test asserts there is no catch-all | `tests/server-permissions.test.ts` |
| **R4** | Medium | `timingSafeEqual` throws `RangeError` on unequal lengths — introduced by the L8 fix — so `{"type":"hello","token":"x"}` killed the relay process and orphaned the JVM it owned | lengths compared first, plus `uncaughtException`/`unhandledRejection` handlers that log to `<state>.errors.log` instead of exiting | `tests/relay.test.ts` (sends the exact frame) |
| **O1** | Medium | Pid reuse on adoption; the `forceKill` timer nulled state 1500 ms after the lock was released, clobbering a Start; `restartServer` was the only lifecycle action outside `withLock` | every adopted/spawned pid carries a kernel start-time fingerprint (`processStartMark`) and is only signalled when the fingerprint still matches; the kill timer only clears the state it was started for; restart holds the lock and uses the unlocked internals (calling the locked `startServer` from inside the lock would deadlock); `isProcessAlive(0)` no longer signals the panel's own process group | `tests/process-identity.test.ts` |
| **O2** | Low | TOTP codes were replayable inside their 90 s window, wrong codes did not count toward the lockout, and recovery codes were generated, shown and **never verified** | `totp_last_step` ledger (migration 014), failed codes increment `failed_attempts`/`locked_until`, recovery codes are matched in constant time and consumed on use; the login form accepts them | `tests/totp.test.ts` |
| **O3** | Low | `server_subusers.permissions` was written nowhere and read nowhere: every sub-user got the account's full role on that server | the scope is written when a share is granted (the role's server-level permissions, or an explicit `scope` map on `PUT /api/users/:id/servers`) and enforced in `requireServerAccess` | pentest `followup.o3` |
| **O4** | Low | A node `fqdn` was re-probed every 15 s with only a loopback+same-port check, so a URL pointing at a cloud metadata service was a permanent SSRF | `src/nodes/address.ts` refuses link-local/metadata ranges (`169.254.0.0/16`, `100.100.100.200`, `fd00:ec2::254`) and wildcard addresses, resolves hostnames before storing them, and re-checks the host on **every heartbeat** so a DNS change cannot quietly redirect the panel. LAN addresses stay allowed — that is what multi-node is for | `tests/node-address.test.ts` |
| **O5** | Low | Dead code, including two traps: `Route.meta` looked like an authorisation hook and was never read; `security.manage` was declared and required by no route | both removed. The remaining ~330 lines of unused exports are listed in the archive review and can go incrementally without touching behaviour | — |
| **O6** | Low | Directories were created without charging the extraction budget (an archive of empty folders defeated the 200k guard), and uploads were measured only after `formData()` had buffered the whole body | directories are charged; the upload route refuses an oversized `Content-Length` **before** parsing (the post-parse check stays as the real enforcement, since `Content-Length` is advisory) | pentest `followup.o6` |

**Not changed, on purpose**

* **Cloud metadata blocking is not configurable.** There is no legitimate reason to register one as a
  node; an operator who needs it can patch the list.
* **The node agent key is still node-wide.** Per-endpoint scoping would be a protocol change between
  panels; a leaked key owns that one node (documented in §3), and the key is never returned by any read
  endpoint (checked by `node.8`).

---

## 1h. Second follow-up review, 3 November 2026 (N1–N3)

Audit 2 re-read `d79d5ac` and confirmed every R and O item, then found one authorisation asymmetry in
the *new* code — which turned out to be two bugs, not one.

| ID | Type | What was wrong | What it is now | Test |
|---|---|---|---|---|
| **N1a** | Medium | The sub-user scope is enforced by `requireServerAccess`, which only local routes call. The node proxy checked the account's **role**, then ownership, and never read `server_subusers.permissions` — so a share scoped to `server.view` was read-only on a local server and unrestricted on a remote one | the scope rule lives in one place, `assertWithinSubuserScope` / `subuserScopeRefusal`, and the proxy calls it with the same expression the local route would use (`ACCESS` counts as `server.view`) | `tests/nodes.test.ts` — real second panel, scoped account: file read forwarded, `power`/console refused `403 subuser_scope`, widening the share allowed again; pentest `followup.n1` |
| **N1b** | Medium | `PUT /api/users/:id/servers` only wrote a scope when the share was *created* (`if (currentShared.has(id)) continue`), so narrowing an existing grant answered `200` and changed nothing. The control looked like it worked | the scope is written on every call (`INSERT … ON CONFLICT DO UPDATE`) | pentest `followup.n1` |
| **N1c** | Low | `/api/servers/:id/files` was listed as `ACCESS` in the proxy table while its handler asks for `server.files`. Nothing caught it because the drift test only parsed `server-routes.ts`, and the row was unreachable anyway: `/files/*` matched `/files` and sorted first | the row says `server.files`; a trailing `*` no longer shadows an exact-depth rule; the drift test now reads `file-routes.ts` and `ws.ts` as well | `tests/server-permissions.test.ts` (79 checks, incl. three rule-selection tests) |
| **N2** | Low | `isSameProcess` returned `true` when a fingerprint was recorded but unreadable — and the panel's own spawn path never recorded one at all, so every locally started server fell back to liveness-only | fingerprints are recorded at spawn; identity is a four-state answer (`dead` / `verified` / `mismatch` / `unmarked`) and `isSameProcess` is `verified` only. A kill on an unmarked pid logs that it is going on liveness alone; an adopted pid whose fingerprint stops matching is released instead of being reported as "exited" | `tests/process-identity.test.ts` (10 checks) |
| **N3** | Trivial | Unused imports after the permission rewrite, plus 53 never-referenced exports (~330 lines) left queued by `d79d5ac` | the 53 exports and 83 unused imports are gone; `typecheck`, the full suite and the build are green. Nothing was left "queued" | `bun run typecheck`, `bun run test`, `bun run build` |

**Not changed, on purpose**

* An **unmarked** pid is still signalable. Refusing outright would strand servers started before this
  release — the panel could no longer stop them. The behaviour is now explicit, logged, and gone for
  every process spawned from here on.
* The proxy's block list stays deny-by-default. A route added to `api/` without a table entry fails
  `tests/server-permissions.test.ts` rather than silently becoming unreachable remotely.

---

## 1i. Docker runtime (2026.11.04.4, diagnosis 2026.11.04.5)

A server can now run inside a Docker container instead of directly on the host. The threat model
changes, so it is written down here rather than left to the code.

**What gets stronger.** Memory and CPU limits stop depending on the host's cgroups and a privileged
helper: `--memory`, `--memory-swap` and `--cpus` put the server in its own cgroup and the kernel
enforces it. The old honest caveat — "partly enforced" — becomes "enforced by the container".

**What the panel deliberately does not do**

* **No Docker socket in the container.** The JVM gets `/data` and nothing else. It is not a sibling
  container with the daemon socket mounted, so a compromised plugin cannot start a privileged
  container as a stepping stone.
* **No `--privileged`, no added capabilities, no host networking unless asked.** Host networking is an
  operator choice (`RSLMC_DOCKER_NETWORK=host`), because Minecraft's UDP traffic and bridge-less
  daemons need it; it is reported in the plan preview, not hidden.
* **No image the operator did not choose.** Only the yolks/Temurin references the wizard lists are
  pulled, and a reference is validated before it is passed to the CLI.
* **Disk limits are not claimed when they cannot be enforced.** `--storage-opt size=` requires a
  storage driver that supports quotas (btrfs/zfs/devicemapper, or overlay2 on a project-quota
  filesystem). The daemon is asked; when it cannot, the panel says "measured, not capped" — the same
  rule the panel already follows for standalone servers.

**New failure modes, and what the panel does about them**

| Failure | Behaviour |
|---|---|
| No daemon / socket permission denied | `docker info` **exits 0** with an empty document and `ServerErrors`; the probe reads that, then diagnoses the *cause* from the machine — which account the panel runs as, its real supplementary groups (`/proc/self/status`), the socket's mode/group, and other sockets present — and reports the fixes in order. Create refuses with `docker_unavailable`; the wizard shows the diagnosis and disables the option |
| Image missing at start | pulled first, progress streamed into the console; a failed pull is `502 image_pull_failed` with the CLI's message |
| Leftover container from a crash | removed before `docker run` so the name is reusable; a container still running from a previous panel session is adopted and shown as `recovering` |
| `docker stats` on a stopped container | returns nulls, so no metrics are published — the last sample is never presented as live |
| `--cpus` larger than the host | refused by the daemon with exit 125 before the JVM runs. The value is clamped to `docker info`'s NCPU (or the panel's own cores) and the difference is reported — a limit that cannot be granted is never presented as if it were |
| Kill | `docker kill` + `docker rm -f`, with a bounded wait for removal; a pid-tree walk cannot reach a containerised JVM |
| Deleted server | its container is removed with it, so the port and the name are freed |

**Privileges.** `RSLMC_DOCKER_SUDO=1` runs the CLI through `sudo -n` (never an interactive prompt, which
would hang a probe) — and applies to the container launch, not only to the probe: the launch prefix comes
from the same `dockerInvocation()` the probes use, so "the wizard offered Docker and the server died with
`permission denied`" cannot recur. It is opt-in and the sudoers entry should name the docker binary, not `ALL`; the
panel never asks for root for anything else. `RSLMC_DOCKER_HOST` is honoured because the default socket
is not the only real endpoint (rootless Docker, Podman, TCP proxy) — without it the panel would insist on
`/var/run/docker.sock` while the operator's own CLI talks elsewhere.

**The endpoint is a privileged setting, so it is treated as one.** `POST /api/panel/docker/config`
requires `system.manage` (administrators only), a CSRF token, and a scheme Docker actually speaks —
`unix://`, `tcp://`, `http(s)://`, `npipe://`, `ssh://`, `fd://` or a bare context name; `file://` and
anything else is refused with `bad_endpoint` before it reaches a command line. The value decides *which
daemon the panel obeys*, so a plain `User` must never be able to set it (pentest `upd.14`–`upd.18` pin
that down). It is **only stored after a successful probe**: a value that cannot reach a daemon is
rejected and the previous configuration is left untouched, which also means the panel cannot be locked
into an unreachable endpoint by a typo. Precedence is `RSLMC_DOCKER_HOST` > saved setting > `DOCKER_HOST`
> platform default, and the source is always reported in the UI, so an override inherited from a systemd
unit cannot masquerade as the default.

**Diagnosis, not a script.** The reason shown for an unreachable daemon is derived from the panel's own
facts: elevation (`uid 0` / Administrator), the namespace it is in (`/.dockerenv`, `/proc/1/cgroup`,
mountinfo), the endpoint and the layer that chose it, the socket's mode/group compared against the
process's *supplementary* groups, `~/.docker/config.json`'s `currentContext`, and the probe's raw output.
Group advice is never shown to a panel that is already root, because it cannot act on it — that
mismatch was a real bug report. The environment the CLI inherits (`PATH`, `DOCKER_HOST`,
`DOCKER_CONTEXT`, `RSLMC_DOCKER_BIN`) is shown so a shell/service disagreement is visible instead of
mysterious.

**Tests.** `tests/docker.test.ts` asserts the real command line (memory, swap, cpus, bind mount, path
translation, quota only when supported, reference validation). `tests/docker-live.test.ts` starts a
real container when `RSLMC_TEST_DOCKER=1` and reads the limits back from the daemon.

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
* **Multi-node** now has its own checks (`node.1`–`node.11`): the agent surface refuses an unknown or
  missing key, a bearer token cannot reach normal routes on a panel that never enrolled, node routes
  need `node.view`/`node.manage`, registering a node without CSRF is refused, a node cannot be pointed
  at its own panel, the stored agent key is never returned by any list endpoint, and a traversal
  through a server path cannot reach node routes. Two-panel behaviour (forwarding, deletion, offline
  handling) is covered by `tests/nodes.test.ts`.
* **Not tested:** the node link over an untrusted network (the harness runs both panels on localhost,
  so TLS certificate validation for a remote node is not exercised), the Modrinth download path with a
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
bun test                              # 441 unit/integration tests (41 files)
bun run tests/security/pentest.ts     # 151 adversarial checks against a throwaway instance
bash scripts/installer-smoke.sh       # runs install.sh --dry-run for every path shape
```

The harness creates its own data directory in `$TMPDIR`, boots the panel on port 3941, seeds two
plain users and two servers, runs every check, and deletes nothing outside its temp folder. Exit code
is non-zero when a check fails, so it can gate a release.
