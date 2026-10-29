import { query } from "../database";
import { startServer } from "../processes/manager";
import { notify } from "./notifications";

/** Starts servers marked as auto-start, once the panel is ready. */
export async function startAutoStartServers(): Promise<void> {
  const servers = query<any>("SELECT id, name FROM servers WHERE auto_start = 1 AND installed_at IS NOT NULL");
  for (const server of servers) {
    try {
      await startServer(server.id, "auto-start");
      console.log(`[rslmc] auto-started ${server.name}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[rslmc] auto-start failed for ${server.name}: ${message}`);
      notify({
        title: `Auto-start failed: ${server.name}`,
        body: message.slice(0, 300),
        severity: "error", kind: "autostart_failed", link: `/servers/${server.id}/console`,
      });
    }
  }
}
