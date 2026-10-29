/** Secret redaction for logs, audit metadata and API payloads. */
const SECRET_KEYS = [
  "password", "passwd", "secret", "token", "csrf", "authorization", "totp", "apikey", "api_key",
  "rcon_password", "rconPassword", "agent_secret", "agentSecret", "recovery", "cookie",
];

export function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_KEYS.some((needle) => lower.includes(needle));
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 6 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1)) as unknown as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? "[redacted]" : redact(val, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** Removes known secret literals (RCON passwords, tokens) from console/log text. */
export function scrubSecrets(text: string, secrets: (string | null | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    out = out.split(secret).join("••••••••");
  }
  return out;
}
