/*
 * A CalVer version is a date, so it can be wrong in a way a semver cannot: it can be *in the future*.
 *
 * That is not theoretical. Release 2026.11.05.1 was cut on 4 November 2026 because the date was typed by
 * hand; the panel then showed a build "from tomorrow", the update checker compared it against a later
 * release and concluded the panel was ahead of itself. Nothing caught it, because every test only asks
 * whether the string looks like a CalVer — not whether the date is real.
 */

export interface CalVerParts {
  year: number;
  month: number;
  day: number;
  build: number;
}

export function parseCalVerParts(version: string): CalVerParts | null {
  const match = /^(\d{4})\.(\d{2})\.(\d{2})(?:\.(\d+))?$/.exec(version.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const build = Number(match[4] ?? 1);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject impossible dates such as 2026.02.31 instead of silently rolling over.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day, build };
}

/** Whole days from `a` to `b`, both read as calendar dates in UTC. */
export function daysBetween(a: CalVerParts, b: CalVerParts): number {
  const first = Date.UTC(a.year, a.month - 1, a.day);
  const second = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((second - first) / 86_400_000);
}

/**
 * How far ahead of `today` the version's date is, in days (negative when it is in the past).
 *
 * One day of slack is allowed: a release cut at 02:00 IST is still "yesterday" in UTC, and a maintainer
 * who works past midnight should not be told their version is wrong. Two days ahead is a typo.
 */
export function daysAheadOfToday(version: string, today = new Date()): number | null {
  const parts = parseCalVerParts(version);
  if (!parts) return null;
  const todayParts: CalVerParts = {
    year: today.getUTCFullYear(),
    month: today.getUTCMonth() + 1,
    day: today.getUTCDate(),
    build: 1,
  };
  return daysBetween(todayParts, parts);
}
