# Installing RSLMC

One command, a short wizard, and a running panel with a service that survives a reboot.

```bash
bash <(curl -sSL https://raw.githubusercontent.com/ROOTSUNNYLAB1/RSLMC/main/install.sh)
```

Works on Linux (Debian/Ubuntu, Fedora/RHEL/Rocky, Arch, Alpine, openSUSE), on WSL2, and on macOS.
On Windows without WSL, run the panel from a checkout — see the
[README quick start](../README.md#or-run-it-from-a-checkout).

Nothing is piped into a shell on your behalf: the installer is a single readable `install.sh` in this
repository, and it downloads everything it needs from this project's own GitHub releases.

---

## What the wizard asks

| Question | Default | What it is for |
| --- | --- | --- |
| **Version** | latest release | a numbered list of recent releases; press Enter for latest, type a number, or type any version (`2026.10.29.2`). Older releases can be installed deliberately. |
| **Install path** | `/opt/rslmc` | the code. Replaced on every upgrade. |
| **Data folder** | `/var/lib/rslmc` | SQLite database, servers, worlds, backups, Java runtimes, logs. **Never** replaced by an upgrade. |
| **Link (address)** | `0.0.0.0` | `0.0.0.0` = reachable from other machines, `127.0.0.1` = local only (reverse proxy or SSH tunnel), or one specific IP. |
| **Port** | `3000` | checked for conflicts before anything is written, and skipped when the conflict is the panel you are upgrading. |

If an installation already exists on the chosen path, the wizard says so and keeps its data folder,
secret and port: re-running the same command is an upgrade, not a reinstall.

## What it does, in order

1. **Checks the machine** — OS, architecture, package manager, root/sudo, free disk, memory, whether
   systemd is really running, and whether the port is free. Everything it finds is printed.
2. **Installs Bun** if it is missing or older than 1.2 — straight from Bun's GitHub release, with the
   published SHA-256 checked before the binary is moved into `/usr/local/bin`.
3. **Downloads the release archive** for the version you picked and verifies it against the
   `SHA256SUMS` published with that release. A mismatch stops the install — there is no "install
   anyway".
4. **Unpacks and installs** — extracts to the install path, runs `bun install --production` and
   builds the frontend *as the service account*, so no root-owned file can break the panel later.
5. **Creates the service account** (`rslmc`, system account, no login shell) and the folders.
6. **Writes `/etc/rslmc/rslmc.env`** — mode `0600`, `root:rslmc`, with `RSLMC_MODE=production`, the
   host/port you chose, the data folder, and a fresh 64-character `RSLMC_SECRET` (kept across
   upgrades).
7. **Installs the service** — a hardened systemd unit (below), plus `/usr/local/bin/rslmc` as a short
   command. Without systemd (containers, some WSL images) it writes `rslmc-ctl` into the install
   folder instead and says so.
8. **Starts it and waits** — polls `/api/setup/status` for up to 30 s. The install is only reported
   as successful when the panel actually answers; otherwise you get the last 30 journal lines and
   the code stays in place for inspection.
9. **Prints the finish screen** — URL, the bootstrap login, version, paths, the control commands and
   any firewall hint (it tells you the `ufw`/`firewalld` command; it never changes your firewall
   silently).

## Flags (everything the wizard asks, up front)

| Flag | Effect |
| --- | --- |
| `--version <ver>` | `latest` (default) or a pinned version like `2026.10.29.3` |
| `--path <dir>` | code folder (default `/opt/rslmc`) |
| `--data-dir <dir>` | data folder (default `/var/lib/rslmc`) |
| `--host <addr>` / `--link <addr>` | bind address (default `0.0.0.0`) |
| `--port <n>` | HTTP port (default `3000`) |
| `--user <name>` | account the service runs as (default `rslmc`) |
| `--no-systemd` | write `rslmc-ctl` instead of a unit |
| `--user-mode` | install entirely under `$HOME`; no root, no service unit |
| `--yes` / `-y` | accept every default, still show progress |
| `--unattended` | accept every default and never wait for input |
| `--uninstall` | stop and remove the panel (data kept) |
| `--purge` | with `--uninstall`: delete the data folder as well |
| `--dry-run` | print the plan and exit |
| `--no-color` | plain output |
| `--help` | the full list |

Unattended install:

```bash
bash <(curl -sSL …/install.sh) --unattended \
  --version latest --path /opt/rslmc --data-dir /var/lib/rslmc \
  --host 0.0.0.0 --port 3000
```

Unprivileged install for one user (great for trying it out):

```bash
bash <(curl -sSL …/install.sh) --user-mode
# code in ~/rslmc, data in ~/.local/share/rslmc, control script instead of systemd
```

## What is created

| Path | Purpose |
| --- | --- |
| `/opt/rslmc` | the code (replaced on upgrade) |
| `/var/lib/rslmc` | database, servers, worlds, backups, Java runtimes, logs |
| `/etc/rslmc/rslmc.env` | production configuration, mode `600`, holds the session secret |
| `/etc/systemd/system/rslmc.service` | the unit |
| `/usr/local/bin/rslmc` | `rslmc start\|stop\|restart\|status\|logs\|url\|edit` |
| `/usr/local/bin/bun` | only installed if Bun was missing |

The unit is deliberately small and hardened:

```ini
[Service]
User=rslmc
WorkingDirectory=/opt/rslmc
EnvironmentFile=/etc/rslmc/rslmc.env
ExecStart=/usr/local/bin/bun src/index.ts
Restart=always
RestartSec=3
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=yes
ReadWritePaths=/opt/rslmc /var/lib/rslmc
```

`ProtectSystem=full` keeps `/usr`, `/boot` and `/etc` read-only for the panel; the only two writable
places are its own folder (the frontend bundle) and the data folder. Everything the panel manages
lives in the data folder, which is why an upgrade cannot cost you a server.

## After the install

* Sign in at the printed URL with **`admin` / `admin123`** and change it immediately — the panel
  keeps `mustChangePassword` set and warns everywhere until you do.
* Point the panel at a real address for players in *Settings → Networking*.
* Back up by copying the data folder; `Administration → Backups` also snapshots the panel database.

### Behind a reverse proxy

The panel is happy behind Caddy or nginx. Terminate TLS there, proxy to `127.0.0.1:3000`, and set
`RSLMC_TRUST_PROXY=true` in `/etc/rslmc/rslmc.env` so rate limits and audit entries see the real
client IP from `X-Forwarded-For`.

```caddyfile
panel.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

```nginx
server {
    listen 443 ssl http2;
    server_name panel.example.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;   # the console socket
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

For a proxy setup, install with `--host 127.0.0.1` so the panel is not reachable around the proxy.

## Upgrading

Either use the panel (*Administration → About → Install update*, which keeps servers running), or
re-run the installer — it detects the existing installation, keeps the data folder and secret, stops
the panel, swaps the code, restarts it and verifies the answer:

```bash
bash <(curl -sSL …/install.sh)          # same answers as last time, all defaults preserved
bash <(curl -sSL …/install.sh) --version 2026.10.29.2   # or pin a specific one
```

The previous code is kept at `/opt/rslmc.previous` until the new version answers, so a bad build can
be rolled back by hand (`mv /opt/rslmc.previous /opt/rslmc && systemctl restart rslmc`).

## Uninstalling

```bash
sudo bash <(curl -sSL …/install.sh) --uninstall            # stops + removes code, keeps data
sudo bash <(curl -sSL …/install.sh) --uninstall --purge    # also deletes the data folder
```

`--purge` only deletes a folder that actually looks like an RSLMC data folder (`panel.env` or
`database/rslmc.db` inside it). If it does not, the installer refuses and asks you to pass the path
explicitly — an uninstaller should never be able to delete the wrong directory.

## Troubleshooting

| Symptom | What is happening | Fix |
| --- | --- | --- |
| `Port 3000 is already in use` | something else listens there | `--port 3001`, or stop the other process |
| `The panel is running but did not answer …` | the service starts and exits again | the last journal lines are printed; `journalctl -u rslmc -n 50` after the fact |
| `Checksum mismatch` | a truncated or tampered download | run it again; if it repeats, do not install that archive |
| `api.github.com did not answer (rate limited?)` | shared IP hit GitHub's anonymous limit | harmless: the installer falls back to the release redirect and carries on |
| Bun was installed but `bun: command not found` | `~/.local/bin` is not on your `PATH` (user mode only) | add it to your shell profile; the service uses an absolute path anyway |
| No systemd (container, minimal WSL) | the panel cannot be supervised by `systemctl` | the installer writes `rslmc-ctl`; to survive reboots, use a container restart policy or a supervisor of your choice |
| The console shows a blank page behind a proxy | WebSocket upgrade not forwarded | add the `Upgrade`/`Connection` headers (snippet above) |

## What the installer deliberately does not do

* It does not touch your firewall or open ports on its own — it prints the exact command instead.
* It does not configure a reverse proxy, TLS or DNS; the snippets above are the whole job.
* It does not enable privileged cgroup enforcement; the panel reports disk limits as *advisory* and
  memory/CPU as *enforced* through cgroup v2 when the environment allows it. See
  [Resource enforcement](../README.md#resource-enforcement--reported-honestly).
* It does not install Java — the panel downloads Eclipse Temurin 8–25 into its data folder when a
  server needs it.
