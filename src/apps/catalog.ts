import { hostPlatform } from "../shared/config";
import { fetchJson } from "../services/download";

/*
 * Non-Minecraft runtimes: Python 3 and Node.js.
 *
 * RSLMC started as a Minecraft panel, but a small VPS usually hosts more than one thing, and "run this
 * Discord bot / Flask app with the same limits, console, files and backups" is the request that follows.
 * These are first-class software entries in the wizard, not a side door: they get the same allocation,
 * the same kernel-enforced limits, the same console and the same file manager.
 *
 * Two rules shaped this module:
 *
 *   1. **Real versions, from the projects that publish them.** Node comes from `nodejs.org/dist/index.json`
 *      (the official index, with its LTS flags). Python comes from `python-build-standalone`, the
 *      relocatable CPython builds that need no compiler and no system packages — the same builds the uv
 *      project ships.
 *   2. **No invented version numbers.** A version is offered only after a download URL for *this*
 *      machine's platform exists. Nothing here guesses "3.13 should exist by now".
 */

export type AppFamily = "python" | "node";

export interface AppDefinition {
  family: AppFamily;
  /** Shown in the wizard and on the server page. */
  name: string;
  /** How the version is labelled, e.g. "Python 3.12.7". */
  versionLabel: string;
  /** The binary that runs the entry file. */
  binary: string;
  /** Convenience file the panel scaffolds when the folder is empty. */
  entryFile: string;
  /** npm / pip live next to the interpreter and are put on PATH for the server. */
  packageManager: string;
  docsUrl: string;
  source: string;
  description: string;
}

export const APP_FAMILIES: Record<AppFamily, AppDefinition> = {
  python: {
    family: "python",
    name: "Python 3",
    versionLabel: "Python",
    binary: "python3",
    entryFile: "main.py",
    packageManager: "pip",
    docsUrl: "https://docs.python.org/3/",
    source: "python-build-standalone (astral-sh)",
    description: "Relocatable CPython build with pip. No compiler or system packages needed.",
  },
  node: {
    family: "node",
    name: "Node.js",
    versionLabel: "Node",
    binary: "node",
    entryFile: "index.js",
    packageManager: "npm",
    docsUrl: "https://nodejs.org/docs/latest/api/",
    source: "nodejs.org/dist",
    description: "Official Node.js build with npm on PATH. Runs bots, APIs and small web apps.",
  },
};

export function isAppSoftware(id: string): id is AppFamily {
  return id === "python" || id === "node";
}

export interface AppVersion {
  /** Exact version, e.g. "3.12.7" or "22.11.0" (no leading "v"). */
  version: string;
  /** Major line for grouping ("3.12", "22"). */
  line: string;
  /** True for a Node LTS line or a Python version still receiving security fixes. */
  lts: boolean;
  /** Epoch ms when upstream published it, when known. */
  releasedAt: number | null;
  /** Set when this exact version cannot be installed on this machine, with the reason. */
  unavailableReason?: string;
  /** Where it comes from, for the honest "Sources" line in the UI. */
  source: string;
}

export interface AppDownload {
  url: string;
  fileName: string;
  /** Absolute install root inside the tarball, e.g. "python/" or "node-v22.11.0-linux-x64/". */
  archiveRoot: string;
  /** URL of the upstream checksum file, when the project publishes one. */
  checksumUrl: string | null;
  version: string;
}

/* ------------------------------------------------------------------ */
/* Node.js — the official index                                        */
/* ------------------------------------------------------------------ */

interface NodeIndexEntry {
  version: string;
  date: string;
  files: string[];
  lts: string | false;
  npm?: string;
}

let nodeCache: { at: number; versions: AppVersion[]; index: NodeIndexEntry[] } | null = null;
let pythonCache: { at: number; versions: AppVersion[] } | null = null;
const NODE_TTL_MS = 30 * 60_000;

async function nodeIndex(): Promise<NodeIndexEntry[]> {
  if (nodeCache && Date.now() - nodeCache.at < NODE_TTL_MS) return nodeCache.index;
  const entries = await fetchJson<NodeIndexEntry[]>("https://nodejs.org/dist/index.json", 20_000);
  nodeCache = { at: Date.now(), versions: nodeCache?.versions ?? [], index: entries };
  return entries;
}

/**
 * Every Node line that still makes sense to run, newest first.
 *
 * One entry per major line (the newest patch of each) — a list of 878 patches is not a choice, it is a
 * wall. Pre-releases (`-alpha`, `-rc`) are dropped: an operator picking a version wants a stable one.
 * Lines older than 16 are shown but marked, because "run my old bot" is a real reason to want one and a
 * silent absence is worse than an honest label.
 */
export async function listNodeVersions(): Promise<AppVersion[]> {
  const entries = await nodeIndex();
  const byLine = new Map<string, NodeIndexEntry>();
  for (const entry of entries) {
    if (!/^v\d+\.\d+\.\d+$/.test(entry.version)) continue;
    const line = entry.version.slice(1).split(".").slice(0, 1)[0]!;
    if (!byLine.has(line)) byLine.set(line, entry);        // the index is newest-first
  }
  const platform = hostPlatform();
  return [...byLine.entries()]
    .map(([line, entry]) => {
      const version = entry.version.slice(1);
      const files = entry.files ?? [];
      const wanted = platform.os === "windows" ? "win-x64-zip"
        : `linux-${platform.arch}`;
      const unavailableReason = platform.os === "darwin"
        ? "macOS hosts are not a supported server platform"
        : files.includes(wanted) ? undefined : `nodejs.org publishes no ${wanted} build for this version`;
      return {
        version,
        line,
        lts: Boolean(entry.lts),
        releasedAt: entry.date ? Date.parse(entry.date) : null,
        unavailableReason,
        source: "nodejs.org/dist",
      } satisfies AppVersion;
    })
    .sort((a, b) => Number(b.line) - Number(a.line));
}

export async function resolveNodeDownload(version: string): Promise<AppDownload> {
  const clean = version.replace(/^v/, "");
  const platform = hostPlatform();
  const arch = platform.arch === "arm64" ? "arm64" : "x64";
  if (platform.os === "windows") {
    return {
      url: `https://nodejs.org/dist/v${clean}/node-v${clean}-win-${arch}.zip`,
      fileName: `node-v${clean}-win-${arch}.zip`,
      archiveRoot: `node-v${clean}-win-${arch}`,
      checksumUrl: `https://nodejs.org/dist/v${clean}/SHASUMS256.txt`,
      version: clean,
    };
  }
  return {
    url: `https://nodejs.org/dist/v${clean}/node-v${clean}-linux-${arch}.tar.gz`,
    fileName: `node-v${clean}-linux-${arch}.tar.gz`,
    archiveRoot: `node-v${clean}-linux-${arch}`,
    checksumUrl: `https://nodejs.org/dist/v${clean}/SHASUMS256.txt`,
    version: clean,
  };
}

/* ------------------------------------------------------------------ */
/* Python — python-build-standalone                                    */
/* ------------------------------------------------------------------ */

interface PythonAsset {
  version: string;
  /** Repo-relative path, e.g. `astral-sh/…/releases/download/<tag>/<file>`. */
  assetPath: string;
  tag: string;
}

let pythonTagCache: { at: number; tags: string[] } | null = null;
const pythonAssetCache = new Map<string, { at: number; assets: string[] }>();
const PYTHON_TTL_MS = 30 * 60_000;

/**
 * The release tags of python-build-standalone, newest first.
 *
 * There is no version index for this project, so the tags are read the way a browser reads them: the
 * atom feed. No token, no API quota — which matters on machines where `api.github.com` is rate limited.
 */
async function pythonTags(): Promise<string[]> {
  if (pythonTagCache && Date.now() - pythonTagCache.at < PYTHON_TTL_MS) return pythonTagCache.tags;
  const feed = await fetch("https://github.com/astral-sh/python-build-standalone/releases.atom", {
    headers: { "user-agent": "rslmc" }, signal: AbortSignal.timeout(20_000),
  }).then((response) => response.text());
  const tags: string[] = [];
  for (const match of feed.matchAll(/\/releases\/tag\/(\d{8})/g)) {
    if (!tags.includes(match[1]!)) tags.push(match[1]!);
  }
  if (tags.length === 0) throw new Error("No python-build-standalone releases could be listed");
  pythonTagCache = { at: Date.now(), tags };
  return tags;
}

/** The `install_only` archives of one release, cached per tag. */
async function pythonAssets(tag: string): Promise<string[]> {
  const hit = pythonAssetCache.get(tag);
  if (hit && Date.now() - hit.at < PYTHON_TTL_MS) return hit.assets;
  const html = await fetch(`https://github.com/astral-sh/python-build-standalone/releases/expanded_assets/${tag}`, {
    headers: { "user-agent": "rslmc" }, signal: AbortSignal.timeout(25_000),
  }).then((response) => response.text()).catch(() => "");
  const assets: string[] = [];
  for (const match of html.matchAll(/href="([^"]*cpython-[^"]*install_only\.tar\.gz)"/g)) {
    assets.push(match[1]!.replace(/^\//, ""));
  }
  pythonAssetCache.set(tag, { at: Date.now(), assets });
  return assets;
}

/**
 * The newest build of every Python minor line that is still published.
 *
 * A single release does not carry every line: upstream drops a line from its build matrix as soon as it
 * is end-of-life, so 3.10 disappeared from the newest tag while it is still perfectly installable from
 * the last tag that built it. A panel that only read the newest tag would silently hide Python 3.10 —
 * and "all versions" then means "whatever the newest tag happens to contain", which is not the promise.
 *
 * So the tags are walked newest-first and the first build of each line wins. The walk stops once the
 * lines stop growing (or after ten tags), so the usual case costs one or two requests.
 */
async function pythonIndex(): Promise<{ byLine: Map<string, PythonAsset>; scanned: string[] }> {
  const tags = await pythonTags();
  const triple = pythonTriple();
  const byLine = new Map<string, PythonAsset>();
  const scanned: string[] = [];

  const merge = (tag: string, assets: string[]): number => {
    let added = 0;
    for (const asset of assets) {
      if (!asset.includes(triple)) continue;
      const parsed = parsePythonAsset(asset);
      if (!parsed) continue;
      const minor = parsed.version.split(".").slice(0, 2).join(".");
      const existing = byLine.get(minor);
      if (!existing || compareVersions(parsed.version, existing.version) > 0) {
        byLine.set(minor, { version: parsed.version, assetPath: asset, tag });
        added += 1;
      }
    }
    return added;
  };

  /*
   * Walk the newest releases until every line a panel should offer (3.9 … 3.15) is represented.
   *
   * Upstream drops a line from its build matrix the moment it goes end-of-life, so 3.10 lives only in
   * older tags — reading the newest release alone silently hides it. The second batch is fetched in
   * parallel because it is the common case (newest tag carries 3.11+ only); a tag that publishes no
   * install_only archive at all contributes nothing and must not end the search.
   */
  const first = tags.slice(0, 1);
  for (const tag of first) {
    scanned.push(tag);
    merge(tag, await pythonAssets(tag));
  }
  if (byLine.size < 7) {
    const batch = tags.slice(1, 8);
    const results = await Promise.all(batch.map(async (tag) => [tag, await pythonAssets(tag)] as const));
    for (const [tag, assets] of results) {
      scanned.push(tag);
      merge(tag, assets);
    }
  }
  if (byLine.size === 0) {
    throw new Error(`python-build-standalone publishes no ${triple} builds the panel could find`);
  }
  return { byLine, scanned };
}

/** The target triple this machine needs, in python-build-standalone's spelling. */
export function pythonTriple(): string {
  const platform = hostPlatform();
  if (platform.os === "windows") return platform.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  if (platform.os === "darwin") return platform.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  return platform.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
}

/** `cpython-3.12.7+20261026-x86_64-unknown-linux-gnu-install_only.tar.gz` → parts. */
export function parsePythonAsset(assetPath: string): { version: string; assetPath: string; tag: string } | null {
  /*
   * The triple is three *or* four dash-separated parts (`aarch64-apple-darwin` vs
   * `x86_64-unknown-linux-gnu`), which is exactly the kind of detail a too-strict pattern turns into
   * "no Python versions available".
   */
  const match = /cpython-(\d+\.\d+\.\d+)\+(\d{8})-([a-z0-9_]+(?:-[a-z0-9_]+){2,3})-install_only\.tar\.gz$/.exec(assetPath);
  if (!match) return null;
  return { version: match[1]!, tag: match[2]!, assetPath };
}

/**
 * The Python versions available for this machine — newest build of every published minor line.
 *
 * Lines older than 3.9 are listed with a reason rather than hidden: an operator with a legacy app needs
 * to know *why* it is not on the list.
 */
export async function listPythonVersions(): Promise<AppVersion[]> {
  const { byLine } = await pythonIndex();
  return [...byLine.entries()]
    .map(([line, asset]) => {
      const [major, minor] = line.split(".").map(Number) as [number, number];
      const supported = major === 3 && minor >= 9;
      const tagDate = `${asset.tag.slice(0, 4)}-${asset.tag.slice(4, 6)}-${asset.tag.slice(6, 8)}`;
      return {
        version: asset.version,
        line,
        lts: supported,
        releasedAt: Date.parse(tagDate) || null,
        unavailableReason: supported ? undefined : `Python ${line} is end-of-life upstream; use a supported line`,
        source: `python-build-standalone ${asset.tag}`,
      } satisfies AppVersion;
    })
    .sort((a, b) => compareVersions(b.version, a.version));
}

export async function resolvePythonDownload(version: string): Promise<AppDownload> {
  const { byLine } = await pythonIndex();
  for (const asset of byLine.values()) {
    if (asset.version === version) {
      return {
        url: `https://github.com/${asset.assetPath}`,
        fileName: asset.assetPath.split("/").pop()!,
        // python-build-standalone's install_only tarball unpacks to a single `python/` directory.
        archiveRoot: "python",
        checksumUrl: `https://github.com/${asset.assetPath}.sha256`,
        version,
      };
    }
  }
  throw new Error(`python-build-standalone does not publish CPython ${version} for ${pythonTriple()}`);
}

/* ------------------------------------------------------------------ */
/* Shared                                                              */
/* ------------------------------------------------------------------ */

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Versions for one family, cached in memory for the life of the process entry. */
export async function listAppVersions(family: AppFamily): Promise<AppVersion[]> {
  if (family === "node") {
    if (nodeCache?.versions?.length && Date.now() - nodeCache.at < NODE_TTL_MS) return nodeCache.versions;
    const versions = await listNodeVersions();
    nodeCache = { at: Date.now(), versions, index: nodeCache?.index ?? [] };
    return versions;
  }
  if (pythonCache?.versions?.length && Date.now() - pythonCache.at < PYTHON_TTL_MS) return pythonCache.versions;
  const versions = await listPythonVersions();
  pythonCache = { at: Date.now(), versions };
  return versions;
}

export async function resolveAppDownload(family: AppFamily, version: string): Promise<AppDownload> {
  return family === "node" ? resolveNodeDownload(version) : resolvePythonDownload(version);
}

/** Everything the wizard needs in one call. Failures are reported, never faked. */
export async function describeApps(): Promise<Array<{
  family: AppFamily;
  name: string;
  description: string;
  binary: string;
  entryFile: string;
  packageManager: string;
  docsUrl: string;
  source: string;
  versions: AppVersion[];
  error: string | null;
}>> {
  const families: AppFamily[] = ["python", "node"];
  return Promise.all(families.map(async (family) => {
    const definition = APP_FAMILIES[family];
    try {
      return { ...definition, versions: await listAppVersions(family), error: null };
    } catch (error) {
      return {
        ...definition, versions: [], error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}
