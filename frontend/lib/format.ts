export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, index);
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(digits)} ${units[index]}`;
}

export function formatMegabytes(bytes: number | null | undefined): string {
  if (!bytes || !Number.isFinite(bytes)) return "0";
  return String(Math.round(bytes / 1024 / 1024));
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds < 0) return "0s";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (!days && !hours) parts.push(`${secs}s`);
  return parts.join(" ");
}

export function formatUptime(seconds: number | null | undefined): { value: string; unit: string } {
  if (!seconds || seconds <= 0) return { value: "0", unit: "s" };
  if (seconds < 60) return { value: String(Math.floor(seconds)), unit: "s" };
  if (seconds < 3600) return { value: String(Math.floor(seconds / 60)), unit: "m" };
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return { value: `${hours}h ${minutes}m`, unit: "" };
  }
  return { value: `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`, unit: "" };
}

export function formatTime(ts: number | string | null | undefined): string {
  if (!ts) return "—";
  const date = typeof ts === "number" ? new Date(ts) : new Date(ts);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function formatDateTime(ts: number | string | null | undefined): string {
  if (!ts) return "—";
  const date = typeof ts === "number" ? new Date(ts) : new Date(ts);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString([], {
    year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

export function relativeTime(ts: number | string | null | undefined): string {
  if (!ts) return "never";
  const date = typeof ts === "number" ? new Date(ts) : new Date(ts);
  const delta = Date.now() - date.getTime();
  if (Number.isNaN(delta)) return "never";
  const seconds = Math.round(delta / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

export const STATUS_META: Record<string, { label: string; tone: "green" | "red" | "amber" | "blue" | "neutral" | "violet" }> = {
  online: { label: "Running", tone: "green" },
  starting: { label: "Starting", tone: "amber" },
  stopping: { label: "Stopping", tone: "amber" },
  restarting: { label: "Restarting", tone: "amber" },
  recovering: { label: "Recovering", tone: "amber" },
  offline: { label: "Offline", tone: "neutral" },
  crashed: { label: "Crashed", tone: "red" },
  error: { label: "Error", tone: "red" },
  installing: { label: "Installing", tone: "blue" },
};

export function statusTone(status: string): "green" | "red" | "amber" | "blue" | "neutral" | "violet" {
  return STATUS_META[status]?.tone ?? "neutral";
}

export function statusLabel(status: string): string {
  return STATUS_META[status]?.label ?? status;
}

/** Initials-based fallback avatar colour; deterministic per name. */
export function colorFor(name: string): string {
  const palette = ["#2f6b4a", "#35507d", "#6b5a2f", "#5c3b6b", "#2f6165", "#6b3a3a"];
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 9973;
  return palette[hash % palette.length]!;
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : plural ?? `${singular}s`;
}

export function cpuAllocationLabel(percent: number): string {
  const cores = percent / 100;
  return `${percent}% · ${cores.toFixed(cores % 1 === 0 ? 0 : 1)} core-equivalent${cores === 1 ? "" : "s"}`;
}
