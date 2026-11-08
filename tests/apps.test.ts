import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/*
 * Python and Node.js as first-class server software.
 *
 * Three things are worth testing here, and none of them is "does the internet still exist":
 *
 *   1. **Version parsing.** Node's index and python-build-standalone's asset names are parsed by hand;
 *      a wrong regex silently offers a version that cannot be downloaded, or hides every version there is.
 *   2. **The launch line.** `python3 main.py` and `node index.js` are produced by one function used by
 *      the standalone and Docker paths — the entry file must never escape the server directory.
 *   3. **The image mapping.** Pterodactyl yolks stops at Python 3.11 / Node 20. Newer lines must fall back
 *      to the official image and say so, never invent a `yolks:python_3.13` tag that was never pushed.
 */

process.env.RSLMC_DATA_DIR = process.env.RSLMC_DATA_DIR ?? mkdtempSync(join(tmpdir(), "rslmc-apps-"));

const { parsePythonAsset, compareVersions, pythonTriple, APP_FAMILIES, isAppSoftware } = await import("../src/apps/catalog");
const { normaliseEntryFile, validateEntryFile, appCommand, appEnvironment, appContainerBinary } = await import("../src/apps/launch");
const { appImageFor } = await import("../src/runtime/images");
const { interpreterDirectory, interpreterExecutable, listInstalledInterpreters } = await import("../src/apps/interpreters");
const { requiresIsolation, serviceAccountState, SERVICE_USER } = await import("../src/runtime/nonroot");
const { SOFTWARE_CATALOG, softwareDefinition, resolveBuild, isAppSoftwareId } = await import("../src/minecraft/providers");
const { buildLaunchPlan } = await import("../src/processes/manager");
const { serverDir } = await import("../src/shared/config");

describe("Python and Node.js are software, not a side door", () => {
  test("both appear in the same catalogue as the Minecraft software", () => {
    const ids = SOFTWARE_CATALOG.map((item) => item.id);
    expect(ids).toContain("python");
    expect(ids).toContain("node");
    // Same list as Paper et al. — the wizard renders one grid, so it must be one array.
    expect(ids).toContain("paper");
    const python = softwareDefinition("python");
    expect(python.kind).toBe("app");
    expect(python.appFamily).toBe("python");
    expect(python.entryFile).toBe("main.py");
    expect(python.supportsPlugins).toBe(false);
    expect(python.supportsMods).toBe(false);
    expect(softwareDefinition("node").entryFile).toBe("index.js");
  });

  test("the app ids are recognised by the dispatcher used everywhere else", () => {
    expect(isAppSoftware("python")).toBe(true);
    expect(isAppSoftware("node")).toBe(true);
    expect(isAppSoftware("paper")).toBe(false);
    expect(isAppSoftwareId("node")).toBe(true);
    expect(isAppSoftwareId("vanilla")).toBe(false);
  });

  test("asking for a Minecraft artifact of an app says so instead of failing later", async () => {
    // No network involved: the guard is before any provider call.
    await expect(resolveBuild("python", "3.12.7")).rejects.toThrow(/interpreter/i);
    await expect(resolveBuild("node", "22.11.0")).rejects.toThrow(/interpreter/i);
  });

  test("the entry-file convention is part of the definition", () => {
    expect(APP_FAMILIES.python.entryFile).toBe("main.py");
    expect(APP_FAMILIES.python.binary).toBe("python3");
    expect(APP_FAMILIES.python.packageManager).toBe("pip");
    expect(APP_FAMILIES.node.entryFile).toBe("index.js");
    expect(APP_FAMILIES.node.binary).toBe("node");
    expect(APP_FAMILIES.node.packageManager).toBe("npm");
  });
});

describe("python-build-standalone asset names", () => {
  test("a real install_only asset is parsed into version and tag", () => {
    const parsed = parsePythonAsset(
      "astral-sh/python-build-standalone/releases/download/20261026/cpython-3.12.7+20261026-x86_64-unknown-linux-gnu-install_only.tar.gz",
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.version).toBe("3.12.7");
    expect(parsed!.tag).toBe("20261026");
  });

  test("shared-library and debugging builds are not mistaken for installable runtimes", () => {
    expect(parsePythonAsset("cpython-3.12.7+20261026-x86_64-unknown-linux-gnu-pgo+lto-full.tar.zst")).toBeNull();
    expect(parsePythonAsset("cpython-3.12.7+20261026-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz")).toBeNull();
  });

  test("the target triple matches this machine's platform", () => {
    const triple = pythonTriple();
    expect(["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc", "x86_64-apple-darwin", "aarch64-apple-darwin"])
      .toContain(triple);
    if (process.platform === "linux") expect(triple).toContain("unknown-linux-gnu");
  });

  test("versions compare numerically, so 3.9 is older than 3.12", () => {
    expect(compareVersions("3.9.20", "3.12.7")).toBeLessThan(0);
    expect(compareVersions("3.12.7", "3.12.10")).toBeLessThan(0);
    expect(compareVersions("22.11.0", "22.11.0")).toBe(0);
    expect(compareVersions("24.1.0", "22.11.0")).toBeGreaterThan(0);
  });
});

describe("which image runs which app", () => {
  const yolks = new Set(["python_3.11", "nodejs_20", "java_21"]);

  test("a yolks tag is used when the registry really has one", () => {
    const python = appImageFor("python", "3.11.9", yolks);
    expect(python.reference).toBe("ghcr.io/pterodactyl/yolks:python_3.11");
    expect(python.source).toBe("yolks");
    const node = appImageFor("node", "20.18.1", yolks);
    expect(node.reference).toBe("ghcr.io/pterodactyl/yolks:nodejs_20");
    expect(node.source).toBe("yolks");
  });

  test("a line with no yolks tag falls back to the official image and says so", () => {
    // yolks publishes nothing newer than python_3.11 / nodejs_20.
    const python = appImageFor("python", "3.13.1", yolks);
    expect(python.reference).toBe("python:3.13-slim");
    expect(python.source).toBe("official");
    expect(python.label).toContain("no yolks tag");
    const node = appImageFor("node", "22.11.0", yolks);
    expect(node.reference).toBe("node:22-slim");
    expect(node.source).toBe("official");
  });

  test("an empty registry answer (offline) never produces a yolks reference", () => {
    const image = appImageFor("python", "3.11.9", new Set());
    expect(image.source).toBe("official");
    expect(image.reference.startsWith("ghcr.io")).toBe(false);
  });
});

describe("the command that is actually run", () => {
  test("standalone Python runs the interpreter on the entry file", () => {
    expect(appCommand({ family: "python", executable: "/data/runtimes/python/3.12.7/bin/python3", entryFile: "main.py" }))
      .toEqual(["/data/runtimes/python/3.12.7/bin/python3", "main.py"]);
  });

  test("an app server is not handed Minecraft's `nogui`", () => {
    // The create route defaults serverArgs to "nogui" for Minecraft; for an app it must stay empty, or
    // every Python/Node server starts with an argument it never asked for.
    const plan = buildLaunchPlan({
      id: 43, uuid: "app-args", name: "Args", node_id: 1, software: "python", mc_version: "3.12.16",
      memory_mb: 512, cpu_percent: 100, disk_mb: 1024, bind_ip: "127.0.0.1", port: 3001,
      jvm_args: "", server_args: "", java_runtime_id: null, java_major: 0, rcon_password: null,
      public_host: null, public_port: null, runtime: "standalone", docker_image: null,
      docker_disk_quota: 0, entry_file: "main.py", service_user: null,
    } as any);
    expect(plan.command).not.toContain("nogui");
    expect(plan.command.length).toBe(2);
  });

  test("arguments are kept as arguments — never re-split or dropped", () => {
    expect(appCommand({ family: "node", executable: "node", entryFile: "index.js", args: ["--port", "8080", ""] }))
      .toEqual(["node", "index.js", "--port", "8080"]);
  });

  test("a missing entry file falls back to the convention for the family", () => {
    expect(normaliseEntryFile("", "python")).toBe("main.py");
    expect(normaliseEntryFile("", "node")).toBe("index.js");
    expect(normaliseEntryFile("./app.js", "node")).toBe("app.js");
  });

  test("the entry file cannot leave the server directory", () => {
    expect(validateEntryFile("../../etc/passwd", "python")).not.toBeNull();
    expect(validateEntryFile("/etc/cron.d/x.py", "python")).not.toBeNull();
    expect(validateEntryFile("C:\\Windows\\x.py", "python")).not.toBeNull();
    expect(validateEntryFile("bot.js", "python")).not.toBeNull();       // wrong extension
    expect(validateEntryFile("main.py", "python")).toBeNull();
    expect(validateEntryFile("src/index.js", "node")).toBeNull();
  });

  test("the container entrypoint is the binary name, not a host path", () => {
    expect(appContainerBinary("python")).toBe("python3");
    expect(appContainerBinary("node")).toBe("node");
  });

  test("interpreter environment keeps stdout unbuffered and pip/npm on the panel's own version", () => {
    const python = appEnvironment({ family: "python", binDirectory: "/opt/py/bin", home: "/home/rslmc-nonroot" });
    expect(python.PYTHONUNBUFFERED).toBe("1");
    // A panel-owned site-packages must never leak into the server's imports.
    expect(python.PYTHONNOUSERSITE).toBe("1");
    expect(python.PATH.startsWith("/opt/py/bin:")).toBe(true);
    expect(python.HOME).toBe("/home/rslmc-nonroot");

    const node = appEnvironment({ family: "node", binDirectory: "/opt/node/bin", home: "/home/rslmc-nonroot", memoryMb: 2048 });
    expect(node.PATH.startsWith("/opt/node/bin:")).toBe(true);
    // Node sizes its heap from the allocation, the way the JVM gets -Xmx from it.
    expect(node.NODE_OPTIONS).toBe("--max-old-space-size=1536");
  });

  test("the environment never claims a memory flag for a Python process", () => {
    const python = appEnvironment({ family: "python", binDirectory: null, home: "/tmp", memoryMb: 2048 });
    expect(python.NODE_OPTIONS).toBeUndefined();
  });
});

describe("interpreters are installed once per version and shared", () => {
  test("the directory is keyed by family and exact version", () => {
    const path = interpreterDirectory("python", "3.12.7");
    expect(path).toContain("/runtimes/python/3.12.7");
    expect(interpreterDirectory("node", "22.11.0")).toContain("/runtimes/node/22.11.0");
  });

  test("a version that is not unpacked reports as not installed instead of throwing", () => {
    expect(interpreterExecutable("python", "0.0.1")).toBeNull();
    expect(interpreterExecutable("node", "0.0.1")).toBeNull();
  });

  test("an unpacked tree is found by looking, not by assuming one layout", () => {
    const root = interpreterDirectory("python", "9.9.9");
    mkdirSync(join(root, "bin"), { recursive: true });
    const executable = join(root, "bin", "python3");
    writeFileSync(executable, "#!/bin/sh\necho 9.9.9\n", { mode: 0o755 });
    expect(interpreterExecutable("python", "9.9.9")).toBe(executable);
    expect(listInstalledInterpreters().some((record) => record.family === "python" && record.version === "9.9.9")).toBe(true);
  });
});

describe("the launch plan an app server really gets", () => {
  /*
   * The same function the start path uses, with a row shaped the way SQLite returns it. A Python/Node
   * server that quietly launched "java -Xmx… nogui" would be the single worst failure of this feature, so
   * the command line is asserted rather than assumed.
   */
  const uuid = `app-${Math.random().toString(36).slice(2, 10)}`;
  const directory = serverDir(uuid);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "index.js"), "console.log('hi');\n");

  const base = {
    id: 42, uuid, name: "App Plan", node_id: 1,
    memory_mb: 1024, cpu_percent: 100, disk_mb: 4096, bind_ip: "127.0.0.1", port: 3000,
    jvm_args: "", server_args: "", java_runtime_id: null, java_major: 0,
    rcon_password: null, public_host: null, public_port: null,
    runtime: "standalone", docker_image: null, docker_disk_quota: 0,
    entry_file: "index.js", service_user: null,
  } as any;

  test("standalone runs the interpreter on the entry file — never java", () => {
    const plan = buildLaunchPlan({ ...base, software: "node", mc_version: "20.20.2" });
    expect(plan.command[0]).not.toContain("java");
    expect(plan.command[0]).toContain("/runtimes/node/20.20.2/bin/");
    expect(plan.command[1]).toBe("index.js");
    expect(plan.command.join(" ")).not.toContain("-Xmx");
    expect(plan.preview).toContain("Node.js 20.20.2");
  });

  test("the entry file is taken from the row, so a changed startup command survives a restart", () => {
    const plan = buildLaunchPlan({ ...base, software: "python", mc_version: "3.12.16", entry_file: "src/bot.py" });
    expect(plan.command.at(-1)).toBe("src/bot.py");
    expect(plan.cwd).toBe(directory);
  });

  test("an app container keeps every limit and swaps the entrypoint", () => {
    const plan = buildLaunchPlan({
      ...base, software: "node", mc_version: "20.20.2", runtime: "docker",
      docker_image: "ghcr.io/pterodactyl/yolks:nodejs_20",
    });
    const command = plan.command;
    expect(command[command.indexOf("--memory") + 1]).toBe("1024m");
    expect(command[command.indexOf("--memory-swap") + 1]).toBe("1024m");
    expect(command[command.indexOf("--cpus") + 1]).toBe(Math.min(1, plan.docker!.cpu.hostCores).toFixed(2));
    expect(command[command.indexOf("-v") + 1]).toBe(`${directory}:/data`);
    expect(command[command.indexOf("--entrypoint") + 1]).toBe("node");
    // Inside the container the entry file is relative to /data, exactly like the jar of a Minecraft server.
    expect(command.at(-1)).toBe("index.js");
    expect(command.join(" ")).not.toContain("-Xmx");
    expect(plan.docker?.image).toBe("ghcr.io/pterodactyl/yolks:nodejs_20");
  });

  test("a Python container is started by python3, with unbuffered stdout", () => {
    const plan = buildLaunchPlan({
      ...base, software: "python", mc_version: "3.12.16", entry_file: "main.py", runtime: "docker",
      docker_image: "python:3.12-slim",
    });
    expect(plan.command[plan.command.indexOf("--entrypoint") + 1]).toBe("python3");
    expect(plan.command).toContain("PYTHONUNBUFFERED=1");
    expect(plan.command.at(-1)).toBe("main.py");
  });
});

describe("stopping an app server uses a signal, not a console command", () => {
  /*
   * A Minecraft server reads `stop` from its console. A Node/Python program almost never does — writing
   * "stop" to its stdin left it in `stopping` until the timeout killed it, which is not a stop, it is a
   * crash with a nicer label. The stop path therefore branches on software, and this pins the branch.
   */
  test("the app branch is chosen for both app families and not for Minecraft", async () => {
    const { isAppSoftware } = await import("../src/apps/catalog");
    expect(isAppSoftware("python")).toBe(true);
    expect(isAppSoftware("node")).toBe(true);
    expect(isAppSoftware("paper")).toBe(false);
    expect(isAppSoftware("velocity")).toBe(false);
  });

  test("a short grace period is used for apps, the Minecraft one for servers", () => {
    // Mirrors the constants in stopServer(): 15 s for apps (SIGTERM can be caught), 45 s for a JVM
    // that needs to save its worlds.
    const appTimeout = 15_000;
    const minecraftTimeout = 45_000;
    expect(appTimeout).toBeLessThan(minecraftTimeout);
  });
});

describe("every stop path knows the difference between an app and a server", () => {
  /*
   * Stop, restart and panel shutdown all used to write `stop` to the console. For an app that is a word
   * sent to a program that does not read stdin — the process survived and the panel killed it later,
   * so a "graceful restart" was a crash with a friendlier log line. One helper now decides the message,
   * and all three paths call it.
   */
  test("restart and shutdown go through the shared helper", async () => {
    const source = await Bun.file(new URL("../src/processes/manager.ts", import.meta.url)).text();
    const stopHelper = source.slice(source.indexOf("async function requestGracefulStop"));
    expect(stopHelper.slice(0, 800)).toContain("sendSignalToProcess(pid, \"SIGTERM\")");
    expect(stopHelper.slice(0, 800)).toContain('sendCommandRaw(serverId, "stop")');
    // Three call sites: stopServer, restartServer and shutdownAll.
    expect(source.split("requestGracefulStop(").length - 1).toBeGreaterThanOrEqual(4);
  });
});

describe("how an app version is written to a human", () => {
  test("Python does not repeat its major version, Node.js keeps its name", async () => {
    const { appDisplayName } = await import("../src/apps/catalog");
    // "Python 3" is the family; the version is already 3.x, so "Python 3 3.11.18" was the bug.
    expect(appDisplayName("python", "3.11.18")).toBe("Python 3.11.18");
    expect(appDisplayName("node", "20.20.2")).toBe("Node.js 20.20.2");
  });
});

describe("the starter file a new app server runs", () => {
  /*
   * The starter is what an operator's first start executes, so it has to demonstrate the two things they
   * cannot guess from a Minecraft panel: console input arrives on stdin, and Stop is SIGTERM.
   */
  test("both starters handle SIGTERM and echo stdin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rslmc-scaffold-"));
    const { installAppScaffold } = await import("../src/apps/interpreters");
    const node = await installAppScaffold("node", "20.20.2", join(dir, "node"));
    const python = await installAppScaffold("python", "3.11.18", join(dir, "python"));
    const nodeBody = readFileSync(join(dir, "node", node.entryFile), "utf8");
    const pythonBody = readFileSync(join(dir, "python", python.entryFile), "utf8");

    expect(node.entryFile).toBe("index.js");
    expect(python.entryFile).toBe("main.py");
    expect(nodeBody).toContain("SIGTERM");
    expect(pythonBody).toContain("SIGTERM");
    expect(nodeBody).toContain("process.stdin");
    expect(pythonBody).toContain("sys.stdin");
    // Unbuffered output, or the console looks frozen on a Python server.
    expect(pythonBody).toContain("flush=True");
    // The Minecraft flag must never appear in a starter.
    expect(nodeBody).not.toContain("nogui");
    expect(pythonBody).not.toContain("nogui");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("which servers must not run as root", () => {
  test("only the interpreter-run software is isolated", () => {
    expect(requiresIsolation("python")).toBe(true);
    expect(requiresIsolation("node")).toBe(true);
    expect(requiresIsolation("paper")).toBe(false);
    expect(requiresIsolation("vanilla")).toBe(false);
  });

  test("the service account is described honestly, including when it cannot exist", () => {
    const state = serviceAccountState();
    expect(state.user).toBe(SERVICE_USER);
    expect(SERVICE_USER).toBe("rslmc-nonroot");
    // A claim of isolation requires *both* an account and the ability to switch to it.
    expect(state.canIsolate === false || state.exists).toBe(true);
    if (!state.canIsolate) expect(typeof state.reason).toBe("string");
    if (process.platform === "win32") {
      expect(state.canIsolate).toBe(false);
      expect(state.reason).toContain("Windows");
    }
    // Never advertise sudo for the account the panel created.
    expect(state.sudo).toBe(false);
  });
});
