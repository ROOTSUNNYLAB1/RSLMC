import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { userInfo } from "node:os";

/*
 * Docker, the way the panel uses it.
 *
 * A server can run two ways: as a JVM started by the panel (standalone), or inside a Docker
 * container. The container is not a wrapper around the same process — it is a separate cgroup, which
 * is the whole reason to offer it: memory and CPU are enforced by the kernel whether or not the host
 * has the RSLMC cgroup helper installed, and the server's files stay where they were, bind-mounted
 * into the container, so the file manager, backups, properties editor and world tools keep working
 * untouched.
 *
 * Everything here shells out to the real `docker` CLI and reports what it actually said. There is no
 * "pretend Docker" path: when the CLI or the daemon is missing, the panel says so and the wizard will
 * not offer the option.
 */

/** A command the panel actually ran, kept so the operator can run the very same thing. */
export interface DockerEvidence {
  /** Full command line, host overrides included — copy-pasteable in a shell. */
  command: string;
  /** The binary that was executed, as resolved (an absolute path when one was found). */
  binary: string;
  exitCode: number;
  /** What the CLI printed, verbatim and unparaphrased. Truncated, never rewritten. */
  stderr: string;
  checkedAt: number;
}

/** Everything the panel knows about *why* Docker is or is not usable here. */
export interface DockerAccess {
  /** The unix user the panel process runs as — the account whose socket access is being tested. */
  user: string;
  uid: number | null;
  /** True when the panel is already root (or Administrator): group advice is then nonsense. */
  elevated: boolean;
  /** `process.platform`, so the UI can say "Administrator" rather than "uid 0" on Windows. */
  platformLabel: string;
  /** Groups of that user, by name. */
  groups: string[];
  /** The socket (or TCP endpoint) the CLI tried, and where that choice came from. */
  endpoint: string;
  endpointSource: EndpointSource;
  socketExists: boolean;
  socketMode: string | null;
  socketGroup: string | null;
  /** True when the socket exists, the panel is not root, and the account is not in its group. */
  groupMissing: boolean;
  /** Alternative sockets that exist on this machine (rootless Docker, Podman). */
  alternatives: string[];
  /**
   * True when the panel itself looks like it is running inside a container. That flips the advice
   * completely: an inner container has no host socket unless one was mounted in, and no amount of
   * `systemctl start docker` will change that.
   */
  inContainer: boolean;
  /** What the CLI would inherit — the usual place a shell and a service disagree. */
  environment: {
    platform: string;
    path: string;
    home: string | null;
    /** `DOCKER_HOST` / `DOCKER_CONTEXT` as the *panel process* sees them. */
    dockerHost: string | null;
    dockerContext: string | null;
    /** `RSLMC_DOCKER_BIN`, when set: it outranks the panel's saved binary, so it must be visible. */
    binEnv: string | null;
    /** `currentContext` from `~/.docker/config.json`, when the CLI would pick a context up. */
    cliContext: string | null;
  };
  /** Every path the panel considers for the CLI, with whether it is there. */
  binaries: { path: string; exists: boolean }[];
  /** The failing command and its raw output, when a command is what failed. */
  evidence: DockerEvidence | null;
  /** Copy-pasteable fixes, most appropriate first. */
  hints: string[];
}

/** Which layer decided the endpoint. Shown in the UI so an override is never invisible. */
export type EndpointSource = "RSLMC_DOCKER_HOST" | "DOCKER_HOST" | "panel setting" | "default";

export interface DockerInfo {
  /** True only when the CLI answered `docker info` — i.e. a daemon is reachable. */
  available: boolean;
  version: string | null;
  apiVersion: string | null;
  /** `overlay2`, `vfs`, … — decides whether a per-container disk quota can be enforced. */
  storageDriver: string | null;
  cgroupVersion: string | null;
  /** Docker's own default runtime, so the UI can say what will execute the container. */
  runtimes: string[];
  /**
   * The CPUs the daemon can hand out (`docker info` → NCPU).
   *
   * Not cosmetic: `docker run --cpus` is refused outright when it asks for more than this, with exit
   * code 125 and no server at all. The launch clamps against this number rather than guessing.
   */
  cpuCount: number | null;
  /** Whether `--storage-opt size=` can actually be honoured on this driver. */
  diskQuota: boolean;
  /** Human explanation when something is missing, e.g. the CLI is not installed. */
  reason: string | null;
  cliPath: string | null;
  checkedAt: number;
  /** Filled whenever the probe ran; the reason is written from these facts, not guessed. */
  access?: DockerAccess | null;
}

interface CommandResult {
  /** The exact argv that was executed, for the evidence block. */
  command: string;
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
  /** True when the binary itself could not be executed. */
  missing: boolean;
}

/**
 * A panel-wide override that does not need an editor or a restart.
 *
 * `.env` is the right place for a decision the operator makes once, but it is the wrong place for
 * debugging: restarting the panel to try one socket is how a five-second fix turns into an evening.
 * The wizard can therefore test an endpoint and save it (admin only, `system.manage`), and the saved
 * value is consulted as if it had been exported.
 */
export interface DockerConfig {
  /** `unix:///var/run/docker.sock`, `tcp://host:2376`, or a named context. Empty = default. */
  host: string | null;
  /** Absolute path to the CLI, for machines where PATH and the panel disagree. */
  bin: string | null;
}

let configOverride: DockerConfig = { host: null, bin: null };

/** Sets (or clears, with `null`) the panel-stored override. Invalidates the probe cache. */
export function setDockerConfigOverride(config: DockerConfig | null): void {
  configOverride = { host: config?.host?.trim() || null, bin: config?.bin?.trim() || null };
  cachedCli = configOverride.bin;
  cachedInfo = null;
  cacheAt = 0;
}

export function dockerConfigOverride(): DockerConfig {
  return { ...configOverride };
}

/**
 * Extra arguments that decide *which* daemon is talked to.
 *
 * `RSLMC_DOCKER_HOST` (and the conventional `DOCKER_HOST`) are honoured because the default socket is
 * not the only real one: rootless Docker listens on `$XDG_RUNTIME_DIR/docker.sock`, Podman on
 * `/run/podman/podman.sock`, and a hardened host may only expose a TCP endpoint. Without this the panel
 * insists on `/var/run/docker.sock` while the operator's own `docker` command talks to something else —
 * which is exactly "docker works in my shell but not in the panel".
 *
 * Precedence is deliberate: the panel-specific variable beats the panel's own saved setting, which
 * beats the generic `DOCKER_HOST` that a systemd unit may have inherited years ago, which beats the
 * default. Every layer is reported by `dockerEndpointSource()`, so an override can never be invisible.
 */
function resolveHost(): { host: string | null; source: EndpointSource } {
  const specific = process.env.RSLMC_DOCKER_HOST?.trim();
  if (specific) return { host: specific, source: "RSLMC_DOCKER_HOST" };
  if (configOverride.host) return { host: configOverride.host, source: "panel setting" };
  const generic = process.env.DOCKER_HOST?.trim();
  if (generic) return { host: generic, source: "DOCKER_HOST" };
  return { host: null, source: "default" };
}

export function dockerHostArgs(): string[] {
  const { host } = resolveHost();
  return host ? ["-H", host] : [];
}

/** The endpoint the CLI will use, for the diagnosis. */
export function dockerEndpoint(): string {
  const { host } = resolveHost();
  if (host) return host;
  if (process.platform === "win32") return "npipe:////./pipe/docker_engine";
  return "unix:///var/run/docker.sock";
}

/** Which layer chose the endpoint currently in force. */
export function dockerEndpointSource(): EndpointSource {
  return resolveHost().source;
}

/**
 * `sudo -n docker …`, when the operator asked for it.
 *
 * This is the escape hatch for the VPS layout where the panel runs as an unprivileged account, the
 * socket is `root:docker 0660`, and adding the account to the group needs a service restart. With a
 * `NOPASSWD` sudoers entry and `RSLMC_DOCKER_SUDO=1` the panel can use the daemon without being root
 * itself. `-n` is deliberate: a password prompt would hang a daemon probe forever.
 */
function sudoPrefix(): string[] {
  const wanted = (process.env.RSLMC_DOCKER_SUDO ?? "").trim() === "1";
  if (!wanted) return [];
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  return uid === 0 ? [] : ["sudo", "-n"];
}

/**
 * The complete argv the panel would run for a docker subcommand.
 *
 * Exported because the *launch* path builds its own array (`docker run …`) and used to start it with
 * `dockerBin()` alone — so a panel configured with `RSLMC_DOCKER_SUDO=1` or `RSLMC_DOCKER_HOST` passed
 * the probe (which did use the prefix) and then failed at start with `permission denied`, exit 126. The
 * probe and the launch must never be able to disagree again, so both take their prefix from here.
 */
export function dockerInvocation(args: string[]): string[] {
  return [...sudoPrefix(), dockerBin(), ...dockerHostArgs(), ...args];
}

/** True when the panel process is already privileged — root, or Administrator on Windows. */
export function panelIsElevated(): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === 0) return true;
  return process.platform === "win32" && Boolean(process.env.USERPROFILE) && (process.env.USERNAME ?? "").toLowerCase() === "administrator";
}

/**
 * Where the CLI might be.
 *
 * Read on every probe rather than at import time, so an operator (or a test) can point
 * `RSLMC_DOCKER_BIN` at a specific binary without restarting the panel. The list matters because the
 * *panel's* PATH is not the operator's PATH: a snap install lives in `/snap/bin`, a per-user install in
 * `~/.docker/bin`, and a service started by systemd often has none of those.
 */
function dockerCandidates(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return [
    process.env.RSLMC_DOCKER_BIN,
    configOverride.bin,
    "/usr/bin/docker",
    "/usr/local/bin/docker",
    "/snap/bin/docker",
    "/opt/homebrew/bin/docker",
    home ? `${home}/.docker/bin/docker` : null,
    "/usr/bin/podman",
    "docker",
    "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
  ].filter((value): value is string => Boolean(value));
}

let cachedCli: string | null = null;
let cachedInfo: DockerInfo | null = null;
let cacheAt = 0;
const INFO_TTL_MS = 15_000;

/** Renders an argv the way a shell would accept it, quoting only what needs quoting. */
function displayCommand(argv: string[]): string {
  return argv.map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`)).join(" ");
}

/**
 * Runs a Docker command with a timeout and no shell.
 *
 * `stdin: "ignore"` matters: `docker` reading a terminal it does not have is how a panel hangs on a
 * dead daemon instead of reporting it. The inherited environment is passed through whole — a curated
 * subset is how a working `DOCKER_HOST`, `DOCKER_CONTEXT` or `DOCKER_CONFIG` from the operator's shell
 * silently disappears in the panel.
 */
export function dockerCommand(args: string[], timeoutMs = 20_000): CommandResult {
  // An explicit override wins over probing: an operator who points RSLMC_DOCKER_BIN at a binary
  // means it, and a failure must be reported for that binary rather than silently using PATH.
  const bin = process.env.RSLMC_DOCKER_BIN ?? cachedCli ?? dockerCandidates().find((candidate) => {
    if (candidate.includes("/") || candidate.includes("\\")) return existsSync(candidate);
    return true;                                    // bare name: let PATH decide
  }) ?? "docker";
  const argv = [...sudoPrefix(), bin, ...dockerHostArgs(), ...args];
  try {
    const result = Bun.spawnSync(argv, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, DOCKER_CLI_HINTS: "false" },
      timeout: timeoutMs,
    });
    return {
      command: displayCommand(argv),
      ok: result.exitCode === 0,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      code: result.exitCode ?? -1,
      missing: false,
    };
  } catch (error) {
    return {
      command: displayCommand(argv),
      ok: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      code: -1,
      missing: true,
    };
  }
}

/**
 * The same command, awaited instead of blocking.
 *
 * `docker stats` samples twice and takes ~2 s on a real daemon. Running that with spawnSync freezes the
 * whole panel for those two seconds — the page stops rendering, the ping looks slow, websockets stall.
 * Anything that can take measurable time goes through this one.
 */
export async function dockerCommandAsync(args: string[], timeoutMs = 20_000): Promise<CommandResult> {
  const bin = process.env.RSLMC_DOCKER_BIN ?? dockerBin();
  const argv = [...sudoPrefix(), bin, ...dockerHostArgs(), ...args];
  try {
    const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env } });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout as ReadableStream<Uint8Array>).text(),
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    const code = await child.exited;
    clearTimeout(timer);
    return { command: displayCommand(argv), ok: code === 0, stdout, stderr, code, missing: false };
  } catch (error) {
    return { command: displayCommand(argv), ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error), code: -1, missing: true };
  }
}

/**
 * The executable to use when spawning a *long-lived* container.
 *
 * Resolved once, from the same candidates as `dockerCommand`, so the launch plan and the probes can
 * never disagree about which binary exists.
 */
export function dockerBin(): string {
  if (process.env.RSLMC_DOCKER_BIN) cachedCli = process.env.RSLMC_DOCKER_BIN;
  if (cachedCli) return cachedCli;
  for (const candidate of dockerCandidates()) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (existsSync(candidate)) { cachedCli = candidate; return candidate; }
      continue;
    }
    const probe = dockerCommandFor(candidate, ["--version"], 8000);
    if (probe.ok) { cachedCli = candidate; return candidate; }
  }
  cachedCli = "docker";
  return cachedCli;
}

function dockerCommandFor(bin: string, args: string[], timeoutMs: number): CommandResult {
  const argv = [...bin, ...args];
  try {
    const result = Bun.spawnSync(argv, {
      stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: timeoutMs,
    });
    return { command: displayCommand(argv), ok: result.exitCode === 0, stdout: result.stdout.toString(), stderr: result.stderr.toString(), code: result.exitCode ?? -1, missing: false };
  } catch (error) {
    return { command: displayCommand(argv), ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error), code: -1, missing: true };
  }
}

/** Storage drivers that can enforce a per-container size. Anything else is reported as unable to. */
const QUOTA_DRIVERS = new Set(["btrfs", "zfs", "devicemapper"]);

/** Probes the daemon. Cached for 15 s so a page load does not fork a dozen processes. */
export function probeDocker(force = false): DockerInfo {
  const now = Date.now();
  if (!force && cachedInfo && now - cacheAt < INFO_TTL_MS) return cachedInfo;

  const version = dockerCommand(["version", "--format", "{{.Server.Version}}"], 12_000);
  const cliVersion = dockerCommand(["version", "--format", "{{.Client.Version}}"], 12_000);

  if (version.missing && cliVersion.missing) {
    /*
     * No CLI at all. This is *not* always "Docker is not installed": the panel's PATH is whatever the
     * service manager gave it, and a snap or per-user install is invisible from there. The reason
     * therefore lists the paths that were tried, which is the only useful thing to say.
     */
    const access = diagnoseMissingCli();
    cachedInfo = {
      ...emptyInfo(
        "The Docker CLI could not be executed from the panel, so container servers cannot be created yet. "
        + (access.hints[0] ?? ""),
      ),
      access,
    };
    cacheAt = now;
    return cachedInfo;
  }

  const info = dockerCommand(["info", "--format", "{{json .}}"], 15_000);
  if (!info.ok) {
    const stderr = `${info.stderr}${info.stdout}`.trim();
    const access = diagnoseAccess(stderr, evidenceFor(info, stderr));
    cachedInfo = {
      ...emptyInfo(
        `Docker is installed but its daemon could not be reached from the panel: ${firstLine(stderr) || "docker info failed"}.`
        + (access.hints.length > 0 ? ` ${access.hints[0]}` : ""),
        cliVersion.ok ? cliVersion.stdout.trim() : null,
      ),
      access,
    };
    cacheAt = now;
    return cachedInfo;
  }

  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(info.stdout) as Record<string, unknown>; } catch { /* older daemons print a table */ }

  /*
   * A daemon that refuses the connection still makes `docker info` exit 0: it prints a full JSON
   * document with empty fields and the real error inside `ServerErrors`. Trusting the exit code is how
   * a panel ends up offering "Docker" while every container command fails with "permission denied".
   */
  const serverErrors = Array.isArray(parsed.ServerErrors) ? parsed.ServerErrors.map(String).filter(Boolean) : [];
  const serverVersion = String(parsed.ServerVersion ?? "").trim();
  if (serverErrors.length > 0 || !serverVersion) {
    const detail = serverErrors[0] ?? "the daemon returned no server version";
    const access = diagnoseAccess(detail, evidenceFor(info, detail));
    cachedInfo = {
      ...emptyInfo(
        `Docker is installed but the daemon refused the request: ${detail}.`
        + (access.hints.length > 0 ? ` ${access.hints[0]}` : ""),
        cliVersion.ok ? cliVersion.stdout.trim() : null,
      ),
      access,
    };
    cacheAt = now;
    return cachedInfo;
  }

  const storageDriver = String(parsed.Driver ?? "").trim() || null;
  const cgroupVersion = parsed.CgroupVersion ? String(parsed.CgroupVersion) : null;
  const runtimesRaw = parsed.Runtimes as Record<string, unknown> | undefined;
  const runtimes = runtimesRaw ? Object.keys(runtimesRaw) : [];
  const cpuCount = Number(parsed.NCPU) > 0 ? Number(parsed.NCPU) : null;

  /*
   * Disk quota support is not "the driver supports storage-opt" in the abstract: overlay2 only
   * enforces it on a filesystem that carries project quotas (xfs with prjquota). The panel probes by
   * asking the daemon to create a throwaway container with a size option and reading the answer —
   * guessing from the driver name alone reported quotas as available on machines that reject them.
   */
  const diskQuota = probeDiskQuota(storageDriver);

  cachedInfo = {
    available: true,
    version: version.ok ? version.stdout.trim() : null,
    apiVersion: parsed.APIVersion ? String(parsed.APIVersion) : null,
    storageDriver,
    cgroupVersion,
    runtimes,
    cpuCount,
    diskQuota,
    reason: null,
    cliPath: dockerBin(),
    checkedAt: now,
    access: collectAccessFacts(),
  };
  cacheAt = now;
  return cachedInfo;
}

function evidenceFor(result: CommandResult, detail: string): DockerEvidence {
  return {
    command: result.command,
    binary: result.command.split(" ")[0] ?? "docker",
    exitCode: result.code,
    stderr: detail.trim().slice(0, 600),
    checkedAt: Date.now(),
  };
}

/**
 * Works out *why* the daemon is unreachable, from facts on this machine rather than from the message.
 *
 * Two reports shaped this:
 *
 *   1. The panel ran as an unprivileged user while the operator's shell was root, and the panel said
 *      "start the daemon" — wrong advice, wrong direction.
 *   2. The panel ran **as root** and still failed. Group advice is then meaningless: root opens any
 *      0660 socket. What is left is a different endpoint (rootless/Podman, a context, a stale
 *      `DOCKER_HOST`), a socket that was never mounted into the panel's container, or SELinux.
 *
 * So the diagnosis is written from the panel's own elevation, its namespace, and the environment the
 * CLI actually inherits — never from a single hard-coded story.
 */
export function diagnoseAccess(detail: string, evidence: DockerEvidence | null = null): DockerAccess {
  const facts = collectAccessFacts();
  facts.evidence = evidence;
  return { ...facts, hints: hintsForFacts(facts, detail) };
}

/**
 * The hints, as a pure function of the facts.
 *
 * Split out from `diagnoseAccess` so the branches are testable: a test cannot make the machine run as
 * root, but it can hand this function the facts of a root-run panel and assert that the advice changes.
 * That matters, because the wrong branch here is exactly what shipped once already.
 */
export function hintsForFacts(facts: DockerAccess, detail: string): string[] {
  const permission = /permission denied|access denied|not authorized/i.test(detail);
  const missingSocket = /no such file or directory|cannot connect|connection refused|is the docker daemon running/i.test(detail);
  const hints: string[] = [];
  const elevated = facts.elevated;
  const who = elevated ? `the panel runs as ${facts.user} (${elevatedLabel(facts)})` : `the panel runs as "${facts.user}" (uid ${facts.uid})`;

  if (permission) {
    if (elevated) {
      hints.push(
        `This is not a group problem: ${who}, which can open any socket on the machine, and ${facts.endpoint} still refused the request. `
        + "That points at a daemon that belongs to a different account (rootless Docker, Podman) or at a security module blocking it.",
      );
      if (facts.alternatives.length > 0) {
        hints.push(`A socket exists at ${facts.alternatives[0]} — enter it under "Docker endpoint" below and press Test & save (or export RSLMC_DOCKER_HOST=${facts.alternatives[0]}) and the card unlocks.`);
      } else {
        hints.push(
          "Run `docker context ls` and `echo $DOCKER_HOST` in the same shell where `docker pull` works, then enter that endpoint below. "
          + "If they print nothing, the shell is using the same default socket — check SELinux with `ausearch -m avc -ts recent`.",
        );
      }
      hints.push("Named contexts are honoured too: put the context name (for example `default`) in the same field if that is what your shell uses.");
    } else if (facts.groupMissing) {
      hints.push(
        `${who} is not in the ${facts.socketGroup ? `"${facts.socketGroup}"` : "socket's"} group and ${facts.endpoint} is ${facts.socketMode ?? "not readable"}. `
        + `Add the account — sudo usermod -aG docker ${facts.user} — then restart the panel: a running process keeps its old groups, `
        + "which is why it still fails after the usual fix.",
      );
      hints.push("Or let the panel use sudo for docker: \"rslmc ALL=(root) NOPASSWD: /usr/bin/docker\" in sudoers, then RSLMC_DOCKER_SUDO=1.");
      if (facts.alternatives.length > 0) {
        hints.push(`Rootless/Podman socket found at ${facts.alternatives[0]} — enter it under "Docker endpoint" below (or set RSLMC_DOCKER_HOST).`);
      }
    } else {
      hints.push(
        `${who} should be able to open ${facts.endpoint} (${facts.socketMode ?? "mode unknown"}, group ${facts.socketGroup ?? "unknown"}), `
        + `so the refusal is coming from the daemon side. Check \`docker info\` output: ${firstLine(detail) || "no detail"}.`,
      );
    }
  } else if (missingSocket) {
    if (facts.inContainer) {
      /*
       * The panel is a container. Its own `/var/run/docker.sock` does not exist unless the host socket
       * was mounted in, and "start the daemon" cannot fix that no matter how many times it is typed.
       */
      hints.push(
        `The panel appears to be running inside a container and ${facts.endpoint} does not exist in it. `
        + "Mount the host socket into the panel: add -v /var/run/docker.sock:/var/run/docker.sock to how this panel is started (docker run / compose volumes).",
      );
      hints.push("Then restart the panel container; the socket appears at the same path and the probe will pick it up.");
    } else {
      hints.push(`Nothing is answering on ${facts.endpoint}. Start the daemon: systemctl start docker (Linux) or open Docker Desktop (Windows/macOS).`);
      if (elevated) {
        hints.push("If your shell reaches Docker but the panel does not, the two are using different endpoints — compare `docker context ls` with the endpoint above and enter the difference below.");
      }
    }
    if (facts.alternatives.length > 0) {
      hints.push(`A socket does exist at ${facts.alternatives[0]} — enter it under "Docker endpoint" and press Test & save.`);
    }
  } else {
    hints.push(`The CLI reported: ${firstLine(detail) || "no detail"}. Run the exact command below as ${facts.user} and compare the output.`);
  }

  /* A context the CLI resolves on its own is invisible from the socket path and is a classic mismatch. */
  if (facts.environment.cliContext && !facts.environment.dockerHost) {
    hints.push(
      `The CLI on this machine has the context "${facts.environment.cliContext}" set in ~/.docker/config.json, which overrides the default socket. `
      + "If that context points somewhere this panel cannot reach, name the right one in the endpoint field.",
    );
  }
  return hints;
}

function elevatedLabel(facts: DockerAccess): string {
  return facts.platformLabel === "win32" ? "Administrator" : `uid ${facts.uid}`;
}

/** The panel could not execute a CLI at all — say which paths were tried, not "not installed". */
export function diagnoseMissingCli(): DockerAccess {
  const facts = collectAccessFacts();
  const existing = facts.binaries.filter((entry) => entry.exists).map((entry) => entry.path);
  const configured = process.env.RSLMC_DOCKER_BIN?.trim() || "";
  /*
   * An explicit override that does not run is the operator's own setting failing, and saying "a CLI
   * exists elsewhere" would be true but not the problem. The override is named first.
   */
  const hints = [
    configured && !existing.includes(configured)
      ? `RSLMC_DOCKER_BIN is set to ${configured}, which the panel cannot execute. Fix that path or unset it so the panel searches normally.`
      : existing.length > 0
        ? `A CLI exists at ${existing[0]} but could not be executed from the panel. Point the panel at it: RSLMC_DOCKER_BIN=${existing[0]}.`
        : "No Docker CLI was found in the paths the panel searched. Install Docker Engine (Linux) or Docker Desktop (Windows/macOS).",
    `The panel's PATH is ${facts.environment.path || "(empty)"} — a shell usually has more than a service. `
    + "If `which docker` works for you, enter that absolute path as the CLI in the Docker settings below.",
  ];
  if (facts.environment.binEnv) {
    hints.push(`RSLMC_DOCKER_BIN is exported as ${facts.environment.binEnv}; it outranks anything saved in the panel, so fix it there or unset it.`);
  }
  if (facts.environment.dockerHost) {
    hints.push(`DOCKER_HOST is set to ${facts.environment.dockerHost} for the panel; the endpoint shown below was taken from it.`);
  }
  return { ...facts, hints };
}

/**
 * The machine facts the hints are written from.
 *
 * Read from the running process, not from the environment: `/proc/self/status` lists the *supplementary*
 * groups the panel actually holds, which is the whole question. Comparing a socket's group against
 * `process.getgid()` (the primary group only) reports "not in the docker group" for somebody who is.
 */
function collectAccessFacts(): DockerAccess {
  const endpoint = dockerEndpoint();
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const elevated = panelIsElevated();

  let user = "unknown";
  try {
    const info = userInfo();
    user = info.username;
    if (user === "unknown" && info.uid !== undefined) user = `uid ${info.uid}`;
  } catch { /* not every platform exposes this */ }

  const groupIds = processGroupIds();

  let socketExists = false;
  let socketMode: string | null = null;
  let socketGroup: string | null = null;
  let socketGid: number | null = null;
  let socketIsSocket = false;
  if (endpoint.startsWith("unix://")) {
    const path = endpoint.slice("unix://".length);
    try {
      const stat = statSync(path);
      socketExists = true;
      socketIsSocket = stat.isSocket();
      socketGid = stat.gid;
      socketMode = `mode ${(stat.mode & 0o777).toString(8)}`;
      socketGroup = groupNameFor(stat.gid);
    } catch { /* socket absent */ }
  }

  /*
   * Other sockets a daemon may be publishing. Checked because "Docker works in my shell" usually means
   * exactly one of these: the operator's CLI has DOCKER_HOST set, or rootless Docker / Podman is what is
   * actually running.
   */
  const alternatives: string[] = [];
  for (const candidate of [
    `/run/user/${uid ?? 0}/docker.sock`,
    `/run/user/${uid ?? 0}/podman/podman.sock`,
    "/run/podman/podman.sock",
    "/run/docker.sock",
    "/var/run/docker.sock",
  ]) {
    if (candidate === endpoint.replace(/^unix:\/\//, "")) continue;
    try {
      /*
       * `/run/docker.sock` is usually a symlink to `/var/run/docker.sock` — the same daemon the panel
       * just failed to reach. Reporting it as "an alternative socket you could use" would send somebody
       * in a circle, so identities are compared after resolving symlinks.
       */
      const resolved = realpathSync(candidate);
      const endpointResolved = endpoint.startsWith("unix://") ? realpathSync(endpoint.slice(7)) : endpoint;
      if (resolved === endpointResolved) continue;
      if (statSync(resolved).isSocket()) alternatives.push(candidate);
    } catch { /* not present */ }
  }

  const groupMissing = socketExists && socketGid !== null && uid !== null && uid !== 0
    && !groupIds.includes(socketGid);

  return {
    user,
    uid,
    elevated,
    platformLabel: process.platform,
    groups: [...new Set(groupIds.map((gid) => groupNameFor(gid)))],
    endpoint,
    endpointSource: dockerEndpointSource(),
    socketExists: socketExists && socketIsSocket,
    socketMode,
    socketGroup,
    groupMissing,
    alternatives,
    inContainer: detectContainer(),
    environment: {
      platform: process.platform,
      path: process.env.PATH ?? "",
      home: process.env.HOME ?? process.env.USERPROFILE ?? null,
      dockerHost: process.env.DOCKER_HOST?.trim() || null,
      dockerContext: process.env.DOCKER_CONTEXT?.trim() || null,
      binEnv: process.env.RSLMC_DOCKER_BIN?.trim() || null,
      cliContext: currentCliContext(),
    },
    binaries: dockerCandidates()
      .filter((candidate) => candidate.includes("/") || candidate.includes("\\"))
      .map((candidate) => ({ path: candidate, exists: existsSync(candidate) })),
    evidence: null,
    hints: [],
  };
}

/** True when this process looks like it lives inside a container rather than on the host. */
export function detectContainer(): boolean {
  if (process.env.container) return true;
  if (existsSync("/.dockerenv")) return true;
  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf8");
    if (/(docker|kubepods|lxc|containerd)/.test(cgroup)) return true;
  } catch { /* not Linux, or no access */ }
  try {
    const mounts = readFileSync("/proc/self/mountinfo", "utf8");
    if (/\/docker\/containers|overlay \/ /.test(mounts)) return true;
  } catch { /* ignore */ }
  return false;
}

/**
 * The context the CLI would resolve by itself.
 *
 * `~/.docker/config.json` can pin a context, and a context overrides the socket path entirely — the
 * single least visible way for "docker works in my shell" to be true while the panel is refused.
 */
export function currentCliContext(): string | null {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return null;
  const file = `${home}/.docker/config.json`;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const context = parsed.currentContext;
    return typeof context === "string" && context.trim() ? context.trim() : null;
  } catch {
    return null;
  }
}

/** The groups this process really holds — supplementary ones included. */
function processGroupIds(): number[] {
  try {
    const status = readFileSync("/proc/self/status", "utf8");
    const line = status.split("\n").find((entry) => entry.startsWith("Groups:"));
    if (line) {
      const ids = line.slice("Groups:".length).trim().split(/\s+/).map(Number).filter((value) => Number.isInteger(value));
      if (ids.length > 0) return ids;
    }
  } catch { /* not Linux */ }
  const gid = typeof process.getgid === "function" ? process.getgid() : null;
  return gid === null ? [] : [gid];
}

let groupTableCache: Map<number, string> | null = null;

/** gid → name from /etc/group, cached. Falls back to the number, which is still useful in a hint. */
function groupNameFor(gid: number): string {
  if (!groupTableCache) {
    groupTableCache = new Map();
    try {
      for (const line of readFileSync("/etc/group", "utf8").split("\n")) {
        const parts = line.split(":");
        const id = Number(parts[2]);
        if (parts[0] && Number.isInteger(id)) groupTableCache.set(id, parts[0]);
      }
    } catch { /* no /etc/group: numbers only */ }
  }
  return groupTableCache.get(gid) ?? String(gid);
}

function emptyInfo(reason: string, version: string | null = null): DockerInfo {
  return {
    available: false, version, apiVersion: null, storageDriver: null, cgroupVersion: null,
    runtimes: [], cpuCount: null, diskQuota: false, reason, cliPath: cachedCli, checkedAt: Date.now(),
  };
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).filter(Boolean)[0] ?? "";
}

/**
 * Asks the daemon directly whether it will honour `--storage-opt size=`. A create that is rejected
 * with "storage-opt is not supported" is the only reliable negative answer; anything else (no image,
 * daemon busy) leaves the question open, so it reports `false` and the UI says "not enforced" rather
 * than promising a limit that may silently not exist.
 */
function probeDiskQuota(storageDriver: string | null): boolean {
  if (!storageDriver) return false;
  if (QUOTA_DRIVERS.has(storageDriver)) return true;
  if (storageDriver !== "overlay2") return false;
  const probe = dockerCommand(
    ["create", "--name", "rslmc-quota-probe", "--storage-opt", "size=1G", "scratch"],
    15_000,
  );
  dockerCommand(["rm", "-f", "rslmc-quota-probe"], 10_000);
  if (probe.ok) {
    // Accepted: the driver really did take the option.
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */

export interface ImageRow {
  reference: string;
  id: string;
  sizeBytes: number;
  /** True when this exact reference is present locally. */
  local: boolean;
}

/** Every local image, newest tag first, for the "already pulled" list. */
export function listImages(): ImageRow[] {
  const result = dockerCommand(["image", "ls", "--format", "{{json .}}"], 20_000);
  if (!result.ok) return [];
  const rows: ImageRow[] = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const repository = String(parsed.Repository ?? "");
      const tag = String(parsed.Tag ?? "");
      if (!repository || repository === "<none>") continue;
      rows.push({
        reference: `${repository}:${tag}`,
        id: String(parsed.ID ?? ""),
        sizeBytes: parseSize(String(parsed.Size ?? "0B")),
        local: true,
      });
    } catch { /* a line the CLI printed that is not JSON: skip it */ }
  }
  return rows;
}

export function imagePresent(reference: string): boolean {
  const result = dockerCommand(["image", "inspect", "--format", "{{.Id}}", reference], 15_000);
  return result.ok && result.stdout.trim().length > 0;
}

/**
 * Parses Docker's human sizes into bytes.
 *
 * The CLI prints both decimal ("1.24GB", used by `docker image ls`) and binary ("463.6MiB", used by
 * `docker stats`) units, and treating "MiB" as unparseable is how the memory panel ended up showing a
 * flat zero for a container that was using half a gigabyte.
 */
export function parseSize(text: string): number {
  const match = /^([\d.]+)\s*([KMGTP])?(i)?B?$/i.exec(text.trim());
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = (match[2] ?? "").toUpperCase();
  const binary = Boolean(match[3]);
  if (!unit) return Math.round(value);
  // Docker's binary units are MiB/GiB (1024-based); its decimal ones are MB/GB (1000-based).
  const base = binary ? 1024 : 1000;
  const power = unit === "K" ? 1 : unit === "M" ? 2 : unit === "G" ? 3 : unit === "T" ? 4 : 5;
  return Math.round(value * base ** power);
}

/**
 * Pulls an image, streaming progress. Used by the wizard ("prepare image") and before the first
 * start of a container server, so a slow pull is visible in the console instead of looking like a
 * server that never starts.
 */
export async function pullImage(
  reference: string,
  onProgress?: (line: string) => void,
  timeoutMs = 15 * 60_000,
): Promise<{ ok: boolean; message: string }> {
  const bin = dockerBin();
  try {
    const process_ = Bun.spawn([bin, "pull", reference], {
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const decoder = new TextDecoder();
    let last = "";
    const reader = async (stream: ReadableStream<Uint8Array> | null) => {
      if (!stream) return;
      for await (const chunk of stream) {
        const text = decoder.decode(chunk as Uint8Array, { stream: true });
        for (const raw of text.split(/[\r\n]+/)) {
          const line = raw.trim();
          if (!line) continue;
          last = line;
          onProgress?.(line);
        }
      }
    };
    const timer = setTimeout(() => { try { process_.kill(); } catch { /* gone */ } }, timeoutMs);
    await Promise.all([reader(process_.stdout as ReadableStream<Uint8Array>), reader(process_.stderr as ReadableStream<Uint8Array>)]);
    const code = await process_.exited;
    clearTimeout(timer);
    if (code === 0) return { ok: true, message: `${reference} is ready.` };
    return { ok: false, message: last || `docker pull exited with code ${code}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/* ------------------------------------------------------------------ */
/* Containers                                                          */
/* ------------------------------------------------------------------ */

export interface ContainerState {
  name: string;
  exists: boolean;
  running: boolean;
  status: string;
  pid: number | null;
  exitCode: number | null;
  startedAt: string | null;
  image: string | null;
}

/** One `docker inspect`, no format guessing: the full JSON, parsed defensively. */
export function inspectContainer(name: string): ContainerState {
  const result = dockerCommand(["inspect", name], 15_000);
  const empty: ContainerState = {
    name, exists: false, running: false, status: "missing", pid: null, exitCode: null, startedAt: null, image: null,
  };
  if (!result.ok) return empty;
  try {
    const parsed = JSON.parse(result.stdout) as Array<Record<string, any>>;
    const first = parsed[0];
    if (!first) return empty;
    const state = first.State ?? {};
    return {
      name,
      exists: true,
      running: Boolean(state.Running),
      status: String(state.Status ?? (state.Running ? "running" : "exited")),
      pid: typeof state.Pid === "number" && state.Pid > 0 ? state.Pid : null,
      exitCode: typeof state.ExitCode === "number" ? state.ExitCode : null,
      startedAt: state.StartedAt ?? null,
      image: first.Config?.Image ?? null,
    };
  } catch {
    return empty;
  }
}

export interface ContainerStats {
  /** CPU percentage of one core, as Docker computes it. */
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  pids: number | null;
}

/**
 * Container metrics from the daemon itself.
 *
 * `docker stats` is the honest source for a container: `/proc/<pid>` describes the whole container
 * process tree, and the panel's process-tree walker would miss the JVM (its parent is containerd's
 * shim, not the CLI). Reading the daemon's own accounting also means the number matches what the
 * limit is enforced against.
 */
export function containerStats(name: string, timeoutMs = 15_000): ContainerStats {
  const result = dockerCommand(
    ["stats", "--no-stream", "--format", "{{json .}}", name],
    timeoutMs,
  );
  if (!result.ok) return { cpuPercent: null, memoryBytes: null, memoryLimitBytes: null, pids: null };
  const line = result.stdout.split("\n").map((value) => value.trim()).filter(Boolean)[0];
  if (!line) return { cpuPercent: null, memoryBytes: null, memoryLimitBytes: null, pids: null };
  try {
    const parsed = JSON.parse(line) as Record<string, string>;
    return {
      cpuPercent: parsePercent(parsed.CPUPerc ?? ""),
      memoryBytes: parseSize((parsed.MemUsage ?? "").split("/")[0] ?? ""),
      memoryLimitBytes: parseSize((parsed.MemUsage ?? "").split("/")[1] ?? ""),
      pids: Number(parsed.PIDs ?? 0) || null,
    };
  } catch {
    return { cpuPercent: null, memoryBytes: null, memoryLimitBytes: null, pids: null };
  }
}

/** `containerStats` without blocking the event loop. Use this on any request path. */
export async function containerStatsAsync(name: string, timeoutMs = 15_000): Promise<ContainerStats> {
  const result = await dockerCommandAsync(["stats", "--no-stream", "--format", "{{json .}}", name], timeoutMs);
  const empty: ContainerStats = { cpuPercent: null, memoryBytes: null, memoryLimitBytes: null, pids: null };
  if (!result.ok) return empty;
  const line = result.stdout.split("\n").map((value) => value.trim()).filter(Boolean)[0];
  if (!line) return empty;
  try {
    const parsed = JSON.parse(line) as Record<string, string>;
    return {
      cpuPercent: parsePercent(parsed.CPUPerc ?? ""),
      memoryBytes: parseSize((parsed.MemUsage ?? "").split("/")[0] ?? ""),
      memoryLimitBytes: parseSize((parsed.MemUsage ?? "").split("/")[1] ?? ""),
      pids: Number(parsed.PIDs ?? 0) || null,
    };
  } catch {
    return empty;
  }
}

export function parsePercent(text: string): number | null {
  const match = /(-?[\d.]+)\s*%/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** SIGKILL the container and remove it. The CLI process goes with it, which the manager observes. */
export function killContainer(name: string): { ok: boolean; message: string } {
  const killed = dockerCommand(["kill", name], 20_000);
  const removed = dockerCommand(["rm", "-f", name], 20_000);
  if (removed.ok || killed.ok) {
    /*
     * `--rm` removes the container asynchronously once the process tree is gone, so an immediate
     * `docker inspect` can still find it. Waiting here means the panel's "killed" is true a moment
     * later for everyone else too — the next start reuses the name, and that must not race.
     */
    waitForRemoval(name, 5000);
    return { ok: true, message: "" };
  }
  const message = `${killed.stderr}${removed.stderr}`.trim();
  // "No such container" is success: there is nothing left to kill.
  if (/no such container/i.test(message)) return { ok: true, message: "" };
  return { ok: false, message: firstLine(message) || "docker kill failed" };
}

/** Blocks (briefly) until the container is really gone. Returns true when it is. */
export function waitForRemoval(name: string, timeoutMs = 5000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!inspectContainer(name).exists) return true;
    Bun.sleepSync(120);
  }
  return !inspectContainer(name).exists;
}

export function removeContainer(name: string): { ok: boolean; message: string } {
  const result = dockerCommand(["rm", "-f", name], 20_000);
  if (result.ok) return { ok: true, message: "" };
  const message = `${result.stderr}`.trim();
  if (/no such container/i.test(message)) return { ok: true, message: "" };
  return { ok: false, message: firstLine(message) };
}

/** Containers whose name starts with the panel's prefix — used to spot leftovers at boot. */
export function listPanelContainers(prefix = "rslmc-"): { name: string; running: boolean; status: string }[] {
  const result = dockerCommand(
    ["ps", "-a", "--filter", `name=${prefix}`, "--format", "{{json .}}"],
    20_000,
  );
  if (!result.ok) return [];
  const rows: { name: string; running: boolean; status: string }[] = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, string>;
      rows.push({
        name: String(parsed.Names ?? ""),
        running: String(parsed.State ?? "").toLowerCase() === "running",
        status: String(parsed.Status ?? ""),
      });
    } catch { /* not JSON */ }
  }
  return rows.filter((row) => row.name.startsWith(prefix));
}

export function containerNameFor(uuid: string): string {
  return `rslmc-${uuid}`;
}
