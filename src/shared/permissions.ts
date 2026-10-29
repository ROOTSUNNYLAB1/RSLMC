/** Central permission catalogue. Every sensitive API route is guarded by one of these. */
export const PERMISSIONS = {
  "server.view": "View a server and its console",
  "server.start": "Start a server",
  "server.stop": "Stop a server",
  "server.kill": "Force-kill a server process",
  "server.restart": "Restart a server",
  "server.command": "Execute console commands",
  "server.create": "Create servers",
  "server.delete": "Delete servers",
  "server.settings": "Change server settings and resource allocations",
  "server.startup": "Choose JVM startup presets within the allocated limits",
  "server.files": "Manage server files",
  "server.players": "Manage players (kick, ban, op, whitelist)",
  "server.plugins": "Install and remove plugins/mods",
  "server.backups": "Create and restore backups",
  "server.worlds": "Manage worlds",
  "server.schedules": "Manage schedules",
  "server.allocations": "Manage networking allocations",
  "node.view": "View nodes",
  "node.manage": "Create, edit and delete nodes",
  "user.view": "View users",
  "user.manage": "Create, edit and delete users",
  "role.manage": "Manage roles and permissions",
  "audit.view": "View audit logs",
  "system.manage": "Manage global system configuration",
  "java.manage": "Manage Java runtimes",
  "security.manage": "Manage security settings",
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const DEFAULT_ROLES = [
  {
    name: "Administrator",
    description: "Full control over the panel, nodes, servers and users.",
    isSystem: true,
    permissions: ALL_PERMISSIONS,
  },
  {
    name: "Server Manager",
    description: "Manages servers, files, players and backups but not infrastructure.",
    isSystem: false,
    permissions: [
      "server.view", "server.start", "server.stop", "server.restart", "server.kill",
      "server.command", "server.create", "server.files", "server.players",
      "server.plugins", "server.backups", "server.worlds", "server.schedules",
      "server.allocations", "node.view",
    ] as Permission[],
  },
  {
    name: "Moderator",
    description: "Day-to-day moderation: console access and player management.",
    isSystem: false,
    permissions: ["server.view", "server.command", "server.players", "node.view"] as Permission[],
  },
  {
    /*
     * The default role for self-registered accounts. Deliberately free of everything that can hurt
     * the panel or other people's servers: no server creation/deletion, no resource or network
     * allocation, no Java runtime installs, and nothing from the administration area. An
     * administrator hands a new account its servers explicitly (Administration → Users → Servers);
     * until then the account sees an empty server list.
     */
    name: "User",
    description: "Owns the servers an administrator allocates to them — no infrastructure access.",
    isSystem: false,
    permissions: [
      "server.view",
      "server.start", "server.stop", "server.restart", "server.kill",
      "server.command",
      "server.files", "server.players", "server.plugins", "server.worlds",
      "server.backups", "server.schedules",
      // JVM preset only — not the memory/CPU/disk allocation, the raw flags or the command line.
      "server.startup",
    ] as Permission[],
  },
  {
    name: "Viewer",
    description: "Read-only access to servers and metrics.",
    isSystem: false,
    permissions: ["server.view", "node.view"] as Permission[],
  },
] as const;

/**
 * Permissions a self-registered account must never be given by default — creating/deleting servers,
 * changing allocations or resource limits, installing Java runtimes, and the whole admin area.
 */
export const DANGEROUS_PERMISSIONS: Permission[] = [
  "server.create", "server.delete", "server.settings", "server.allocations",
  "node.view", "node.manage", "user.view", "user.manage", "role.manage", "audit.view",
  "system.manage", "java.manage", "security.manage",
];

/** True when a role grants anything from the administration area or any destructive server action. */
export function roleHasAdminAccess(permissions: string[]): boolean {
  return permissions.some((permission) => DANGEROUS_PERMISSIONS.includes(permission as Permission));
}
