import { query, run } from "../database";
import { getNode, probeNode, nodeRequest, type NodeRow } from "./client";

/**
 * Keeps the Nodes page honest.
 *
 * Every node is asked two things on a timer: "are you alive" (a handshake, which also brings back the
 * machine's real CPU/memory/disk figures) and "what are your servers doing" (an inventory, so a
 * server whose status changed on the node — crashed, restarted, finished installing — shows the same
 * status here). Nothing is inferred: a node that does not answer is marked offline with the reason
 * the request gave, and the timestamps are real.
 */

const PROBE_INTERVAL_MS = 15_000;
const INVENTORY_INTERVAL_MS = 5_000;

let probeTimer: ReturnType<typeof setInterval> | null = null;
let inventoryTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function remoteNodes(): NodeRow[] {
  return query<NodeRow>("SELECT * FROM nodes WHERE is_local = 0 ORDER BY id");
}

async function probeAll(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const node of remoteNodes()) {
      try { await probeNode(node); } catch { /* probeNode records the failure itself */ }
    }
  } finally {
    running = false;
  }
}

/** Pulls each node's server list and copies the statuses onto the linked local rows. */
async function syncInventories(): Promise<void> {
  for (const node of remoteNodes()) {
    // No point asking a node that just failed its handshake.
    if (node.last_status === "offline") continue;
    const response = await nodeRequest(node, "/api/agent/servers", { timeoutMs: 8000 });
    if (!response.ok) continue;
    const inventory = ((response.body as any)?.data ?? []) as { id: number; status: string; uuid?: string }[];
    const byRemoteId = new Map(inventory.map((entry) => [entry.id, entry]));
    const links = query<{ server_id: number; remote_server_id: number }>(
      "SELECT server_id, remote_server_id FROM node_server_links WHERE node_id = ?", [node.id],
    );
    for (const link of links) {
      const remote = byRemoteId.get(link.remote_server_id);
      if (!remote) {
        // The node no longer has this server: say so instead of showing a status that never changes.
        run("UPDATE servers SET status = 'missing' WHERE id = ?", [link.server_id]);
        continue;
      }
      const local = query<{ status: string }>("SELECT status FROM servers WHERE id = ?", [link.server_id])[0];
      if (local && local.status !== remote.status) {
        run("UPDATE servers SET status = ? WHERE id = ?", [remote.status, link.server_id]);
      }
    }
  }
}

export function startNodeHeartbeats(): void {
  if (probeTimer) return;
  void probeAll();
  void syncInventories();
  probeTimer = setInterval(() => void probeAll(), PROBE_INTERVAL_MS);
  inventoryTimer = setInterval(() => void syncInventories(), INVENTORY_INTERVAL_MS);
  probeTimer.unref?.();
  inventoryTimer.unref?.();
}

export function stopNodeHeartbeats(): void {
  if (probeTimer) clearInterval(probeTimer);
  if (inventoryTimer) clearInterval(inventoryTimer);
  probeTimer = null;
  inventoryTimer = null;
}
