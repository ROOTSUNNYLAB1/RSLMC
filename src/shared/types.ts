/**
 * RSLMC — shared domain types used by both the Bun backend and the React frontend.
 * Keeping these in one place guarantees the API contract is typed end-to-end.
 */

export type ServerStatus =
  | "offline"
  | "starting"
  | "online"
  | "stopping"
  | "restarting"
  | "crashed"
  | "error"
  | "recovering"
  | "installing";

export type SoftwareKind = "vanilla" | "plugin" | "mod" | "proxy" | "app";

export type ServerSoftwareId =
  | "vanilla"
  | "paper"
  | "purpur"
  | "folia"
  | "fabric"
  | "forge"
  | "neoforge"
  | "quilt"
  | "velocity"
  | "bungeecord"
  | "waterfall"
  /*
   * Non-Minecraft software. These are first-class entries in the same catalogue — same wizard, same
   * allocation, same console — but they are started by their own interpreter instead of a JVM, and
   * they are the only software the panel refuses to run as root.
   */
  | "python"
  | "node";

export interface SoftwareDefinition {
  id: ServerSoftwareId;
  name: string;
  kind: SoftwareKind;
  description: string;
  supportsPlugins: boolean;
  supportsMods: boolean;
  proxy: boolean;
  installerBased: boolean;
  /** Whether RSLMC can currently provision this software end-to-end. */
  supported: boolean;
  unsupportedReason?: string;
  source: string;
  docsUrl: string;
  /** Set for non-Minecraft software, which needs an interpreter rather than a Java runtime. */
  appFamily?: "python" | "node";
  /** Convenience entry file a fresh install of this software gets. */
  entryFile?: string;
}

/** What a Python/Node server needs on top of the usual server fields. */
export interface AppServerInfo {
  family: "python" | "node";
  name: string;
  /** The interpreter version this server runs, e.g. "3.12.7" or "22.11.0". */
  version: string;
  /** File the interpreter is pointed at, relative to the server directory. */
  entryFile: string;
  /** Absolute path of the interpreter on this host, once installed. */
  interpreterPath: string | null;
  /** False until the interpreter archive has been unpacked on this machine. */
  installed: boolean;
  /** The binary name (`python3` / `node`). */
  binary: string;
  /** Account the process must run as; null for Minecraft software. */
  serviceUser: string | null;
  /** True only when the kernel really switches user for this server. */
  isolated: boolean;
}

export type EnforcementLevel = "enforced" | "partial" | "advisory" | "unsupported";

export interface ResourceEnforcement {
  memory: { level: EnforcementLevel; mechanism: string; note: string };
  cpu: { level: EnforcementLevel; mechanism: string; note: string };
  disk: { level: EnforcementLevel; mechanism: string; note: string };
}

export interface JavaRuntimeInfo {
  id: number;
  nodeId: number | null;
  major: number;
  vendor: string;
  version: string;
  os: string;
  arch: string;
  imageType: string;
  path: string;
  sizeBytes: number;
  checksum: string | null;
  status: "downloading" | "installed" | "verified" | "failed" | "missing";
  verifiedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface UserPublic {
  id: number;
  username: string;
  email: string | null;
  isRoot: boolean;
  mustChangePassword: boolean;
  totpEnabled: boolean;
  disabled: boolean;
  roles: string[];
  permissions: string[];
  createdAt: string;
  lastLoginAt: string | null;
  avatarColor: string;
  /** Present once a picture has been uploaded; already carries a `?v=` cache buster. */
  avatarUrl: string | null;
  /** Interface theme id (see src/shared/themes.ts). */
  theme: string;
}

export interface NodeStats {
  os: string;
  arch: string;
  cpuCores: number;
  cpuUsagePercent: number;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  diskTotalBytes: number;
  diskUsedBytes: number;
  loadAverage: [number, number, number];
  javaVersion: string | null;
  bunVersion: string;
  uptimeSeconds: number;
  agents: { cgroups: boolean; privileged: boolean };
}

export interface ServerSummary {
  id: number;
  uuid: string;
  name: string;
  description: string | null;
  icon: string | null;
  status: ServerStatus;
  software: ServerSoftwareId;
  softwareVersion: string;
  mcVersion: string;
  nodeId: number;
  nodeName?: string;
  /** How this server runs: a JVM the panel starts, or a Docker container. */
  runtime: "standalone" | "docker";
  /** The image used when `runtime` is `docker`, e.g. `ghcr.io/pterodactyl/yolks:java_21`. */
  dockerImage: string | null;
  /** The container name (`rslmc-<uuid>`), null for standalone servers. */
  containerName: string | null;
  /** True when the daemon accepted a per-container disk quota for this server. */
  dockerDiskQuota: boolean;
  ownerId: number;
  ownerName?: string;
  memoryMb: number;
  /** Allocation in CPU-percent (100 % = one core-equivalent). */
  cpuPercent: number;
  /**
   * Observed usage right now, when the server is running. `null` means "not running", and
   * `cpuPercent: null` inside means the sampler could not read the process on this host.
   */
  usage?: { cpuPercent: number | null; memBytes: number | null; cpuSource: string } | null;
  diskMb: number;
  bindIp: string;
  port: number;
  /** Tunnel / port-forwarding hostname players should use (playit.gg, ngrok, …). */
  publicHost: string | null;
  /** Port to append to `publicHost`; null means "show the host only". */
  publicPort: number | null;
  /** Internal address as the JVM listens (`ip:port`) — for operators, not players. */
  internalAddress: string;
  /** What players actually type: the public host (with its port only if one was set). */
  playAddress: string;
  address: string;
  javaMajor: number;
  javaRuntimeId: number | null;
  autoStart: boolean;
  crashRecovery: boolean;
  createdAt: string;
  lastStartedAt: string | null;
  installedAt: string | null;
  uptimeSeconds: number;
  playersOnline: number;
  maxPlayers: number;
  enforcement: ResourceEnforcement | null;
  /**
   * Docker only: what the CPU allocation will really be granted.
   *
   * `--cpus` above the daemon's core count is an error, not a queue, so the panel clamps and says so
   * instead of pretending 400% is in force on a two-core box.
   */
  cpuBudget?: {
    requestedCores: number;
    grantedCores: number;
    hostCores: number;
    clamped: boolean;
    source: string;
  } | null;
  /**
   * Present only for Python/Node servers: which interpreter, which file, and which account runs it.
   * `null` for Minecraft software, so the UI can decide without string comparisons.
   */
  app: AppServerInfo | null;
}

export interface ServerMetrics {
  ts: number;
  cpuPercent: number;
  /** Where the numbers came from ("/proc", "Get-Process", "unavailable") — the UI says so honestly. */
  cpuSource?: string;
  /** Resident working set of the process (file page cache excluded — it is reclaimable). */
  memBytes: number;
  /** Page cache the server touched (jars, libraries, world files). Reported separately. */
  memCacheBytes?: number;
  diskBytes: number;
  players: number;
  netRxBytes: number;
  netTxBytes: number;
  uptimeSeconds: number;
  tps: number | null;
}

export interface ConsoleLine {
  ts: number;
  /** "input" marks a command the operator typed through the panel. */
  stream: "stdout" | "stderr" | "system" | "input";
  text: string;
}

export type WsMessage =
  | { type: "console"; serverId: number; lines: ConsoleLine[] }
  | { type: "console.history"; serverId: number; lines: ConsoleLine[] }
  | { type: "status"; serverId: number; status: ServerStatus; uptimeSeconds: number }
  | { type: "metrics"; serverId: number; metrics: ServerMetrics }
  | { type: "players"; serverId: number; players: OnlinePlayer[] }
  | { type: "notification"; notification: NotificationRecord }
  | { type: "progress"; kind: string; id: string; progress: number; total: number; label: string; done: boolean; error?: string }
  | { type: "hello"; user: UserPublic }
  | { type: "pong" }
  | { type: "error"; message: string };

export interface OnlinePlayer {
  name: string;
  uuid: string | null;
  joinedAt: number | null;
  sessionSeconds: number | null;
  operator: boolean;
  whitelisted: boolean;
}

export interface PlayerRecord {
  id: number;
  serverId: number;
  uuid: string;
  username: string;
  online: boolean;
  operator: boolean;
  whitelisted: boolean;
  banned: boolean;
  lastSeenAt: string | null;
  lastJoinAt: string | null;
  firstSeenAt: string;
  playtimeSeconds: number;
  sessionStartAt: string | null;
}

export interface BackupRecord {
  id: number;
  uuid: string;
  serverId: number;
  name: string;
  description: string | null;
  kind: "full" | "worlds" | "config" | "plugins";
  fileName: string;
  sizeBytes: number;
  status: "queued" | "running" | "completed" | "failed" | "restoring" | "restored";
  sha256: string | null;
  createdAt: string;
  completedAt: string | null;
  createdBy: string | null;
  error: string | null;
}

export interface ScheduleRecord {
  id: number;
  serverId: number;
  name: string;
  cron: string;
  timezone: string;
  action: "restart" | "start" | "stop" | "command" | "backup" | "announce" | "cleanup";
  payload: Record<string, unknown>;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastResult: string | null;
}

export interface NotificationRecord {
  id: number;
  userId: number | null;
  severity: "info" | "success" | "warning" | "error";
  title: string;
  body: string | null;
  link: string | null;
  kind: string;
  readAt: string | null;
  createdAt: string;
}

export interface ActivityRecord {
  id: number;
  ts: string;
  serverId: number | null;
  serverName?: string | null;
  actorName: string | null;
  type: string;
  target: string | null;
  result: "success" | "failure" | "info";
  metadata: Record<string, unknown> | null;
}

export interface AuditRecord extends ActivityRecord {
  actorId: number | null;
  ip: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
  modifiedAt: number;
  mode: string;
  editable: boolean;
}

export interface WorldRecord {
  id: number;
  serverId: number;
  name: string;
  folder: string;
  environment: "overworld" | "nether" | "end" | "custom";
  sizeBytes: number;
  seed: string | null;
  protected: boolean;
  lastUpdated: string | null;
  detected: boolean;
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export interface SetupStatus {
  needsSetup: boolean;
  mode: "development" | "production";
  checks: SetupCheck[];
}

export interface SetupCheck {
  id: string;
  label: string;
  status: "ok" | "warn" | "error";
  detail: string;
}

