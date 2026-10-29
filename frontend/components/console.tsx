import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronDown, Copy, Download, Pause, Play, Search, Trash2 } from "lucide-react";
import { Button } from "./ui";
import { formatTime } from "../lib/format";
import { api } from "../lib/api";
import { useToast } from "../lib/app";
import { AnsiText, stripAnsi } from "../lib/ansi";

export interface ConsoleLine {
  ts: number;
  stream: string;
  text: string;
}

function classify(line: ConsoleLine): string {
  if (line.stream === "stderr") return "stderr";
  if (line.stream === "input") return "cmd";
  if (line.stream === "system") return "system";
  // Match on the plain text: escape codes would otherwise split words like "\u001b[31mERROR".
  const text = stripAnsi(line.text);
  if (/^\[.*\]\s*\[?.*(ERROR|SEVERE)/i.test(text) || /\bERROR\b/.test(text)) return "error";
  if (/\bWARN(ING)?\b/.test(text)) return "warn";
  if (/Done \([0-9.]+s\)!/.test(text) || /joined the game/.test(text)) return "ready";
  return "";
}

/**
 * Appends only the lines the buffer does not already hold. Used by the WebSocket history replay and
 * by the polling fallback so neither path can duplicate or reorder the visible log.
 */
export function mergeLines(current: ConsoleLine[], incoming: ConsoleLine[], limit: number): ConsoleLine[] {
  if (incoming.length === 0) return current;
  const seen = new Set(current.map((line) => `${line.ts}:${line.text}`));
  const extra = incoming.filter((line) => !seen.has(`${line.ts}:${line.text}`));
  if (extra.length === 0) return current;
  return [...current, ...extra].slice(-limit).sort((a, b) => a.ts - b.ts);
}

const RENDER_LIMIT = 900;

/**
 * One console line. Memoised so a live stream only re-renders the rows that changed —
 * re-rendering hundreds of rows on every 40 ms batch is what made typing feel laggy.
 */
const ConsoleRow = memo(function ConsoleRow({ line, search }: { line: ConsoleLine; search: string }) {
  return (
    <div className={`console-line ${classify(line)}`}>
      <span className="ts">{formatTime(line.ts)}</span>
      <span className="msg"><AnsiText text={line.text} search={search} /></span>
    </div>
  );
});


export function ConsolePanel({
  serverId, lines, live, connection = "open", foreign = false, height = 300, showInput = true, canCommand, onCopyState, compact = false,
}: {
  serverId: number;
  lines: ConsoleLine[];
  live: boolean;
  /** WebSocket state, so the header never claims "Live" while the stream is down. */
  connection?: "connecting" | "open" | "closed";
  /** True when the JVM was adopted: it runs, but RSLMC has no stdout pipe for it. */
  foreign?: boolean;
  height?: number | string;
  showInput?: boolean;
  canCommand: boolean;
  onCopyState?: (count: number) => void;
  compact?: boolean;
}) {
  const [autoScroll, setAutoScroll] = useState(true);
  const [paused, setPaused] = useState(false);
  const [search, setSearch] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const [hidden, setHidden] = useState<ConsoleLine[]>([]);
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const toast = useToast();

  // Pausing freezes the rendered buffer without dropping incoming lines.
  const rendered = useMemo(() => {
    const all = paused ? hidden : lines;
    if (!search) return all.length > RENDER_LIMIT ? all.slice(-RENDER_LIMIT) : all;
    const needle = search.toLowerCase();
    const matches = all.filter((line) => line.text.toLowerCase().includes(needle));
    return matches.length > RENDER_LIMIT ? matches.slice(-RENDER_LIMIT) : matches;
  }, [lines, hidden, paused, search]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !autoScroll) return;
    element.scrollTop = element.scrollHeight;
  }, [rendered, autoScroll]);

  useEffect(() => {
    if (!paused) setHidden([]);
  }, [paused]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    setAutoScroll(atBottom);
  };

  const send = async () => {
    const value = command.trim();
    if (!value) return;
    setSending(true);
    try {
      await api.post(`/api/servers/${serverId}/console`, { command: value });
      setHistory((current) => [...current.slice(-49), value]);
      setHistoryIndex(null);
      setCommand("");
    } catch (error) {
      toast.fromError(error, "Command failed");
    } finally {
      setSending(false);
    }
  };

  const copy = async () => {
    const text = rendered.map((line) => stripAnsi(line.text)).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      onCopyState?.(rendered.length);
      toast.success("Console copied", `${rendered.length} lines copied to the clipboard.`);
    } catch {
      toast.error("Could not copy", "Your browser blocked clipboard access.");
    }
  };

  const download = () => {
    const text = rendered.map((line) => `[${new Date(line.ts).toISOString()}] ${stripAnsi(line.text)}`).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `server-${serverId}-console-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowUp" && history.length > 0) {
      event.preventDefault();
      const next = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setCommand(history[next] ?? "");
    } else if (event.key === "ArrowDown" && historyIndex !== null) {
      event.preventDefault();
      const next = historyIndex + 1;
      if (next >= history.length) { setHistoryIndex(null); setCommand(""); }
      else { setHistoryIndex(next); setCommand(history[next] ?? ""); }
    }
  };

  return (
    <div className="console-shell">
      <div className="console-toolbar">
        <span
          className="row"
          style={{ gap: 5, fontSize: 11, color: live && connection === "open" ? "var(--green)" : live && connection !== "open" ? "var(--amber)" : "var(--text-faint)" }}
        >
          <span
            className={live && connection === "open" ? "live-dot" : ""}
            style={{
              width: 6, height: 6, borderRadius: "50%",
              background: live && connection === "open" && !foreign ? "var(--green)" : live ? "var(--amber)" : "var(--text-ghost)",
            }}
          />
          {foreign
            ? "Process adopted — output not captured"
            : !live
              ? "Server offline"
              : connection === "open"
                ? "Live"
                : connection === "connecting" ? "Connecting…" : "Stream interrupted — polling"}
        </span>
        <div className="spacer" />
        <div className="row" style={{ gap: 4 }}>
          <input
            ref={filterRef}
            className="console-search"
            placeholder="Filter output…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Filter console output"
          />
          <Button
            size="sm"
            variant="ghost"
            icon={<Search size={13} />}
            onClick={() => filterRef.current?.focus()}
            aria-label="Jump to the filter field"
            title="Filter console output"
          />
          <Button
            size="sm" variant="ghost" onClick={() => setPaused((value) => !value)}
            icon={paused ? <Play size={13} /> : <Pause size={13} />}
            title={paused ? "Resume output" : "Pause output"}
          >
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={copy} title="Copy output" />
          <Button size="sm" variant="ghost" icon={<Download size={13} />} onClick={download} title="Download log" />
          <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setHidden(lines)} title="Clear the visible buffer (the server log file is untouched)" />
        </div>
      </div>

      <div className="console-output" style={{ height }} ref={scrollRef} onScroll={onScroll} tabIndex={0} aria-label="Server console output" aria-live="polite">
        {rendered.length === 0 ? (
          <div style={{ color: "var(--text-ghost)" }}>
            {paused ? "Output paused." : "No console output yet. Start the server to see live logs."}
          </div>
        ) : (
          rendered.map((line, index) => (
            <ConsoleRow key={`${line.ts}-${index}`} line={line} search={search} />
          ))
        )}
      </div>

      {!autoScroll && !compact ? (
        <button
          className="btn btn-sm"
          style={{ position: "relative", alignSelf: "center", marginTop: -34, marginBottom: 6, zIndex: 2 }}
          onClick={() => { setAutoScroll(true); const element = scrollRef.current; if (element) element.scrollTop = element.scrollHeight; }}
        >
          <ChevronDown size={13} /> Jump to latest
        </button>
      ) : null}

      {showInput ? (
        <div className="console-input-row">
          <input
            className="console-input"
            placeholder={foreign
              ? "Adopted process — RSLMC has no console pipe for it"
              : canCommand ? (live ? "Type a command…" : "Server is offline — commands are unavailable") : "You do not have permission to run commands"}
            value={command}
            disabled={!live || !canCommand || sending || foreign}
            onChange={(event) => setCommand(event.target.value)}
            onKeyDown={onKeyDown}
            onKeyUp={(event) => { if (event.key === "Enter") void send(); }}
            aria-label="Server command"
          />
          <button className="console-send" onClick={() => void send()} disabled={!live || !canCommand || sending || foreign || !command.trim()} aria-label="Send command">
            <ArrowUp size={15} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
