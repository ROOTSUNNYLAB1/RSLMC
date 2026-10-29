/**
 * Maps a Minecraft release to the Java major version it requires.
 * Paper's API publishes an authoritative minimum for its projects; this table is the
 * fallback for vanilla-derived software and for offline planning.
 */
export function javaMajorForMcVersion(mcVersion: string): number {
  const version = mcVersion.trim();
  // Modern (2026+) versioning scheme, e.g. "26.3" — Mojang's first release needing Java 25.
  if (/^\d{2}\./.test(version)) {
    const major = Number(version.split(".")[0]);
    if (major >= 26) return 25;
    if (major >= 25) return 21;
  }
  const match = /^1\.(\d+)(?:\.(\d+))?/.exec(version);
  if (!match) return 21;
  const minor = Number(match[1]);
  const patch = Number(match[2] ?? 0);
  if (minor >= 20 && (minor > 20 || patch >= 5)) return 21; // 1.20.5+
  if (minor >= 18) return 17;                               // 1.18 – 1.20.4
  if (minor === 17) return 16;                              // 1.17
  return 8;                                                 // 1.16.5 and older
}

export function javaMajorLabel(major: number): string {
  return `Java ${major} (Eclipse Temurin)`;
}

/** Sanity check used by the API before starting a server. */
export function javaCompatible(
  mcVersion: string,
  selectedMajor: number,
): { ok: boolean; note: string; required: number } {
  const required = javaMajorForMcVersion(mcVersion);
  if (selectedMajor === required) return { ok: true, required, note: `Matches the requirement for Minecraft ${mcVersion}.` };
  if (selectedMajor > required) {
    return { ok: true, required, note: `Newer than the minimum (Java ${required}) — usually fine for this version.` };
  }
  return {
    ok: false, required,
    note: `Minecraft ${mcVersion} requires at least Java ${required}; Java ${selectedMajor} will likely fail to start.`,
  };
}
