import { useEffect, useState } from "react";
import { Terminal } from "lucide-react";
import type { ServerSummary } from "../../src/shared/types";
import { Card, PageHeader, Pill, Button } from "../components/ui";
import { ConsolePanel, mergeLines, type ConsoleLine } from "../components/console";
import { useSession } from "../lib/app";
import { api } from "../lib/api";
import { usePanelSocket } from "../lib/ws";
import { Link } from "../lib/router";
import { statusLabel, statusTone } from "../lib/format";

export function ConsolePage({ server }: { server: ServerSummary }) {
  const { can } = useSession();
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [live, setLive] = useState(false);
  const [foreign, setForeign] = useState(false);
  const [status, setStatus] = useState(server.status);

  useEffect(() => {
    api.get<{ data: ConsoleLine[]; live: boolean; foreign?: boolean }>(`/api/servers/${server.id}/console?limit=2000`)
      .then((result) => { setLines(result.data); setLive(result.live); setForeign(Boolean(result.foreign)); })
      .catch(() => {});
  }, [server.id]);


  const connection = usePanelSocket(server.id, (message) => {
    if (message.type === "console") {
      setLines((current) => [...current, ...message.lines].slice(-4000));
    } else if (message.type === "console.history") {
      // Merge instead of replace: the REST fetch above may already hold more history than
      // the 500 lines the socket replays, and replacing it made the log look like it
      // "restarted" every time the page subscribed.
      setLines((current) => {
        if (current.length === 0) return message.lines.slice(-4000);
        const seen = new Set(current.map((line) => `${line.ts}:${line.text}`));
        const extra = message.lines.filter((line) => !seen.has(`${line.ts}:${line.text}`));
        return [...current, ...extra].slice(-4000).sort((a, b) => a.ts - b.ts);
      });
    }
    else if (message.type === "status") { setStatus(message.status as any); setLive(["online", "starting", "stopping"].includes(message.status)); }
  });

  /*
   * Fallback: while the WebSocket is not open (proxies, sleeping tabs, a panel restart) the console
   * would silently stop updating. Poll the history endpoint instead and merge the new lines, so the
   * page stays live instead of looking frozen.
   */
  useEffect(() => {
    if (connection === "open") return;
    const timer = setInterval(() => {
      api.get<{ data: ConsoleLine[]; live: boolean; foreign?: boolean }>(`/api/servers/${server.id}/console?limit=2000`)
        .then((result) => {
          setLive(result.live);
          setForeign(Boolean(result.foreign));
          setLines((current) => mergeLines(current, result.data, 4000));
        })
        .catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [connection, server.id]);

  return (
    <>
      <PageHeader
        title="Console"
        icon={<Terminal size={19} />}
        status={<Pill tone={statusTone(status)} dot>{statusLabel(status)}</Pill>}
        subtitle={<>Live standard input and output of the <strong style={{ color: "var(--text)" }}>{server.name}</strong> process.</>}
        actions={<Link to={`/servers/${server.id}/overview`} className="btn btn-sm">Overview</Link>}
      />
      <Card title="Server console" icon={<Terminal size={12} />} bodyClass="tight" actions={<span className="text-xs faint">Buffered in memory · last 6000 lines</span>}>
        <ConsolePanel
          serverId={server.id}
          lines={lines}
          live={live}
          connection={connection}
          foreign={foreign}
          height="clamp(320px, calc(100vh - 430px), 540px)"
          canCommand={can("server.command")}
        />
      </Card>
    </>
  );
}
