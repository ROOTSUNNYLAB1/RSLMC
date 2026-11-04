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
  kind:
    | "out_of_memory" | "native_threads" | "killed" | "port_in_use" | "world_corrupt"
    | "bad_jar" | "watchdog" | "container_rejected" | "container_unreachable"
    | "invalid_cpu_limit" | "unknown";
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
  /*
   * The watchdog: a single tick took longer than 60 s, so the server killed itself rather than hang.
   * Seen for real on a starved host (four busy cores next to a 1-core allocation) — the fix is less
   * load, not a backup restore.
   */
  const tick = /A single server tick took ([\d.]+) seconds/i.exec(log);
  if (tick || /java\.lang\.Error: Watchdog|Watching Server/i.test(log)) {
    const took = tick ? ` A single server tick took ${tick[1]} seconds.` : "";
    return {
      kind: "watchdog",
      message:
        `The server watchdog stopped the process because the main thread stalled.${took} ` +
        "That is lag, not corruption: check the CPU share this server gets, view-distance and forceloaded chunks, " +
        "then start it again.",
    };
  }
  /*
   * A jar that is not a jar is the first thing that can go wrong after a download, and it is *not* a
   * world problem — matching the bare word "corrupt" used to send operators to restore a perfectly
   * healthy world. Check it before any world pattern.
   */
  if (/Invalid or corrupt jarfile|Error: Unable to access jarfile|no main manifest attribute/i.test(log)) {
    return {
      kind: "bad_jar",
      message:
        "The server jar stored for this server is missing or is not a runnable jar (the download was probably " +
        "interrupted). Reinstall the server from the Versions section of the server's Overview page.",
    };
  }
  if (
    /Exception reading|Failed to load world|level\.dat is not|"corrupt":\s*true|\b(?:chunk|world|level\.dat|region file)\b[^\n]{0,60}\bcorrupt|\bcorrupt(?:ed)?\b[^\n]{0,60}\b(?:chunk|world|level\.dat|region file)\b/i.test(
      log,
    )
  ) {
    return {
      kind: "world_corrupt",
      message: "A world file could not be read. Restore a backup of this world from the Backups page.",
    };
  }
  /*
   * Docker rejected the container command itself.
   *
   * The console is full of server lines and then a *docker* line, and the exit code (125) belongs to the
   * CLI, not to Minecraft — that is why the crash said "code signal relay-disconnected" and named no
   * cause. Real report: `range of CPUs is from 0.01 to 2.00, as there are only 2 CPUs available`, from a
   * 400% allocation on a two-core VPS. Checked before the generic branches so the daemon's own words
   * reach the operator instead of a puzzle.
   */
  const cpuRange = /range of CPUs is from ([\d.]+) to ([\d.]+), as there are only (\d+) CPUs? available/i.exec(log);
  if (cpuRange) {
    return {
      kind: "invalid_cpu_limit",
      message:
        `The CPU allocation asks for more cores than this machine has — Docker only has ${cpuRange[3]} `
        + `and accepts up to ${cpuRange[2]} cores. RSLMC clamps the value at launch, so this container was started `
        + "by a build that did not: lower the allocation in Settings → Resources, or run on a larger node.",
    };
  }
  const dockerError = /docker: Error response from daemon: ([^\n]+)/i.exec(log);
  if (dockerError) {
    return {
      kind: "container_rejected",
      message:
        `Docker refused to create the container: ${dockerError[1].trim()} `
        + "The server never started — this is a Docker-side problem, not a Minecraft one: check the image, "
        + "the limits and the daemon's health, then start it again.",
    };
  }
  if (/docker: (?:Cannot connect to the Docker daemon|permission denied while trying to connect)/i.test(log)) {
    return {
      kind: "container_unreachable",
      message:
        "Docker could not be reached, so the container never started (not a Minecraft failure). "
        + "The wizard's Docker diagnosis shows the account, socket and endpoint the panel used — fix that, then start again.",
    };
  }
  const code = exit === null ? (signal ? `signal ${signal}` : "an unknown code") : `code ${exit}`;
  return {
    kind: "unknown",
    message: `The process exited with ${code} and the console does not name a cause.`,
  };
}
