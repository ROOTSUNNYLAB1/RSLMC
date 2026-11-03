import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/g, "").toUpperCase().replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) throw new Error("Invalid base32 input");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret: string, counter?: number): string {
  const step = counter ?? Math.floor(Date.now() / 30000);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

/** The step whose code matched, or `null`. Tolerates one step of clock skew either way. */
export function matchingTotpStep(secret: string, token: string, now = Date.now()): number | null {
  const normalized = token.replace(/\s/g, "");
  if (!/^\d{6}$/.test(normalized)) return null;
  const step = Math.floor(now / 30000);
  for (const offset of [-1, 0, 1]) {
    if (totpCode(secret, step + offset) === normalized) return step + offset;
  }
  return null;
}

/** Accepts the current step plus one before/after to tolerate clock skew. */
export function verifyTotp(secret: string, token: string): boolean {
  return matchingTotpStep(secret, token) !== null;
}

/**
 * Recovery codes, compared in constant time and matched case/format-insensitively.
 *
 * These were generated, stored and displayed but never checked anywhere, so an operator who lost
 * their authenticator had no way back in — a feature the UI promised and the code did not have.
 */
export function normaliseRecoveryCode(input: string): string {
  return input.replace(/[^0-9a-zA-Z]/g, "").toLowerCase();
}

export function recoveryCodeMatches(stored: string[], input: string): string | null {
  const wanted = Buffer.from(normaliseRecoveryCode(input));
  if (wanted.length === 0) return null;
  for (const candidate of stored) {
    const value = Buffer.from(normaliseRecoveryCode(candidate));
    if (value.length !== wanted.length) continue;
    if (timingSafeEqual(value, wanted)) return candidate;
  }
  return null;
}

export function otpauthUrl(secret: string, username: string, issuer = "RSLMC"): string {
  const label = encodeURIComponent(`${issuer}:${username}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString("hex");
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
  });
}
