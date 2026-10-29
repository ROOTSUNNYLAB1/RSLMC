<div align="center">

<img src="docs/banner.svg" alt="RSLMC — Minecraft server management panel" width="100%">

**Self-hosted Minecraft server management panel.**
Creates servers, installs the server software and a matching Java runtime, runs each one as a real OS
process, and puts the console, files, players, worlds, backups and schedules in one browser tab.
Bun + TypeScript · React · SQLite · CalVer self-updates · Windows, Linux and macOS.

[![Bun](https://img.shields.io/badge/Bun-1.2%2B-000000?logo=bun&logoColor=3ecf72)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](tsconfig.json)
[![React](https://img.shields.io/badge/React-19-149eca?logo=react&logoColor=white)](frontend)
[![SQLite](https://img.shields.io/badge/SQLite-bun%3Asqlite-003b57?logo=sqlite&logoColor=white)](migrations)
[![Tests](https://img.shields.io/badge/tests-158%20passing-3ecf72)](#testing)
[![Security](https://img.shields.io/badge/adversarial%20checks-114%20passing-3ecf72)](SECURITY.md)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-555)](#)

</div>

**[Quick start](#running-rslmc)** · **[Your first 15 minutes](#your-first-15-minutes-what-to-click)** · **[Screenshots](#screenshots)** · **[Features](#what-actually-works)** · **[Updating](docs/updating.md)** · **[Limitations](#known-limitations-stated-not-hidden)**

![RSLMC dashboard](docs/screenshots/dashboard-midnight.png)

<div align="center"><sub>Midnight theme · every theme is one click away in <i>My Profile → Appearance</i></sub></div>

---

## Why another panel?

Pterodactyl is excellent — but it needs PHP, Composer, a queue worker, a database server, Docker and a
separate daemon before your first server exists. RSLMC is a **single Bun process** that owns the
database, the HTTP API, the WebSocket console and the game processes themselves. Clone it, run one
command, create a server, watch it boot.

What it deliberately does **not** do: invent numbers. If a limit is not enforced, the panel says so.
If a feature is not finished (MySQL provisioning, remote node transport), the page says so instead of
showing a dead button. Every metric, console line and player list comes from the real process.

---

## Highlights

| | |
|---|---|
| **11 server flavours** | Vanilla, Paper, Purpur, Spigot, Fabric, Forge, NeoForge, Quilt, Velocity, BungeeCord, Waterfall — real downloads with checksum verification where the upstream publishes one. |
| **Java 8 – 25, managed** | Temurin JDKs downloaded, verified and pinned per server; nothing needs to be installed on the host. |
| **12 colour themes** | Charcoal, Slate, Midnight, Ocean, Forest, Ember, Sand, Crimson, Rose, Plum, Violet, Graphite. Saved to your account, applied instantly, status colours never change meaning. |
| **Live console** | WebSocket streaming of actual stdout with ANSI colours, command history and a typed command bar. |
| **Players, worlds, plugins** | Player inspector (inventory, ender chest, stats), world switching, Modrinth marketplace with a real newest-first version picker. |
| **Backups that restore** | tar.gz snapshots, verified restore, honest progress. |
| **Files & properties** | Full file manager plus a typed `server.properties` editor where allocation-owned keys are protected. |
| **Discord + Google sign-in** | Optional SSO, configured entirely in the admin panel. Google goes through **Firebase**; no browser SDK, strict CSP kept. |
| **Roles that mean something** | Permissions enforced server-side on every route, per-account server allocation, force-kill allowed for plain users but never destructive admin actions. |
| **Profile pictures** | Upload/replace/remove, magic-byte validated, served through an authenticated route. |
| **Updates itself, safely** | CalVer releases checked against GitHub on a timer, an "Update available" notice with an action, a step-by-step install log on *Administration → About*, and a **Restart RSLMC** button that relaunches the panel while **every server keeps running**. |
| **Schedules, notifications, audit** | Cron-style schedules, WebSocket notifications, secret-redacted audit trail. |
| **Windows + Linux + macOS** | No `unix shell` assumptions; data lives in `%ProgramData%\RSLMC`, `/opt/rslmc` or `~/Library/Application Support/RSLMC`. |

---

## Screenshots

<table>
<tr>
<td width="50%"><img src="docs/screenshots/login.png" alt="Sign-in screen"><br><sub><b>Sign-in</b> — two-pane layout, optional Discord/Google buttons, honest session warnings.</sub></td>
<td width="50%"><img src="docs/screenshots/themes.png" alt="Theme picker"><br><sub><b>12 themes</b> — each swatch previews the panel; status colours stay fixed.</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/dashboard-ember.png" alt="Ember theme dashboard"><br><sub><b>Ember</b> — same layout, warmer chrome.</sub></td>
<td><img src="docs/screenshots/dashboard-rose.png" alt="Rose theme dashboard"><br><sub><b>Rose</b> — the theme only changes the chrome, never the meaning of a status.</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/sso-admin.png" alt="Single sign-on settings"><br><sub><b>Administration → Sign-in</b> — paste credentials, copy the exact redirect URI, flip the switch (<i>Midnight</i>).</sub></td>
<td><img src="docs/screenshots/users.png" alt="Users administration"><br><sub><b>Users</b> — roles, linked providers, avatars, server allocation (<i>Slate</i>).</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/profile-avatar.png" alt="Profile picture upload"><br><sub><b>My Profile</b> — drag a file onto the circle, or pick one; the theme picker is right above (<i>Violet</i>).</sub></td>
<td><img src="docs/screenshots/security-headers.png" alt="Console under a strict CSP"><br><sub><b>Live console</b> under a strict CSP (<code>script-src 'self'</code>) — zero violations recorded (<i>Ocean</i>).</sub></td>
</tr>
</table>

### The same panel in twelve themes

One layout, twelve palettes — the same pages, each shot with a different theme **selected on the
account** (not injected into the page), so the chrome, the sidebar, the buttons and the theme picker
all agree. A theme changes the chrome and nothing else: a green RUNNING badge stays green in every
one of them. `Charcoal` is the default; `Slate` and `Graphite` are the low-chroma greys, so they shift
the temperature rather than the hue.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/overview-midnight.png" alt="Overview · Midnight"><br><sub><b>Overview · Midnight</b> — Server overview — CPU, memory, players, disk and uptime, all measured from the process.</sub></td>
<td width="50%"><img src="docs/screenshots/console-ocean.png" alt="Console · Ocean"><br><sub><b>Console · Ocean</b> — Live console: real stdout, ANSI colours, filter, pause, download.</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/files-ember.png" alt="Files · Ember"><br><sub><b>Files · Ember</b> — File manager and the typed server.properties editor behind it.</sub></td>
<td width="50%"><img src="docs/screenshots/players-violet.png" alt="Players · Violet"><br><sub><b>Players · Violet</b> — Player inspector with online list, whitelist, ops and bans.</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/plugins-forest.png" alt="Plugins · Forest"><br><sub><b>Plugins · Forest</b> — Modrinth marketplace — real newest-first version pickers.</sub></td>
<td width="50%"><img src="docs/screenshots/worlds-plum.png" alt="Worlds · Plum"><br><sub><b>Worlds · Plum</b> — World management: switch, clone, delete, verify.</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/properties-slate.png" alt="Properties · Slate"><br><sub><b>Properties · Slate</b> — Typed properties editor; allocation-owned keys are locked.</sub></td>
<td width="50%"><img src="docs/screenshots/backups-sand.png" alt="Backups · Sand"><br><sub><b>Backups · Sand</b> — tar.gz snapshots with verified restore and honest progress.</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/schedules-crimson.png" alt="Schedules · Crimson"><br><sub><b>Schedules · Crimson</b> — Cron-style schedules that really execute.</sub></td>
<td width="50%"><img src="docs/screenshots/servers-charcoal.png" alt="Servers · Charcoal"><br><sub><b>Servers · Charcoal</b> — every server in one table: status, software, address, players, memory, CPU, uptime.</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/dashboard-graphite.png" alt="Dashboard · Graphite"><br><sub><b>Dashboard · Graphite</b> — The account dashboard with live totals and recent activity.</sub></td>
<td width="50%"><img src="docs/screenshots/about-rose.png" alt="About · Rose"><br><sub><b>About · Rose</b> — Administration → About: build, update channel and restart history.</sub></td>
</tr>
</table>

---

## Quick start

Three commands to a running panel, then a short tour of what to click.

### Running RSLMC

#### 1. Requirements

| | |
|---|---|
| **Bun** | 1.2 or newer (`curl -fsSL https://bun.sh/install \| bash`, or `powershell -c "irm bun.sh/install.ps1 \| iex"` on Windows) |
| **Java** | *nothing to install* — RSLMC downloads Eclipse Temurin 8–25 itself into its data folder |
| **Disk** | ~200 MB for the panel + ~150 MB per Java runtime you install + your worlds |
| **OS** | Linux, Windows, macOS. No `unix shell` utilities are required, so the Windows path is real |

#### 2. Start it

```bash
bun install                  # dependencies (React, TypeScript, SQLite driver — all bundled)
cp .env.example .env         # optional — every default works without it
bun run start                # builds the frontend, migrates the database, starts the panel
# → http://localhost:3000
```

On Windows (PowerShell) the same three commands work. For development use `bun run dev`
(restarts the backend on change; the frontend is rebuilt on each boot).

First boot creates the data folder, the SQLite schema and a bootstrap administrator:

| Username | Password   |
| -------- | ---------- |
| `admin`  | `admin123` |

The panel immediately warns you — banner, notification and a blocking-looking notice on
*My Profile* — and keeps `mustChangePassword` set until you change it; *Administration → System →
Security* reports the same state, so it cannot quietly go stale. Nothing else is pre-seeded: no fake
servers, no fake metrics, no demo data.

#### 3. Make it yours before exposing it

```bash
RSLMC_MODE=production \
RSLMC_SECRET="$(openssl rand -hex 32)" \
RSLMC_PORT=3000 \
bun run start
```

* `RSLMC_MODE=production` turns on secure cookies and the minified frontend build. Over plain HTTP
  (for example `http://<ip>:19519`) keep `development`, because a `Secure` cookie would never be
  sent — RSLMC detects this and says so instead of locking you out.
* `RSLMC_SECRET` (≥32 chars) is **required** in production.
* Behind a reverse proxy set `RSLMC_TRUST_PROXY=true` so rate limits and audit entries see the real IP.
* Data lives in one folder (`/opt/rslmc`, `%ProgramData%\RSLMC`, `~/Library/Application Support/RSLMC`,
  or `RSLMC_DATA_DIR`). Back it up by zipping that folder; move the install by copying it.

**Keep it running after logout** — any supervisor works, because the panel is one process:

```ini
# Linux: /etc/systemd/system/rslmc.service
[Unit]
Description=RSLMC panel
After=network.target

[Service]
WorkingDirectory=/opt/rslmc-panel
ExecStart=/root/.bun/bin/bun run start
Environment=RSLMC_MODE=production
Environment=RSLMC_SECRET=<32+ random chars>
Restart=always

[Install]
WantedBy=multi-user.target
```

`systemctl enable --now rslmc`, then use *Administration → About → Restart RSLMC* for updates — it
restarts the panel process itself and leaves running Minecraft servers untouched. (One honesty note:
if you run it under a supervisor, restart it through that supervisor if you ever change the unit
file, since the relauncher starts the process outside systemd's control.)

#### 4. Troubleshooting the first run

| Symptom | Cause and fix |
|---|---|
| `EADDRINUSE` | the port is taken — `RSLMC_PORT=3001 bun run start` |
| *"RSLMC is rebuilding the panel UI"* 503 | `public/dist` was deleted or the build failed; the next request rebuilds it, and the message says which error stopped it |
| Data folder is not writable | the banner names the folder and the reason; set `RSLMC_DATA_DIR` to somewhere you can write |
| Windows: `%ProgramData%` refused | run once as administrator, or let the panel fall back to `%LOCALAPPDATA%\RSLMC` |
| A server says *"…requested, only … MB free"* | real memory guard, not a bug: lower the server's allocation |

---

### Your first 15 minutes (what to click)

Everything below is an actual page in the panel — no feature is a mock button.

1. **Sign in** at `/login` with `admin` / `admin123`, then go to **My Profile** and change the
   password. Pick a **theme** on the same page while you are there: twelve palettes, saved to your
   account, applied instantly. A theme never changes the meaning of a status colour.
2. **New server** (*Servers → New server*). The wizard asks for a name, then the software
   (Paper, Purpur, Fabric, Forge, NeoForge, Quilt, Vanilla, Spigot, Velocity, BungeeCord, Waterfall),
   the Minecraft version and build — these lists come live from the upstream APIs — then memory,
   CPU share, port and the EULA. RSLMC downloads the jar, checks the upstream checksum when one is
   published, and installs a Temurin JDK that matches the version's requirement.
3. **Start** it. The first start writes `server.properties`, accepts the EULA you agreed to, and
   streams the real console. If Java is missing or the port is busy, the log says exactly that.
4. **Console** — type `list`, `say hi`, `op <player>`, `stop`. History is here and survives a panel
   restart. **Files** and **Properties** edit the real directory and the real `server.properties`
   (allocation-owned keys are locked so you cannot make the server undiscoverable).
5. **Players** — online list, whitelist, ops, bans, plus an inspector with inventory, ender chest and
   stats read from the world files.
6. **Plugins** — search Modrinth, pick a version, install; the jar lands in `plugins/` (or `mods/`).
   **Worlds** lists, switches, clones and deletes worlds with the server stopped.
7. **Backups** — create a tar.gz snapshot, then restore it later with verified progress. **Schedules**
   run cron-style tasks (restart at 04:00, backup hourly) for real.
8. **Administration → Users / Roles** — create accounts, assign roles, and allocate servers. A
   **User** can start, stop, kill and use the console of the servers you allocate; it cannot create
   servers, touch another account or open the admin area.
9. **Administration → Sign-in** — optional Discord and Google (via Firebase) login. Paste the
   credentials, copy the redirect URI the page shows you into the provider's console, flip the switch.
10. **Administration → Java Runtimes** — pre-install Temurin 8/11/17/21/25 so a server never waits at
    first start. **Audit Log** records who did what with secrets redacted. **About** shows the build,
    the update channel and the update controls.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/profile-avatar.png" alt="My Profile — themes and profile picture"><br><sub><b>Step 1 · My Profile</b> — twelve themes, chosen here, plus the profile picture (Violet).</sub></td>
<td width="50%"><img src="docs/screenshots/users.png" alt="Administration → Users"><br><sub><b>Step 8 · Users</b> — roles, status and per-account server allocation (Slate).</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/sso-admin.png" alt="Administration → Sign-in"><br><sub><b>Step 9 · Sign-in</b> — paste credentials, copy the exact redirect URI, flip the switch (Midnight).</sub></td>
<td><img src="docs/screenshots/security-headers.png" alt="Live console under a strict CSP"><br><sub><b>Step 4 · Console</b> — real stdout under <code>script-src 'self'</code>; zero CSP violations recorded (Ocean).</sub></td>
</tr>
</table>

Deeper walkthroughs: [updating](docs/updating.md) · [the seed map](docs/seed-map.md) · [the sidebar map and permissions](#panel-features) ·
[honest limitations](#known-limitations-stated-not-hidden).

### Environment

| Variable             | Default       | Purpose                                                        |
| -------------------- | ------------- | -------------------------------------------------------------- |
| `RSLMC_PORT`         | `3000`        | HTTP port                                                      |
| `RSLMC_HOST`         | `0.0.0.0`     | Bind address                                                   |
| `RSLMC_MODE`         | `development` | `production` enables secure cookies and minified builds        |
| `RSLMC_DATA_DIR`     | platform default (see below) | Data root override (database, servers, Java, backups) |
| `RSLMC_SECRET`       | generated     | Cookie signing secret; **required** (≥32 chars) in production   |
| `RSLMC_TRUST_PROXY`  | `false`       | Trust `X-Forwarded-*` headers from a reverse proxy             |
| `RSLMC_SERVER_RELAY` | `1`           | `0` disables the per-server relay (see *Self-update and restart*) |
| `RSLMC_GITHUB_REPO`  | `ROOTSUNNYLAB1/RSLMC` | Which repository the updater reads                    |
| `RSLMC_GITHUB_API`   | `https://api.github.com` | API base — only useful for a mirror or the test feed |

### Where the data lives (one folder, per platform)

Everything RSLMC creates — SQLite database, server directories, worlds, Java runtimes, downloads,
backups, logs and the panel secret — lives in **one** directory, so the install can be zipped,
copied, moved or deleted as a single unit. Nothing is scattered across the filesystem.

| Platform | Default data folder | Notes |
| -------- | ------------------- | ----- |
| **Linux** | `/opt/rslmc` | created automatically at boot (run as root once, or `mkdir -p /opt/rslmc && chown $USER /opt/rslmc`) |
| **Windows** | `%ProgramData%\RSLMC` | machine-wide; needs administrator rights |
| **Windows (no admin)** | `%LOCALAPPDATA%\RSLMC` | used automatically when `ProgramData` is not writable |
| **macOS** | `~/Library/Application Support/RSLMC` | platform convention |
| **Existing install** | `<app>/runtime` | detected and used in place — updating never moves it |
| **Override** | `RSLMC_DATA_DIR=/some/path` | relative paths resolve against the app folder |
| **Auto-move** | `RSLMC_ADOPT_LEGACY=true` | one-time migration of `<app>/runtime` into the platform folder |

Resolution order is `RSLMC_DATA_DIR` → platform default → `<app>/runtime` (with a loud warning in the
console, the startup banner and *Admin → System*). The banner prints the resolved folder and where it
came from:

```
  Data          /opt/rslmc (platform-default)
```

Sources reported by the panel: `platform-default`, `env` (`RSLMC_DATA_DIR`), `existing-install`
(legacy folder kept in place) and `local-fallback` (platform folder not writable — with a warning).
The same value is shown in *Admin → System → Data directory*.

**Upgrading an existing installation (data stays where it is).** Older builds keep data in
`<app>/runtime` (for example `/root/rslmc-panel/runtime`). Updating the code **never moves it**: on
boot RSLMC finds that database and keeps using it, saying so plainly:

```
[rslmc] Using the existing data folder /root/rslmc-panel/runtime (kept in place — nothing was moved).
        To consolidate everything in the platform folder later, run `bun scripts/move-data.ts`.
  Data          /root/rslmc-panel/runtime (existing-install)
```

So the update procedure is just: stop the panel → replace the code → start it. No database copy, no
`RSLMC_DATA_DIR`, no downtime beyond the restart.

Moving to the single platform folder is a deliberate, reversible action:

```
bun scripts/move-data.ts                 # preview: source, target, size, entries
bun scripts/move-data.ts --apply         # move to /opt/rslmc (panel stopped)
bun scripts/move-data.ts --to /srv/rslmc --apply
```

The script refuses to run if the target already holds a database, and a rename is used when both
folders are on the same filesystem (instant) — otherwise copy first, delete after. `RSLMC_ADOPT_LEGACY=true`
performs the same move automatically on the next boot for scripted installations.

Precedence, in one line: **`RSLMC_DATA_DIR` → existing `<app>/runtime` install (kept) → platform
default → `<app>/runtime` as last resort**. A fresh machine needs nothing at all: the folder and every
subdirectory are created on first run, the bootstrap admin is seeded and the setup is immediately
usable.

Because everything is in one place, a clean reinstall is: **delete the folder → unzip → run** —
`rm -rf /opt/rslmc` (Linux) or delete `%ProgramData%\RSLMC` (Windows), then start the panel again.
Backing up is just as simple: zip that one folder.

---

## Self-update and restart (CalVer)

RSLMC updates itself from its own GitHub releases. No SSH, no upload, no file copying — and, the part
that matters on a live host, **an update never stops a Minecraft server**. The full reference lives in
[`docs/updating.md`](docs/updating.md); this is the short version.

**Versions are dates.** `2026.11.02` is a build from 2 November 2026; a second release that day is
`2026.11.02.1`. `version` in `package.json` is the only source of truth — the startup banner, the
`x-rslmc-version` header, the sidebar footer and the updater all read that one string.

**It checks continuously.** `src/update/service.ts` polls the public GitHub releases API
(`GET /repos/ROOTSUNNYLAB1/RSLMC/releases`) on the interval set in *Administration → About → Update
channel* (six hours by default, thirty minutes minimum; automatic checks and pre-releases are both
switchable). The answer is stored in SQLite, so the badge is instant after a restart and the UI never
waits on the network. When something newer appears:

* every administrator gets a **notification** (`panel_update`) plus a strip under the top bar —
  *“Update available for RSLMC — 2026.11.02 is published.”* with a **View update** button;
* the bell in the header carries the same item, and a WebSocket event (`panel.update`) refreshes
  every open tab without polling;
* dismissing silences that one version — a newer release re-opens it.

**Administration → About is the whole story in one page:** the running build with its CalVer date and
an explicit arrow to the new one, build/runtime/uptime, the API route count, the data root and its
size, what is actually enforced (memory, CPU, disk), the release notes rendered as Markdown, checksum
status, the update channel settings, the full install timeline and the restart history. Every value is
read from the process, the database or GitHub at request time.

**Install Update** is a real installer, and it narrates itself while it runs:

| # | Step | What it proves before moving on |
|---|------|---------------------------------|
| 1 | Reading the release manifest | asset name and version come from the release, not from a guess |
| 2 | Checking free space and write access | staging folder inside the data root, with the free MB it found |
| 3 | Downloading the release archive | byte count, streamed into `<data>/temporary/update-<version>` |
| 4 | Verifying the archive | SHA-256 compared against the published `SHA256SUMS` |
| 5 | Unpacking into a staging folder | how many files were unpacked |
| 6 | Checking the new build | `package.json`, the source folders and `migrations/` must be present |
| 7 | Saving a rollback copy of the current build | `code-<from>-<timestamp>.tar.gz` in the backup folder |
| 8 | Installing the new files | items replaced; **the database, `servers/`, `backups/`, `java/` and `logs/` are not touched** |
| 9 | Updating dependencies | `bun install`, only when `package.json` changed |
| 10 | Ready to restart | the new code is on disk; the running process is still the old one |

A failure stops the job, keeps the old code in place (or restores the rollback archive) and says which
step failed and why. The panel never half-installs and never invents a success.

The flow above is exercised against the **real** GitHub releases, not a mirror: a copy of the panel at
`2026.10.28` checked `github.com/ROOTSUNNYLAB1/RSLMC/releases` (through the public API, no token),
downloaded `rslmc-2026.10.29.tar.gz`, matched the published `SHA256SUMS`, swapped the code, restarted in
1.4 s with **2 servers kept running**, and then went on to install `2026.10.29.2` the same way.

**Restart RSLMC** asks for confirmation, then hands every running server to its relay, closes the HTTP
and WebSocket listeners, and a small detached relauncher starts the new process, waits for the port and
records how long the boot took. The page you are looking at reconnects on its own; the restart history
shows *reason · who · boot time · servers kept*.

```
panel ──loopback TCP (random port + 32-byte token)──▶ relay ──pipes──▶ java
```

The relay (`src/processes/relay.ts`) is spawned per server and owns the JVM, so a panel restart changes
nothing about a running server: stdout continues, `stop` is still graceful, metrics keep sampling. If a
host cannot use the relay the panel says so and falls back to a direct spawn — then a restart still
keeps the servers alive by adoption, but their console history restarts. That difference is reported in
the console instead of being papered over.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/update-hero.png" alt="Update available on the About page"><br><sub><b>Update available</b> — CalVer dates, the release arrow, one button.</sub></td>
<td width="50%"><img src="docs/screenshots/update-up-to-date.png" alt="Up to date after installing and restarting"><br><sub><b>Up to date</b> — the same page after install + restart.</sub></td>
</tr>
<tr>
<td colspan="2"><img src="docs/screenshots/update-install-live.png" alt="Live install timeline"><br><sub><b>Install Update, in progress</b> — each step carries the evidence it checked: asset name, free space, SHA-256, file counts, rollback archive.</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/restart-history.png" alt="Restart history after a live restart"><br><sub><b>Restart history</b> — a real restart on a live instance: boot 0.7 s, <b>1 server kept running</b>.</sub></td>
<td><img src="docs/screenshots/update-restart-confirm.png" alt="Restart confirmation"><br><sub><b>Restart RSLMC</b> — the dialog states that servers are handed over, not stopped.</sub></td>
</tr>
</table>

<img src="docs/screenshots/update-restarting.png" alt="Panel restarting" width="100%">

---

---

## What actually works

Everything below is executed against the real filesystem, the real kernel and the real Mojang /
PaperMC / Adoptium / Modrinth APIs. Where a feature cannot be honest about its limits, the panel
says so instead of pretending.

### Server lifecycle (real OS processes)

* Status machine: `STARTING → ONLINE → STOPPING → OFFLINE`, plus `CRASHED`, `RECOVERING`,
  `INSTALLING`, `ERROR` — derived from the child process, never simulated.
* `stop` sends the Minecraft `stop` command, waits for the grace period, then escalates to a
  kernel kill; a dedicated **Kill** action skips the grace period. Both are audited.
* Panel shutdown stops managed servers gracefully first, so a panel restart is not recorded as a
  crash.
* Kill is honest and verified: `cgroup.kill` is issued *in addition to* the pid-tree kill (an
  adopted JVM was never placed in the server's cgroup, so cgroup-only kill left it running), the
  panel waits for the process to actually disappear and, if it survives SIGKILL, logs
  *"still alive after SIGKILL"* and keeps reporting it instead of flipping the badge to OFFLINE.
  Orphan detection reads `/proc/<pid>/exe`, so a shell wrapper that merely mentions `java` in its
  command line is not mistaken for the server.
* Crash detection is based on the exit code or the terminating signal, writes an activity event, raises a notification
  and can auto-restart when *crash recovery* is enabled.
* Console is a real PTY-less pipe with WebSocket streaming, command history, filtering, pause and
  download of buffered output.
* The console header never lies about its stream: **Live** (green) only when the WebSocket is open,
  *Connecting…*, *Stream interrupted — polling* (amber) when it is not, *Server offline* when there is
  no process, and *Process adopted — output not captured* when the JVM was started outside the panel
  (no stdout pipe exists, so the command input is disabled rather than pretending to work).
* `GET /api/servers/:id/console` reports `captured` (this process is a child of the panel, so stdout
  is attached) separately from `foreign` (an adopted JVM), so the UI never labels a stream *Live*
  when there is nothing to stream.
* Metrics are sampled **once per second** (`/proc` + cgroup reads are cheap; the disk walk stays on
  a 60 s cadence and the history table is written every 15 s), so the dashboard, server list and
  server overview all show live CPU/memory instead of a 3-second-stale number. The Dashboard and
  Servers pages poll `/api/servers` every second themselves (paused while the tab is hidden) and
  show a `live · 1s` pill plus the time of the last sample.
* While the socket is down the page **polls the history endpoint every 3 s** and merges the new
  lines, so a proxy that blocks WebSocket upgrades degrades to 3-second latency instead of a frozen
  console.
* Console output is rendered with its **ANSI colours**: SGR truecolor (`38;2;r;g;b`), 256-colour
  (`38;5;n`), the classic 16-colour palette, bold/dim/italic/underline/strike and inverse are
  parsed into styled runs, while cursor/OSC sequences are dropped instead of printed. The escape
  byte is optional — capture paths that strip it (leaving `[38;2;…m`) are parsed the same way.
  Copy and log download always give clean text, and severity tinting (`ERROR`/`WARN`) is computed
  on the plain text so colour codes can never hide a failure.

<img src="docs/screenshots/overview-midnight.png" alt="Server overview with measured resources" width="100%">


### Software installation (no mocks)

| Software    | Source                                              | Notes |
| ----------- | --------------------------------------------------- | ----- |
| Vanilla     | Mojang version manifest                             | SHA-1 verified |
| Paper / Folia / Velocity / Waterfall | PaperMC *fill v3* API             | SHA-256 verified |
| Purpur      | `api.purpurmc.org/v2`                               | MD5 verified (only hash upstream publishes) |
| Fabric      | Fabric meta + official installer                    | managed Java |
| Quilt       | Quilt installer                                     | managed Java |
| Forge       | Forge maven installer                               | managed Java |
| NeoForge    | NeoForged maven installer                           | managed Java |
| BungeeCord  | Jenkins artifact (unverified metadata)              | marked *limited* |
| Spigot      | —                                                   | **not offered**: no official download exists |

### Java runtime manager (standalone)

* Downloads **Eclipse Temurin** JDKs 8–25 from the Adoptium API, verifies the SHA-256 checksum,
  extracts atomically through a staging directory and confirms `java -version` reports the
  expected major before registering the runtime.
* Repair-on-use: if an executable bit is lost (restores, copies), RSLMC fixes it instead of failing
  with `EACCES`.
* Minecraft version → Java mapping (`26.x → 25`, `1.20.5+ → 21`, `1.18–1.20.4 → 17`,
  `1.17 → 16`, `≤1.16.5 → 8`) with a compatibility warning on the Startup page.

### JVM flags — optimised by default, visible always

Every server is launched with a tuned flag set instead of an empty `jvm_args`:

| Preset | Used for | What it does |
| ------ | -------- | ------------ |
| **Aikar's flags (G1GC)** *recommended* | game servers, ≥ 1 GB allocation | G1GC tuned for Minecraft: pause target 200 ms, region sizing, `MaxTenuringThreshold=1`, `PerfDisableSharedMem`, `AlwaysPreTouch` |
| **Proxy tuning** | Velocity / BungeeCord / Waterfall | small-heap G1GC set (4 MB regions, inlining depth 15, no explicit GC) |
| **Low memory (SerialGC)** | allocations **below** 1 GB | SerialGC — less collector overhead than G1 on tiny heaps |
| **Custom** | anything hand-edited | exactly the operator's flags |

* New servers get the right preset automatically (`defaultJvmArgsFor(software, memoryMb)`); existing
  servers with an empty `jvm_args` are back-filled on boot, and the action is logged.
* **Settings → Startup** has a preset selector, a *Use recommended* button and the raw flag field.
  Hand-editing the field switches the preset to *Custom*; nothing is overwritten on save.
* The **exact command line** is shown on the Startup page (`java -Xms… -Xmx… <flags> -jar server.jar`),
  and the same string is written to the console as `Launch: …` on every start.

**Memory model — why a server "uses its whole RAM" and what RSLMC does about it.**

The allocation is the *budget*: on Linux it is the hard cap for the whole process (`memory.max` in
the server's cgroup). If you give a server 1 GB, the JVM is allowed to grow into that 1 GB — that is
what the setting means. What is **not** normal is a server that touches the whole box, or one whose
memory card reads 100 % while it is empty. Four things caused that and all four are fixed:

| Cause | Fix |
| ----- | --- |
| `-Xms == -Xmx` committed the entire heap at boot | `-Xms` now starts at **half the heap** (min 256 MB, max 2 GB); only the ceiling stays |
| `-XX:+AlwaysPreTouch` faulted in every heap page up front | removed from every preset |
| Metaspace, code cache and direct buffers were uncapped and counted as "used" | `-XX:MaxMetaspaceSize`, `-XX:ReservedCodeCacheSize`, `-XX:MaxDirectMemorySize` are part of the presets |
| The memory card counted reclaimable **page cache** (jars, libraries, world files) | usage is now the cgroup **working set** (`memory.current − memory.stat: file`), with the cache reported separately |

`-Xms`/`-Xmx` are set to the allocation minus a reserve for the JVM itself — `max(320 MB, 25 %)`
capped at 512 MB above 1 GB, and 25 % of the allocation below that so small budgets keep a usable
heap. **The allocation floor is 128 MB** (API, wizard and Settings enforce it; `127` is rejected with
`400 invalid_memory`):

| Allocation | `-Xms` / `-Xmx` | Reserved for the JVM | Reported working set (live test, Paper 1.21.4 + Via, idle) |
| ---------- | --------------- | -------------------- | ----------------------------------------------------------- |
| 128 MB | 96 MB / **96 MB** | 32 MB | — (accepted; the UI warns it cannot hold a world) |
| 256 MB | 192 MB / **192 MB** | 64 MB | — |
| 512 MB | 256 MB / **384 MB** | 128 MB | — |
| 1024 MB | 352 MB / **704 MB** | 320 MB | **758 MB** (was 938 MB before the fix) |
| 2048 MB | 768 MB / **1536 MB** | 512 MB | — |
| 4096 MB | 1792 MB / **3584 MB** | 512 MB | — |

Small values are accepted, not blocked: the hint says what the heap becomes and that Minecraft
realistically needs ~1 GB. The number is the operator's budget, the warning is the panel's honesty.

Heap and reserve are never hidden: they are printed in the launch command (`Launch: java -Xms352M
-Xmx704M …`), on the Startup page (*Memory allocation 1024 MB*, *Java heap -Xms 352 MB · -Xmx 704 MB*)
and in the API next to the allocation. A hand-written `-Xms`/`-Xmx` in the custom flag field is
rejected with `400 memory_flags_in_jvm_args` instead of producing `Initial heap size set to a larger
value than the maximum heap size`.

Other guards:

* **Small heaps (< 1.5 GB) use SerialGC**, not G1: no remembered sets, no concurrent marking, so the
  native side stays small. `-XX:MinHeapFreeRatio=20 -XX:MaxHeapFreeRatio=40` let the heap shrink back
  after the world-generation spike; the G1 presets get `-XX:G1PeriodicGCInterval`.
* **Host memory sanity check on every start**: if the allocation is larger than what the host
  actually has free, the console says so (`Memory warning: 1024 MB requested, only 1278 MB free on
  the host …`) instead of leaving a bare `exited unexpectedly (code signal SIGKILL)` behind.
* **The create wizard defaults to half the host's RAM** (rounded to 256 MB, 1–4 GB) and pins CPU to
  the host's core count, so a fresh server does not claim the whole machine by default.
* Being honest about the rest: on Windows there is no kernel memory cap, so only `-Xmx` limits the
  heap and native memory can exceed the allocation (shown as *advisory* in the UI).

### Player-facing address (playit.gg / tunnels / port forwarding)

`bind_ip` + `port` describe how the JVM listens locally. Many setups put a tunnel in front of it —
playit.gg, ngrok, FRP, a router's port forward — and players must type that hostname instead. RSLMC
stores it as an optional **public address** (`servers.public_host` / `public_port`):

| Public domain | Public port | What players see and copy |
| ------------- | ----------- | ------------------------- |
| – | – | `203.0.113.5:25565` (the internal address) |
| `calm-forest.playit.gg` | – | `calm-forest.playit.gg` — **no port**, because the tunnel owns it |
| `calm-forest.playit.gg` | `25590` | `calm-forest.playit.gg:25590` |

* Set it while creating a server (**Networking** step → *Public domain* / *Public port*, directly under
  the bind address and port) or later under **Networking → Public address**.
* Every place that shows the address — page header, *Server info*, dashboard cards and table,
  Networking — switches to the public host, and the internal `ip:port` is still shown beside it for
  the operator (labelled *Internal*).
* The address is **click-to-copy** everywhere (clipboard API with a hidden-textarea fallback, so it
  works on plain HTTP too) with a `Copied` confirmation.
* Pasted values are normalised (`https://play.example.com/` → `play.example.com`), invalid hosts and
  ports are rejected with `400 invalid_public_address` / `invalid_public_port`, and an empty value
  simply restores the internal address. Nothing is guessed: no public host means no invented domain.

### Recommended plugins (ViaVersion + ViaBackwards)

Paper and Purpur servers get the Via stack installed automatically right after the software install
finishes, so clients on other Minecraft versions can still join:

* resolved from Modrinth (`viaversion`, `viabackwards`), release builds first, fallback to the
  loader-only version list when no build advertises the exact MC version;
* real downloads with SHA-512 verification into the server's `plugins/` directory and rows in the
  `plugins` table — nothing is marked installed unless the jar exists;
* serialised in the console (`Recommended plugins installed: ViaVersion 5.12.1, ViaBackwards 5.12.1.`)
  and recorded as `server.plugins_recommended` in the activity log;
* failures never break the install: each one is reported per plugin, the rest continues;
* **Plugins → Recommended for this server** shows installed/missing state and an *Install missing*
  button (`POST /api/servers/:id/plugins/recommended`). A restart is required to load them.

### Resource enforcement — reported honestly

| Resource | Linux + cgroup v2 (helper installed) | Otherwise |
| -------- | ------------------------------------ | --------- |
| Memory   | **enforced** — `memory.max` in `rslmc-server-<id>` | *advisory* — only `-Xmx` |
| CPU      | **enforced** — `cpu.max` quota from the allocation | *advisory* — recorded target only |
| Disk     | *partial* — tracked, quota only with project quotas | *advisory* |

The privileged helper is a narrowly scoped, root-owned shell script installed to
`/usr/local/sbin/rslmc-cgroup-helper`; it can only create/limit/attach/remove RSLMC cgroups and
never executes user input. `System → Install privileged cgroup helper` performs the install, and
the UI shows the exact enforcement level everywhere (Overview, Servers, Admin, System).

Metrics are sampled from the real process and pushed over the WebSocket every second — there are no
random or placeholder numbers anywhere. **100 % means one fully used core** on every platform, so
`200 %` is two cores, matching how CPU allocation is expressed in the panel.

| | CPU | Memory |
| --- | --- | --- |
| Linux | `/proc/<pid>/stat` utime+stime+cutime+cstime jiffies, delta over wall-clock time | cgroup `memory.current` when attached, else RSS pages |
| Windows | `Get-Process -Id <pid>` `.CPU` (cumulative CPU seconds), delta over wall-clock time | `WorkingSet64` / `PrivateMemorySize64` |

Two rules keep the number honest:

* **Only the 3 s metrics ticker advances the CPU baseline.** API reads and page polls call the
  read-only `peekProcess()`: they used to run the delta version, which reset the window every
  couple of seconds and made a JVM pinned at 176 % report 0.0 %.
* **A dead process reports 0, never its last value.** The baseline is cleared and the ticker stops
  on exit, so a crashed server cannot keep showing the CPU it used a minute ago.

Everywhere in the UI the **observed** figure is shown with the allocation next to it
(`0.3 % / 100 %`, `180 / 512 MB`) and `—` when nothing is running, so a running server can never be
mistaken for its limit (a list of `100 %` columns used to be allocations, not usage).

On Windows the PowerShell probe is cached for 2 s so a UI poll does not fork a shell, properties the
account cannot read are treated as *unknown* (empty `Get-Process` values would otherwise parse as
`0`), and if the probe fails entirely the card says *sampler unavailable* instead of inventing a
value. Linux is verified live in this build (paper start-up measured at 98.7–99.7 %, an idle Velocity
proxy at 0.3–0.7 %); the Windows path is implemented and reviewed but has to be confirmed on a
Windows host.

**Memory is measured, never assumed.** Usage comes from the server's cgroup when that cgroup is
actually charging the process, and from `/proc/<pid>/statm` when it is not. A container can hand out a
cgroupfs whose files look right while `memory.current` reads a few hundred kilobytes for a JVM holding
a gigabyte; RSLMC detects that (a >4× disagreement between the two) and reports the process number
instead, says so once in the server's console, and keeps the limits as configured. A fake metric is
worse than a smaller one — `tests/memory-source.test.ts` pins the behaviour down.

### Java runtimes

Runtimes installed by the panel live on the local host and are stored with `node_id = NULL`; server
rows always carry a concrete node id, so node-scoped queries match `node_id = ? OR node_id IS NULL`
instead of hiding every local runtime (this previously made Settings claim "Java 21 is not installed"
next to an installed Java 21).

The **Java runtime** selector in *Server → Settings* offers *managed automatically* plus every
installed runtime. When the required build is missing it says so and offers *Install Java N now*
(`POST /api/java/install`) instead of failing the save. Saving settings never dead-ends on a runtime:
a pinned runtime that no longer exists or whose files were wiped is reset to *managed automatically*
and the response carries a `warnings[]` entry explaining exactly what happened; the server's
`java_major` is kept in step with an explicitly pinned runtime, and the start path calls
`ensureRuntime()` so a missing build is downloaded, checksum-verified and extracted on demand.

### Player tracking

* Join / leave detection reads the real console, but **strips colour codes first**: a 256-colour SGR
  such as `\u001b[38;5;85m` used to leave its digit/`m` tail glued to the name and the panel stored
  `85mSUNNYGAMINGPE` (with `85` as the avatar initials). Names are now matched as whole tokens only.
* Every capture is reconciled against the server's own `usercache.json`, so a mis-read name is
  healed to the authoritative name/UUID; records already stored under a mangled name are rewritten
  (or folded into the real player) the next time the list is loaded.
* The player inspector accepts a **UUID or a username**. Records imported from Minecraft's JSON
  files can legitimately have no UUID yet; the panel then says *"no saved data yet"* instead of
  failing with *"a player UUID is required"*.
* `tests/console-detect.test.ts` covers the colour-code regression, bracketed join messages, leave /
  disconnect lines and unrelated output (`bun test`).

<img src="docs/screenshots/players-violet.png" alt="Players page" width="100%">


### Files, properties, players, worlds, plugins

* **Files** — breadcrumb navigation, upload (multipart), mkdir, rename/move, copy, bulk delete,
  search, download, tar.gz archive download, extract, and a text editor with `Ctrl+S` and an
  `expectedModifiedAt` conflict check. Every path is resolved inside the server directory
  (`..` and symlink escapes rejected).
* **Properties** — typed, spec-driven editor for `server.properties` (General / Gameplay / World /
  Network / Security / Resource pack / Advanced), unknown keys preserved verbatim, secrets
  redacted, restart-required detection. Values are read and written with the same escaping that
  `java.util.Properties` uses, so `level-type=minecraft\:normal` is shown (and saved back) as
  `minecraft:normal` instead of tripping the world-type validation. Legacy values
  (`DEFAULT`, `FLAT`, `LARGEBIOMES`, `AMPLIFIED`, `SINGLEBIOME`) are mapped to their modern
  `minecraft:*` ids, and datapack generators such as `terralith:overworld` are accepted as a
  custom entry rather than rejected.
* **Players** — read from the live process and from `ops.json` / `whitelist.json` /
  `banned-players.json`; op/deop/whitelist/ban/pardon/kick are executed live when the server is
  running, with UUID resolution through Mojang.
* **Player inspector** — clicking a player name opens their saved data straight out of
  `<world>/playerdata/<uuid>.dat` (a full NBT reader/writer, 64-bit `UUIDMost`/`UUIDLeast` kept as
  BigInt so nothing is truncated, unknown tags and `components`/`DataVersion` preserved):
  health/max-health/absorption, hunger, saturation, exhaustion, XP, gamemode, dimension, position,
  and all 41 slots — 27 inventory, 9 hotbar, 4 armour, 1 offhand. Slots are editable: drag & drop
  to move or swap, set stack size, duplicate, delete, clear, and give any item id to a chosen or
  first free slot. One-click Heal (health back to the real max-health attribute, stale absorption cleared) and Feed
  (hunger + saturation to 20, exhaustion reset), plus XP and
  gamemode edits. Writes are atomic (`<file>.tmp` → rename) with a `.bak` copy of the previous
  file, the path honours `level-name`, and every edit is audited as `player.data_edited`.
  **Honest limits:** edits are refused while the player is online (the running server holds their
  data in memory and would overwrite the file on disconnect) and the UI says exactly that; a
  running-but-empty server shows a warning instead of blocking. Ender chest contents
  (`EnderItems`) are not exposed yet, and the UI never draws an inventory that is not in the file.
* **Worlds** — real on-disk worlds with dimensions, size, export, backup and delete.
* **Plugins** — Modrinth marketplace search + version picker, dependency-aware install, update
  checks, manual JAR upload, removal. Honest note: Minecraft has no "enabled" flag, so presence is
  reported instead of a guessed state.
* **Backups** — compressed, checksummed archives in `runtime/backups`, with verify, download,
  restore and automatic retention pruning.
* **Schedules** — cron (5-field, validated through `/api/cron/validate`), persisted in SQLite,
  next-run calculation, run-now and per-run history; missed runs are not replayed.
* **Map** — the page is a **Chunkbase seed map** first: the panel reads the real seed out of
  `level.dat` (`GET /api/servers/:id/seed-map`), maps your Minecraft version onto the matching
  Chunkbase profile (`java_1_21_4`, `java_26_3`, …), and builds the exact deep link —
  `#seed=…&platform=…&dimension=overworld|nether|end&x=…&z=…&zoom=…` — for every world on disk.
  Coordinates, dimension and zoom are editable and travel into the link; *Copy link* and *Open seed
  map* use the same string. **The site refuses to be framed** (`www.chunkbase.com` answers
  `X-Frame-Options: DENY`), so the map opens in a new tab and the page says exactly that instead of
  pretending to embed it. The seed only ever travels in the URL fragment, which browsers do not
  send to a server.
* **Rendered map (BlueMap)** — below the seed map: BlueMap installation for Paper/Purpur/Folia, real
  render status read from `bluemap/web/maps`, and a built-in viewer: `/servers/:id/map/view` embeds
  the renderer's own output, which the panel serves through `/api/servers/:id/map/web/*` with an
  authenticated, directory-bounded path check (traversal attempts are rejected, unauthenticated
  requests get 401). Different question, different answer: a seed map *predicts* terrain, BlueMap
  *renders* the chunks that really exist.

<img src="docs/screenshots/seed-map.png" alt="Seed map built from the world's own level.dat" width="100%">

<img src="docs/screenshots/seed-map-worlds.png" alt="Every world folder with its own Chunkbase link" width="100%">

<img src="docs/screenshots/files-ember.png" alt="File manager" width="100%">


### Running behind a proxy, or on plain HTTP

* The session cookie's `Secure` flag follows the **actual request**, not `RSLMC_MODE`: `https://`
  requests and requests carrying `X-Forwarded-Proto: https` get `Secure`, everything else does not.
  Previously a production-mode panel served over `http://host:3000` handed out a `Secure` cookie,
  the browser dropped it, and every `/api/auth/me` answered 401 — the login page looked broken while
  the password was in fact accepted.
* `RSLMC_COOKIE_SECURE=always|never` overrides the detection for unusual setups (TLS terminated on a
  box the panel cannot see, cookie-breaking middleboxes, …).
* Login now verifies the cookie round-trip. If the browser refuses to store the session, the login
  form says so — *"Signed in, but this browser did not keep the session cookie…"* — instead of
  reloading into a 401 loop.
* Reverse proxy: forward `Host`, `X-Forwarded-For` and `X-Forwarded-Proto`, and keep the panel on
  `RSLMC_HOST=127.0.0.1` when it should not be reachable directly.

### Security

The panel is audited by an executable harness, not by a checklist: `tests/security/pentest.ts` boots a
throwaway instance and attacks it over HTTP and WebSocket — IDOR, privilege escalation, path traversal
(with a real symlink escape), zip-slip, SQL injection, prototype pollution, SSRF, command injection,
CSRF, session fixation, username enumeration, secret disclosure, security headers and resource limits.
**77 checks, all passing.** Full write-up, including the seven real defects that round found and how each
was fixed, is in [`SECURITY.md`](SECURITY.md).

```bash
bun run tests/security/pentest.ts          # 77 checks, non-zero exit on failure
```

Hardening that is on by default:

* Argon2id password hashing, `HttpOnly` + `SameSite` session cookies, session rotation on login,
  per-IP and per-account rate limits taken from the socket (not a spoofable header).
* A CSRF token on every mutation *plus* an `Origin` check, so a valid token is not enough from another site.
* A strict Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff` and a referrer policy on the
  document itself — not just on API responses.
* Every server route is scoped to a server the caller can actually reach; a foreign id is a flat 404 so
  existence is not confirmed. Schedule runs, backups and run history are scoped the same way.
* `server.properties` is written with `java.util.Properties` escaping, and the raw file editor keeps the
  allocation-owned `server-port`/`server-ip` values (it tells you when it did).
* Archive extraction has a byte and entry budget, so a compression bomb cannot fill the host disk.
* Root access can only be granted or changed by a root administrator; delegated account managers cannot
  hand out permissions they do not hold.

### Accounts, roles and server allocation

Two ideas kept strictly apart: a **role** decides *what kind of action* an account may perform
anywhere, and an **allocation** decides *which servers* it can touch. Neither one implies the other.

| | `User` (self-registered) | `Administrator` |
| --- | --- | --- |
| Start / stop / restart **and force-kill** own servers | yes | yes |
| Console commands, files, properties | yes | yes |
| Players, plugins, worlds, backups, schedules | yes | yes |
| JVM startup preset (curated list) | yes | yes |
| Memory / CPU / disk allocation, raw JVM flags, startup command | **no** | yes |
| Create / delete servers | **no** | yes |
| Networking: ports, public address (playit.gg) | **no** | yes |
| Install / pin Java runtimes | **no** | yes |
| Users, roles, nodes, audit log, system settings | **no** | yes |

* **Why that line is drawn there:** everything above the split mutates one server the administrator
  handed over, and is reversible through a backup. Everything below it changes the panel or the
  host — a bad `-Xmx`, a stolen port, a deleted server or a new administrator account cannot be
  undone from inside the panel, so a plain account never gets it.
* **Force-kill (`server.kill`) is included on purpose.** It only ends a process that account already
  owns and can start again; it is the right answer to a JVM stuck in a shutdown that `stop` cannot
  finish, and holding it back would just make people ask an administrator to press the same button.
  It still cannot touch anybody else's server (`requireServerAccess` runs first) and it is audited.
* **Limited startup (`server.startup`).** The Startup page renders a preset picker instead of the full
  editor: Aikar's G1GC, proxy tuning, or low-memory SerialGC. `custom` — the path to a raw flag
  string — is not selectable, the API rejects any preset carrying `-Xms`/`-Xmx`/`-Xss`/`XX:MaxRAM*`
  (a native *cap* like `-XX:MaxDirectMemorySize=128M` only limits, so it is allowed), and the heap
  preview is computed from the allocation, so a preset can never buy more memory than granted. The
  allocation, the raw flags, the command line and the port stay read-only with the reason shown.
* The permission list is enforced by the API (`requirePermission` / `requireServerAccess`), not by
  hiding buttons: a `User` calling `PATCH /api/servers/:id`, `GET /api/servers/:id/settings` or
  `GET /api/servers/:id/allocations` directly gets `403`, and pages it may not open are gated in the
  router as well, so no "Access denied" dead ends are rendered into the sidebar.
* **Allocating servers:** Administration → Users → **Servers** next to an account. Each server is set
  to *Owner*, *Shared access* or *No access*. Ownership is moved, not copied (a server always has
  exactly one owner, and taking it away hands it back to the administrator making the change);
  shared access is an extra grant that keeps the original owner. A server cannot be both.
  The change is audited as `user.servers_updated` and the account gets a notification.
* A brand-new account sees an empty server list with a plain explanation instead of a broken
  dashboard, and the *New server* action is absent because it genuinely is not permitted.

### Single sign-on (Discord + Google/Firebase)

Two providers, one shared code path, no browser SDK — the panel keeps `script-src 'self'`.

* **Configuration** lives in the database (`oauth.*` settings) and is edited at
  **Administration → Sign-in**. Each card shows the *exact* redirect URI to register at the provider
  console (the usual reason a first attempt fails), whether a secret is stored (secrets are
  write-only and never echoed by the API or the audit log), and a readiness check: enabling a
  provider without credentials is refused, and clearing a secret switches the provider back off.
* **Discord** is plain OAuth 2.0 with PKCE (`S256`), scope `identify email`.
* **Google goes through Firebase.** The panel runs the normal Google OAuth code flow, then hands the
  Google ID token to Firebase Identity Toolkit (`accounts:signInWithIdp`) and reads the account back
  with `accounts:lookup`. Firebase therefore stays the single source of truth for these identities,
  and the browser never needs the Firebase SDK.
* **Account mapping**: existing identity link → (optional) link to an account with the same
  *verified* email → create a new account with the registration default role (`User`) and **no**
  usable password (`!oauth:<uuid>`). New provider accounts get no servers until an administrator
  allocates one. If the email is already used by another account while email-linking is off, the new
  account is created without an email — the identity row keeps it — instead of failing.
* **Second factor still applies**: an account with TOTP gets a 5-minute, single-use ticket and must
  finish on the login screen; the provider alone never yields a session.
* **State handling**: every redirect carries a single-use, provider-bound `state` with a stored PKCE
  verifier, mirrored in an HttpOnly `SameSite=Lax` cookie. Replaying a callback, presenting a state
  to the wrong provider or tampering with `redirect_uri` is refused (see `sso.*` in the harness).
* **Policy switches**: allow/deny *new* accounts from providers, and allow/deny email linking. Both
  are one toggle each, because they change who can get in — not a wall of options.
* **Administration**: the users table shows which providers each account has, and an administrator
  can unlink one (`DELETE /api/users/:id/identities/:provider`); unlinking the last identity of a
  password-less account is refused so nobody locks themselves out.

### Panel features

* First-run setup screen with real environment checks (Bun, SQLite, Java manager, cgroups, mode).
* **Sign-in / sign-up screens** — a two-pane layout (capability panel + form) in the same charcoal
  language as the panel, password reveal toggles, a live password-policy checklist fed by the
  server's own rules, inline validation and a mobile layout. `/register` is a real page, not a modal.
* **Self-registration, controlled by the administrator** (Administration → Users → *Account
  registration*): off by default; when on it can require a write-only sign-up code and assign a
  chosen default role (the default is **User**). Accounts are active immediately — there is no
  approval queue, because a new account cannot reach anything until an administrator allocates it a
  server. Sign-ups are rate limited per IP, audited as `auth.register`, and notify the
  administrators.
* Every account still goes through the same Argon2id hashing, password policy, session and CSRF
  path as the bootstrap administrator — registration only creates the row.
* **Sign in with Discord or Google (through Firebase)** — configured entirely in *Administration →
  Sign-in*, never in a config file: paste the client id/secret (and the Firebase web API key for
  Google), copy the redirect URI the page shows you, flip the switch. The login and register screens
  grow a compact provider strip only when a provider is genuinely ready, so an unconfigured panel
  shows nothing at all. Full details in *Single sign-on* above.
* Argon2id password hashing, signed HTTP-only session cookies, CSRF tokens on every mutation,
  login rate limiting, session listing/revocation and optional TOTP with recovery codes.
* Registration endpoints (`GET /api/auth/registration`, `POST /api/auth/register`) are public by
  design but the second one validates everything server-side: closed-state, invite code, password
  policy, reserved names, duplicate usernames/emails, and the approval switch.
* **Twelve colour themes**, chosen in *My Profile → Appearance*: Charcoal (the original), Slate,
  Midnight, Ocean, Forest, Ember, Sand, Crimson, Rose, Plum, Violet and Graphite. Click a swatch and
  the whole panel re-paints instantly — sidebar, cards, borders, terminal wells, the login screen —
  and the choice is saved **to your account**, so it follows you to any browser. A theme only ever
  changes the chrome: status colours (green running / amber warning / red error) are deliberately
  *not* themed, so a red panel can never make a failed server look healthy. No neon, no gradients:
  every palette is dark, matte and low-chroma, and a unit test asserts it.
* **Profile picture** on *My Profile* — upload, replace, remove, or drag a file onto the circle.
  PNG/JPEG/WebP up to 2 MB, identified by magic bytes (a renamed script is refused, not stored), and
  served back through an authenticated route with a version ETag so a new picture appears instantly.
  The picture is used in the sidebar, the account page and the admin users list; without one you get
  the coloured initials, as before. Files live in `<data>/avatars/`, one per account.
* RBAC with permissions (`server.*`, `node.*`, `user.*`, `role.manage`, `java.manage`,
  `audit.view`, `system.manage`, …) enforced **server-side** on every route (135 routes); the sidebar only
  renders what your role can open.
* **Self-update** — CalVer releases, a timer-driven GitHub check, an *Update available* notice with an
  action, a live ten-step install timeline and **Restart RSLMC**, all on *Administration → About*
  (see *Self-update and restart* above).
* Audit log (secret-redacted) and per-server activity feed.
* Admin area: overview, nodes, users, roles, sign-in providers, Java runtimes, audit, system/maintenance.
* Notifications with WebSocket push and a live connection indicator.
* Multi-node: nodes can be registered and their heartbeats tracked. **Server processes currently
  execute on the local node only** — the agent transport is not finished, and the Nodes page says
  so instead of implying otherwise.
* Databases page: database provisioning is **not implemented** and the page explains what a real
  implementation would require.
* The panel UI is built from `frontend/` on boot (`public/dist` is generated output). If that bundle
  ever goes missing, the next page request rebuilds it once and serves it; if the rebuild fails you
  get a styled *"RSLMC is rebuilding the panel UI"* 503 page, never a 404 wall over a healthy API.

---

## Testing

```bash
bun run test                          # every suite, one process per file (21 files, 205 tests)
bun run tests/security/pentest.ts     # 114 adversarial checks against a throwaway instance
bun run typecheck                     # tsc --noEmit, strict
```

The security harness boots its own panel on port 3941 with a temporary data directory, seeds two
plain users and two servers, and then attacks it like an untrusted client would — IDOR on schedules,
privilege escalation through user management, CSRF, forged cookies, open redirects on the OAuth
callback, state replay, profile-picture polyglots, theme id injection, compression bombs, and more.
It exits non-zero when anything fails, so it can gate a release. Every finding so far, and the exact
fix, is written up in **[SECURITY.md](SECURITY.md)**.

The panel is also exercised in a real browser (Playwright) for the parts a unit test cannot see:
CSP violations, WebSocket console streaming, theme switching, drag-and-drop uploads and the
sign-in flow.

## Project layout

```
src/
  api/         HTTP router, auth/admin/server/file routes, WebSocket gateway
  auth/        sessions, Argon2id, TOTP, permission helpers
  database/    Bun SQLite wrapper + migrations runner
  java/        Temurin download/verify/extract/register
  minecraft/   providers (Vanilla, Paper, Purpur, Fabric, Forge, NeoForge, Quilt…),
               properties, players, worlds, Java requirements,
               nbt-file (NBT read/write), player-data (playerdata .dat editing)
  plugins/     Modrinth client
  processes/   real process manager, metrics sampling, console piping, per-server relay
  resources/   /proc stats, disk usage, cgroup v2 helper, enforcement reporting
  security/    path sandboxing, redaction, rate limiting, password policy, TOTP
  services/    servers, backups, schedules, cron, downloads, notifications, audit, bootstrap
  shared/      config, http helpers, permissions, types, calver
  update/      GitHub release client, CalVer comparison, installer, restart + relauncher
migrations/    SQL schema, 001_init.sql … 012_updates.sql (applied in order, never rewritten)
frontend/
  lib/         api client, WebSocket client, router, session/toast providers, formatters
  components/  UI primitives, charts, console, layout (sidebar, topbar, footer)
  pages/       one file per screen
  styles.css   design system (near-black panels, accent rules, reduced-motion support)
runtime/       live data: database/rslmc.db, java/, servers/, backups/, logs/, temporary/,
               relays/ (handshake files for running servers)
scripts/       release.ts (CalVer bump + release notes), restart-panel.ts (the relauncher),
               move-data.ts, publish.sh
```

## Design

Near-black charcoal surfaces, a persistent grouped sidebar (Navigation / server / Account /
Administration), breadcrumb header with bell + fullscreen, compact summary cards with a coloured
top rule and icon chip, resource cards with progress bars, a terminal-style console, dotted-row
info panels, and a footer with `© RSLMC` plus quick links. No neon, no gradients, no emoji icons;
animations are short and respect `prefers-reduced-motion`.

## Known limitations (stated, not hidden)

* Remote node execution (agent) is not finished — local node only.
* Database provisioning is not implemented.
* Disk quotas are advisory unless the host has project quotas enabled.
* BungeeCord artifact URLs come from a Jenkins job whose API returned no metadata; they are marked
  as unverified.
* BlueMap rendering is only offered automatically for Paper/Purpur/Folia.
* Server survival across a panel restart relies on the per-server relay, which talks over
  `127.0.0.1`. With `RSLMC_SERVER_RELAY=0` (or a host that blocks loopback binding) servers are
  still adopted after a restart, but their console history restarts. If you run the panel under a
  supervisor that kills the whole process group on exit, restart the panel through that supervisor
  instead — RSLMC says as much on the page.
* An update needs write access to the code folder. Read-only deployments must keep updating by
  replacing the code by hand; the About page reports the failed step instead of pretending.

---

## Contributing

Issues and pull requests are welcome. Two rules keep the project honest:

1. **Never fake state.** If something cannot be implemented yet, the UI says so instead of showing a
   number that looks plausible. A PR that adds a nice-looking placeholder will be asked to add an
   honest empty state instead.
2. **Anything user-facing that writes needs a test** — a unit test for the logic, and a check in
   `tests/security/pentest.ts` if it touches an account boundary.

```bash
bun install
bun test
bun run tests/security/pentest.ts
```

## License

MIT — see [LICENSE](LICENSE). Do what you want; a link back is appreciated.
