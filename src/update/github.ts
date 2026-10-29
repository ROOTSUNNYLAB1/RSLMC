import { isCalVer, parseCalVer } from "../shared/calver";

/**
 * Read-only GitHub client for the update checker.
 *
 * Everything here is unauthenticated public data: the panel never stores a GitHub token, and it
 * never needs one to answer "is there a newer release?". If the repository is private the check
 * fails and says so — the panel refuses to pretend it is up to date.
 *
 * `RSLMC_GITHUB_API` and `RSLMC_GITHUB_REPO` exist so the update flow can be exercised end-to-end
 * against a local fake (the test suite does exactly that) and so forks can check their own releases.
 */

export const DEFAULT_REPOSITORY = "ROOTSUNNYLAB1/RSLMC";

export interface GitHubReleaseAsset {
  name: string;
  /** Direct download URL (assets API) or a public source archive (tags fallback). */
  url: string;
  size: number;
  contentType: string;
}

export interface GitHubRelease {
  /** Normalised CalVer (no leading `v`), or the raw tag when it is not CalVer at all. */
  version: string;
  tag: string;
  name: string;
  notes: string;
  url: string;
  publishedAt: string | null;
  prerelease: boolean;
  draft: boolean;
  calver: boolean;
  assets: GitHubReleaseAsset[];
}

export interface RepositoryInfo {
  fullName: string;
  description: string | null;
  url: string;
  stars: number;
  forks: number;
  watchers: number;
  openIssues: number;
  license: string | null;
  defaultBranch: string;
  pushedAt: string | null;
  topics: string[];
  archived: boolean;
}

export class GitHubError extends Error {
  status: number;
  rateLimited: boolean;
  constructor(message: string, status = 0, rateLimited = false) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.rateLimited = rateLimited;
  }
}

export function repositorySlug(): string {
  const raw = (process.env.RSLMC_GITHUB_REPO ?? "").trim() || DEFAULT_REPOSITORY;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw) ? raw : DEFAULT_REPOSITORY;
}

function apiBase(): string {
  return ((process.env.RSLMC_GITHUB_API ?? "").trim() || "https://api.github.com").replace(/\/+$/, "");
}

export function repositoryUrl(): string {
  return `https://github.com/${repositorySlug()}`;
}

async function request<T>(path: string, init: { etag?: string | null; timeoutMs?: number } = {}): Promise<{ data: T; etag: string | null; notModified: boolean }> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "RSLMC-panel-update-check",
    "x-github-api-version": "2022-11-28",
  };
  if (init.etag) headers["if-none-match"] = init.etag;
  let response: Response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      headers,
      signal: AbortSignal.timeout(init.timeoutMs ?? 12_000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new GitHubError(`Could not reach GitHub (${reason}). The panel keeps working; only the update check failed.`);
  }
  if (response.status === 304) return { data: null as unknown as T, etag: init.etag ?? null, notModified: true };
  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = Number(response.headers.get("x-ratelimit-reset") ?? 0) * 1000;
    const when = reset > Date.now() ? ` Try again after ${new Date(reset).toISOString()}.` : "";
    throw new GitHubError(
      remaining === "0"
        ? `GitHub's unauthenticated API limit is used up.${when}`
        : "GitHub refused the update check (HTTP 403).",
      403,
      true,
    );
  }
  if (response.status === 404) {
    throw new GitHubError(
      `The repository ${repositorySlug()} was not found on GitHub (HTTP 404). `
      + "If it was renamed, update RSLMC_GITHUB_REPO.",
      404,
    );
  }
  if (!response.ok) throw new GitHubError(`GitHub replied HTTP ${response.status}.`, response.status);
  return { data: (await response.json()) as T, etag: response.headers.get("etag"), notModified: false };
}

interface RawAsset { name?: string; browser_download_url?: string; size?: number; content_type?: string }
interface RawRelease {
  tag_name?: string; name?: string; body?: string; html_url?: string; published_at?: string;
  prerelease?: boolean; draft?: boolean; assets?: RawAsset[];
}

function toRelease(raw: RawRelease): GitHubRelease {
  const tag = (raw.tag_name ?? "").trim();
  const version = tag.replace(/^v/i, "");
  const calver = isCalVer(version);
  return {
    version,
    tag,
    name: (raw.name ?? "").trim() || tag,
    notes: (raw.body ?? "").trim(),
    url: raw.html_url ?? repositoryUrl(),
    publishedAt: raw.published_at ?? null,
    prerelease: Boolean(raw.prerelease),
    draft: Boolean(raw.draft),
    calver,
    assets: (raw.assets ?? []).flatMap((asset) => {
      if (!asset.browser_download_url || !asset.name) return [];
      return [{
        name: asset.name,
        url: asset.browser_download_url,
        size: Number(asset.size ?? 0),
        contentType: asset.content_type ?? "application/octet-stream",
      }];
    }),
  };
}

/**
 * Releases, newest first. Drafts are dropped (nobody outside the repository can download them) and
 * prereleases are kept only when the operator opted in.
 */
export async function listReleases(options: { includePrerelease?: boolean; perPage?: number } = {}): Promise<GitHubRelease[]> {
  const perPage = Math.min(30, Math.max(1, options.perPage ?? 10));
  const { data } = await request<RawRelease[]>(`/repos/${repositorySlug()}/releases?per_page=${perPage}`);
  return (Array.isArray(data) ? data : [])
    .map(toRelease)
    .filter((release) => !release.draft && (options.includePrerelease || !release.prerelease))
    .filter((release) => release.version.length > 0);
}

/**
 * Fallback for repositories that publish git tags but no GitHub *releases*.
 *
 * A tag has no downloadable asset, so the source archive is used — that is the same tarball GitHub
 * serves from "Download ZIP", and it is what the installer verifies and swaps in.
 */
export async function listTags(perPage = 10): Promise<GitHubRelease[]> {
  const slug = repositorySlug();
  const { data } = await request<Array<{ name?: string; commit?: { sha?: string } }>>(`/repos/${slug}/tags?per_page=${perPage}`);
  return (Array.isArray(data) ? data : []).flatMap((tag) => {
    const name = (tag.name ?? "").trim();
    const version = name.replace(/^v/i, "");
    if (!version) return [];
    const ref = encodeURIComponent(name);
    return [{
      version,
      tag: name,
      name,
      notes: "",
      url: `https://github.com/${slug}/releases/tag/${ref}`,
      publishedAt: null,
      prerelease: false,
      draft: false,
      calver: isCalVer(version),
      assets: [{
        name: `${slug.split("/")[1]}-${version}.tar.gz`,
        url: `https://codeload.github.com/${slug}/tar.gz/refs/tags/${ref}`,
        size: 0,
        contentType: "application/gzip",
      }],
    }];
  });
}

/**
 * Releases plus the tag fallback, de-duplicated by version. Returned order is newest first by
 * CalVer, not by API order, so a mistagged old release can never be offered as an upgrade.
 */
export async function listAvailableVersions(options: { includePrerelease?: boolean } = {}): Promise<{ items: GitHubRelease[]; source: "releases" | "tags" }> {
  let items: GitHubRelease[] = [];
  let source: "releases" | "tags" = "releases";
  try {
    items = await listReleases(options);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) throw error;
    items = [];
  }
  if (items.length === 0) {
    items = await listTags();
    source = "tags";
  }
  const seen = new Set<string>();
  const unique = items.filter((release) => {
    if (seen.has(release.version)) return false;
    seen.add(release.version);
    return true;
  });
  unique.sort((a, b) => {
    const left = parseCalVer(a.version);
    const right = parseCalVer(b.version);
    if (left && right) {
      const delta = (right.year * 10_000 + right.month * 100 + right.day) - (left.year * 10_000 + left.month * 100 + left.day);
      return delta !== 0 ? delta : right.revision - left.revision;
    }
    if (left) return -1;
    if (right) return 1;
    return (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
  });
  return { items: unique, source };
}

/** Stars, forks, licence … for the About page. Cached by the caller; rate limits apply. */
export async function fetchRepositoryInfo(): Promise<RepositoryInfo> {
  const { data } = await request<Record<string, any>>(`/repos/${repositorySlug()}`);
  return {
    fullName: String(data.full_name ?? repositorySlug()),
    description: data.description ?? null,
    url: String(data.html_url ?? repositoryUrl()),
    stars: Number(data.stargazers_count ?? 0),
    forks: Number(data.forks_count ?? 0),
    watchers: Number(data.subscribers_count ?? data.watchers_count ?? 0),
    openIssues: Number(data.open_issues_count ?? 0),
    license: data.license?.spdx_id ?? null,
    defaultBranch: String(data.default_branch ?? "main"),
    pushedAt: data.pushed_at ?? null,
    topics: Array.isArray(data.topics) ? data.topics.map(String) : [],
    archived: Boolean(data.archived),
  };
}

/** The `.sha256` companion of an asset, or null when the release does not publish one. */
export function checksumAsset(release: GitHubRelease): GitHubReleaseAsset | null {
  return release.assets.find((asset) => /\.sha256$/i.test(asset.name))
    ?? release.assets.find((asset) => /sha256sum/i.test(asset.name))
    ?? null;
}

/**
 * Picks the archive the installer will download. Preference order:
 *   1. an asset that carries the version in its name (rslmc-2026.10.29.tar.gz)
 *   2. any .tar.gz asset
 *   3. the first asset at all (the caller validates the archive after download)
 */
export function installerAsset(release: GitHubRelease): GitHubReleaseAsset | null {
  if (release.assets.length === 0) return null;
  const tarballs = release.assets.filter((asset) => /\.(tar\.gz|tgz)$/i.test(asset.name));
  const versioned = tarballs.find((asset) => asset.name.includes(release.version));
  return versioned ?? tarballs[0] ?? release.assets[0]!;
}
