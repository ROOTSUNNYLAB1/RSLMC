import type { ServerSoftwareId } from "../shared/types";

/**
 * JVM flag presets.
 *
 * These are the flags RSLMC puts on the command line *after* `-Xms/-Xmx` (memory always comes from
 * the server allocation). The default preset for a game server is Aikar's G1GC set — the tuning the
 * Paper/Spigot community has converged on — because the stock JVM spends a lot of time in GC pauses
 * with Minecraft's allocation pattern. Proxies get a much smaller set (they allocate almost nothing
 * and mostly move bytes).
 *
 * Nothing here is magic: every flag is a real HotSpot option, the panel shows the exact arguments it
 * will use, and `custom` exists so a user can replace them entirely.
 *
 * "-XX:+AlwaysPreTouch" is deliberately **not** included. It faults in every heap page at boot, so a
 * panel host running three servers instantly wanted 3 × allocation of resident memory (and the
 * dashboard honestly showed "all RAM used" for an empty server). Aikar's set is otherwise unchanged;
 * pages still get touched as the heap grows, and G1 handles that without meaningful pauses.
 */

export type JvmPresetId = "aikar" | "proxy" | "lowmem" | "custom";

export interface JvmPreset {
  id: JvmPresetId;
  label: string;
  summary: string;
  /** Space separated flags, exactly what is stored in `servers.jvm_args`. */
  flags: string;
  /** Software this preset is meant for. */
  software: ServerSoftwareId[];
  recommended?: boolean;
}

/** Aikar's flags — G1GC tuning for Minecraft servers (mcflags.emc.gs). */
export const AIKAR_FLAGS = [
  "-XX:+UseG1GC",
  "-XX:+ParallelRefProcEnabled",
  "-XX:MaxGCPauseMillis=200",
  "-XX:+UnlockExperimentalVMOptions",
  "-XX:+DisableExplicitGC",
  "-XX:G1NewSizePercent=30",
  "-XX:G1MaxNewSizePercent=40",
  "-XX:G1HeapRegionSize=8M",
  "-XX:G1ReservePercent=20",
  "-XX:G1HeapWastePercent=5",
  "-XX:G1MixedGCCountTarget=4",
  "-XX:InitiatingHeapOccupancyPercent=15",
  "-XX:G1MixedGCLiveThresholdPercent=90",
  "-XX:G1RSetUpdatingPauseTimePercent=5",
  "-XX:SurvivorRatio=32",
  "-XX:+PerfDisableSharedMem",
  "-XX:MaxTenuringThreshold=1",
  // Metaspace is unbounded by default; capping it keeps the native side predictable.
  "-XX:MaxMetaspaceSize=256M",
  // G1 hands memory back only when asked; a periodic GC keeps an idle server from pinning the box.
  "-XX:G1PeriodicGCInterval=300000",
  "-XX:G1PeriodicGCSystemLoadThreshold=0",
  "-XX:MinHeapFreeRatio=20",
  "-XX:MaxHeapFreeRatio=40",
  "-Dusing.aikars.flags=https://mcflags.emc.gs",
  "-Daikars.new.flags=true",
].join(" ");

/** Velocity / BungeeCord / Waterfall: small heap, short-lived objects, no world simulation. */
export const PROXY_FLAGS = [
  "-XX:+UseG1GC",
  "-XX:G1HeapRegionSize=4M",
  "-XX:+UnlockExperimentalVMOptions",
  "-XX:+ParallelRefProcEnabled",
  "-XX:MaxInlineLevel=15",
  "-XX:MaxMetaspaceSize=192M",
].join(" ");

/**
 * Small heaps (below 1.5 GB): SerialGC instead of G1.
 *
 * G1 keeps per-region remembered sets and a concurrent marking cycle in native memory — on a 1 GB
 * heap that overhead is a noticeable slice of the allocation, and its pause advantage only shows up
 * with much bigger heaps. SerialGC plus an explicit native cap keeps a small server's real footprint
 * close to its heap instead of "everything the box has".
 */
export const LOW_MEMORY_FLAGS = [
  "-XX:+UseSerialGC",
  "-XX:+DisableExplicitGC",
  // SerialGC does shrink the heap after a spike (world generation, chunk loading), but only down to
  // these ratios. Without them an idle small server keeps holding everything it ever touched.
  "-XX:MinHeapFreeRatio=20",
  "-XX:MaxHeapFreeRatio=40",
  "-XX:MaxMetaspaceSize=192M",
  "-XX:ReservedCodeCacheSize=96M",
  "-XX:MaxDirectMemorySize=128M",
  "-Dio.netty.maxDirectMemory=134217728",
].join(" ");

export const JVM_PRESETS: JvmPreset[] = [
  {
    id: "aikar",
    label: "Aikar's flags (G1GC, recommended)",
    summary:
      "G1GC tuned for Minecraft's allocation pattern: 200 ms pause target, 30–40 % young generation, "
      + "explicit GC disabled, metaspace capped. Best all-round choice from ~1.5 GB upwards.",
    flags: AIKAR_FLAGS,
    software: ["paper", "purpur", "folia", "vanilla", "fabric", "quilt", "forge", "neoforge"],
    recommended: true,
  },
  {
    id: "proxy",
    label: "Proxy tuning (Velocity / BungeeCord)",
    summary:
      "Small-heap G1GC set for proxies: 4 MB heap regions, inlining depth 15, no explicit GC. "
      + "Proxies do not load worlds, so Aikar's young-generation tuning just adds overhead.",
    flags: PROXY_FLAGS,
    software: ["velocity", "bungeecord", "waterfall"],
  },
  {
    id: "lowmem",
    label: "Low memory (SerialGC, < 1.5 GB heap)",
    summary:
      "SerialGC plus explicit metaspace/code-cache/direct-memory caps: the smallest real footprint, "
      + "so a small server does not slowly grow into the whole box. Best below ~1.5 GB.",
    flags: LOW_MEMORY_FLAGS,
    software: ["paper", "purpur", "folia", "vanilla", "fabric", "quilt", "velocity", "bungeecord", "waterfall"],
  },
  {
    id: "custom",
    label: "Custom",
    summary: "Your own flags. RSLMC still adds -Xms/-Xmx from the memory allocation.",
    flags: "",
    software: [],
  },
];

const PROXY_SOFTWARE: ServerSoftwareId[] = ["velocity", "bungeecord", "waterfall"];

export {
  heapMbFor, overheadMbFor, initialHeapMbFor, allocationAdvice,
  JVM_RUNTIME_OVERHEAD_MIN_MB, JVM_RUNTIME_OVERHEAD_MAX_MB,
} from "../shared/memory";

export function isProxySoftware(software: ServerSoftwareId): boolean {
  return PROXY_SOFTWARE.includes(software);
}

/** Flags a new server of this software gets unless the user asks for something else. */
export function defaultJvmArgsFor(software: ServerSoftwareId, memoryMb?: number): string {
  if (isProxySoftware(software)) return PROXY_FLAGS;
  // Below 1.5 GB, G1's remembered sets cost more than they save; SerialGC keeps the footprint flat.
  if (typeof memoryMb === "number" && memoryMb < 1536) return LOW_MEMORY_FLAGS;
  return AIKAR_FLAGS;
}

function normalise(flags: string): string {
  return flags.split(/\s+/).map((part) => part.trim()).filter(Boolean).sort().join(" ");
}

/** Which preset the stored flags correspond to (so the UI can show it honestly). */
export function detectJvmPreset(flags: string | null | undefined): JvmPresetId {
  const value = normalise(flags ?? "");
  if (!value) return "custom";
  if (value === normalise(AIKAR_FLAGS)) return "aikar";
  if (value === normalise(PROXY_FLAGS)) return "proxy";
  if (value === normalise(LOW_MEMORY_FLAGS)) return "lowmem";
  return "custom";
}

export function presetById(id: string): JvmPreset | null {
  return JVM_PRESETS.find((preset) => preset.id === id) ?? null;
}
