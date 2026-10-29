/** In-memory sliding-window rate limiter (per-process, sufficient for a single panel). */
interface Bucket { hits: number[] }

const buckets = new Map<string, Bucket>();
const MAX_KEYS = 20_000;

export interface RateLimitResult { allowed: boolean; remaining: number; retryAfterSeconds: number }

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  if (buckets.size > MAX_KEYS) buckets.clear();
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
