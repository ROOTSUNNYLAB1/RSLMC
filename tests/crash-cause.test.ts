import { describe, expect, test } from "bun:test";
import { explainCrash } from "../src/processes/crash-cause";

/*
 * The panel used to answer a dead server with "Server process exited unexpectedly (code 0)" and
 * nothing else — true, and useless. These cases pin the explanations that replace it, using console
 * text copied from real runs (Paper 1.21.4 on a 512 MB allocation, and a kernel OOM kill).
 */

describe("explainCrash()", () => {
  test("names a Java heap exhaustion and mentions the allocation", () => {
    const cause = explainCrash({
      lines: [
        "Starting org.bukkit.craftbukkit.Main",
        "java.lang.OutOfMemoryError: Java heap space",
        "\tat net.minecraft.world.level.block.Blocks.<clinit>(Blocks.java:6950)",
        "Process exited (code 0).",
      ],
      exitCode: 0,
      signalCode: null,
      memoryMb: 512,
    });
    expect(cause.kind).toBe("out_of_memory");
    expect(cause.message).toContain("OutOfMemoryError");
    expect(cause.message).toContain("512 MB");
  });

  test("separates native-memory and thread failures from heap exhaustion", () => {
    const cause = explainCrash({
      lines: ["java.lang.OutOfMemoryError: unable to create native thread: possibly out of memory"],
      exitCode: 1,
    });
    expect(cause.kind).toBe("native_threads");
  });

  test("a SIGKILL is reported as the kernel killing the process", () => {
    const cause = explainCrash({ lines: ["[Server thread/INFO]: Preparing level"], signalCode: "SIGKILL" });
    expect(cause.kind).toBe("killed");
    expect(cause.message).toContain("SIGKILL");
  });

  test("a bind failure is reported as a port clash", () => {
    const cause = explainCrash({
      lines: ["[Server thread/WARN]: **** FAILED TO BIND TO PORT!", "Address already in use"],
      exitCode: 1,
    });
    expect(cause.kind).toBe("port_in_use");
  });

  test("an unreadable world points at backups", () => {
    const cause = explainCrash({ lines: ["java.io.IOException: level.dat is not a valid world file"], exitCode: 1 });
    expect(cause.kind).toBe("world_corrupt");
    expect(cause.message).toContain("Backups");
  });

  test("says so honestly when nothing in the log explains the exit", () => {
    const cause = explainCrash({ lines: ["[Server thread/INFO]: Stopping server"], exitCode: 3 });
    expect(cause.kind).toBe("unknown");
    expect(cause.message).toContain("code 3");
    expect(cause.message).toContain("does not name a cause");
  });

  test("accepts raw strings as well as ConsoleLine objects", () => {
    const cause = explainCrash({ lines: ["java.lang.OutOfMemoryError: Java heap space"], exitCode: 0 });
    expect(cause.kind).toBe("out_of_memory");
  });
});
