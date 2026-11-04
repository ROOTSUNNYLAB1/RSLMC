import { describe, expect, test } from "bun:test";
import { probeDocker, containerNameFor, inspectContainer, killContainer, containerStats, dockerCommand } from "../src/runtime/docker";

/*
 * The real thing: start a container through the Docker CLI, read its limits back from the daemon, and
 * kill it. Nothing here is mocked — it asserts on what Docker itself reports.
 *
 * It only runs when asked (`RSLMC_TEST_DOCKER=1`) and when a daemon actually answers, because a CI
 * machine without Docker is a normal machine, not a failing one. The panel's own claim — "memory and
 * CPU are hard limits in a container" — is exactly what this verifies, so it must be runnable on
 * demand:
 *
 *   RSLMC_TEST_DOCKER=1 bun test tests/docker-live.test.ts
 */

const docker = probeDocker(true);
const enabled = process.env.RSLMC_TEST_DOCKER === "1" && docker.available;
const IMAGE = process.env.RSLMC_TEST_DOCKER_IMAGE ?? "eclipse-temurin:21-jre";

describe("a real container", () => {
  if (!enabled) {
    test.skip(`skipped: ${docker.available ? "set RSLMC_TEST_DOCKER=1 to run" : `Docker is not usable (${docker.reason})`}`, () => {});
    return;
  }

  const name = containerNameFor(`test-${Date.now()}`);

  test("the image is present or can be pulled", async () => {
    const present = dockerCommand(["image", "inspect", IMAGE], 15_000).ok;
    if (!present) {
      const pulled = dockerCommand(["pull", IMAGE], 300_000);
      expect(pulled.ok).toBe(true);
    }
    expect(dockerCommand(["image", "inspect", IMAGE], 15_000).ok).toBe(true);
  }, 320_000);

  test("the daemon reports the limits the panel passes", async () => {
    // -d keeps this test short; the panel runs in the foreground with -i so it can keep the console.
    const run = dockerCommand(
      ["run", "-d", "--rm", "--name", name, "--memory", "256m", "--memory-swap", "256m", "--cpus", "0.5",
        "--entrypoint", "sleep", IMAGE, "60"],
      120_000,
    );
    expect(run.ok).toBe(true);

    const inspect = dockerCommand(["inspect", "--format", "{{json .HostConfig}}", name], 20_000);
    expect(inspect.ok).toBe(true);
    const host = JSON.parse(inspect.stdout) as Record<string, number>;
    expect(host.Memory).toBe(256 * 1024 * 1024);
    expect(host.MemorySwap).toBe(256 * 1024 * 1024);
    expect(host.NanoCpus).toBe(500_000_000);

    const state = inspectContainer(name);
    expect(state.exists).toBe(true);
    expect(state.running).toBe(true);
  }, 180_000);

  test("usage is measured by the daemon", async () => {
    const stats = containerStats(name, 30_000);
    expect(stats.memoryBytes).not.toBeNull();
    expect(stats.memoryBytes!).toBeGreaterThan(0);
    // The limit Docker reports back is the one that was asked for.
    expect(stats.memoryLimitBytes).toBe(256 * 1024 * 1024);
  }, 60_000);

  test("killing through the panel's helper really removes it", async () => {
    const result = killContainer(name);
    expect(result.ok).toBe(true);
    const after = inspectContainer(name);
    expect(after.exists).toBe(false);
  }, 60_000);
});
