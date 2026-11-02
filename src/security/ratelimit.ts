/** In-memory sliding-window rate limiter (per-process, sufficient for a single panel). */
interface Bucket { hits: number[] }

const buckets = new Map<string, Bucket>();
const MAX_KEYS = 20_000;

export interface RateLimitResult { allowed: boolean; remaining: number; retryAfterSeconds: number }

/**
 * Drops the oldest buckets when the map grows past the ceiling.
 *
 * `buckets.clear()` here wiped *every* counter — a global fail-open that a flood of distinct keys
 * (one per path/IP) could trigger on purpose, resetting the login and password-verification limits
 * along with everything else. Expired and least-recently-used entries go first instead.
 */
function evict(now: number): void {
  for (const [key, bucket] of buckets) {
    const newest = bucket.hits[bucket.hits.length - 1];
    if (newest === undefined || now - newest > 60 * 60 * 1000) buckets.delete(key);
  }
  if (buckets.size <= MAX_KEYS) return;
  // Still too many live keys: drop in insertion order (Map keeps it) until there is room.
  const excess = buckets.size - MAX_KEYS;
  let dropped = 0;
  for (const key of buckets.keys()) {
    buckets.delete(key);
    if (++dropped >= excess) break;
  }
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  if (buckets.size > MAX_KEYS) evict(now);
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { hits: [] };
    buckets.set(key, bucket);
  }
  bucket.hits = bucket.hits.filter((ts) => now - ts < windowMs);
  if (bucket.hits.length >= limit) {
    const oldest = bucket.hits[0]!;
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)) };
  }
  bucket.hits.push(now);
  return { allowed: true, remaining: limit - bucket.hits.length, retryAfterSeconds: 0 };
}

export function resetRateLimit(prefix: string): void {
  for (const key of buckets.keys()) if (key.startsWith(prefix)) buckets.delete(key);
}
