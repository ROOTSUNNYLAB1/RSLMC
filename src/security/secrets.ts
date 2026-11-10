import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { loadAppSecret } from "../shared/config";

/*
 * Secrets the panel must be able to *use* later, not just compare.
 *
 * Passwords are hashed; an agent key is compared by hash. A Cloudflare tunnel token is different: the
 * panel has to hand the exact string to `cloudflared` on every start, so it cannot be hashed — it has
 * to be readable. Readable means it must not sit in SQLite as plain text, because a database copy
 * (a backup, a support bundle, a stolen disk) would otherwise contain live credentials for someone's
 * Cloudflare account.
 *
 * So: AES-256-GCM, key derived from the panel secret (`RSLMC_SECRET` or `<data>/secrets/panel.key`,
 * 0600). GCM is authenticated: a tampered ciphertext fails to open instead of decrypting to garbage.
 * The key never enters the database, so a dumped `.db` alone is useless for offline decryption — the
 * same reasoning as the hashed agent keys next door.
 *
 * Format: `v1:<iv-b64>:<tag-b64>:<ciphertext-b64>`. The version tag is there so a future
 * key-rotation or algorithm change can be recognised instead of guessed at.
 */

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the size GCM is defined for
const KEY_SALT = "rslmc:sealed-secret:v1";

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (!cachedKey) cachedKey = scryptSync(loadAppSecret(), KEY_SALT, 32);
  return cachedKey;
}

/** True when this string looks like something `sealSecret()` produced. */
export function isSealedSecret(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(`${VERSION}:`) && value.split(":").length === 4;
}

/** Encrypt a secret for storage. Returns null for an empty input, so "not set" stays "not set". */
export function sealSecret(plain: string | null | undefined): string | null {
  const value = (plain ?? "").trim();
  if (!value) return null;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

/**
 * Decrypt a stored secret. Returns null when the value is missing, malformed, or fails authentication
 * (wrong key, edited row) — the caller then reports "no usable token" instead of sending garbage to
 * `cloudflared` and blaming Cloudflare for the resulting error.
 */
export function openSecret(sealed: string | null | undefined): string | null {
  if (!isSealedSecret(sealed)) return null;
  const [, ivPart, tagPart, dataPart] = sealed!.split(":");
  try {
    const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivPart, "base64"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(dataPart, "base64")), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * A short, non-reversible fingerprint of a secret, for the UI: "token stored (a1b2c3…)". Lets an
 * operator tell two tokens apart — and tell "the right token is stored" from "someone pasted another
 * one" — without ever sending the token back to a browser.
 */
export function secretFingerprint(sealed: string | null | undefined): string | null {
  if (!isSealedSecret(sealed)) return null;
  const plain = openSecret(sealed);
  if (!plain) return null;
  // Not the panel secret: a plain hash of the *token* would let anyone who reads the database test
  // guesses. This is only an identifier, so a truncated hash of the ciphertext is enough.
  return sealed!.split(":").pop()!.replace(/[^0-9a-zA-Z]/g, "").slice(-8);
}

/** Test hook: forget the derived key (used when a test changes RSLMC_SECRET). */
export function resetSecretKeyCache(): void {
  cachedKey = null;
}
