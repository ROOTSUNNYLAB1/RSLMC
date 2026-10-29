import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../services/download";

export type PropertyType = "string" | "boolean" | "integer" | "enum";

export interface PropertySpec {
  key: string;
  label: string;
  type: PropertyType;
  default?: string;
  description: string;
  options?: string[];
  min?: number;
  max?: number;
  requiresRestart: boolean;
  group: "General" | "Gameplay" | "World" | "Network" | "Security" | "Resource pack" | "Advanced";
  secret?: boolean;
}

/**
 * Curated server.properties metadata. Unknown keys are always preserved on save, so a
 * version-specific property never silently disappears.
 */
export const PROPERTY_SPECS: PropertySpec[] = [
  { key: "motd", label: "MOTD", type: "string", default: "A Minecraft Server", description: "Message shown in the multiplayer server list.", requiresRestart: false, group: "General" },
  { key: "server-port", label: "Server port", type: "integer", default: "25565", min: 1, max: 65535, description: "TCP port the server listens on. Changing this requires RSLMC's allocation to be updated too.", requiresRestart: true, group: "Network" },
  { key: "server-ip", label: "Bind address", type: "string", default: "", description: "Interface to bind. Empty means all interfaces.", requiresRestart: true, group: "Network" },
  { key: "max-players", label: "Maximum players", type: "integer", default: "20", min: 1, max: 10000, description: "Maximum number of simultaneous players.", requiresRestart: false, group: "General" },
  { key: "gamemode", label: "Default game mode", type: "enum", default: "survival", options: ["survival", "creative", "adventure", "spectator"], description: "Game mode for new players.", requiresRestart: false, group: "General" },
  { key: "difficulty", label: "Difficulty", type: "enum", default: "easy", options: ["peaceful", "easy", "normal", "hard"], description: "World difficulty.", requiresRestart: false, group: "General" },
  { key: "hardcore", label: "Hardcore", type: "boolean", default: "false", description: "Players are set to spectator mode on death.", requiresRestart: true, group: "Gameplay" },
  { key: "pvp", label: "PvP", type: "boolean", default: "true", description: "Allow players to damage each other.", requiresRestart: false, group: "General" },
  { key: "force-gamemode", label: "Force game mode", type: "boolean", default: "false", description: "Force players into the default game mode on join.", requiresRestart: false, group: "Gameplay" },
  { key: "allow-flight", label: "Allow flight", type: "boolean", default: "false", description: "Allow flight in survival mode (needed by many anti-cheat plugins).", requiresRestart: false, group: "Gameplay" },
  { key: "allow-nether", label: "Allow Nether", type: "boolean", default: "true", description: "Allow players to travel to the Nether.", requiresRestart: true, group: "World" },
  { key: "level-name", label: "World folder", type: "string", default: "world", description: "Folder containing the main world.", requiresRestart: true, group: "General" },
  { key: "level-seed", label: "World seed", type: "string", default: "", description: "Seed for new world generation. Ignored once the world exists.", requiresRestart: true, group: "World" },
  { key: "level-type", label: "World type", type: "enum", default: "minecraft:normal", options: ["minecraft:normal", "minecraft:flat", "minecraft:large_biomes", "minecraft:amplified", "minecraft:single_biome_surface"], description: "Generator used when creating the world.", requiresRestart: true, group: "World" },
  { key: "view-distance", label: "View distance", type: "integer", default: "10", min: 3, max: 32, description: "Chunk radius sent to clients. Higher values cost memory and CPU.", requiresRestart: false, group: "General" },
  { key: "simulation-distance", label: "Simulation distance", type: "integer", default: "10", min: 3, max: 32, description: "Chunk radius where entities and blocks tick.", requiresRestart: false, group: "World" },
  { key: "spawn-protection", label: "Spawn protection radius", type: "integer", default: "16", min: 0, max: 1000, description: "Blocks around spawn where non-operators cannot build.", requiresRestart: false, group: "World" },
  { key: "spawn-monsters", label: "Spawn monsters", type: "boolean", default: "true", description: "Allow hostile mob spawning.", requiresRestart: false, group: "World" },
  { key: "spawn-npcs", label: "Spawn villagers", type: "boolean", default: "true", description: "Allow NPC (villager) spawning.", requiresRestart: false, group: "World" },
  { key: "spawn-animals", label: "Spawn animals", type: "boolean", default: "true", description: "Allow passive mob spawning.", requiresRestart: false, group: "World" },
  { key: "generate-structures", label: "Generate structures", type: "boolean", default: "true", description: "Generate villages, temples and other structures.", requiresRestart: true, group: "World" },
  { key: "online-mode", label: "Online mode", type: "boolean", default: "true", description: "Verify players against Mojang authentication. Disabling this allows impersonation and changes UUIDs.", requiresRestart: true, group: "General" },
  { key: "enforce-whitelist", label: "Enforce whitelist", type: "boolean", default: "false", description: "Kick players who are not on the whitelist.", requiresRestart: false, group: "Security" },
  { key: "white-list", label: "Whitelist enabled", type: "boolean", default: "false", description: "Only allow whitelisted players to join.", requiresRestart: false, group: "General" },
  { key: "enable-command-block", label: "Enable command blocks", type: "boolean", default: "false", description: "Allow command blocks to run.", requiresRestart: true, group: "Security" },
  { key: "op-permission-level", label: "Operator permission level", type: "enum", default: "4", options: ["1", "2", "3", "4"], description: "Default permission level for operators.", requiresRestart: false, group: "Security" },
  { key: "player-idle-timeout", label: "Idle timeout (minutes)", type: "integer", default: "0", min: 0, max: 10000, description: "Kick players after this many idle minutes. 0 disables.", requiresRestart: false, group: "Security" },
  { key: "enable-rcon", label: "Enable RCON", type: "boolean", default: "false", description: "Enable the remote console protocol. Never expose the RCON port to the internet.", requiresRestart: true, group: "Advanced" },
  { key: "rcon.port", label: "RCON port", type: "integer", default: "25575", min: 1, max: 65535, description: "Port for RCON.", requiresRestart: true, group: "Advanced" },
  { key: "rcon.password", label: "RCON password", type: "string", default: "", description: "Password for RCON. Stored in server.properties in plain text — RSLMC redacts it in the console.", requiresRestart: true, group: "Advanced", secret: true },
  { key: "enable-query", label: "Enable query", type: "boolean", default: "false", description: "Enable the GameSpy4 query protocol for external status polling.", requiresRestart: true, group: "Advanced" },
  { key: "query.port", label: "Query port", type: "integer", default: "25565", min: 1, max: 65535, description: "UDP port for the query protocol.", requiresRestart: true, group: "Advanced" },
  { key: "resource-pack", label: "Resource pack URL", type: "string", default: "", description: "Direct HTTPS URL of a resource pack sent to clients.", requiresRestart: false, group: "Resource pack" },
  { key: "resource-pack-sha1", label: "Resource pack SHA-1", type: "string", default: "", description: "SHA-1 hash of the resource pack for integrity checking.", requiresRestart: false, group: "Resource pack" },
  { key: "resource-pack-prompt", label: "Resource pack prompt", type: "string", default: "", description: "Message shown when prompting players to download the pack.", requiresRestart: false, group: "Resource pack" },
  { key: "require-resource-pack", label: "Require resource pack", type: "boolean", default: "false", description: "Kick players who decline the resource pack.", requiresRestart: false, group: "Resource pack" },
  { key: "max-tick-time", label: "Max tick time (ms)", type: "integer", default: "60000", min: -1, max: 600000, description: "Watchdog threshold. -1 disables the watchdog.", requiresRestart: true, group: "Advanced" },
  { key: "network-compression-threshold", label: "Compression threshold", type: "integer", default: "256", min: -1, max: 65536, description: "Packet size above which compression starts. -1 disables compression.", requiresRestart: true, group: "Advanced" },
  { key: "sync-chunk-writes", label: "Sync chunk writes", type: "boolean", default: "true", description: "Synchronous chunk saving. Leave enabled unless you know the trade-off.", requiresRestart: true, group: "Advanced" },
  { key: "max-world-size", label: "Max world size", type: "integer", default: "29999984", min: 1, max: 29999984, description: "Maximum world border radius in blocks.", requiresRestart: false, group: "Advanced" },
];

/**
 * `server.properties` is written by `java.util.Properties.store()`, so values that contain `:` or `=`
 * come back escaped — a modern server file literally contains `level-type=minecraft\:normal`.
 * Reading that raw made the enum dropdown miss its option ("minecraft\:normal (current)") and saving
 * it failed validation with "World type must be one of: minecraft:normal, …". Unescape on read and
 * escape on write, so the panel always deals with the real value.
 */
export function unescapePropertyValue(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i]!;
    if (char !== "\\") { out += char; continue; }
    const next = raw[i + 1];
    if (next === undefined) { out += "\\"; break; }
    i += 1;
    switch (next) {
      case "t": out += "\t"; break;
      case "n": out += "\n"; break;
      case "r": out += "\r"; break;
      case "f": out += "\f"; break;
      case "u": {
        const hex = raw.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 4; }
        else out += "u";
        break;
      }
      // \\, \:, \= and any other escaped character stand for themselves.
      default: out += next;
    }
  }
  return out;
}

/** Inverse of unescapePropertyValue — matches what Minecraft itself writes back. */
export function escapePropertyValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/([:=])/g, "\\$1");
}

/**
 * World generators renamed themselves in 1.16 (`DEFAULT` → `minecraft:normal`, …). Older files and
 * datapack generators both have to keep working, so known aliases are canonicalised and any other
 * `namespace:path` identifier is accepted as-is.
 */
export const LEGACY_WORLD_TYPES: Record<string, string> = {
  DEFAULT: "minecraft:normal",
  NORMAL: "minecraft:normal",
  FLAT: "minecraft:flat",
  LARGEBIOMES: "minecraft:large_biomes",
  AMPLIFIED: "minecraft:amplified",
  SINGLEBIOME: "minecraft:single_biome_surface",
};

export function normalisePropertyValue(key: string, value: string): string {
  if (key !== "level-type") return value;
  const trimmed = value.trim();
  const legacy = LEGACY_WORLD_TYPES[trimmed.toUpperCase()];
  if (legacy) return legacy;
  // `normal` / `flat` … without a namespace
  if (/^[a-z0-9_]+$/i.test(trimmed) && !trimmed.includes(":")) {
    const candidate = LEGACY_WORLD_TYPES[trimmed.toUpperCase()] ?? `minecraft:${trimmed.toLowerCase()}`;
    return candidate;
  }
  return trimmed;
}

/** A datapack generator id (`terralith:overworld`) is a valid enum value even when it is not listed. */
export function isNamespacedId(value: string): boolean {
  return /^[a-z0-9_.-]+:[a-z0-9_./-]+$/i.test(value.trim());
}

export function parseProperties(text: string): { values: Record<string, string>; order: string[] } {
  const values: Record<string, string> = {};
  const order: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = unescapePropertyValue(line.slice(0, eq).trim());
    const value = normalisePropertyValue(key, unescapePropertyValue(line.slice(eq + 1).trim()));
    if (!key) continue;
    values[key] = value;
    order.push(key);
  }
  return { values, order };
}

export function readProperties(directory: string): { values: Record<string, string>; exists: boolean; raw: string; modifiedAt: number | null } {
  const path = join(directory, "server.properties");
  if (!existsSync(path)) return { values: {}, exists: false, raw: "", modifiedAt: null };
  const raw = readFileSync(path, "utf8");
  return { values: parseProperties(raw).values, exists: true, raw, modifiedAt: Date.now() };
}

export interface PropertyPatch { [key: string]: string }

/**
 * Serialises properties while preserving comments from the existing file and appending any
 * keys the currently running Minecraft version added.
 */
export function writeProperties(directory: string, patch: PropertyPatch, reserved: Set<string>): { changed: string[]; restartRequired: boolean } {
  const path = join(directory, "server.properties");
  const existingRaw = existsSync(path) ? readFileSync(path, "utf8") : "";
  const existing = parseProperties(existingRaw);
  const changed: string[] = [];

  const specByKey = new Map(PROPERTY_SPECS.map((spec) => [spec.key, spec]));
  for (const [key, rawValue] of Object.entries(patch)) {
    if (reserved.has(key)) {
      /*
       * The editor always posts the whole value map, so a reserved key that merely echoes what is
       * already on disk is protocol noise and gets skipped. A reserved key whose value would actually
       * *change* is a real attempt to take the port/bind address away from the panel: refuse it by
       * name instead of silently dropping it.
       */
      const current = existing.values[key] ?? "";
      if (String(rawValue ?? "") !== current) {
        throw new Error(
          `${key} is managed by RSLMC (it comes from the server's allocation). `
          + "Change it under Networking → Allocations instead.",
        );
      }
      continue;
    }
    const spec = specByKey.get(key);
    const value = spec ? normalisePropertyValue(key, rawValue) : rawValue;
    patch[key] = value;
    if (spec) {
      if (spec.type === "integer") {
        const num = Number(value);
        if (!Number.isFinite(num)) throw new Error(`${spec.label} must be a number`);
        if (spec.min !== undefined && num < spec.min) throw new Error(`${spec.label} must be at least ${spec.min}`);
        if (spec.max !== undefined && num > spec.max) throw new Error(`${spec.label} must be at most ${spec.max}`);
      }
      if (spec.type === "boolean" && !["true", "false"].includes(value)) throw new Error(`${spec.label} must be true or false`);
      if (spec.type === "enum" && spec.options && !spec.options.includes(value)) {
        // Datapack world generators (`terralith:overworld`) are legitimate values the curated list
        // cannot know about; anything else is a real mistake.
        if (!isNamespacedId(value)) {
          throw new Error(`${spec.label} must be one of: ${spec.options.join(", ")}, or a generator id such as terralith:overworld`);
        }
      }
    }
    if (existing.values[key] !== value) changed.push(key);
  }

  const lines: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of existingRaw.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) {
      lines.push(rawLine);
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) { lines.push(rawLine); continue; }
    const key = trimmed.slice(0, eq).trim();
    if (key in patch && !reserved.has(key)) {
      lines.push(`${key}=${escapePropertyValue(patch[key])}`);
      seen.add(key);
    } else {
      lines.push(rawLine);
    }
  }
  for (const [key, value] of Object.entries(patch)) {
    if (seen.has(key) || reserved.has(key)) continue;
    lines.push(`${key}=${escapePropertyValue(value)}`);
  }
  const newRaw = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  if (newRaw !== existingRaw) writeFileAtomic(path, newRaw);

  const restartRequired = changed.some((key) => specByKey.get(key)?.requiresRestart ?? false);
  return { changed, restartRequired };
}

export function defaultPropertyValues(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of PROPERTY_SPECS) if (spec.default !== undefined) out[spec.key] = spec.default;
  return out;
}
