# Repo page — the exact text to paste into GitHub

Two GitHub settings are not in the repository itself, so they cannot be changed by pushing code:
the **About** box (description, website, topics) and the **social preview** image. Everything is
prepared below — copy, paste, done. Each takes under a minute.

---

## 1. Description (repo → ⚙️ *Edit repository details* → Description)

Current, and what should replace it:

| | |
|---|---|
| ✗ now | `A self-hosted Minecraft server panel that shows you the truth — real processes, real metrics, no black boxes.` |
| ✓ use | `Self-hosted Minecraft server panel — installs Paper/Purpur/Fabric/Forge/Velocity and the matching Java, runs each server as its own OS process, with console, files, players, worlds, backups and CalVer self-updates.` |

Shorter alternative, if the box cuts it off:

```
Self-hosted Minecraft server panel: real processes, real metrics, console, files, players, worlds, backups, self-updates.
```

---

## 2. Topics (same dialog → *Topics*)

Paste these one by one (GitHub lowercases them):

```
minecraft
minecraft-server
server-panel
game-server
server-management
bun
typescript
react
sqlite
self-hosted
windows
linux
pterodactyl-alternative
calver
```

---

## 3. Website (optional)

If the panel is running anywhere public, put that URL here — GitHub shows it next to the description.
`http://<your-host>:19519` is fine; leave the field empty otherwise.

---

## 4. Social preview (Settings → Social preview)

Upload **`docs/screenshots/overview-midnight.png`** (1440×900). It is the shot that shows the most of
the panel at once: sidebar, resource cards, live console, server info, RUNNING badge.

---

## 5. While you are in Settings

- **Releases** → check *Enable releases* (the updater reads `/releases`; with releases off it falls
  back to tags).
- **Deploy keys** → delete the old `rslmc-push` key if it is still listed. Its private half no longer
  exists, so it can never be used again; keeping it only widens the attack surface.
- **Secrets and variables → Actions** → nothing is required. CI runs on the GitHub runner with no
  secrets, which is why the suite is built to work offline.

---

## What is already correct in the repository

| Thing | Where |
|---|---|
| Name, tagline, badges, screenshot | `README.md` (top block) |
| Licence | `LICENSE` (MIT) |
| Contributing rules, security policy | `CONTRIBUTING.md`, `SECURITY.md` |
| Issue templates, pull-request template | `.github/ISSUE_TEMPLATE/`, `.github/pull_request_template.md` |
| CI (typecheck, tests, adversarial harness, Windows smoke test) | `.github/workflows/ci.yml` |
| Release pipeline (CalVer tag → tarball + `SHA256SUMS` → GitHub release) | `.github/workflows/release.yml` |
| Update reference for operators | `docs/updating.md` |
| Screenshots (29) | `docs/screenshots/` |
