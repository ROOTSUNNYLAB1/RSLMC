import { describe, expect, test } from "bun:test";
import {
  AIKAR_FLAGS, LOW_MEMORY_FLAGS, PROXY_FLAGS, JVM_PRESETS, heapMbFor, overheadMbFor, initialHeapMbFor,
  defaultJvmArgsFor, detectJvmPreset, presetById, allocationAdvice,
} from "../src/minecraft/jvm-presets";
import { MIN_ALLOCATION_MB } from "../src/shared/memory";

describe("JVM flag presets", () => {
  test("game servers get Aikar's G1GC set", () => {
    const flags = defaultJvmArgsFor("paper", 4096);
    expect(flags).toBe(AIKAR_FLAGS);
    expect(flags).toContain("-XX:+UseG1GC");
    expect(flags).toContain("-XX:MaxGCPauseMillis=200");
    expect(flags).toContain("-XX:G1NewSizePercent=30");
    expect(flags).toContain("-Daikars.new.flags=true");
  });

  test("proxies get the small-heap set", () => {
    expect(defaultJvmArgsFor("velocity", 512)).toBe(PROXY_FLAGS);
    expect(defaultJvmArgsFor("bungeecord", 512)).toBe(PROXY_FLAGS);
    expect(PROXY_FLAGS).not.toContain("G1NewSizePercent");
  });

  test("small heaps fall back to SerialGC, larger ones get G1", () => {
    expect(defaultJvmArgsFor("paper", 512)).toBe(LOW_MEMORY_FLAGS);
    expect(defaultJvmArgsFor("paper", 1024)).toBe(LOW_MEMORY_FLAGS);
    expect(defaultJvmArgsFor("paper", 1536)).toBe(AIKAR_FLAGS);
    expect(defaultJvmArgsFor("paper", 2048)).toBe(AIKAR_FLAGS);
  });

  test("native memory is capped so an idle server cannot grow into the whole box", () => {
    for (const flags of [AIKAR_FLAGS, PROXY_FLAGS, LOW_MEMORY_FLAGS]) {
      expect(flags).toContain("-XX:MaxMetaspaceSize=");
      expect(flags).not.toContain("AlwaysPreTouch");
    }
    expect(LOW_MEMORY_FLAGS).toContain("-XX:MaxDirectMemorySize=128M");
  });

  test("memory flags are never part of a preset (the allocation owns -Xms/-Xmx)", () => {
    for (const preset of JVM_PRESETS) {
      expect(preset.flags).not.toContain("-Xmx");
      expect(preset.flags).not.toContain("-Xms");
    }
  });

  test("preset detection round-trips", () => {
    expect(detectJvmPreset(AIKAR_FLAGS)).toBe("aikar");
    expect(detectJvmPreset(PROXY_FLAGS)).toBe("proxy");
    expect(detectJvmPreset(LOW_MEMORY_FLAGS)).toBe("lowmem");
    // Order and duplicate whitespace do not matter.
    expect(detectJvmPreset(`  ${AIKAR_FLAGS.replace(/ /g, "   ")}  `)).toBe("aikar");
    expect(detectJvmPreset("")).toBe("custom");
    expect(detectJvmPreset("-XX:+UseZGC")).toBe("custom");
  });

  test("preset catalogue exposes exactly one recommended default", () => {
    const recommended = JVM_PRESETS.filter((preset) => preset.recommended);
    expect(recommended).toHaveLength(1);
    expect(recommended[0]!.id).toBe("aikar");
    expect(presetById("custom")?.flags).toBe("");
  });
  test("heap stays below the allocation so the kernel cap is never hit", () => {
    expect(heapMbFor(1024)).toBe(704);
    expect(overheadMbFor(1024)).toBe(320);
    // Below 1 GB the reserve scales with the budget instead of eating it.
    expect(heapMbFor(768)).toBe(576);
    expect(overheadMbFor(768)).toBe(192);
    expect(heapMbFor(512)).toBe(384);
    expect(heapMbFor(2048)).toBe(1536);
    expect(heapMbFor(4096)).toBe(3584);
    expect(heapMbFor(16384)).toBe(15872);
    // The smallest allowed allocation (128 MB) keeps a small heap instead of a negative one.
    expect(heapMbFor(128)).toBe(96);
    expect(overheadMbFor(128)).toBe(32);
    expect(heapMbFor(0)).toBe(96);   // clamped to the minimum, never a negative heap
    expect(heapMbFor(256)).toBe(192);
    for (const allocation of [256, 640, 1024, 2048, 8192]) {
      expect(heapMbFor(allocation)).toBeLessThan(allocation);
      expect(heapMbFor(allocation) + overheadMbFor(allocation)).toBe(allocation);
    }
  });
  test("initial heap is smaller than the max heap and never reserves the whole allocation", () => {
    expect(initialHeapMbFor(1024)).toBe(352);
    expect(initialHeapMbFor(2048)).toBe(768);
    expect(initialHeapMbFor(8192)).toBe(2048);
    expect(initialHeapMbFor(512)).toBe(256);  // heap 384 → initial 256
    expect(initialHeapMbFor(4096)).toBe(1792);
    for (const allocation of [512, 1024, 2048, 4096, 8192]) {
      expect(initialHeapMbFor(allocation)).toBeLessThanOrEqual(heapMbFor(allocation));
    }
    // AlwaysPreTouch would fault in the entire heap at boot — it must not come back.
    for (const flags of [AIKAR_FLAGS, PROXY_FLAGS, LOW_MEMORY_FLAGS]) {
      expect(flags).not.toContain("AlwaysPreTouch");
    }
  });
  test("the allocation floor is 128 MB and small values are accepted with honest advice", () => {
    expect(MIN_ALLOCATION_MB).toBe(128);
    expect(allocationAdvice(1024)).toBeNull();
    expect(allocationAdvice(2048)).toBeNull();
    expect(allocationAdvice(128)).toContain("out-of-memory");
    expect(allocationAdvice(512)).toContain("384 MB");
    expect(allocationAdvice(64)).toContain("minimum allocation is 128 MB");
    // Whatever the operator picks, heap + reserve adds up and the heap stays usable.
    for (const allocation of [128, 192, 256, 512, 1024, 2048, 8192]) {
      expect(heapMbFor(allocation) + overheadMbFor(allocation)).toBe(allocation);
      expect(heapMbFor(allocation)).toBeGreaterThanOrEqual(96);
    }
  });
});
