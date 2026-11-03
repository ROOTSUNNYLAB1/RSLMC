import type { ConsoleLine, ServerStatus } from "../shared/types";

export interface RuntimeState {
  serverId: number;
  status: ServerStatus;
  pid: number | null;
  /**
   * Fingerprint of the process that owns `pid` (see `processStartMark` in orphans.ts). Pids are
   * recycled; without this, a kill could land on an unrelated process the panel never started.
   */
  pidMark?: string | null;
  startedAt: number | null;
  stoppingAt: number | null;
  exitCode: number | null;
  lastError: string | null;
  console: ConsoleLine[];
  players: Map<string, { name: string; uuid: string | null; joinedAt: number }>;
  ready: boolean;
  stopKind: "graceful" | "forced" | null;
  cgroupAttached: boolean;
  enforcementMessage: string | null;
  /** True when the JVM was adopted: it runs this server's directory but RSLMC did not spawn it. */
  foreign: boolean;
  /** True when the process is owned by an RSLMC relay (survives a panel restart). */
  relayed?: boolean;
}
