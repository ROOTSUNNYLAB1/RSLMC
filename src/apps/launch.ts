import { APP_FAMILIES, appDisplayName, type AppFamily } from "./catalog";

/*
 * Turning a Python/Node server into a command line.
 *
 * Kept separate from the process manager so the rules can be tested without spawning anything, and so
 * the same rules produce the standalone command, the Docker command and the line the console shows at
 * start — three places that must never disagree about what is really being run.
 */

/** What a fresh server of each family is started with. */
export interface AppLaunchInput {
  family: AppFamily;
  /** Absolute path of the interpreter (standalone) or the in-container binary name (Docker). */
  executable: string;
  /** Entry file relative to the server directory. */
  entryFile: string;
  /** Extra arguments from the Startup page; each element is one argument, never re-split. */
  args?: string[];
  memoryMb?: number;
}

/**
 * The process command line.
 *
 * The entry file is passed as a path relative to the working directory (the server directory in both
 * runtimes), so a container's `/data` mount and a standalone host path produce the same command and the
 * console line is readable.
 */
export function appCommand(input: AppLaunchInput): string[] {
  const definition = APP_FAMILIES[input.family];
  const entry = normaliseEntryFile(input.entryFile || definition.entryFile, input.family);
  return [input.executable, entry, ...(input.args ?? []).filter((arg) => arg.length > 0)];
}

/**
 * Environment for an app process.
 *
 * `PYTHONUNBUFFERED`/`PYTHONNOUSERSITE` and `NODE_ENV` are set for one reason: the console must show
 * stdout as it happens (Python buffers by default when stdout is a pipe, which made the console look
 * frozen), and the interpreter must not pick up a `site-packages` from the panel's own account.
 * `PATH` is prefixed with the interpreter's `bin` so `pip`/`npm` resolve to the versions the panel
 * installed rather than whatever the host happens to have.
 */
export function appEnvironment(input: {
  family: AppFamily;
  binDirectory: string | null;
  home: string;
  memoryMb?: number;
  base?: Record<string, string>;
}): Record<string, string> {
  const path = [
    ...(input.binDirectory ? [input.binDirectory] : []),
    "/usr/local/bin", "/usr/bin", "/bin",
  ].join(":");
  const common: Record<string, string> = {
    PATH: path,
    HOME: input.home,
    LANG: "en_US.UTF-8",
    // Colour in pip/npm output is fine: the console renders ANSI.
    FORCE_COLOR: "1",
  };
  if (input.family === "python") {
    return {
      ...common,
      PYTHONUNBUFFERED: "1",
      PYTHONNOUSERSITE: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      PIP_ROOT_USER_ACTION: "ignore",
    };
  }
  return {
    ...common,
    NODE_ENV: input.base?.NODE_ENV ?? "production",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    // Node sizes its heap from the allocation, the same way the JVM gets -Xmx from it.
    ...(input.memoryMb && input.memoryMb > 0
      ? { NODE_OPTIONS: `--max-old-space-size=${Math.max(64, Math.round(input.memoryMb * 0.75))}`, UV_THREADPOOL_SIZE: "4" }
      : {}),
  };
}

/**
 * The binary name used inside a container. `--entrypoint` needs a name, not a host path: the
 * interpreter inside the image is at `/usr/local/bin` (official images) or on PATH (yolks).
 */
export function appContainerBinary(family: AppFamily): string {
  return family === "python" ? "python3" : "node";
}

/**
 * Entry files: a path relative to the server directory, ending in the right extension.
 *
 * This is deliberately strict. The value reaches a command line and, in Docker, a path inside the
 * container; `../` or an absolute path would either escape the server directory or point at a file the
 * service account cannot read.
 */
export function normaliseEntryFile(value: string, family: AppFamily): string {
  const definition = APP_FAMILIES[family];
  const trimmed = (value ?? "").trim().replace(/\\/g, "/");
  if (!trimmed) return definition.entryFile;
  return trimmed.replace(/^\.\//, "");
}

export interface EntryFileProblem {
  message: string;
}

/** Returns a problem description, or null when the entry file is usable. */
export function validateEntryFile(value: string, family: AppFamily): EntryFileProblem | null {
  const definition = APP_FAMILIES[family];
  const entry = normaliseEntryFile(value, family);
  if (entry.length === 0) return { message: "An entry file is required." };
  if (entry.length > 200) return { message: "Entry file path is too long (200 characters max)." };
  if (entry.startsWith("/") || /^[A-Za-z]:/.test(entry)) {
    return { message: "Use a path relative to the server directory, for example " + definition.entryFile + "." };
  }
  if (entry.split("/").includes("..")) return { message: "The entry file must stay inside the server directory (no \"..\")." };
  const expected = definition.entryFile.split(".").pop()!;
  if (!entry.toLowerCase().endsWith(`.${expected}`)) {
    return { message: `${definition.name} servers start a .${expected} file; "${entry}" does not look like one.` };
  }
  return null;
}

/** One-line description of what the process is, for the console's start banner. */
export function appLaunchSummary(family: AppFamily, version: string, entryFile: string): string {
  const definition = APP_FAMILIES[family];
  return `${appDisplayName(family, version)} — ${definition.binary} ${normaliseEntryFile(entryFile, family)}`;
}
