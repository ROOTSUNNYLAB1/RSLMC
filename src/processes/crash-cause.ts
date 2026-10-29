import type { ConsoleLine } from "../shared/types";

/**
 * Why did the server process stop?
 *
 * "Server process exited unexpectedly (code 0)" is technically true and completely useless: the real
 * reason is usually a line or two further up the console (`java.lang.OutOfMemoryError: Java heap
 * space`), a kernel SIGKILL on a small host, or the port already being taken. A panel that shows raw
 * exit codes and nothing else sends the operator looking in the wrong place, so this module reads the
 * last lines of console output and names the cause when it can, and says "unknown" when it cannot.
 */

export interface CrashCause {
  kind: "out_of_memory" | "native_threads" | "killed" | "port_in_use" | "world_corrupt" | "unknown";
  /** One sentence an operator can act on. */
  message: string;
}

export interface CrashInput {
  /** Newest console lines first or last — order does not matter, the whole window is searched. */
  lines: Array<Pick<ConsoleLine, "text"> | string>;
  exitCode?: number | null;
  signalCode?: string | null;
  /** The allocation the server was given, for a message that names a number. */
  memoryMb?: number;
}

function text(lines: CrashInput["lines"]): string {
  return lines.map((line) => (typeof line === "string" ? line : line.text)).join("\n");
}

export function explainCrash(input: CrashInput): CrashCause {
  const log = text(input.lines);
  const exit = input.exitCode ?? null;
  const signal = input.signalCode ?? null;

  if (/java\.lang\.OutOfMemoryError: Java heap space/i.test(log)) {
    const gave = input.memoryMb ? ` It was given ${input.memoryMb} MB.` : "";
    return {
      kind: "out_of_memory",
      message:
        `The JVM ran out of heap memory while starting (java.lang.OutOfMemoryError: Java heap space).${gave} ` +
        "Raise the server's memory allocation, or lower view-distance and simulation-distance in server.properties.",
    };
  }
  if (/java\.lang\.OutOfMemoryError: (?:unable to create (?:native )?thread|Metaspace)/i.test(log)) {
    return {
      kind: "native_threads",
      message:
        "The JVM ran out of native memory or could not create a thread (OutOfMemoryError). " +
        "This is memory outside the Java heap: lower the allocation's -Xmx headroom, or free memory on the host.",
    };
  }
  if (/OutOfMemoryError/i.test(log)) {
    return {
      kind: "out_of_memory",
      message: "The JVM reported java.lang.OutOfMemoryError before exiting. Raise the memory allocation.",
    };
  }
  if (signal === "SIGKILL" || signal === "SIGBUS") {
    return {
      kind: "killed",
      message:
        "The process was killed by the operating system (SIGKILL) instead of exiting on its own — on a small host " +
        "this is almost always the out-of-memory killer. Check free memory, or allocate less to this server.",
    };
  }
  if (/Address already in use|Failed to bind to port|Perhaps a server is already running on that port/i.test(log)) {
    return {
      kind: "port_in_use",
      message: "The server could not bind its port because something else is already listening on it. Change the allocation.",
    };
  }
  if (/Exception reading|corrupt|Failed to load world|level\.dat is not/i.test(log)) {
    return {
      kind: "world_corrupt",
      message: "A world file could not be read. Restore a backup of this world from the Backups page.",
    };
  }
  const code = exit === null ? (signal ? `signal ${signal}` : "an unknown code") : `code ${exit}`;
  return {
    kind: "unknown",
    message: `The process exited with ${code} and the console does not name a cause.`,
  };
}
