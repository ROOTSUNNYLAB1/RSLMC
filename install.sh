#!/usr/bin/env bash
#
#  RSLMC · one-line installer
#
#      bash <(curl -sSL https://raw.githubusercontent.com/ROOTSUNNYLAB1/RSLMC/main/install.sh)
#
#  What it does, in order:
#    1. checks the machine (root, tools, disk, ports) and tells you what it found
#    2. asks you five questions — version, install path, data folder, address, port
#    3. downloads the release archive from GitHub and verifies its SHA-256
#    4. installs Bun if it is missing (checksum-verified), installs the panel, builds the frontend
#    5. creates a service user, an env file with a real secret, and a systemd unit
#    6. starts the panel, waits for it to answer, and prints the URL and the login
#
#  It never touches your data on upgrade: the database, servers, worlds and backups live in the
#  data folder, and only the code folder is replaced.
#
#  Flags (everything the wizard asks can also be given up front):
#    --version <ver>      release to install (default: latest)
#    --path <dir>         code folder            (default: /opt/rslmc)
#    --data-dir <dir>     data folder            (default: /var/lib/rslmc)
#    --port <n>           HTTP port              (default: 3000)
#    --host <addr>        bind address           (default: 0.0.0.0)
#    --user <name>        service user           (default: rslmc)
#    --no-systemd         write a control script instead of a unit (containers, WSL)
#    --user-mode          install without root, entirely under your home folder
#    --yes                accept every default and do not ask for confirmation
#    --unattended         same as --yes, and fail instead of prompting for missing input
#    --uninstall          stop and remove the install (data kept unless --purge)
#    --purge              with --uninstall: delete the data folder too
#    --dry-run            print the plan and exit
#    --no-color           plain output
#    --help
#
set -Eeuo pipefail

INSTALLER_VERSION="1.0.0"
REPO_SLUG="ROOTSUNNYLAB1/RSLMC"
API="https://api.github.com/repos/${REPO_SLUG}"
SERVICE="rslmc"
DEFAULT_PATH="/opt/rslmc"
DEFAULT_DATA="/var/lib/rslmc"
DEFAULT_PORT="3000"
DEFAULT_HOST="0.0.0.0"
DEFAULT_USER="rslmc"
MIN_BUN="1.2.0"

# ─────────────────────────────────────────────────────────────── output ────
# Colours are only emitted when the terminal can show them, so a piped install log stays readable.
if [[ -t 1 && -z "${NO_COLOR:-}" && "${TERM:-dumb}" != "dumb" && "${RSLMC_OPT_NO_COLOR:-0}" != "1" ]]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  C_GREEN=$'\033[38;5;114m'; C_DEEP=$'\033[38;5;35m'
  C_AMBER=$'\033[38;5;179m'; C_RED=$'\033[38;5;167m'
  C_GREY=$'\033[38;5;245m'; C_WHITE=$'\033[38;5;252m'
else
  C_RESET=""; C_DIM=""; C_BOLD=""; C_GREEN=""; C_DEEP=""; C_AMBER=""; C_RED=""; C_GREY=""; C_WHITE=""
fi

STEP_NO=0
STEP_TOTAL=14
LOG_FILE=""

say()  { printf '  %s\n' "$*"; }
dim()  { printf '  %s%s%s\n' "$C_GREY" "$*" "$C_RESET"; }
ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_AMBER" "$C_RESET" "$*"; }
err()  { printf '  %s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
kv()   { printf '  %s%-14s%s %s\n' "$C_GREY" "$1" "$C_RESET" "$2"; }

rule() { printf '  %s%s%s\n' "$C_DIM" "$(printf '─%.0s' $(seq 1 "${1:-64}"))" "$C_RESET"; }

banner() {
  printf '\n'
  printf '  %s██████╗ ███████╗██╗     ███╗   ███╗ ██████╗%s\n' "$C_DEEP" "$C_RESET"
  printf '  %s██╔══██╗██╔════╝██║     ████╗ ████║██╔════╝%s\n' "$C_DEEP" "$C_RESET"
  printf '  %s██████╔╝███████╗██║     ██╔████╔██║██║%s     \n' "$C_GREEN" "$C_RESET"
  printf '  %s██╔══██╗╚════██║██║     ██║╚██╔╝██║██║%s     \n' "$C_GREEN" "$C_RESET"
  printf '  %s██║  ██║███████║███████╗██║ ╚═╝ ██║╚██████╗%s\n' "$C_GREEN" "$C_RESET"
  printf '  %s╚═╝  ╚═╝╚══════╝╚══════╝╚═╝     ╚═╝ ╚═════╝%s\n' "$C_GREEN" "$C_RESET"
  printf '\n'
  printf '  %sMinecraft server panel · installer %s%s\n' "$C_WHITE" "$INSTALLER_VERSION" "$C_RESET"
  printf '  %shttps://github.com/%s%s\n\n' "$C_GREY" "$REPO_SLUG" "$C_RESET"
}

section() {
  STEP_NO=$((STEP_NO + 1))
  printf '\n  %s[%d/%d]%s %s%s%s\n' "$C_GREEN" "$STEP_NO" "$STEP_TOTAL" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"
}

# Runs a command behind a spinner and keeps its output for the failure case.
spin() {
  local message="$1"; shift
  local log rc=0
  log="$(mktemp)"
  ( "$@" ) >"$log" 2>&1 &
  local pid=$!
  local frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i=0 start elapsed
  start=$(date +%s)
  if [[ -t 1 ]]; then
    while kill -0 "$pid" 2>/dev/null; do
      i=$(( (i + 1) % 10 ))
      elapsed=$(( $(date +%s) - start ))
      printf '\r  %s%s%s %s %s(%ss)%s ' "$C_GREEN" "${frames:$i:1}" "$C_RESET" "$message" "$C_GREY" "$elapsed" "$C_RESET"
      sleep 0.08
    done
    printf '\r\033[K'
  fi
  wait "$pid" || rc=$?
  if [[ $rc -eq 0 ]]; then
    ok "$message"
  else
    err "$message"
    printf '  %s%s%s\n' "$C_GREY" "$(printf '┄%.0s' $(seq 1 60))" "$C_RESET"
    tail -n 25 "$log" | sed 's/^/    /' >&2
    printf '  %s%s%s\n' "$C_GREY" "$(printf '┄%.0s' $(seq 1 60))" "$C_RESET"
  fi
  rm -f "$log"
  return $rc
}

on_error() {
  local code=$?
  trap - ERR
  printf '\n'
  err "Installation stopped (exit $code) on line $(caller | awk '{print $1}')."
  if [[ -n "$LOG_FILE" && -s "$LOG_FILE" ]]; then
    printf '\n  %sLast lines of the installer log:%s\n' "$C_GREY" "$C_RESET"
    tail -n 20 "$LOG_FILE" | sed 's/^/    /'
  fi
  printf '\n  %sNothing was left half-started: the panel is either not installed or still on its previous version.%s\n' "$C_GREY" "$C_RESET"
  printf '  %sReport it: https://github.com/%s/issues%s\n\n' "$C_GREY" "$REPO_SLUG" "$C_RESET"
  exit "$code"
}

# ────────────────────────────────────────────────────────────── arguments ────
OPT_VERSION=""; OPT_PATH=""; OPT_DATA=""; OPT_PORT=""; OPT_HOST=""; OPT_USER=""
OPT_YES=0; OPT_UNATTENDED=0; OPT_SYSTEMD=""; OPT_USER_MODE=0
OPT_UNINSTALL=0; OPT_PURGE=0; OPT_DRYRUN=0

usage() {
  cat <<'TXT'
RSLMC installer — installs the panel and its service on this machine.

  bash <(curl -sSL https://raw.githubusercontent.com/ROOTSUNNYLAB1/RSLMC/main/install.sh)

Wizard questions (each one can also be given as a flag):
  --version <ver>    release to install — "latest" (default) or a pinned version like 2026.10.29.3
  --path <dir>       code folder                      (default /opt/rslmc)
  --data-dir <dir>   database, servers, worlds, backups (default /var/lib/rslmc)
  --port <n>         HTTP port                        (default 3000)
  --host <addr>      address the panel answers on     (default 0.0.0.0)
  --user <name>      account the service runs as      (default rslmc)

Other flags:
  --no-systemd       write a control script instead of a systemd unit (containers, WSL)
  --user-mode        install entirely under $HOME, no root needed
  --yes, -y          take every default, no questions (still shows progress)
  --unattended       like --yes, and never wait for input
  --uninstall        stop and remove the panel (data kept)
  --purge            with --uninstall: also delete the data folder
  --dry-run          print the plan and exit
  --no-color         plain output
  --help

What it guarantees:
  · the release archive is checked against the SHA256SUMS published with that release
  · the checksum of Bun is checked too when it has to install it
  · an upgrade never touches the data folder, and the previous code is kept until it works
  · nothing is reported as done until the panel actually answers on its port
TXT
  exit 0
}

need_value() { [[ $# -ge 2 && "${2:-}" != "" ]] || { err "$1 needs a value"; exit 2; }; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)    need_value "$@"; OPT_VERSION="${2#v}"; shift 2 ;;
    --path)       need_value "$@"; OPT_PATH="$2"; shift 2 ;;
    --data-dir)   need_value "$@"; OPT_DATA="$2"; shift 2 ;;
    --port)       need_value "$@"; OPT_PORT="$2"; shift 2 ;;
    --host|--bind|--link) need_value "$@"; OPT_HOST="$2"; shift 2 ;;
    --user)       need_value "$@"; OPT_USER="$2"; shift 2 ;;
    --no-systemd) OPT_SYSTEMD="no"; shift ;;
    --systemd)    OPT_SYSTEMD="yes"; shift ;;
    --user-mode)  OPT_USER_MODE=1; shift ;;
    --yes|-y)     OPT_YES=1; shift ;;
    --unattended) OPT_YES=1; OPT_UNATTENDED=1; shift ;;
    --uninstall)  OPT_UNINSTALL=1; shift ;;
    --purge)      OPT_PURGE=1; shift ;;
    --dry-run)    OPT_DRYRUN=1; shift ;;
    --no-color)   RSLMC_OPT_NO_COLOR=1; C_RESET=""; C_DIM=""; C_BOLD=""; C_GREEN=""; C_DEEP=""; C_AMBER=""; C_RED=""; C_GREY=""; C_WHITE=""; shift ;;
    -h|--help)    usage ;;
    *) err "Unknown option: $1 (try --help)"; exit 2 ;;
  esac
done

# ─────────────────────────────────────────────────────────────── helpers ────
have() { command -v "$1" >/dev/null 2>&1; }

# /dev/tty can exist and still refuse to open (containers, cron, "curl | bash" over ssh -T).
tty_ok() { { : < /dev/tty; } 2>/dev/null; }
INTERACTIVE=0
if tty_ok && [[ $OPT_YES -eq 0 && $OPT_UNATTENDED -eq 0 ]]; then INTERACTIVE=1; fi

# Reads a line from the terminal even when the script itself arrived through a pipe.
ask() {  # ask <prompt> <default> <var>
  local prompt="$1" default="${2:-}" __var="$3" answer="" hint=""
  [[ -n "$default" ]] && hint=" ${C_GREY}[${default}]${C_RESET}"
  if [[ $INTERACTIVE -eq 0 ]]; then
    if [[ -z "$default" ]]; then
      err "No value for '${prompt}' and no terminal to ask on."
      say "Pass it as a flag (see --help) or run the installer from an interactive shell."
      exit 2
    fi
    printf -v "$__var" '%s' "$default"
    return 0
  fi
  printf '  %s%s%s%s ' "$C_WHITE" "$prompt" "$C_RESET" "$hint" >&2
  read -r answer < /dev/tty || answer=""
  [[ -z "$answer" ]] && answer="$default"
  printf -v "$__var" '%s' "$answer"
}

confirm() {  # confirm <question> <default y|n>
  local question="$1" default="${2:-y}" answer=""
  if [[ $OPT_YES -eq 1 || $INTERACTIVE -eq 0 ]]; then return 0; fi
  printf '  %s%s%s %s[%s]%s ' "$C_WHITE" "$question" "$C_RESET" "$C_GREY" "$default" "$C_RESET" >&2
  read -r answer < /dev/tty || answer=""
  answer="${answer:-$default}"
  [[ "$answer" =~ ^[Yy] ]]
}

require_tty_or_yes() {
  if [[ $INTERACTIVE -eq 0 && $OPT_YES -eq 0 ]]; then
    err "This installer asks questions but there is no terminal here to ask them on."
    say "Run it with --unattended (accept every default) or pass --version/--path/--port."
    exit 2
  fi
}

filesize() { # portable file size in bytes
  if stat -c%s "$1" >/dev/null 2>&1; then stat -c%s "$1"; else stat -f%z "$1"; fi
}

url_size() { # Content-Length in bytes, or empty
  curl -fsSIL --max-time 20 "$1" 2>/dev/null | tr -d '\r' \
    | awk 'tolower($1)=="content-length:" {v=$2} END {if (v) print v}' || true
}

human() { # bytes → human
  awk -v b="${1:-0}" 'BEGIN{split("B KB MB GB",u," "); i=1; while (b>=1024 && i<4) {b/=1024; i++}; printf (i==1? "%d %s" : "%.1f %s"), b, u[i]}'
}

download() { # download <url> <dest> [label]
  local url="$1" dest="$2" label="${3:-download}"
  local total="" have_size=0
  total="$(url_size "$url")"
  if [[ -z "$total" || "$total" -le 0 ]] 2>/dev/null; then total=0; fi

  curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 -o "$dest" "$url" &
  local pid=$! frames='⣾⣽⣻⢿⡿⣟⣯⣷' i=0
  if [[ -t 1 ]]; then
    while kill -0 "$pid" 2>/dev/null; do
      have_size=$(filesize "$dest" 2>/dev/null || echo 0)
      i=$(( (i + 1) % 8 ))
      if [[ "$total" -eq 0 ]]; then
        total="$(url_size "$url" || echo 0)"
        [[ -z "$total" ]] && total=0
      fi
      if [[ "$total" -gt 0 ]]; then
        local pct=$(( have_size * 100 / total ))
        local filled=$(( pct * 24 / 100 )) bar="" i2=0
        for ((i2 = 0; i2 < 24; i2++)); do
          if (( i2 < filled )); then bar="${bar}█"; else bar="${bar}░"; fi
        done
        printf '\r\033[K  %s%s%s %-20s %s%3d%%%s %s%s%s %s%s / %s%s' \
          "$C_GREEN" "${frames:$i:1}" "$C_RESET" "$label" \
          "$C_GREY" "$pct" "$C_RESET" "$C_DEEP" "$bar" "$C_RESET" \
          "$C_GREY" "$(human "$have_size")" "$(human "$total")" "$C_RESET"
      else
        printf '\r\033[K  %s%s%s %-20s %s%s%s' \
          "$C_GREEN" "${frames:$i:1}" "$C_RESET" "$label" "$C_GREY" "$(human "$have_size")" "$C_RESET"
      fi
      sleep 0.1
    done
    printf '\r\033[K'
  fi
  wait "$pid" || {
    err "Download failed: $url"
    say "If that version looks wrong, the releases page lists what exists:"
    say "https://github.com/${REPO_SLUG}/releases"
    return 1
  }
  ok "$label ($(human "$(filesize "$dest")"))"
}

sha256_of() {
  if have sha256sum; then sha256sum "$1" | awk '{print $1}'
  elif have shasum; then shasum -a 256 "$1" | awk '{print $1}'
  elif have openssl; then openssl dgst -sha256 -r "$1" | awk '{print $1}'
  else return 1; fi
}

version_ge() { # version_ge 1.4.4 1.2.0
  [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]
}

detect_os() {
  OS=""; DISTRO=""; PKG=""
  case "$(uname -s)" in
    Linux) OS="linux" ;;
    Darwin) OS="darwin" ;;
    *) OS="other" ;;
  esac
  if [[ "$OS" == "linux" && -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    DISTRO="$(. /etc/os-release && printf '%s' "${ID:-unknown}")"
    case "$DISTRO" in
      debian|ubuntu|linuxmint|pop|raspbian|kali) PKG="apt-get" ;;
      fedora|rhel|centos|rocky|almalinux|ol) PKG="dnf"; have dnf || PKG="yum" ;;
      arch|manjaro|endeavouros) PKG="pacman" ;;
      alpine) PKG="apk" ;;
      opensuse*|sles) PKG="zypper" ;;
      *) PKG="" ;;
    esac
  fi
}

is_musl() { [[ -f /etc/alpine-release ]] || (ldd /bin/sh 2>/dev/null | grep -qi musl); }

have_systemd() {
  [[ "$OS" == "linux" ]] && have systemctl && [[ -d /run/systemd/system ]]
}

primary_ip() {
  local ip=""
  if have ip; then ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"; fi
  if [[ -z "$ip" ]] && have hostname; then ip="$(hostname -I 2>/dev/null | awk '{print $1}')"; fi
  if [[ -z "$ip" ]] && have ifconfig; then ip="$(ifconfig 2>/dev/null | awk '/inet /{print $2; exit}')"; fi
  printf '%s' "${ip:-127.0.0.1}"
}

port_free() { # port_free <port> [host]
  local port="$1" host="${2:-127.0.0.1}"
  if have ss; then ! ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN
  elif have lsof; then ! lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  elif have nc; then ! nc -z "$host" "$port" >/dev/null 2>&1
  else return 0; fi
}


# GitHub answers https://github.com/<repo>/releases/latest with a redirect to the newest tag.
# Unlike api.github.com this is not rate limited, so the installer still works on a fresh server
# or behind a shared NAT.
latest_tag() {
  local loc
  loc="$(curl -sIL --max-time 20 "https://github.com/${REPO_SLUG}/releases/latest" 2>/dev/null \
    | tr -d '\r' | awk 'tolower($1)=="location:" {print $2}' | tail -n1)"
  loc="${loc##*/tag/}"
  printf '%s' "${loc#v}"
}

# ─────────────────────────────────────────────────────────────── preflight ────
banner

if [[ $OPT_UNINSTALL -eq 0 ]]; then
  section "Checking this machine"
else
  section "Preparing to uninstall"
fi

detect_os
if [[ "$OS" == "other" ]]; then
  err "This installer supports Linux and macOS. On Windows, run the panel in WSL2 or read the manual steps:"
  say "https://github.com/${REPO_SLUG}#quick-start"
  exit 1
fi

ROOT=0
if [[ "$(id -u)" -eq 0 ]]; then ROOT=1; fi

# Privileged steps are escalated one command at a time instead of re-executing the whole script.
# That matters because "$0" is /dev/fd/63 when this installer came from `bash <(curl …)` — it cannot
# be re-run, and a fresh copy of it cannot be recovered either (the descriptor is already consumed).
SUDO=""
CAN_ROOT=$ROOT
if [[ $ROOT -eq 0 ]] && have sudo; then
  CAN_ROOT=1
  SUDO="sudo"
fi
run() { if [[ -n "$SUDO" ]]; then sudo "$@"; else "$@"; fi; }

if [[ $OPT_USER_MODE -eq 0 && $CAN_ROOT -eq 0 ]]; then
  warn "Not root and sudo is unavailable — continuing as a user-mode install under \$HOME."
  OPT_USER_MODE=1
fi

for tool in curl tar; do
  if ! have "$tool"; then
    err "$tool is required and missing."
    [[ -n "$PKG" ]] && say "Install it first: sudo $PKG install -y $tool"
    exit 1
  fi
done

if ! have sha256sum && ! have shasum && ! have openssl; then
  err "No SHA-256 tool found (sha256sum, shasum or openssl) — refusing to install unverified code."
  exit 1
fi

# Defaults depend on whether this is a system install or a user install.
if [[ $OPT_USER_MODE -eq 1 ]]; then
  DEFAULT_PATH="$HOME/rslmc"
  DEFAULT_DATA="$HOME/.local/share/rslmc"
  DEFAULT_USER="$(id -un)"
fi

# An existing install supplies its own answers, so re-running the same command is an upgrade.
EXISTING=0
EXISTING_VERSION=""
EXISTING_PORT=""
ENV_FILE="/etc/${SERVICE}/${SERVICE}.env"
CTL_FILE=""
if [[ -r "$ENV_FILE" ]]; then
  EXISTING=1
  # shellcheck disable=SC1090
  OPT_PATH="${OPT_PATH:-$(sed -n 's/^# RSLMC_INSTALL_PATH=//p' "$ENV_FILE" 2>/dev/null | head -n1)}"
  OPT_DATA="${OPT_DATA:-$(sed -n 's/^RSLMC_DATA_DIR=//p' "$ENV_FILE" 2>/dev/null | head -n1)}"
  OPT_PORT="${OPT_PORT:-$(sed -n 's/^RSLMC_PORT=//p' "$ENV_FILE" 2>/dev/null | head -n1)}"
  OPT_HOST="${OPT_HOST:-$(sed -n 's/^RSLMC_HOST=//p' "$ENV_FILE" 2>/dev/null | head -n1)}"
  EXISTING_PORT="${OPT_PORT:-}"
  if [[ -f "${OPT_PATH:-/opt/rslmc}/package.json" ]]; then
    EXISTING_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$OPT_PATH/package.json" | head -n1)"
  fi
  ok "Existing installation found${EXISTING_VERSION:+ (version $EXISTING_VERSION)}"
elif [[ -r "$HOME/.local/share/rslmc/panel.env" ]]; then
  ENV_FILE="$HOME/.local/share/rslmc/panel.env"
  EXISTING=1
  OPT_PATH="${OPT_PATH:-$(sed -n 's/^# RSLMC_INSTALL_PATH=//p' "$ENV_FILE" 2>/dev/null | head -n1)}"
  OPT_DATA="${OPT_DATA:-$(sed -n 's/^RSLMC_DATA_DIR=//p' "$ENV_FILE" 2>/dev/null | head -n1)}"
  OPT_PORT="${OPT_PORT:-$(sed -n 's/^RSLMC_PORT=//p' "$ENV_FILE" 2>/dev/null | head -n1)}"
  OPT_HOST="${OPT_HOST:-$(sed -n 's/^RSLMC_HOST=//p' "$ENV_FILE" 2>/dev/null | head -n1)}"
  EXISTING_PORT="${OPT_PORT:-}"
  if [[ -f "${OPT_PATH:-$HOME/rslmc}/package.json" ]]; then
    EXISTING_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$OPT_PATH/package.json" | head -n1)"
  fi
  ok "Existing user-mode installation found${EXISTING_VERSION:+ (version $EXISTING_VERSION)}"
fi

kv "System" "$(uname -s) $(uname -r | cut -d- -f1) · $(uname -m)"
[[ -n "$DISTRO" ]] && kv "Distribution" "$DISTRO${PKG:+ · $PKG}"
kv "User" "$(id -un) $( [[ $ROOT -eq 1 ]] && echo '(root)' )"
if have_systemd; then kv "Service manager" "systemd"; else kv "Service manager" "none — a control script will be written"; fi

DISK_TARGET="/"
[[ -n "$OPT_DATA" ]] && DISK_TARGET="$(dirname "$OPT_DATA")"
while [[ ! -d "$DISK_TARGET" && "$DISK_TARGET" != "/" ]]; do DISK_TARGET="$(dirname "$DISK_TARGET")"; done
FREE_MB="$(df -Pm "$DISK_TARGET" 2>/dev/null | awk 'NR==2 {print $4}')"
FREE_MB="${FREE_MB:-0}"
kv "Free disk" "$(human $((FREE_MB * 1024 * 1024))) on $DISK_TARGET"
if [[ "$FREE_MB" -lt 1500 ]]; then
  warn "Less than 1.5 GB free. The panel itself needs ~200 MB; Minecraft servers and Java runtimes need the rest."
fi
MEM_MB="$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || sysctl -n hw.memsize 2>/dev/null | awk '{printf "%d", $1/1024/1024}' || echo 0)"
[[ "${MEM_MB:-0}" -gt 0 ]] && kv "Memory" "${MEM_MB} MB"

# ──────────────────────────────────────────────────────────── uninstall path ────
if [[ $OPT_UNINSTALL -eq 1 ]]; then
  STEP_TOTAL=4
  section "Stopping the panel"
  if have systemctl && { [[ -f "/etc/systemd/system/${SERVICE}.service" ]] || systemctl status "$SERVICE" >/dev/null 2>&1; }; then
    spin "Stopping ${SERVICE}.service" run systemctl disable --now "$SERVICE" || true
    if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
      err "${SERVICE}.service is still running after systemctl stop."
      say "Look at: journalctl -u ${SERVICE} -n 40"
      exit 1
    fi
    ok "${SERVICE}.service is stopped"
  elif [[ -x "${OPT_PATH:-/opt/rslmc}/rslmc-ctl" ]]; then
    if ! spin "Stopping ${SERVICE}" "${OPT_PATH}/rslmc-ctl" stop; then
      err "The control script could not stop the panel."
      exit 1
    fi
  else
    warn "No service found — nothing to stop."
  fi

  # The state file next to the code knows where this installation kept its data and config.
  UNINSTALL_PATH="${OPT_PATH:-/opt/rslmc}"
  if [[ -f "${UNINSTALL_PATH}/.rslmc-install" ]]; then
    # shellcheck disable=SC1090
    . "${UNINSTALL_PATH}/.rslmc-install"
    OPT_DATA="${OPT_DATA:-${STATE_DATA_DIR:-}}"
    OPT_PATH="$UNINSTALL_PATH"
  else
    OPT_PATH="$UNINSTALL_PATH"
  fi

  section "Removing the panel"
  if [[ -x "${OPT_PATH:-/opt/rslmc}/rslmc-ctl" && $OPT_USER_MODE -eq 1 ]]; then
    rm -rf "${OPT_PATH:?}"
    ok "Removed $OPT_PATH"
  elif [[ $CAN_ROOT -eq 1 ]]; then
    run rm -f "/etc/systemd/system/${SERVICE}.service" /usr/local/bin/rslmc
    run rm -rf "${OPT_PATH:?}" "/etc/${SERVICE}"
    run systemctl daemon-reload 2>/dev/null || true
    run systemctl reset-failed "$SERVICE" 2>/dev/null || true
    ok "Removed $OPT_PATH, /etc/${SERVICE} and the service unit"
  else
    rm -rf "${OPT_PATH:?}"
    ok "Removed $OPT_PATH"
  fi

  DATA_DIR_FOUND="${OPT_DATA:-${STATE_DATA_DIR:-}}"
  if [[ $OPT_PURGE -eq 1 ]]; then
    # Only delete a folder that actually looks like an RSLMC data folder. Getting this wrong would
    # be the one unrecoverable mistake an uninstaller can make, so it is checked, not assumed.
    looks_like_data=0
    if [[ -n "$DATA_DIR_FOUND" && "$DATA_DIR_FOUND" != "/" ]]; then
      if [[ -f "$DATA_DIR_FOUND/panel.env" || -f "$DATA_DIR_FOUND/database/rslmc.db" ]]; then looks_like_data=1; fi
    fi
    if [[ $looks_like_data -eq 1 ]]; then
      rm -rf "${DATA_DIR_FOUND:?}"
      ok "Deleted data folder $DATA_DIR_FOUND"
    else
      err "Not deleting '${DATA_DIR_FOUND:-?}' — it does not look like an RSLMC data folder."
      say "Point at the right one explicitly: --uninstall --purge --data-dir <path>"
      exit 1
    fi
  else
    say ""
    kv "Data kept" "$DATA_DIR_FOUND"
    dim "Your database, servers, worlds and backups are still there."
    dim "Delete them with: bash <(curl -sSL …/install.sh) --uninstall --purge"
  fi
  printf '\n'
  ok "Uninstalled."
  exit 0
fi

# An existing install is the best source of defaults: re-running the same command must not silently
# move the panel to another port or address.
if [[ $EXISTING -eq 1 ]]; then
  [[ -n "${OPT_PORT:-}" ]] && DEFAULT_PORT="$OPT_PORT"
  [[ -n "${OPT_HOST:-}" ]] && DEFAULT_HOST="$OPT_HOST"
fi

# ───────────────────────────────────────────────────────────────── wizard ────
require_tty_or_yes

section "Choosing what to install"

# --- 1. version -------------------------------------------------------------------------------
LATEST=""
RELEASES=()
RELEASE_DATES=()
if have curl; then
  json="$(curl -fsSL --max-time 20 "${API}/releases?per_page=10" 2>/dev/null || true)"
  if [[ -z "$json" ]]; then
    warn "api.github.com did not answer (rate limited?) — falling back to the release redirect."
  fi
  if [[ -n "$json" ]]; then
    while IFS='|' read -r tag date; do
      [[ -z "$tag" ]] && continue
      RELEASES+=("${tag#v}")
      RELEASE_DATES+=("${date%%T*}")
    done < <(printf '%s' "$json" | tr '{' '\n' | sed -n 's/.*"tag_name": *"\([^"]*\)".*"published_at": *"\([^"]*\)".*/\1|\2/p')
  fi
fi
[[ ${#RELEASES[@]} -gt 0 ]] && LATEST="${RELEASES[0]}"
if [[ -z "$LATEST" ]]; then
  LATEST="$(latest_tag)"
  if [[ -n "$LATEST" ]]; then RELEASES+=("$LATEST"); RELEASE_DATES+=(""); fi
fi

if [[ -n "${OPT_VERSION:-}" ]]; then
  VERSION="$OPT_VERSION"
else
  say "${C_WHITE}Which version should be installed?${C_RESET}"
  if [[ ${#RELEASES[@]} -gt 0 ]]; then
    printf '\n'
    local_i=1
    for i in "${!RELEASES[@]}"; do
      marker=""
      [[ $i -eq 0 ]] && marker=" ${C_GREEN}(latest)${C_RESET}"
      printf '    %s%d)%s %-14s %s%s%s%s\n' "$C_GREY" "$local_i" "$C_RESET" "${RELEASES[$i]}" "$C_GREY" "${RELEASE_DATES[$i]}" "$C_RESET" "$marker"
      local_i=$((local_i + 1))
      [[ $local_i -gt 6 ]] && break
    done
    printf '\n'
    dim "Pick a number, or type a full version (e.g. 2026.10.29.2) or 'latest'. Press Enter for latest."
  else
    warn "Could not reach the GitHub releases API — type the version you want."
    dim "Example: 2026.10.29.3   (or 'latest' once the network works)"
  fi
  answer=""
  if [[ $INTERACTIVE -eq 1 ]]; then
    printf '  %sVersion%s %s[%s]%s ' "$C_WHITE" "$C_RESET" "$C_GREY" "${LATEST:-latest}" "$C_RESET" >&2
    read -r answer < /dev/tty || answer=""
  fi
  answer="${answer:-latest}"
  if [[ "$answer" =~ ^[0-9]+$ && ${#RELEASES[@]} -gt 0 ]]; then
    idx=$((answer - 1))
    if [[ $idx -ge 0 && $idx -lt ${#RELEASES[@]} ]]; then VERSION="${RELEASES[$idx]}"; else VERSION="${LATEST:-latest}"; fi
  else
    VERSION="${answer#v}"
  fi
fi

if [[ "$VERSION" == "latest" || -z "$VERSION" ]]; then
  if [[ -z "$LATEST" ]]; then
    err "No release list available and no explicit version given."
    exit 1
  fi
  VERSION="$LATEST"
  VERSION_NOTE="latest release"
else
  VERSION_NOTE="pinned by you"
  if [[ ${#RELEASES[@]} -gt 0 ]] && ! printf '%s\n' "${RELEASES[@]}" | grep -qx "$VERSION"; then
    warn "$VERSION is not in the last 10 releases — I will still try the download, and fail honestly if it is not there."
  fi
fi
ARCHIVE="rslmc-${VERSION}.tar.gz"
DOWNLOAD_URL="https://github.com/${REPO_SLUG}/releases/download/v${VERSION}/${ARCHIVE}"
SUMS_URL="https://github.com/${REPO_SLUG}/releases/download/v${VERSION}/SHA256SUMS"
ok "Version ${C_BOLD}${VERSION}${C_RESET} (${VERSION_NOTE})"

# --- 2. install path ---------------------------------------------------------------------------
if [[ -n "${OPT_PATH:-}" ]]; then
  INSTALL_PATH="$OPT_PATH"
else
  ask "Install path" "$DEFAULT_PATH" INSTALL_PATH
fi
if [[ "$INSTALL_PATH" != /* ]]; then err "The install path must be absolute (got '$INSTALL_PATH')."; exit 2; fi
INSTALL_PATH="${INSTALL_PATH%/}"
case "$INSTALL_PATH" in
  /bin|/boot|/dev|/etc|/lib|/proc|/sys|/usr|/var|/home|/root|/opt|/) err "Refusing to install into $INSTALL_PATH — pick a folder of its own."; exit 2 ;;
esac
ok "Install path ${C_BOLD}${INSTALL_PATH}${C_RESET}"

# A previous run leaves a small state file next to the code, so re-running this installer on the
# same path is an upgrade: same data folder, same env file, same secret, servers untouched.
STATE_FILE="${INSTALL_PATH}/.rslmc-install"
if [[ -f "$STATE_FILE" ]]; then
  # shellcheck disable=SC1090
  . "$STATE_FILE"
  EXISTING=1
  EXISTING_VERSION="${STATE_VERSION:-$EXISTING_VERSION}"
  OPT_DATA="${OPT_DATA:-${STATE_DATA_DIR:-}}"
  ENV_FILE="${STATE_ENV_FILE:-$ENV_FILE}"
  if [[ -r "$ENV_FILE" ]]; then
    EXISTING_PORT="$(sed -n 's/^RSLMC_PORT=//p' "$ENV_FILE" 2>/dev/null | head -n1)"
    OPT_PORT="${OPT_PORT:-$EXISTING_PORT}"
    OPT_HOST="${OPT_HOST:-$(sed -n 's/^RSLMC_HOST=//p' "$ENV_FILE" 2>/dev/null | head -n1)}"
  fi
  ok "Existing installation here${EXISTING_VERSION:+ (version $EXISTING_VERSION)} — this run is an upgrade"
fi

# --- 3. data folder ----------------------------------------------------------------------------
if [[ -n "${OPT_DATA:-}" ]]; then
  DATA_DIR="$OPT_DATA"
else
  say ""
  dim "The database, servers, worlds, backups and Java runtimes live here. It is never replaced by an update."
  ask "Data folder" "$DEFAULT_DATA" DATA_DIR
fi
if [[ "$DATA_DIR" != /* ]]; then err "The data folder must be absolute (got '$DATA_DIR')."; exit 2; fi
DATA_DIR="${DATA_DIR%/}"
if [[ "$DATA_DIR" == "$INSTALL_PATH" ]]; then err "The data folder cannot be the same as the install path."; exit 2; fi
if [[ $EXISTING -eq 1 ]]; then
  ok "Data folder ${C_BOLD}${DATA_DIR}${C_RESET} (kept — your servers and worlds stay put)"
else
  ok "Data folder ${C_BOLD}${DATA_DIR}${C_RESET}"
fi

# --- 4. address --------------------------------------------------------------------------------
if [[ -n "${OPT_HOST:-}" ]]; then
  BIND_HOST="$OPT_HOST"
else
  say ""
  say "${C_WHITE}Which link should the panel answer on?${C_RESET}"
  printf '    %s1)%s %-14s %s%s%s\n' "$C_GREY" "$C_RESET" "0.0.0.0" "$C_GREY" "every interface — reachable from other machines (default)" "$C_RESET"
  printf '    %s2)%s %-14s %s%s%s\n' "$C_GREY" "$C_RESET" "127.0.0.1" "$C_GREY" "this machine only — for a reverse proxy or SSH tunnel" "$C_RESET"
  printf '    %s3)%s %-14s %s%s%s\n' "$C_GREY" "$C_RESET" "custom" "$C_GREY" "type one specific IP address of this host" "$C_RESET"
  # Default to whatever this install already uses, otherwise "every interface".
  default_choice="1"
  case "$DEFAULT_HOST" in
    127.0.0.1|::1|localhost) default_choice="2" ;;
    ""|0.0.0.0|"*") default_choice="1" ;;
    *) default_choice="3" ;;
  esac
  answer=""
  if [[ $INTERACTIVE -eq 1 ]]; then
    printf '  %sAddress%s %s[%s]%s ' "$C_WHITE" "$C_RESET" "$C_GREY" "$DEFAULT_HOST" "$C_RESET" >&2
    read -r answer < /dev/tty || answer=""
  fi
  case "${answer:-$default_choice}" in
    1) BIND_HOST="0.0.0.0" ;;
    2) BIND_HOST="127.0.0.1" ;;
    3)
      ask "IP to bind" "$( [[ "$DEFAULT_HOST" == "0.0.0.0" ]] && primary_ip || echo "$DEFAULT_HOST" )" BIND_HOST
      ;;
    *) BIND_HOST="${answer}" ;;
  esac
fi
ok "Bind address ${C_BOLD}${BIND_HOST}${C_RESET}"

# --- 5. port -----------------------------------------------------------------------------------
if [[ -n "${OPT_PORT:-}" ]]; then
  BIND_PORT="$OPT_PORT"
else
  ask "Port" "$DEFAULT_PORT" BIND_PORT
fi
if ! [[ "$BIND_PORT" =~ ^[0-9]+$ ]] || ((BIND_PORT < 1 || BIND_PORT > 65535)); then
  err "Port must be a number between 1 and 65535 (got '$BIND_PORT')."
  exit 2
fi
if ! port_free "$BIND_PORT" "$BIND_HOST"; then
  if [[ $EXISTING -eq 1 && -n "$EXISTING_PORT" && "$BIND_PORT" == "$EXISTING_PORT" ]]; then
    ok "Port ${BIND_PORT} is used by the panel being upgraded — it will be stopped and started again"
  elif [[ $INTERACTIVE -eq 0 ]]; then
    err "Port $BIND_PORT is already in use on this machine — pick another one with --port <n>."
    exit 2
  else
    warn "Port $BIND_PORT is already in use on this machine."
    if ! confirm "Continue anyway?" "n"; then
      err "Pick another port with --port <n>."
      exit 2
    fi
  fi
fi
ok "Port ${C_BOLD}${BIND_PORT}${C_RESET}"

# --- 6. service details ------------------------------------------------------------------------
USE_SYSTEMD=0
if [[ $OPT_USER_MODE -eq 1 ]]; then
  # A user-mode install cannot write /etc/systemd/system, so it always gets the control script.
  USE_SYSTEMD=0
elif [[ "$OPT_SYSTEMD" == "yes" ]]; then
  if have_systemd; then USE_SYSTEMD=1; else warn "systemd was requested but is not running here."; fi
elif [[ "$OPT_SYSTEMD" == "no" ]]; then
  USE_SYSTEMD=0
elif have_systemd; then
  USE_SYSTEMD=1
fi

if [[ -n "${OPT_USER:-}" ]]; then
  RUN_USER="$OPT_USER"
elif [[ $OPT_USER_MODE -eq 1 ]]; then
  RUN_USER="$(id -un)"
else
  RUN_USER="$DEFAULT_USER"
fi

PUBLIC_IP="$(primary_ip)"
case "$BIND_HOST" in
  0.0.0.0) DISPLAY_URL="http://${PUBLIC_IP}:${BIND_PORT}" ;;
  127.0.0.1|::1|localhost) DISPLAY_URL="http://127.0.0.1:${BIND_PORT}" ;;
  *) DISPLAY_URL="http://${BIND_HOST}:${BIND_PORT}" ;;
esac

# ─────────────────────────────────────────────────────────────── summary ────
section "Review"
printf '\n'
printf '  %s┌────────────────────────────────────────────────────────────┐%s\n' "$C_DIM" "$C_RESET"
printf '  %s│%s %-58s %s│%s\n' "$C_DIM" "$C_RESET" "Installation summary" "$C_DIM" "$C_RESET"
printf '  %s├────────────────────────────────────────────────────────────┤%s\n' "$C_DIM" "$C_RESET"
row() { printf '  %s│%s %s%-19s%s %-38s%s│%s\n' "$C_DIM" "$C_RESET" "$C_GREY" "$1" "$C_RESET" "$2" "$C_DIM" "$C_RESET"; }
row "Panel version"   "$VERSION ($VERSION_NOTE)"
row "Install path"    "$INSTALL_PATH"
row "Data folder"     "$DATA_DIR"
row "Address"         "${BIND_HOST}:${BIND_PORT}"
row "Panel URL"       "$DISPLAY_URL"
row "Service"         "$( [[ $USE_SYSTEMD -eq 1 ]] && echo "systemd unit" || echo "control script" )"
row "Runs as"         "$RUN_USER"
row "Mode"            "$( [[ $EXISTING -eq 1 ]] && echo "upgrade · data kept" || echo "fresh install" )"
printf '  %s└────────────────────────────────────────────────────────────┘%s\n' "$C_DIM" "$C_RESET"
printf '\n'

if [[ $OPT_DRYRUN -eq 1 ]]; then
  ok "--dry-run: plan printed, nothing was changed."
  exit 0
fi

if ! confirm "Install RSLMC now?" "y"; then
  say "Cancelled — nothing was changed."
  exit 0
fi

# ─────────────────────────────────────────────────────────── installation ────
WORK="$(mktemp -d "${TMPDIR:-/tmp}/rslmc-install.XXXXXX")"
STAGE="$WORK/stage"
mkdir -p "$STAGE"
LOG_FILE="$WORK/install.log"
: >"$LOG_FILE"
trap on_error ERR

cleanup() { rm -rf "${WORK:-}"; }
trap cleanup EXIT

# ── 1. bun ──────────────────────────────────────────────────────────────────
section "Runtime"
BUN_BIN=""
ensure_bun() {
  local existing="" need_install=1
  if have bun; then
    existing="$(bun --version 2>/dev/null || true)"
    if [[ -n "$existing" ]] && version_ge "$existing" "$MIN_BUN"; then
      BUN_BIN="$(command -v bun)"
      need_install=0
    fi
  fi
  if [[ $need_install -eq 0 ]]; then
    ok "Bun ${existing} already installed at ${BUN_BIN}"
    return 0
  fi

  local arch asset url tmp code
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="aarch64" ;;
    *) err "Unsupported CPU architecture $(uname -m) for Bun."; return 1 ;;
  esac
  asset="bun-${OS}-${arch}"
  is_musl && asset="${asset}-musl"
  asset="${asset}.zip"

  url="https://github.com/oven-sh/bun/releases/latest/download/${asset}"
  code="$(curl -sIL -o /dev/null -m 20 -w '%{http_code}' "$url" 2>/dev/null || echo 000)"
  if [[ "$code" != "200" && "$code" != "302" ]]; then
    err "Bun has no ${asset} for this platform (HTTP $code). Install Bun yourself and re-run."
    return 1
  fi
  tmp="$WORK/bun"
  mkdir -p "$tmp"
  download "$url" "$tmp/bun.zip" "Bun runtime"

  # Bun publishes SHASUMS256.txt next to each release; verify when it is reachable.
  local sums_url="${url%/*}/SHASUMS256.txt"
  if curl -fsSL --max-time 20 -o "$tmp/SHASUMS256.txt" "$sums_url" 2>/dev/null; then
    local want got
    want="$(awk -v a="$(basename "$url")" '$2==a || $2=="*"a {print $1}' "$tmp/SHASUMS256.txt" | head -n1)"
    got="$(sha256_of "$tmp/bun.zip")"
    if [[ -n "$want" && "$want" != "$got" ]]; then
      err "Bun checksum mismatch — refusing to install it."
      say "expected $want"
      say "got      $got"
      return 1
    fi
    [[ -n "$want" ]] && ok "Bun checksum verified (sha256 ${got:0:16}…)"
  else
    warn "Bun does not publish a checksum file for this asset — installing without a checksum."
  fi

  ( cd "$tmp" && { have unzip && unzip -oq bun.zip || python3 -c "import zipfile,sys; zipfile.ZipFile('bun.zip').extractall('.')" || busybox unzip -o bun.zip; } ) >/dev/null 2>&1 \
    || { err "Could not unpack the Bun archive (install unzip and retry)."; return 1; }
  local bin_path
  bin_path="$(find "$tmp" -type f -name bun -perm -u+x | head -n1)"
  [[ -z "$bin_path" ]] && bin_path="$(find "$tmp" -type f -name bun | head -n1)"
  [[ -z "$bin_path" ]] && { err "The Bun archive did not contain a bun binary."; return 1; }

  local target
  if [[ $OPT_USER_MODE -eq 1 ]]; then
    target="$HOME/.local/bin"
    mkdir -p "$target"
    install -m 0755 "$bin_path" "$target/bun"
    ln -sf "$target/bun" "$target/bunx"
    ok "Bun installed to $target/bun"
    case ":$PATH:" in *":$target:"*) ;; *) warn "$target is not on your PATH — add it to your shell profile." ;; esac
    export PATH="$target:$PATH"
  else
    target="/usr/local/bin"
    run install -d -m 0755 "$target"
    run install -m 0755 "$bin_path" "$target/bun"
    run ln -sf "$target/bun" "$target/bunx"
    ok "Bun installed to $target/bun"
  fi
  BUN_BIN="$(command -v bun || echo "${target}/bun")"
  ok "Bun $("$BUN_BIN" --version 2>/dev/null || echo '?') ready"
}
ensure_bun

# ── 2. download ─────────────────────────────────────────────────────────────
section "Downloading RSLMC ${VERSION}"
download "$DOWNLOAD_URL" "$WORK/$ARCHIVE" "release archive"

section "Verifying the download"
if curl -fsSL --max-time 30 -o "$WORK/SHA256SUMS" "$SUMS_URL" 2>/dev/null; then
  want="$(awk -v a="$ARCHIVE" '$2==a || $2=="*"a {print $1}' "$WORK/SHA256SUMS" | head -n1)"
  got="$(sha256_of "$WORK/$ARCHIVE")"
  if [[ -z "$want" ]]; then
    err "SHA256SUMS exists but has no line for $ARCHIVE — refusing to install."
    exit 1
  fi
  if [[ "$want" != "$got" ]]; then
    err "Checksum mismatch — the download is corrupt or has been tampered with."
    say "expected $want"
    say "got      $got"
    exit 1
  fi
  ok "SHA-256 matches the published checksum (${got:0:16}…)"
else
  err "Could not download SHA256SUMS for v${VERSION} — refusing to install unverified code."
  say "The release v${VERSION} may not exist. Check: https://github.com/${REPO_SLUG}/releases"
  exit 1
fi

tar -xzf "$WORK/$ARCHIVE" -C "$STAGE"
SRC_DIR="$(find "$STAGE" -maxdepth 1 -mindepth 1 -type d | head -n1)"
if [[ ! -f "$SRC_DIR/src/index.ts" ]]; then
  err "The archive did not look like RSLMC (no src/index.ts)."
  exit 1
fi
ok "Unpacked $(find "$SRC_DIR" -type f | wc -l | tr -d ' ') files"

# ── 3. service user and folders ─────────────────────────────────────────────
section "Preparing folders"
if [[ $OPT_USER_MODE -eq 0 && $CAN_ROOT -eq 1 ]]; then
  if ! id -u "$RUN_USER" >/dev/null 2>&1; then
    if have useradd; then
      run useradd --system --create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$RUN_USER" >/dev/null 2>&1 \
        || run useradd --system --home-dir "$DATA_DIR" --shell /bin/false "$RUN_USER"
      ok "Created service user ${RUN_USER}"
    else
      warn "useradd is missing; the panel will run as ${RUN_USER} if that account exists, otherwise as root — change it in the unit file."
    fi
  else
    ok "Service user ${RUN_USER} already exists"
  fi
fi

run mkdir -p "$INSTALL_PATH" "$DATA_DIR"
run mkdir -p "$DATA_DIR/logs"
if [[ $OPT_USER_MODE -eq 0 && $CAN_ROOT -eq 1 ]]; then
  run chown -R "$RUN_USER":"$RUN_USER" "$INSTALL_PATH" "$DATA_DIR" 2>/dev/null || true
  run chmod 750 "$DATA_DIR"
fi
ok "Folders ready · $INSTALL_PATH · $DATA_DIR"

# ── 4. swap the code in ─────────────────────────────────────────────────────
section "Installing the code"
STOPPED=0
stop_running() {
  if [[ $USE_SYSTEMD -eq 1 ]]; then
    if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
      run systemctl stop "$SERVICE" >/dev/null 2>&1 || true
      STOPPED=1
    fi
  elif [[ -x "$INSTALL_PATH/rslmc-ctl" ]]; then
    if "$INSTALL_PATH/rslmc-ctl" status >/dev/null 2>&1; then
      "$INSTALL_PATH/rslmc-ctl" stop >/dev/null 2>&1 || true
      STOPPED=1
    fi
  fi
}
stop_running
[[ $STOPPED -eq 1 ]] && ok "Stopped the running panel for the swap"

if [[ -d "$INSTALL_PATH" && -n "$(ls -A "$INSTALL_PATH" 2>/dev/null)" ]]; then
  run rm -rf "${INSTALL_PATH}.previous"
  run mv "$INSTALL_PATH" "${INSTALL_PATH}.previous"
  ok "Previous code kept at ${INSTALL_PATH}.previous (rollback if anything fails)"
fi
run mkdir -p "$INSTALL_PATH"
if [[ -n "$SUDO" ]]; then
  # The target belongs to the service account, so the copy has to run with the same privileges the
  # folder was created with — otherwise a root-owned directory rejects an unprivileged extraction.
  run tar -xzf "$WORK/$ARCHIVE" -C "$INSTALL_PATH" --strip-components=1
else
  ( cd "$SRC_DIR" && tar -cf - . ) | ( cd "$INSTALL_PATH" && tar -xf - )
fi
if [[ $OPT_USER_MODE -eq 0 && $CAN_ROOT -eq 1 ]]; then run chown -R "$RUN_USER":"$RUN_USER" "$INSTALL_PATH" 2>/dev/null || true; fi
ok "Code in place"

rollback() {
  err "Install failed after the swap — restoring the previous code."
  run rm -rf "$INSTALL_PATH"
  if [[ -d "${INSTALL_PATH}.previous" ]]; then run mv "${INSTALL_PATH}.previous" "$INSTALL_PATH"; fi
  exit 1
}

# ── 5. dependencies + frontend build ────────────────────────────────────────
# Both steps run as the account the panel will run as: if root did this, public/dist and the bun
# cache would end up root-owned and the service would fail on its very first write.
as_service_user() {
  if [[ $OPT_USER_MODE -eq 0 && $CAN_ROOT -eq 1 ]] && id -u "$RUN_USER" >/dev/null 2>&1; then
    sudo -u "$RUN_USER" -- env HOME="$DATA_DIR" BUN_INSTALL_CACHE_DIR="$WORK/bun-cache" \
      bash -c 'cd "$1" && shift && exec "$@"' _ "$INSTALL_PATH" "$@"
  else
    ( cd "$INSTALL_PATH" && BUN_INSTALL_CACHE_DIR="$WORK/bun-cache" "$@" )
  fi
}

section "Installing dependencies"
if ! as_service_user "$BUN_BIN" install --production --frozen-lockfile >>"$LOG_FILE" 2>&1; then
  as_service_user "$BUN_BIN" install --production >>"$LOG_FILE" 2>&1 || rollback
fi
ok "Dependencies installed ($(du -sh "$INSTALL_PATH/node_modules" 2>/dev/null | cut -f1 || echo 'ok'))"

section "Building the frontend"
if ! as_service_user "$BUN_BIN" run build >>"$LOG_FILE" 2>&1; then
  warn "The build step failed; the panel rebuilds the bundle when it starts, so this is not fatal."
  tail -n 8 "$LOG_FILE" | sed 's/^/    /'
else
  ok "Frontend bundle written to public/dist"
fi

# Belt and braces: whatever is in the folder must belong to the account that runs the panel.
if [[ $OPT_USER_MODE -eq 0 && $CAN_ROOT -eq 1 ]]; then
  run chown -R "$RUN_USER":"$RUN_USER" "$INSTALL_PATH" 2>/dev/null || true
fi

# ── 6. configuration ───────────────────────────────────────────────────────
section "Writing configuration"
SECRET=""
if [[ -r "$ENV_FILE" ]]; then
  SECRET="$(sed -n 's/^RSLMC_SECRET=//p' "$ENV_FILE" 2>/dev/null | head -n1)"
fi
if [[ -z "$SECRET" || ${#SECRET} -lt 32 ]]; then
  if have openssl; then SECRET="$(openssl rand -hex 32)"
  else SECRET="$("$BUN_BIN" -e 'console.log(crypto.randomUUID().replace(/-/g,"")+crypto.randomUUID().replace(/-/g,""))')"
  fi
  ok "Generated a new session secret (64 hex characters)"
else
  ok "Kept the existing session secret"
fi

ENV_DIR="$(dirname "$ENV_FILE")"
if [[ $OPT_USER_MODE -eq 1 ]]; then ENV_FILE="$DATA_DIR/panel.env"; ENV_DIR="$DATA_DIR"; fi
run mkdir -p "$ENV_DIR"
ENV_TMP="$WORK/rslmc.env"
cat >"$ENV_TMP" <<ENVFILE
# RSLMC panel — written by install.sh on $(date -u '+%Y-%m-%d %H:%M UTC')
# RSLMC_INSTALL_PATH=${INSTALL_PATH}
RSLMC_MODE=production
RSLMC_HOST=${BIND_HOST}
RSLMC_PORT=${BIND_PORT}
RSLMC_DATA_DIR=${DATA_DIR}
RSLMC_SECRET=${SECRET}
RSLMC_TRUST_PROXY=false
ENVFILE
run install -m 0600 "$ENV_TMP" "$ENV_FILE"
if [[ $OPT_USER_MODE -eq 0 && $CAN_ROOT -eq 1 ]]; then run chown "root:${RUN_USER}" "$ENV_FILE" 2>/dev/null || true; fi
ok "Environment file ${ENV_FILE} (mode 600)"

cat >"$WORK/rslmc-state" <<STATEFILE
# Written by install.sh — read by the next run so it can upgrade in place.
STATE_VERSION=${VERSION}
STATE_DATA_DIR=${DATA_DIR}
STATE_ENV_FILE=${ENV_FILE}
STATE_INSTALLED_AT=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
STATEFILE
run install -m 0644 "$WORK/rslmc-state" "$STATE_FILE"
ok "Install state recorded in ${STATE_FILE}"

# ── 7. service ─────────────────────────────────────────────────────────────
section "Installing the service"
CTL_FILE="$INSTALL_PATH/rslmc-ctl"
if [[ $USE_SYSTEMD -eq 1 ]]; then
  UNIT="$(mktemp)"
  PROTECT_HOME="yes"
  case "$DATA_DIR" in "$HOME"*) PROTECT_HOME="no" ;; esac
  cat >"$UNIT" <<UNITFILE
[Unit]
Description=RSLMC — Minecraft server panel
Documentation=https://github.com/${REPO_SLUG}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_USER}
WorkingDirectory=${INSTALL_PATH}
EnvironmentFile=${ENV_FILE}
ExecStart=${BUN_BIN} src/index.ts
Restart=always
RestartSec=3
TimeoutStopSec=25
KillMode=mixed
LimitNOFILE=65535

# Hardening. The panel needs to write its own folder (the frontend bundle) and the data folder
# (database, servers, worlds, backups, Java runtimes) and nothing else.
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=${PROTECT_HOME}
PrivateTmp=no
ReadWritePaths=${INSTALL_PATH} ${DATA_DIR}

[Install]
WantedBy=multi-user.target
UNITFILE
  run install -m 0644 "$UNIT" "/etc/systemd/system/${SERVICE}.service"
  rm -f "$UNIT"
  ok "Unit written to /etc/systemd/system/${SERVICE}.service"

  cat >"$WORK/rslmc-cli" <<CLIFILE
#!/usr/bin/env bash
# rslmc — control the RSLMC panel (installed by install.sh)
case "\${1:-status}" in
  start)   sudo systemctl start ${SERVICE} ;;
  stop)    sudo systemctl stop ${SERVICE} ;;
  restart) sudo systemctl restart ${SERVICE} ;;
  status)  systemctl status ${SERVICE} --no-pager ;;
  logs)    sudo journalctl -u ${SERVICE} -f -n 200 ;;
  url)     grep -E '^RSLMC_(HOST|PORT)=' ${ENV_FILE} ;;
  edit)    sudo "\${EDITOR:-nano}" ${ENV_FILE} && echo "restart to apply: rslmc restart" ;;
  *)       echo "usage: rslmc {start|stop|restart|status|logs|url|edit}"; exit 2 ;;
esac
CLIFILE
  run install -m 0755 "$WORK/rslmc-cli" /usr/local/bin/rslmc
  ok "Command installed: rslmc {start|stop|restart|status|logs|url}"
else
  cat >"$CTL_FILE" <<CTLFILE
#!/usr/bin/env bash
# rslmc-ctl — start/stop the panel without systemd (containers, WSL, user installs).
set -uo pipefail
DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
DATA="${DATA_DIR}"
PIDFILE="\$DATA/rslmc.pid"
LOGFILE="\$DATA/logs/panel.log"
ENVFILE="${ENV_FILE}"
BUN="${BUN_BIN}"
running() { [[ -f "\$PIDFILE" ]] && kill -0 "\$(cat "\$PIDFILE")" 2>/dev/null; }
start() {
  if running; then echo "already running (pid \$(cat "\$PIDFILE"))"; return 0; fi
  mkdir -p "\$DATA/logs"
  set -a; . "\$ENVFILE"; set +a
  # No subshell here: \$! must be the panel's own pid, or stop would kill a shell that already exited.
  cd "\$DIR" || return 1
  nohup "\$BUN" src/index.ts >>"\$LOGFILE" 2>&1 &
  local child=\$!
  echo "\$child" >"\$PIDFILE"
  local i
  for i in \$(seq 1 40); do
    if ! kill -0 "\$child" 2>/dev/null; then
      echo "the panel exited immediately — last lines of \$LOGFILE:"
      tail -n 15 "\$LOGFILE"
      rm -f "\$PIDFILE"
      return 1
    fi
    sleep 0.25
  done
  echo "started (pid \$child) — logs: \$LOGFILE"
}
stop() {
  if ! running; then echo "not running"; rm -f "\$PIDFILE"; return 0; fi
  local pid; pid="\$(cat "\$PIDFILE")"
  kill "\$pid" 2>/dev/null
  local i
  for i in \$(seq 1 40); do kill -0 "\$pid" 2>/dev/null || break; sleep 0.25; done
  if kill -0 "\$pid" 2>/dev/null; then
    kill -9 "\$pid" 2>/dev/null
    sleep 0.5
  fi
  if kill -0 "\$pid" 2>/dev/null; then
    echo "could not stop pid \$pid — it is still running"
    return 1
  fi
  rm -f "\$PIDFILE"
  echo "stopped"
}
status() {
  if running; then echo "running (pid \$(cat "\$PIDFILE"))"; else echo "stopped"; return 3; fi
}
case "\${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  logs) tail -f "\$LOGFILE" ;;
  *) echo "usage: \$0 {start|stop|restart|status|logs}"; exit 2 ;;
esac
CTLFILE
  chmod 0755 "$CTL_FILE"
  [[ $OPT_USER_MODE -eq 0 && $CAN_ROOT -eq 1 ]] && run chown "$RUN_USER":"$RUN_USER" "$CTL_FILE" 2>/dev/null || true
  ok "Control script written: ${CTL_FILE} {start|stop|restart|status|logs}"
  if [[ $OPT_USER_MODE -eq 0 && $CAN_ROOT -eq 1 ]]; then
    printf '#!/usr/bin/env bash\nexec %s "$@"\n' "$CTL_FILE" >"$WORK/rslmc-cli"
    run install -m 0755 "$WORK/rslmc-cli" /usr/local/bin/rslmc
    ok "Command installed: rslmc {start|stop|restart|status|logs}"
  fi
fi

# ── 8. start and wait ──────────────────────────────────────────────────────
section "Starting the panel"
if [[ $USE_SYSTEMD -eq 1 ]]; then
  run systemctl daemon-reload
  run systemctl enable "$SERVICE" >/dev/null 2>&1 || true
  if ! run systemctl start "$SERVICE"; then
    err "systemd could not start ${SERVICE}."
    run journalctl -u "$SERVICE" -n 25 --no-pager | sed 's/^/    /' || true
    rollback
  fi
  ok "systemctl start ${SERVICE}"
else
  if ! "$CTL_FILE" start >/dev/null 2>&1; then
    err "The panel did not start."
    tail -n 25 "$DATA_DIR/logs/panel.log" 2>/dev/null | sed 's/^/    /' || true
    rollback
  fi
  ok "Started through ${CTL_FILE}"
fi

HEALTH_URL="http://127.0.0.1:${BIND_PORT}/api/setup/status"
attempt=0
healthy=0
started_at=$(date +%s)
while [[ $attempt -lt 60 ]]; do
  attempt=$((attempt + 1))
  code="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || echo 000)"
  if [[ "$code" == "200" ]]; then healthy=1; break; fi
  if [[ $attempt -eq 3 ]]; then
    printf '  %s%s waiting for the panel %s' "$C_GREY" "$( [[ -t 1 ]] && echo '⠋' )" "$C_RESET"
  fi
  [[ $attempt -ge 3 && -t 1 ]] && printf '.'
  sleep 0.5
done
[[ $attempt -ge 3 && -t 1 ]] && printf '\n'
elapsed_ms=$(( ($(date +%s) - started_at) * 1000 ))
if [[ $healthy -eq 1 ]]; then
  ok "Panel answered on ${HEALTH_URL} in ${elapsed_ms} ms"
else
  err "The panel is running but did not answer on ${HEALTH_URL} within 30s."
  if [[ $USE_SYSTEMD -eq 1 ]]; then run journalctl -u "$SERVICE" -n 30 --no-pager | sed 's/^/    /' || true
  else tail -n 30 "$DATA_DIR/logs/panel.log" 2>/dev/null | sed 's/^/    /' || true; fi
  if [[ $USE_SYSTEMD -eq 1 ]]; then
    run systemctl stop "$SERVICE" >/dev/null 2>&1 || true
    warn "Stopped ${SERVICE}.service so it does not restart in a loop while you look into it."
  fi
  warn "The code is in place, so you can inspect it. Roll back with: mv ${INSTALL_PATH}.previous ${INSTALL_PATH}"
  exit 1
fi

SERVED_VERSION="$(curl -sI -m 5 "http://127.0.0.1:${BIND_PORT}/" 2>/dev/null | tr -d '\r' | awk 'tolower($1)=="x-rslmc-version:" {print $2}' | head -n1)"
[[ -z "$SERVED_VERSION" ]] && SERVED_VERSION="$VERSION"
SETUP_STATE="$(curl -s -m 5 "$HEALTH_URL" 2>/dev/null \
  | tr -d '\n' | sed -n 's/.*"mode":"\([^"]*\)".*/\1/p')"
SETUP_STATE="GET /api/setup/status → 200 · mode ${SETUP_STATE:-production}"

# ── 9. finish ──────────────────────────────────────────────────────────────
section "Done"
run rm -rf "${INSTALL_PATH}.previous" 2>/dev/null || true

printf '\n'
printf '  %s╭──────────────────────────────────────────────────────────────╮%s\n' "$C_GREEN" "$C_RESET"
printf '  %s│%s  %sRSLMC is installed and running%s                              %s│%s\n' "$C_GREEN" "$C_RESET" "$C_BOLD" "$C_RESET" "$C_GREEN" "$C_RESET"
printf '  %s╰──────────────────────────────────────────────────────────────╯%s\n' "$C_GREEN" "$C_RESET"
printf '\n'
kv "Open"        "$DISPLAY_URL"
kv "Local check" "http://127.0.0.1:${BIND_PORT}"
kv "Sign in"     "admin / admin123   ${C_AMBER}← change it on first login${C_RESET}"
if [[ "$SERVED_VERSION" == "$VERSION" ]]; then
  kv "Version"   "$SERVED_VERSION"
else
  kv "Version"   "$SERVED_VERSION ${C_AMBER}(requested ${VERSION})${C_RESET}"
fi
kv "Code"        "$INSTALL_PATH"
kv "Data"        "$DATA_DIR"
kv "Env file"    "$ENV_FILE"
if [[ $USE_SYSTEMD -eq 1 ]]; then
  kv "Control"   "rslmc status · rslmc logs · rslmc restart"
  kv "Service"   "systemctl status ${SERVICE} · journalctl -u ${SERVICE} -f"
else
  kv "Control"   "${CTL_FILE} status|logs|restart"
  kv "Service"   "no systemd here — this control script does not survive a reboot on its own"
fi
kv "Health"      "${SETUP_STATE}"
printf '\n'

# Firewall hint — printed, never changed without being asked.
if have ufw && ufw status 2>/dev/null | grep -qi "Status: active"; then
  dim "ufw is active. To reach the panel from another machine:"
  say "    sudo ufw allow ${BIND_PORT}/tcp"
elif have firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
  dim "firewalld is active. To reach the panel from another machine:"
  say "    sudo firewall-cmd --add-port=${BIND_PORT}/tcp --permanent && sudo firewall-cmd --reload"
fi
if [[ "$BIND_HOST" != "0.0.0.0" ]]; then
  dim "The panel is bound to ${BIND_HOST}, so it is only reachable from this machine."
  dim "For remote access, put a reverse proxy (Caddy/nginx) in front, or re-run with --host 0.0.0.0."
fi
dim "Back up the data folder: everything you create in the panel lives in ${DATA_DIR}."
dim "Upgrade later: re-run this installer, or use Administration → About → Install update."
printf '\n'
