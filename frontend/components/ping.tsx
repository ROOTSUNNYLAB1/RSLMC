import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

/*
 * The ping next to the server address, in the shape Minecraft uses: five bars and a number.
 *
 * Two different round trips are involved and the tooltip keeps them apart instead of adding them up:
 *
 *   latency  — measured *in your browser*, around this very request. It is the path your packets take
 *              to the machine running the server, which is the number a player actually feels.
 *   portMs   — a TCP handshake to the game port from the machine hosting the server, taken there.
 *
 * The bars follow `latency`. When the game port is closed the bars still describe the network and the
 * tooltip says the port refused the connection — "0 ms" would be a lie, and a stopped server is not a
 * fast one.
 */

interface PingSample {
  /** Browser-measured round trip in milliseconds. */
  latency: number;
  /** TCP handshake from the hosting machine, or null when nothing answered. */
  portMs: number | null;
  reachable: boolean;
  reason: string | null;
  target: string;
  at: number;
}

function barsFor(latency: number | null): 0 | 1 | 2 | 3 | 4 | 5 {
  if (latency === null) return 0;
  if (latency <= 40) return 5;
  if (latency <= 80) return 4;
  if (latency <= 150) return 3;
  if (latency <= 300) return 2;
  return 1;
}

function toneFor(latency: number | null): "good" | "ok" | "fair" | "poor" | "unknown" {
  const bars = barsFor(latency);
  return bars === 5 ? "good" : bars === 4 ? "ok" : bars === 3 ? "fair" : bars >= 1 ? "poor" : "unknown";
}

const BAR_HEIGHTS = [4, 7, 10, 13, 16];

/** Five Minecraft-style bars. Filled from the left; the rest stay dim so the shape never moves. */
export function PingBars({ filled, tone }: { filled: number; tone: string }) {
  return (
    <span className={`ping-bars ping-${tone}`} aria-hidden="true">
      {BAR_HEIGHTS.map((height, index) => (
        <span
          key={height}
          className={`ping-bar ${index < filled ? "on" : ""}`}
          style={{ height: `${height}px` }}
        />
      ))}
    </span>
  );
}

export function PingMeter({ serverId, running }: { serverId: number; running: boolean }) {
  const [sample, setSample] = useState<PingSample | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const measure = async () => {
      const started = performance.now();
      try {
        const payload = await api.get<{
          server: { ms: number | null; reachable: boolean; reason: string | null; target: string };
        }>(`/api/servers/${serverId}/ping`);
        /*
         * `performance.now()` around the request is the honest number: the browser started the clock
         * before the request left and stopped it after the answer arrived. A remote node adds the
         * controller's hop, which the tooltip states rather than hides.
         */
        const latency = performance.now() - started;
        if (!mounted.current) return;
        setSample({
          latency,
          portMs: payload.server.ms,
          reachable: payload.server.reachable,
          reason: payload.server.reason,
          target: payload.server.target,
          at: Date.now(),
        });
        setError(null);
      } catch (caught) {
        if (!mounted.current) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (mounted.current) {
          // Every 5 s while the server is up, every 15 s while it is down: a stopped server's ping
          // does not change, and the panel should not hammer the network to prove it.
          timer = setTimeout(measure, running ? 5000 : 15000);
        }
      }
    };

    void measure();
    return () => {
      mounted.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [serverId, running]);

  if (error) {
    return (
      <span className="ping-pill ping-unknown" title={error}>
        <PingBars filled={0} tone="unknown" />
        <span className="ping-value">—</span>
      </span>
    );
  }
  if (!sample) {
    return (
      <span className="ping-pill ping-unknown" title="Measuring the round trip to this server…">
        <PingBars filled={0} tone="unknown" />
        <span className="ping-value">…</span>
      </span>
    );
  }

  const rounded = Math.round(sample.latency);
  const bars = barsFor(sample.latency);
  const tone = toneFor(sample.latency);
  const portLine = sample.reachable
    ? `Game port ${sample.target} answered a TCP handshake in ${sample.portMs?.toFixed(1) ?? "—"} ms (measured on the machine hosting it).`
    : `Game port ${sample.target} did not accept a connection (${sample.reason ?? "no answer"})${
      sample.reason === "refused" ? " — the server is not listening; start it." : "."
    }`;
  const tooltip =
    `Your round trip to this server: ${rounded} ms, measured in your browser (HTTP, not ICMP).\n`
    + `${portLine}\n`
    + "Bars: ≤40 ms five, ≤80 four, ≤150 three, ≤300 two, slower one.";

  return (
    <span className={`ping-pill ping-${tone}`} title={tooltip} role="status" aria-live="off"
      aria-label={`Ping ${rounded} milliseconds`}>
      <PingBars filled={bars} tone={tone} />
      <span className="ping-value">{rounded} ms</span>
      {!sample.reachable && <span className="ping-port-closed" title="Game port is closed" />}
    </span>
  );
}
