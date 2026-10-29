import { badRequest } from "../shared/http";

/** Argon2id via Bun's native password API — no plaintext password ever touches storage. */
export const hashPassword = (password: string): Promise<string> =>
  Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });

export const verifyPassword = (password: string, hash: string): Promise<boolean> =>
  Bun.password.verify(password, hash).catch(() => false);

export interface PasswordPolicyResult { ok: boolean; problems: string[] }

export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  const problems: string[] = [];
  if (password.length < 10) problems.push("Must be at least 10 characters long.");
  if (password.length > 200) problems.push("Must be shorter than 200 characters.");
  if (!/[a-z]/.test(password)) problems.push("Must contain a lowercase letter.");
  if (!/[A-Z]/.test(password)) problems.push("Must contain an uppercase letter.");
  if (!/[0-9]/.test(password)) problems.push("Must contain a number.");
  if (!/[^A-Za-z0-9]/.test(password)) problems.push("Must contain a symbol.");
  if (/^(admin|password|rslmc|letmein|qwerty)/i.test(password)) problems.push("Must not start with a common password word.");
  return { ok: problems.length === 0, problems };
}

export function assertPasswordPolicy(password: string): void {
  const result = checkPasswordPolicy(password);
  if (!result.ok) throw badRequest("Password does not meet the security requirements.", result.problems);
}
