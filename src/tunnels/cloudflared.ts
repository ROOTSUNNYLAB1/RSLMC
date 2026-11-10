import { chmodSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PATHS, hostPlatform } from "../shared/config";

/*
 * The `cloudflared` binary.
 *
 * A Cloudflare Tunnel needs one program on the machine that owns the server: `cloudflared`. It makes an
 * *outbound* connection to Cloudflare and Cloudflare forwards requests back down it — which is the whole
 * reason this is useful for a node. A node that sits behind CGNAT, a home router, or a provider that
 * blocks inbound ports has no way to be reached at `node.example.com` by opening anything; it has to
 * dial out. That is exactly what a tunnel does.
 *
 * The binary is looked up in three places, in order, and the panel always reports which one it used:
 *   1. `RSLMC_CLOUDFLARED_PATH`, for operators who manage their own build;
 *   2. `<data>/bin/cloudflared`, the copy this panel downloaded;
 *   3. `PATH`, for a distro package.
 *
 * What "verified" means here, honestly: Cloudflare publishes these binaries only over TLS from
 * `github.com/cloudflare/cloudflared` (there is no published checksum file for the latest-download
 * shortcut), so the panel verifies what it *can*: the download must be non-trivial in size, it must be
 * executable, and it must print a version when asked. If any of those fail the file is deleted and the
 * failure is reported — the panel never keeps a half-downloaded binary and never claims a signature
 * check it did not perform.
 */

export interface CloudflaredInfo {
  /** Absolute path, or null when nothing usable was found. */
  path: string | null;
  /** Version string as the binary reported it (e.g. "2026.10.7"), or null. */
  version: string | null;
  /** Where it came from: an env override, the panel's own copy, the system PATH, or nowhere. */
  source: "env" | "managed" | "path" | "missing";
  /** Why it is missing, when it is. */
  problem: string | null;
  /** Size of the binary in bytes, for the UI. */
  sizeBytes: number | null;
  /** Where the panel would download its own copy to. */
  installPath: string;
  /** True when the panel can install one (the platform is one Cloudflare publishes builds for). */
  installable: boolean;
}

const MIN_PLAUSIBLE_BYTES = 5 * 1024 * 1024; // the real binary is ~40 MB; a redirect page is ~1 KB

export function managedBinaryPath(): string {
  const suffix = process.platform === "win32" ? ".exe" : "";
  return join(PATHS.data, "bin", `cloudflared${suffix}`);
}

/** The asset name Cloudflare publishes for this machine, or null when there is no build for it. */
export function downloadAssetName(): string | null {
  const { os, arch } = hostPlatform();
  if (os === "windows") return arch === "arm64" ? "cloudflared-windows-arm64.exe" : "cloudflared-windows-amd64.exe";
  if (os === "darwin") return arch === "arm64" ? "cloudflared-darwin-arm64.tgz" : "cloudflared-darwin-amd64.tgz";
  if (os === "linux") return arch === "arm64" ? "cloudflared-linux-arm64" : "cloudflared-linux-amd64";
  return null;
}

export function downloadUrl(): string | null {
  const asset = downloadAssetName();
  if (!asset) return null;
  return `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
}

/** Runs `cloudflared --version` and returns what it printed, or null. Bounded, no shell. */
export function probeVersion(binary: string, timeoutMs = 8000): string | null {
  try {
    const result = Bun.spawnSync({ cmd: [binary, "--version"], stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    if (result.exitCode !== 0) return null;
    const text = `${result.stdout?.toString() ?? ""} ${result.stderr?.toString() ?? ""}`.trim();
    // "cloudflared version 2026.10.7 (built 2026-10-30-17:05 UTC)" — the date is what people quote.
    const match = text.match(/version\s+([0-9]+\.[0-9]+\.[0-9]+)/i) ?? text.match(/([0-9]{4}\.[0-9]+\.[0-9]+)/);
    return match ? match[1] : text.split(/\s+/).slice(0, 3).join(" ") || null;
  } catch {
    return null;
  }
}

function sizeOf(path: string): number | null {
  try { return statSync(path).size; } catch { return null; }
}

/** Finds a usable binary and reports exactly how sure it is. */
export function cloudflaredInfo(): CloudflaredInfo {
  const installPath = managedBinaryPath();
  const installable = downloadAssetName() !== null;
  const candidates: Array<{ path: string; source: CloudflaredInfo["source"] }> = [];
  const fromEnv = (process.env.RSLMC_CLOUDFLARED_PATH ?? "").trim();
  if (fromEnv) candidates.push({ path: fromEnv, source: "env" });
  candidates.push({ path: installPath, source: "managed" });
  const onPath = Bun.which("cloudflared");
  if (onPath) candidates.push({ path: onPath, source: "path" });

  const problems: string[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) {
      if (candidate.source === "env") problems.push(`RSLMC_CLOUDFLARED_PATH points at ${candidate.path}, which does not exist.`);
      continue;
    }
    const version = probeVersion(candidate.path);
    if (!version) {
      problems.push(`${candidate.path} exists but did not answer \`--version\``);
      continue;
    }
    return {
      path: candidate.path,
      version,
      source: candidate.source,
      problem: problems.length > 0 ? problems.join("; ") : null,
      sizeBytes: sizeOf(candidate.path),
      installPath,
      installable,
    };
  }
  return {
    path: null,
    version: null,
    source: "missing",
    problem: problems.length > 0
      ? problems.join("; ")
      : installable
        ? "cloudflared is not installed on this machine. Cloudflare publishes a build for it — press Install."
        : `Cloudflare does not publish a cloudflared build for ${hostPlatform().label}. Download one from github.com/cloudflare/cloudflared and set RSLMC_CLOUDFLARED_PATH.`,
    sizeBytes: null,
    installPath,
    installable,
  };
}

export interface InstallResult {
  path: string;
  version: string;
  sizeBytes: number;
  /** What was and was not verified — printed in the UI, not hidden. */
  verification: string;
}

/**
 * Download the official build into `<data>/bin` and prove it runs.
 *
 * Written to a temporary name and renamed into place, so an interrupted download can never leave a
 * truncated `cloudflared` that the next start would try to execute.
 */
export async function installCloudflared(): Promise<InstallResult> {
  const url = downloadUrl();
  if (!url) throw new Error(`No cloudflared build is published for ${hostPlatform().label}.`);
  const target = managedBinaryPath();
  mkdirSync(join(PATHS.data, "bin"), { recursive: true });
  const staging = `${target}.part`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Cloudflare's download answered HTTP ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < MIN_PLAUSIBLE_BYTES) {
    throw new Error(
      `The download was only ${bytes.byteLength} bytes, which is not a cloudflared binary (the real one is about 40 MB). Nothing was installed.`,
    );
  }
  writeFileSync(staging, bytes);
  chmodSync(staging, 0o755);
  const version = probeVersion(staging);
  if (!version) {
    try { unlinkSync(staging); } catch { /* nothing to clean */ }
    throw new Error("The downloaded file does not run on this machine, so it was deleted instead of installed.");
  }
  renameSync(staging, target);
  chmodSync(target, 0o755);
  return {
    path: target,
    version,
    sizeBytes: sizeOf(target) ?? bytes.byteLength,
    verification:
      "Downloaded over TLS from github.com/cloudflare/cloudflared and verified by running `cloudflared --version`. "
      + "Cloudflare does not publish a checksum file for this shortcut URL, so no signature is claimed here.",
  };
}
