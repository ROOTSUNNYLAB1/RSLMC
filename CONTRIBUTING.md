# Contributing to RSLMC

Thanks for wanting to help. This project has one non-negotiable rule:

> **Never show the user something that is not real.**

If a feature cannot be implemented yet, it says so. A pretty placeholder is a bug, not a feature.

## Getting set up

```bash
bun install
bun src/index.ts      # http://localhost:3000, bootstrap admin: admin / admin123
```

Data lives outside the repository (`/opt/rslmc`, `%ProgramData%\RSLMC` or
`~/Library/Application Support/RSLMC`). Set `RSLMC_DATA_DIR` to keep everything in one folder while
developing.

## Before you open a pull request

```bash
bun test                            # must be green
bun run tests/security/pentest.ts   # must be 100% green
bun run typecheck                   # tsc --noEmit, strict
```

* **New behaviour needs a test.** Logic goes in `tests/*.test.ts`; anything that crosses an account
  boundary also gets a check in `tests/security/pentest.ts`.
* **New API routes:** add the permission check first, then the handler. Public routes must be added
  to `PUBLIC_ROUTES` (or `PUBLIC_ROUTE_PATTERNS`) in `src/api/index.ts` or they will 401.
* **Frontend work** follows the design system in `frontend/styles.css`: use the CSS tokens, never a
  raw hex colour. Themes must keep working — if you add a colour, add it to every theme block.
* **Secrets never reach the audit log, the API response or the browser.** Only "is one stored".

## Style

* TypeScript everywhere, no `any` in new code unless it is at a boundary with a comment.
* Comments explain *why*, not *what*.
* UI copy is plain English, short, and never promises something the backend does not do.

## Commit messages

`area: what changed` — e.g. `themes: add per-account preference`, `files: refuse traversal in zip`.
