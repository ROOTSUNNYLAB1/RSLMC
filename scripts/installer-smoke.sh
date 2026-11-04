#!/usr/bin/env bash
#
#  installer-smoke.sh — proves install.sh survives being *run*, not just parsed.
#
#  Why this exists: `bash -n install.sh` (and shellcheck) only parse the file. A function used
#  before its definition — `canonical_path` called at line 646 but defined at line 855 — parses
#  perfectly and then dies on line 646 of every single run, which is a release blocker that no
#  syntax check catches. This script executes the real installer in `--dry-run --unattended` mode
#  for every path shape the wizard can produce, and fails if any of them exits non-zero.
#
#  Usage:  bash scripts/installer-smoke.sh
#  CI:     one step in .github/workflows/ci.yml
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="$ROOT/install.sh"
failures=0

run_case() {  # run_case <label> <expected-exit> <args...>
  local label="$1" expected="$2"
  shift 2
  local output status
  output="$(bash "$INSTALLER" "$@" 2>&1)"
  status=$?
  if [[ "$status" -eq "$expected" ]]; then
    printf '  ok    %s (exit %s)\n' "$label" "$status"
  else
    printf '  FAIL  %s (exit %s, expected %s)\n' "$label" "$status" "$expected"
    printf '%s\n' "$output" | tail -n 6 | sed 's/^/        /'
    failures=$((failures + 1))
  fi
}

echo "install.sh smoke test"

# A normal unattended plan: every flag supplied, nothing touched.
run_case "dry-run with all flags" 0 \
  --dry-run --unattended --version 2026.11.02.1 \
  --path /tmp/rslmc-smoke --data-dir /tmp/rslmc-smoke-data \
  --host 127.0.0.1 --port 39999

# A path that needs canonicalising (/opt/../etc) must be refused by the deny-list, not executed.
run_case "traversal path is refused" 2 \
  --dry-run --unattended --version 2026.11.02.1 \
  --path /opt/../etc --data-dir /tmp/rslmc-smoke-data --host 0.0.0.0 --port 39999

# The data folder may never be the install path.
run_case "data folder equal to install path is refused" 2 \
  --dry-run --unattended --version 2026.11.02.1 \
  --path /tmp/rslmc-smoke --data-dir /tmp/rslmc-smoke --host 0.0.0.0 --port 39999

# A relative path is refused before anything is resolved.
run_case "relative path is refused" 2 \
  --dry-run --unattended --version 2026.11.02.1 \
  --path rslmc --data-dir /tmp/rslmc-smoke-data --host 0.0.0.0 --port 39999

# Help must always work — it is the one thing a broken install still owes the operator.
run_case "--help" 0 --help

# Every function an option handler calls has to be defined before it can run. This is the exact
# class of bug that shipped in v2026.11.02.1, so it gets its own check: any `name()` definition that
# appears after its first call site is a failure.
# Call sites only: comment lines are skipped (the header prose mentions "ask" and "run"), and a
# definition line does not count as its own call site.
first_call_of() {
  # A *call site* is the function in command position — start of a command, or after `;`, `|`, `&&`,
  # `$(`, `then`, `do`, `else`, `!`. Without that, prose in --help ("--dry-run   print the plan")
  # looks like a call to `run`.
  awk -v fn="$1" '
    { line = $0; sub(/^[ \t]+/, "", line) }
    line ~ /^#/ { next }
    $0 ~ "^" fn "\\(\\)" { next }
    $0 ~ "(^|[;|&(${}]|[ \t](then|do|else|if|!))[ \t]*" fn "([ \t(]|$)" { print NR; exit }
  ' "$INSTALLER"
}
definition_of() { grep -n "^$1()" "$INSTALLER" | head -n1 | cut -d: -f1; }

for fn in canonical_path ask download sha256_of version_ge have run is_musl section spin kv; do
  def="$(definition_of "$fn")"
  call="$(first_call_of "$fn")"
  if [[ -z "$def" ]]; then
    printf '  FAIL  %s is called but never defined\n' "$fn"
    failures=$((failures + 1))
  elif [[ -n "$call" && "$call" -lt "$def" ]]; then
    printf '  FAIL  %s is called on line %s but defined on line %s\n' "$fn" "$call" "$def"
    failures=$((failures + 1))
  else
    printf '  ok    %s defined (line %s) before first call (line %s)\n' "$fn" "$def" "${call:-never}"
  fi
done

echo
if [[ $failures -gt 0 ]]; then
  echo "${failures} installer check(s) failed"
  exit 1
fi
echo "all installer checks passed"
