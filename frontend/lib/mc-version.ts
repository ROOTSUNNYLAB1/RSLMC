/**
 * Minecraft version helpers for the marketplace tables.
 *
 * Modrinth returns `game_versions` in ascending order (oldest first, e.g. `["1.8", "1.8.1", …,
 * "1.21.9"]`), so naively taking the first four entries showed "1.8, 1.8.1, 1.8.2, 1.8.3" for almost
 * every project — technically not a lie, but useless: it never told an operator whether the build
 * runs on *their* server. These helpers sort properly and describe the support range instead.
 */

export function compareMcVersions(a: string, b: string): number {
  const pa = a.split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = b.split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}

export interface GameVersionSummary {
  /** True when the build lists the server's own Minecraft version. */
  supportsCurrent: boolean;
  /** Newest version the build supports (null when the list is empty). */
  newest: string | null;
  /** Oldest version the build supports. */
  oldest: string | null;
  /** Newest entries, newest first — used for a compact preview. */
  recent: string[];
  total: number;
  /** Human description, e.g. `1.8 – 1.21.9 · 34 versions`. */
  range: string;
}

export function summariseGameVersions(versions: string[] | undefined, current?: string | null): GameVersionSummary {
  const list = [...new Set((versions ?? []).filter((value) => typeof value === "string" && value.trim() !== ""))]
    .sort(compareMcVersions);
  const total = list.length;
  const newest = total ? list[total - 1]! : null;
  const oldest = total ? list[0]! : null;
  const supportsCurrent = Boolean(current && list.includes(current));
  const range = total === 0
    ? "—"
    : total === 1
      ? newest!
      : `${oldest} – ${newest}`;
  return {
    supportsCurrent,
    newest,
    oldest,
    recent: [...list].reverse().slice(0, 3),
    total,
    range,
  };
}

/** `paper, purpur, spigot +5` — long loader lists are not readable in a table cell. */
export function summariseLoaders(loaders: string[] | undefined, preview = 3): { shown: string; hidden: string[] } {
  const list = (loaders ?? []).filter(Boolean);
  if (list.length <= preview) return { shown: list.join(", ") || "—", hidden: [] };
  return { shown: `${list.slice(0, preview).join(", ")}`, hidden: list.slice(preview) };
}
