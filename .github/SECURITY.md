# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Use GitHub's
*Security → Report a vulnerability* on this repository, or contact the maintainer directly.

Include what you did, what happened, and what you expected. A proof of concept (a curl command, a
small script, a description of the request sequence) is worth more than a scanner report.

You can expect an acknowledgement within a few days. Confirmed issues are fixed in the open and
documented in [SECURITY.md](../SECURITY.md) with the class of bug and the mitigation, because
publishing what went wrong is how the next person avoids it.

## Supported versions

The `main` branch is the supported version. Fixes land there first.

## What RSLMC already defends against

`bun run tests/security/pentest.ts` boots a throwaway panel and attacks it — 101 checks covering
authentication, IDOR, privilege escalation, CSRF, injection, resource exhaustion, header hygiene,
the OAuth callback, uploads and per-account settings. Run it before reporting; if a check is missing
for the class of bug you found, that is a valuable report on its own.

## Known and accepted

* Plugins installed on a Minecraft server run unsandboxed inside that server's JVM. This is the same
  trade-off every panel makes and it is stated in the README.
* Remote node execution is not implemented yet, so there is no agent attack surface to test.
