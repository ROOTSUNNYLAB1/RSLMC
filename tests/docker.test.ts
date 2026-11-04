import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/*
 * Docker support, tested for what it claims.
 *
 * Two kinds of test live here:
 *
 *   1. Pure logic — size/percentage parsing, image selection, container naming. These run everywhere.
 *   2. The launch plan — the actual `docker run` command line, built by the same function the panel
 *      uses at start time. A container server that starts but silently ignores `--memory` would be
 *      worse than no Docker support at all, so the flags are asserted, not assumed.
 *
 * A third kind is deliberately *not* here: starting a real container needs a daemon, an image pull
 * and a machine with cgroups, so it lives in `tests/docker-live.test.ts` and only runs when asked.
 */

process.env.RSLMC_DATA_DIR = process.env.RSLMC_DATA_DIR ?? mkdtempSync(join(tmpdir(), "rslmc-docker-"));

const docker = await import("../src/runtime/docker");
const images = await import("../src/runtime/images");
const { buildLaunchPlan } = await import("../src/processes/manager");

describe("Docker's human units", () => {
  test("binary units from `docker stats` are bytes, not zero", () => {
    // The bug this pins: "463.6MiB" was unparseable, so a container using half a gigabyte reported 0 MB.
    expect(docker.parseSize("463.6MiB")).toBe(486119834);
    expect(docker.parseSize("900MiB")).toBe(943718400);
    expect(docker.parseSize("1GiB")).toBe(1024 ** 3);
  });

  test("decimal units from `docker image ls` are bytes", () => {
    expect(docker.parseSize("1.24GB")).toBe(1_240_000_000);
    expect(docker.parseSize("612MB")).toBe(612_000_000);
    expect(docker.parseSize("0B")).toBe(0);
  });

  test("anything unparseable is zero, never NaN", () => {
    expect(docker.parseSize("")).toBe(0);
    expect(docker.parseSize("n/a")).toBe(0);
  });

  test("percentages", () => {
    expect(docker.parsePercent("101.89%")).toBe(101.89);
    expect(docker.parsePercent("0.00%")).toBe(0);
    expect(docker.parsePercent("—")).toBeNull();
  });
});

describe("naming and selection", () => {
  test("the container name is derived from the server uuid, so it survives the row", () => {
    expect(docker.containerNameFor("86de0f81-5bd7-4e6a-85c4-bffb02137965"))
      .toBe("rslmc-86de0f81-5bd7-4e6a-85c4-bffb02137965");
  });

  test("a yolks tag is used only when the registry actually lists it", () => {
    const tags = new Set(["java_8", "java_17", "java_21"]);
    expect(images.imageForMajor(21, tags).reference).toBe("ghcr.io/pterodactyl/yolks:java_21");
    expect(images.imageForMajor(21, tags).source).toBe("yolks");
  });

  test("a major with no yolks tag falls back to Temurin instead of a broken reference", () => {
    const fallback = images.imageForMajor(24, new Set(["java_8", "java_21"]));
    expect(fallback.reference).toBe("eclipse-temurin:24-jre");
    expect(fallback.source).toBe("temurin");
  });

  test("every major from 8 to 25 has an image", () => {
    const tags = new Set(["java_8", "java_11", "java_16", "java_17", "java_21", "java_22", "java_23", "java_24", "java_25"]);
    for (const major of images.ALL_JAVA_MAJORS) {
      const image = images.imageForMajor(major, tags);
      expect(image.reference.length).toBeGreaterThan(5);
      expect(image.major).toBe(major);
    }
    expect(images.ALL_JAVA_MAJORS[0]).toBe(8);
    expect(images.ALL_JAVA_MAJORS.at(-1)).toBe(25);
  });
});

describe("the daemon probe tells the truth", () => {
  test("a binary that does not exist is reported as missing, not as a working daemon", () => {
    const previous = process.env.RSLMC_DOCKER_BIN;
    process.env.RSLMC_DOCKER_BIN = "/nonexistent/rslmc-no-docker";
    try {
      const info = docker.probeDocker(true);
      expect(info.available).toBe(false);
      // The wording changed on purpose: "not found" was wrong for a snap install the panel's PATH cannot
      // see. What is true in every case is that the panel could not execute it.
      expect(String(info.reason)).toContain("could not be executed");
      // And it names the override that is failing, instead of blaming the machine.
      expect(String(info.reason)).toContain("/nonexistent/rslmc-no-docker");
    } finally {
      if (previous === undefined) delete process.env.RSLMC_DOCKER_BIN;
      else process.env.RSLMC_DOCKER_BIN = previous;
      docker.probeDocker(true);
    }
  });
});

describe("the container launch plan", () => {
  /*
   * buildLaunchPlan addresses files the way the panel does: <data>/servers/<uuid>. The test builds a
   * real directory in the same shape instead of inventing a path, so the bind mount and the jar path
   * are checked against what a start would really see.
   */
  const uuid = `plan-${Math.random().toString(36).slice(2, 10)}`;
  const dir = join(process.env.RSLMC_DATA_DIR!, "servers", uuid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "server.jar"), "not a real jar");

  /* A row shaped exactly like the one buildLaunchPlan receives from SQLite. */
  const row = {
    id: 7,
    uuid,
    name: "Plan Test",
    software: "paper",
    mc_version: "1.21.4",
    java_major: 21,
    memory_mb: 2048,
    cpu_percent: 250,
    disk_mb: 10240,
    bind_ip: "0.0.0.0",
    port: 25565,
    jvm_args: "-XX:+UseG1GC",
    server_args: "nogui",
    java_runtime_id: null,
    rcon_password: "secret-rcon",
    public_host: null,
    public_port: null,
    runtime: "docker",
    docker_image: "ghcr.io/pterodactyl/yolks:java_21",
    docker_disk_quota: 0,
  } as any;

  test("it is a real `docker run`, in the foreground, with a console", () => {
    const plan = buildLaunchPlan({ ...row, uuid } as any);
    const command = plan.command;
    expect(command[1]).toBe("run");
    // `-i` keeps stdin open: that is how `stop` and console commands reach the JVM.
    expect(command).toContain("-i");
    expect(command).toContain("--rm");
    expect(command).toContain("--name");
    expect(command[command.indexOf("--name") + 1]).toStartWith("rslmc-");
    expect(plan.docker?.image).toBe("ghcr.io/pterodactyl/yolks:java_21");
  }, 30_000);

  test("memory and CPU become hard limits", () => {
    const plan = buildLaunchPlan({ ...row, uuid } as any);
    const command = plan.command;
    expect(command[command.indexOf("--memory") + 1]).toBe("2048m");
    // swap is pinned to the same value, so the JVM cannot silently dip into swap past its budget
    expect(command[command.indexOf("--memory-swap") + 1]).toBe("2048m");
    expect(command[command.indexOf("--cpus") + 1]).toBe("2.50");
  }, 30_000);

  test("the server directory is bind-mounted at /data and the jar path is translated", () => {
    const plan = buildLaunchPlan({ ...row, uuid } as any);
    const command = plan.command;
    expect(command[command.indexOf("-v") + 1]).toBe(`${dir}:/data`);
    expect(command[command.indexOf("-w") + 1]).toBe("/data");
    // Inside the container the host path does not exist; the jar must be addressed as /data/server.jar.
    expect(command).toContain("/data/server.jar");
    expect(command.join(" ")).not.toContain(`${dir}/server.jar`);
  }, 30_000);

  test("the JVM heap still comes from the allocation, and the JVM flags survive", () => {
    const plan = buildLaunchPlan({ ...row, uuid } as any);
    const command = plan.command;
    expect(command.some((part) => part.startsWith("-Xmx"))).toBe(true);
    expect(command).toContain("-XX:+UseG1GC");
    expect(command[command.indexOf("--entrypoint") + 1]).toBe("java");
    expect(command.at(-1)).toBe("nogui");
  }, 30_000);

  test("a disk quota is only promised when the daemon accepted one", () => {
    const without = buildLaunchPlan({ ...row, uuid, docker_disk_quota: 0 } as any);
    expect(without.command).not.toContain("--storage-opt");
    const with_ = buildLaunchPlan({ ...row, uuid, docker_disk_quota: 1 } as any);
    expect(with_.command[with_.command.indexOf("--storage-opt") + 1]).toBe("size=10240m");
  }, 30_000);

  test("the rcon password is passed through the environment, not the command line preview", () => {
    const plan = buildLaunchPlan({ ...row, uuid } as any);
    expect(plan.command).toContain("RSLMC_RCON_PASSWORD=secret-rcon");
    expect(plan.preview).not.toContain("secret-rcon");
  }, 30_000);

  test("standalone servers are unaffected — no docker anywhere in the plan", () => {
    const plan = buildLaunchPlan({ ...row, uuid, runtime: "standalone" } as any);
    expect(plan.command[0]).not.toContain("docker");
    expect(plan.docker ?? null).toBeNull();
    expect(plan.command.join(" ")).toContain("-jar");
  }, 30_000);

  test("the preview says what will be enforced, in plain words", () => {
    const plan = buildLaunchPlan({ ...row, uuid } as any);
    expect(plan.preview).toContain("2048 MB");
    expect(plan.preview).toContain("2.50");
  }, 30_000);

  // Cleanup: the temp dir is removed at exit rather than per test, so the row stays usable.
  process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
});


/*
 * "Docker works in my shell but the panel says it is not available."
 *
 * That was a real report: the operator's shell was root, the panel ran as an unprivileged user, and the
 * socket is root:docker 0660. The old message said "start the daemon", which is the wrong advice and
 * sends people hunting in the wrong place. These tests drive a fake CLI so the *diagnosis* is asserted,
 * not just the fact that a daemon is missing.
 */
describe("access diagnosis", () => {
  const fake = (body: string) => {
    const path = join(tmpdir(), `rslmc-fake-docker-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return path;
  };

  test("a socket the panel's account cannot open is reported as a group problem", () => {
    // What the real daemon returns: exit code 0, empty fields, and the error inside ServerErrors.
    const binary = fake(
      'cat <<JSON\n{"ServerVersion":"","Driver":"","ServerErrors":["permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock"]}\nJSON',
    );
    const previous = process.env.RSLMC_DOCKER_BIN;
    process.env.RSLMC_DOCKER_BIN = binary;
    try {
      const info = docker.probeDocker(true);
      expect(info.available).toBe(false);
      const access = info.access!;
      expect(access).toBeTruthy();
      expect(access.endpoint).toContain("docker.sock");
      expect(access.hints.length).toBeGreaterThan(0);
      // The fix must name the group and the restart, because adding the group alone does not help.
      const all = access.hints.join(" ");
      expect(all).toMatch(/docker group|usermod/);
      expect(all).toMatch(/restart/i);
      // And it must say which account is affected.
      expect(all).toContain(access.user);
    } finally {
      if (previous === undefined) delete process.env.RSLMC_DOCKER_BIN;
      else process.env.RSLMC_DOCKER_BIN = previous;
      docker.probeDocker(true);
    }
  }, 60_000);

  test("a missing daemon is reported as a missing daemon, with the start command", () => {
    const binary = fake('cat <<JSON\n{"ServerVersion":"","ServerErrors":["Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"]}\nJSON');
    const previous = process.env.RSLMC_DOCKER_BIN;
    process.env.RSLMC_DOCKER_BIN = binary;
    try {
      const info = docker.probeDocker(true);
      expect(info.available).toBe(false);
      const hints = (info.access?.hints ?? []).join(" ");
      expect(hints).toMatch(/systemctl start docker|Docker Desktop/);
      // It must not blame a permission problem that does not exist.
      expect(hints).not.toMatch(/usermod/);
    } finally {
      if (previous === undefined) delete process.env.RSLMC_DOCKER_BIN;
      else process.env.RSLMC_DOCKER_BIN = previous;
      docker.probeDocker(true);
    }
  }, 60_000);

  test("RSLMC_DOCKER_HOST decides which daemon is contacted", () => {
    const previousHost = process.env.RSLMC_DOCKER_HOST;
    process.env.RSLMC_DOCKER_HOST = "unix:///run/user/1000/docker.sock";
    try {
      expect(docker.dockerEndpoint()).toBe("unix:///run/user/1000/docker.sock");
      expect(docker.dockerHostArgs()).toEqual(["-H", "unix:///run/user/1000/docker.sock"]);
    } finally {
      if (previousHost === undefined) delete process.env.RSLMC_DOCKER_HOST;
      else process.env.RSLMC_DOCKER_HOST = previousHost;
    }
    expect(docker.dockerHostArgs()).toEqual([]);
  });
});

/*
 * "The panel always runs as root."
 *
 * That correction exposed the shape of the bug: the first fix assumed the panel was unprivileged, so a
 * root-run panel was told to join a group it does not need and could not act on. Root can open a 0660
 * socket, so a refusal means something else entirely — a different endpoint (rootless, Podman, a CLI
 * context), a socket that was never mounted into the panel's own container, or a security module. The
 * branches are asserted here with constructed facts, because a test cannot become root.
 */
describe("diagnosis for an already-privileged panel", () => {
  const facts = (over: Partial<any> = {}): any => ({
    user: "root",
    uid: 0,
    elevated: true,
    platformLabel: "linux",
    groups: ["root"],
    endpoint: "unix:///var/run/docker.sock",
    endpointSource: "default",
    socketExists: true,
    socketMode: "mode 660",
    socketGroup: "docker",
    groupMissing: false,
    alternatives: [],
    inContainer: false,
    environment: {
      platform: "linux", path: "/usr/local/sbin:/usr/bin", home: "/root",
      dockerHost: null, dockerContext: null, binEnv: null, cliContext: null,
    },
    binaries: [{ path: "/usr/bin/docker", exists: true }],
    evidence: null,
    hints: [],
    ...over,
  });

  test("a refusal is never blamed on group membership", () => {
    const hints = docker.hintsForFacts(facts(), "permission denied while trying to connect to the Docker daemon socket").join(" ");
    expect(hints).toMatch(/not a group problem/);
    expect(hints).not.toMatch(/usermod/);
    // It must name the two things that are actually left, and how to compare with the working shell.
    expect(hints).toMatch(/rootless|Podman/);
    expect(hints).toMatch(/docker context ls/);
  });

  test("an alternative socket is offered as a concrete endpoint, not as trivia", () => {
    const hints = docker.hintsForFacts(
      facts({ alternatives: ["/run/user/1000/docker.sock"] }),
      "permission denied while trying to connect to the Docker daemon socket",
    ).join(" ");
    expect(hints).toContain("/run/user/1000/docker.sock");
    expect(hints).toMatch(/Docker endpoint/);
  });

  test("root inside a container is told to mount the socket, not to start a daemon", () => {
    const hints = docker.hintsForFacts(
      facts({ inContainer: true, socketExists: false, socketMode: null, socketGroup: null }),
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    ).join(" ");
    expect(hints).toMatch(/inside a container/);
    expect(hints).toMatch(/docker\.sock:\/var\/run\/docker\.sock/);
    expect(hints).not.toMatch(/^Nothing is answering/);
  });

  test("the CLI context is called out, because it overrides the socket invisibly", () => {
    const hints = docker.hintsForFacts(
      facts({ environment: { ...facts().environment, cliContext: "desktop-linux" } }),
      "permission denied while trying to connect to the Docker daemon socket",
    ).join(" ");
    expect(hints).toContain("desktop-linux");
    expect(hints).toMatch(/config\.json/);
  });

  test("an unprivileged panel still gets the group advice, restart included", () => {
    const hints = docker.hintsForFacts(
      facts({ user: "user", uid: 1000, elevated: false, groups: ["sudo", "user"], groupMissing: true }),
      "permission denied while trying to connect to the Docker daemon socket",
    ).join(" ");
    expect(hints).toMatch(/usermod -aG docker user/);
    expect(hints).toMatch(/restart/);
  });
});

describe("the endpoint the panel really uses", () => {
  test("a saved endpoint is used, and reported as its own source", () => {
    try {
      docker.setDockerConfigOverride({ host: "unix:///run/podman/podman.sock", bin: null });
      expect(docker.dockerEndpoint()).toBe("unix:///run/podman/podman.sock");
      expect(docker.dockerEndpointSource()).toBe("panel setting");
      // The bug this pins: dockerHostArgs() existed, was tested, and was never applied to any command,
      // so RSLMC_DOCKER_HOST changed the label in the UI and nothing else.
      expect(docker.dockerHostArgs()).toEqual(["-H", "unix:///run/podman/podman.sock"]);
    } finally {
      docker.setDockerConfigOverride(null);
    }
  });

  test("RSLMC_DOCKER_HOST still beats the saved value", () => {
    const previousHost = process.env.RSLMC_DOCKER_HOST;
    try {
      docker.setDockerConfigOverride({ host: "unix:///saved.sock", bin: null });
      process.env.RSLMC_DOCKER_HOST = "unix:///from-env.sock";
      expect(docker.dockerEndpoint()).toBe("unix:///from-env.sock");
      expect(docker.dockerEndpointSource()).toBe("RSLMC_DOCKER_HOST");
    } finally {
      docker.setDockerConfigOverride(null);
      if (previousHost === undefined) delete process.env.RSLMC_DOCKER_HOST;
      else process.env.RSLMC_DOCKER_HOST = previousHost;
    }
  });

  test("the endpoint reaches the actual command line, and is quoted for the operator", () => {
    const path = join(tmpdir(), `rslmc-fake-docker-argv-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(path, '#!/bin/sh\necho "argv: $@" >&2\nexit 1\n', { mode: 0o755 });
    const previous = process.env.RSLMC_DOCKER_BIN;
    process.env.RSLMC_DOCKER_BIN = path;
    try {
      const info = docker.probeDocker(true);
      expect(info.available).toBe(false);
      const evidence = info.access!.evidence;
      expect(evidence).toBeTruthy();
      // The evidence is the real argv: binary, any host override, then the subcommand.
      expect(evidence!.command).toContain(path);
      expect(evidence!.command).toContain("info");
      expect(evidence!.stderr).toContain("argv:");
      expect(evidence!.exitCode).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.RSLMC_DOCKER_BIN;
      else process.env.RSLMC_DOCKER_BIN = previous;
      docker.probeDocker(true);
    }
  }, 60_000);

  test("environment the CLI would inherit is reported, not hidden", () => {
    const previous = process.env.DOCKER_CONTEXT;
    process.env.DOCKER_CONTEXT = "desktop-linux";
    try {
      const access = docker.diagnoseAccess("cannot connect to the Docker daemon");
      expect(access.environment.dockerContext).toBe("desktop-linux");
      expect(access.elevated).toBe(typeof process.getuid === "function" ? process.getuid() === 0 : access.elevated);
      expect(Array.isArray(access.binaries)).toBe(true);
      expect(access.binaries.every((entry) => typeof entry.exists === "boolean")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.DOCKER_CONTEXT;
      else process.env.DOCKER_CONTEXT = previous;
    }
  });

  test("a CLI that cannot be executed lists the paths that were searched", () => {
    const previous = process.env.RSLMC_DOCKER_BIN;
    process.env.RSLMC_DOCKER_BIN = "/nonexistent/rslmc-test-docker";
    try {
      const info = docker.probeDocker(true);
      expect(info.available).toBe(false);
      const access = info.access!;
      const hints = access.hints.join(" ");
      expect(hints).toMatch(/PATH/);
      expect(access.binaries.length).toBeGreaterThan(0);
      // A snap install must be considered, because a service's PATH does not include /snap/bin.
      expect(access.binaries.some((entry) => entry.path.includes("/snap/bin"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.RSLMC_DOCKER_BIN;
      else process.env.RSLMC_DOCKER_BIN = previous;
      docker.probeDocker(true);
    }
  }, 60_000);
});
