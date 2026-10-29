/**
 * Calendar versioning (CalVer) — `YYYY.MM.DD` with an optional same-day revision.
 *
 * RSLMC is a self-hosted panel that people upgrade whenever they feel like it, not on a promise of
 * "backwards compatible within 1.x". Calendar versions answer the only question an operator actually
 * asks — *how old is my panel?* — at a glance: `2026.10.29` is older than `2026.11.02` without
 * anybody having to remember what a major number meant.
 *
 * Accepted forms (a leading `v` and a `-suffix` are stripped):
 *
 *   2026.10.29          → 2026-10-29, revision 0
 *   2026.10.29.2        → 2026-10-29, revision 2  (second release of that day)
 *   v2026.10.29-beta.1  → 2026-10-29, revision 0, prerelease "beta.1"
 *
 * Comparison order: date, then revision, then stable > prerelease. Anything that is not a valid
 * CalVer string sorts *below* every valid one, so a typo in a tag can never look like an upgrade.
 */

export interface CalVer {
  year: number;
  month: number;
  day: number;
  /** Same-day revision, 0 when the version has none. */
  revision: number;
  /** e.g. "beta.1"; empty for a stable release. */
  prerelease: string;
  /** The normalised string this object came from, without a leading `v`. */
  raw: string;
}

const PATTERN = /^v?(\d{4})\.(\d{1,2})\.(\d{1,2})(?:\.(\d{1,3}))?(?:-([0-9A-Za-z.-]+))?$/;

/** Parses a CalVer string, returning null when it is not one. */
export function parseCalVer(input: string | null | undefined): CalVer | null {
  if (!input) return null;
  const trimmed = input.trim();
  const match = PATTERN.exec(trimmed);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const revision = match[4] ? Number(match[4]) : 0;
  return {
    year, month, day, revision,
    prerelease: (match[5] ?? "").toLowerCase(),
    raw: trimmed.replace(/^v/, ""),
  };
}

export function isCalVer(input: string | null | undefined): boolean {
  return parseCalVer(input) !== null;
}

/**
 * Returns a negative number when `a` is older than `b`, 0 when they are the same release and a
 * positive number when `a` is newer. Unparseable versions always lose.
 */
export function compareCalVer(a: string | null | undefined, b: string | null | undefined): number {
  const left = parseCalVer(a);
  const right = parseCalVer(b);
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  const dateLeft = left.year * 10_000 + left.month * 100 + left.day;
  const dateRight = right.year * 10_000 + right.month * 100 + right.day;
  if (dateLeft !== dateRight) return dateLeft < dateRight ? -1 : 1;
  if (left.revision !== right.revision) return left.revision < right.revision ? -1 : 1;
  // Same date and revision: a stable build is newer than any prerelease of it.
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/** True when `candidate` is a strictly newer release than `current`. */
export function isNewerCalVer(candidate: string | null | undefined, current: string | null | undefined): boolean {
  return compareCalVer(candidate, current) > 0;
}

/**
 * Suggests the version a release built *today* should carry. Used by `bun run release` and by the
 * panel when it reports its own build, so both agree on the scheme.
 */
export function todayCalVer(now = new Date(), revision = 0): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return revision > 0 ? `${year}.${month}.${day}.${revision}` : `${year}.${month}.${day}`;
}

/**
 * Human-readable age of a release, e.g. "released 3 days ago" — the About page uses it so an
 * operator can tell an update that landed this morning from one that has been waiting a month.
 */
export function describeReleaseAge(version: string, now = Date.now()): string | null {
  const parsed = parseCalVer(version);
  if (!parsed) return null;
  const released = Date.UTC(parsed.year, parsed.month - 1, parsed.day);
  const days = Math.floor((now - released) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? "a month ago" : `${months} months ago`;
  const years = Math.floor(months / 12);
  return years === 1 ? "a year ago" : `${years} years ago`;
}
