# Updating RSLMC

RSLMC updates itself from its own GitHub releases. There is no upload step, no SSH required, and —
the part that matters on a live host — **an update never stops a Minecraft server**.

Everything below is implemented in this repository; nothing here is aspirational.

---

## Calendar versioning

Versions are dates: `2026.11.02` is a build from 2 November 2026. A second release on the same day
becomes `2026.11.02.1`. That is deliberately the only thing an operator needs to know — comparing two
versions is comparing two dates, and nobody has to remember what "1.4" meant.

- The single source of truth is `version` in `package.json`; the startup banner, the About page, the
  `x-rslmc-version` response header and the updater all read it.
- `bun run release` bumps it to today (or to today's next revision) and prints the tag commands.
- Pushing a `v<version>` tag runs `.github/workflows/release.yml`, which typechecks, tests, builds
  `rslmc-<version>.tar.gz` and its `SHA256SUMS`, and publishes the GitHub release. Those two assets
  are exactly what a panel downloads.

---

## How a panel finds out

`src/update/service.ts` polls the public GitHub API (`GET /repos/<owner>/<repo>/releases`) — no
token, no account, no identifiers of any kind. The result is stored in SQLite (table
`panel_update_settings`), so the answer survives a restart and the UI never waits on the network.

| Setting | Default | Where to change it |
| --- | --- | --- |
| Automatic check | on | Administration → About → Update channel |
| Interval | every 6 hours (min 30 min) | same |
| Pre-releases | off | same |
| Repository | `ROOTSUNNYLAB1/RSLMC` | `RSLMC_GITHUB_REPO` |

When a newer release appears, administrators get a notification, a strip under the top bar
(“Update available for RSLMC”), and the full picture on **Administration → About**: current version,
new version, release age, the release notes, whether a checksum was published, and a button.

<img src="screenshots/update-hero.png" alt="Update available on Administration → About" width="100%">

The panel never claims to be up to date when it could not check — the last error is shown verbatim.

If the repository publishes no GitHub *releases* yet, the checker falls back to git tags and uses the
source archive; the About page says which source it used.

---

## Installing an update

```
manifest → free space → download → checksum → unpack → validate → rollback copy → swap → dependencies → restart
```

Each step is streamed to the About page with its own result and timing. Concretely
(`src/update/installer.ts`):

1. **Manifest** — re-reads the release from GitHub (never trusts a stale cache) and picks the archive.
2. **Disk** — refuses to start when the data folder has less than three times the archive size free.
3. **Download** — HTTPS only (loopback HTTP is allowed solely with `RSLMC_ALLOW_INSECURE_UPDATE_FEED=1`,
   which exists for the test suite), capped at 512 MB.
4. **Checksum** — compares the SHA-256 of the download with the release's `SHA256SUMS`. A mismatch
   aborts before anything is unpacked. When a release publishes no checksum, the step says so
   instead of pretending.
5. **Unpack** — extraction is path-checked (`src/shared/archive.ts` refuses entries that escape the
   target folder).
6. **Validate** — the archive must contain `package.json` (name `rslmc`, matching version),
   `src/index.ts`, `frontend/index.html` and `migrations/`, and must **not** contain a `database/` or
   `servers/` folder. A release that ships data is rejected.
7. **Rollback copy** — the current code tree is written to
   `<data>/backups/panel/code-<version>-<timestamp>.tar.gz`. No copy, no update.
8. **Swap** — top-level code folders are replaced. `node_modules`, `runtime`, `public`, `.git`,
   `.env` and anything else local are left alone, and the data folder is never inside the swap.
9. **Dependencies** — `bun install` runs only when `package.json`/`bun.lock` changed; a failure
   restores the rollback copy.

<img src="screenshots/update-install-live.png" alt="Live install timeline" width="100%">

Failures after the swap restore the rollback copy automatically, and the job record says exactly
which step failed and what was restored. Installing can be rehearsed safely: `startInstall()` accepts
a `targetRoot` (used by the test suite) so a copy of the panel can be updated instead of the live one.

---

## Restarting into the new build

Installing writes files; **Restart RSLMC** is what actually runs them.

1. A detached relauncher (`scripts/restart-panel.ts`) is spawned, pointed at the current pid.
2. The panel hands every running server to its relay (`handOffForPanelRestart()`), closes
   HTTP/WebSocket, closes SQLite cleanly and exits.
3. The relauncher waits for the process to disappear and the port to be free, starts
   `src/index.ts` again with the same environment, and retries once if the first attempt dies.
4. The new process finds the restart record, reattaches every relay (`adoptRelays()`), and writes the
   measured timings back: “restarted in 1.8 s, 3 servers kept running”.

<table>
<tr>
<td width="50%"><img src="screenshots/update-restart-confirm.png" alt="Restart confirmation"></td>
<td width="50%"><img src="screenshots/update-restarting.png" alt="Panel restarting"></td>
</tr>
</table>

Sessions live in SQLite, so nobody is signed out. Scheduled tasks resume on boot.

---

## Why servers do not stop

A Minecraft server is not a child of the panel any more. When a server starts, the panel spawns a
small detached **relay** (`src/processes/relay.ts`) that owns the JVM:

```
panel ──loopback TCP (random port + 32-byte token)──▶ relay ──pipes──▶ java
```

The relay keeps a ring buffer of console output, appends every line to
`<data>/logs/servers/<uuid>.log`, and survives the panel exiting (it runs in its own process group).
The next panel process reconnects to it, replays the backlog, and the console — including typing
`stop` — works exactly as before. The JVM is never signalled.

If a host cannot run the relay, the panel falls back to the classic in-process spawn, says so in the
console, and a restart then leaves the server running but without a console (it is reported as
`recovering`, and the panel tells you to force-kill before taking control again).

<img src="screenshots/overview-midnight.png" alt="A server running under the relay" width="100%">

---

## Doing it by hand

Updates are not mandatory and not magic — the old way still works:

```bash
git pull                # or unzip a release archive over the code folder
bun install
# stop the panel, start it again
bun src/index.ts
```

The data folder is unchanged by all of this. Point `RSLMC_DATA_DIR` at it if you move the code
somewhere else, or copy the whole data folder to a new machine — the panel picks up where it left off.

## Rolling back

- Through the UI: nothing to do — a failed update restores the rollback copy itself.
- Manually: unpack `<data>/backups/panel/code-<version>-<timestamp>.tar.gz` over the code folder and
  restart. The database may already have run newer migrations; they are additive, so an older build
  keeps working, but do not roll back further than one release if you can avoid it.
