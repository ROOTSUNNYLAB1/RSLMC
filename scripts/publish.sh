#!/usr/bin/env bash
# Publishes this repository to GitHub in one shot.
#
#   GITHUB_TOKEN=github_pat_xxx ./scripts/publish.sh
#
# The token is only ever read from the environment: it is not written to disk, not put in .git/config
# and not echoed. Needs (fine-grained): Contents: RW, Workflows: RW, Administration: RW if the repo
# does not exist yet. Classic token: `repo` + `workflow` scopes.
set -euo pipefail

REPO_NAME="${REPO_NAME:-RSLMC}"
DESCRIPTION="${DESCRIPTION:-A self-hosted Minecraft server panel that shows you the truth — real processes, real metrics, no black boxes.}"
HOMEPAGE="${HOMEPAGE:-}"
TOPICS='["minecraft","minecraft-server","server-panel","bun","typescript","react","sqlite","self-hosted","game-server","pterodactyl-alternative"]'

: "${GITHUB_TOKEN:?Set GITHUB_TOKEN first: GITHUB_TOKEN=... ./scripts/publish.sh}"
API="https://api.github.com"

api() { # method path [body]
  curl -sS -X "$1" -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" \
    -H "Content-Type: application/json" ${3:+-d "$3"} "${API}$2"
}

echo "→ Identifying the account…"
LOGIN=$(api GET /user | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("login",""))')
[ -n "$LOGIN" ] || { echo "The token was rejected by GitHub."; exit 1; }
echo "  account: ${LOGIN}"

echo "→ Creating ${LOGIN}/${REPO_NAME} (public)…"
CREATE=$(api POST /user/repos "$(python3 - "$REPO_NAME" "$DESCRIPTION" "$HOMEPAGE" <<'PY'
import json, sys
name, description, homepage = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({
    "name": name, "description": description, "homepage": homepage or None,
    "private": False, "has_issues": True, "has_wiki": False, "has_projects": False,
    "has_discussions": True, "auto_init": False, "squash_merge_commit_title": "PR_TITLE",
}))
PY
)")
echo "$CREATE" | python3 -c '
import sys, json
d = json.load(sys.stdin)
if "full_name" in d:
    print("  created:", d["full_name"], "→", d["html_url"])
elif d.get("errors") and any("already exists" in str(e.get("message","")) for e in d["errors"]):
    print("  repository already exists, continuing")
else:
    print("  GitHub said:", json.dumps(d)[:400])
' || true

# ---------------------------------------------------------------- push
cd "$(dirname "$0")/.."
git remote remove origin 2>/dev/null || true
# Token in the URL only for this one push; the stored remote is clean.
git push "https://x-access-token:${GITHUB_TOKEN}@github.com/${LOGIN}/${REPO_NAME}.git" HEAD:main --force
git remote add origin "https://github.com/${LOGIN}/${REPO_NAME}.git"
git branch --set-upstream-to=origin/main main 2>/dev/null || true

echo "→ Filling in the repository owner inside .github/ISSUE_TEMPLATE/config.yml…"
if grep -q "OWNER" .github/ISSUE_TEMPLATE/config.yml; then
  sed -i.bak "s|OWNER/${REPO_NAME}|${LOGIN}/${REPO_NAME}|g" .github/ISSUE_TEMPLATE/config.yml && rm -f .github/ISSUE_TEMPLATE/config.yml.bak
  git add .github/ISSUE_TEMPLATE/config.yml
  git -c user.name="RSLMC" -c user.email="rslmc@users.noreply.github.com" \
      commit -q -m "github: point the security advisory link at the real repository"
  git push "https://x-access-token:${GITHUB_TOKEN}@github.com/${LOGIN}/${REPO_NAME}.git" HEAD:main
fi

echo "→ Setting topics…"
api PUT "/repos/${LOGIN}/${REPO_NAME}/topics" "{\"names\": ${TOPICS}}" >/dev/null || echo "  (topics skipped)"

echo "→ Verifying…"
api GET "/repos/${LOGIN}/${REPO_NAME}" | python3 -c '
import sys, json
d = json.load(sys.stdin)
print("  name        :", d.get("full_name"))
print("  visibility  :", "private" if d.get("private") else "public")
print("  description :", d.get("description"))
print("  default br. :", d.get("default_branch"))
print("  url         :", d.get("html_url"))
if d.get("topics"): print("  topics      :", ", ".join(d["topics"]))
'
echo
echo "Done. Open: https://github.com/${LOGIN}/${REPO_NAME}"
echo "Revoke the token now: https://github.com/settings/tokens"
