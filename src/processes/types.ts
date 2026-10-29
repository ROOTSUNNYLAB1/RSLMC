import type { ConsoleLine, ServerStatus } from "../shared/types";

export interface RuntimeState {
  serverId: number;
  status: ServerStatus;
  pid: number | null;
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
}
