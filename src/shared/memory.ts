/**
 * Memory allocation vs. Java heap — shared by the server and the panel UI so both always print the
 * same numbers.
 *
 * The allocation is the budget: on Linux it is the kernel cap for the *whole* process
 * (`memory.max` in the server's cgroup), otherwise it is the value the panel enforces through the
 * JVM. A JVM needs room on top of the heap for metaspace, code cache, GC bookkeeping, thread stacks
 * and Netty buffers — with `-Xmx == allocation` the kernel kills the server a few seconds into
 * startup ("Server process exited unexpectedly (code signal SIGKILL)") and, before that, the memory
 * card reads ~100 % even while the server is idle.
 *
 * Measured on a Paper 1.21.4 + ViaVersion server, the non-heap side sits at roughly 250–320 MB
 * (metaspace ~120–190 MB, code cache ~40–90 MB, GC structures, ~40 thread stacks, direct buffers).
 * Above 1 GB the reserve is therefore `max(320 MB, 25 %)` capped at 512 MB; smaller allocations
 * scale their reserve down with the allocation (see `overheadMbFor`) so a 128 MB server still has a
 * heap at all:
 *
 * | Allocation | Heap (-Xmx) | Reserved for the JVM itself |
 * | ---------- | ----------- | --------------------------- |
 * | 128 MB     | 96 MB       | 32 MB                       |
 * | 512 MB     | 384 MB      | 128 MB                      |
 * | 1024 MB    | 704 MB      | 320 MB                      |
 * | 2048 MB    | 1536 MB     | 512 MB                      |
 * | 4096 MB    | 3584 MB     | 512 MB                      |
 *
 * The allocation may be as small as `MIN_ALLOCATION_MB` (128 MB). A Minecraft server that small
 * cannot hold a world — the panels says so in the UI instead of refusing the number, because the
 * allocation is the operator's budget, not the panel's opinion.
 *
 * Nothing here is silent: the exact `-Xms`/`-Xmx`/overhead numbers are part of the launch command,
 * are shown on the Startup page and are returned by the API next to the allocation.
 */
export const MIN_ALLOCATION_MB = 128;
export const MAX_ALLOCATION_MB = 65536;

/** A JVM cannot run with less than this, so a heap is never shrunk below it. */
export const MIN_HEAP_MB = 96;

export const JVM_RUNTIME_OVERHEAD_MIN_MB = 320;
export const JVM_RUNTIME_OVERHEAD_MAX_MB = 512;

function clampAllocation(allocationMb: number): number {
  const value = Math.round(Number(allocationMb) || 0);
  return Math.max(MIN_ALLOCATION_MB, Math.min(MAX_ALLOCATION_MB, value));
}

export function overheadMbFor(allocationMb: number): number {
  const allocation = clampAllocation(allocationMb);
  // Big allocations: the JVM's own footprint is roughly constant, so reserve a flat (or 25 %) chunk.
  // Small allocations: there is nothing to reserve at that scale — scale it down with the budget.
  const scaled = allocation >= 1024
    ? Math.min(JVM_RUNTIME_OVERHEAD_MAX_MB, Math.max(JVM_RUNTIME_OVERHEAD_MIN_MB, Math.round(allocation * 0.25)))
    : Math.round(allocation * 0.25);
  return Math.max(0, Math.min(scaled, allocation - MIN_HEAP_MB));
}

export function heapMbFor(allocationMb: number): number {
  const allocation = clampAllocation(allocationMb);
  return Math.max(MIN_HEAP_MB, allocation - overheadMbFor(allocation));
}

/**
 * Initial heap (`-Xms`).
 *
 * `-Xms == -Xmx` makes the JVM reserve *and* commit the whole heap the moment it boots, so an empty
 * server already sat at 100 % of its memory card. RSLMC starts at half the heap (at least 256 MB,
 * at most 2 GB) and lets the collector grow into `-Xmx` on demand. The ceiling never changes — only
 * how much of it is resident.
 */
export const INITIAL_HEAP_FRACTION = 0.5;
export const INITIAL_HEAP_MAX_MB = 2048;

export function initialHeapMbFor(allocationMb: number): number {
  const heap = heapMbFor(allocationMb);
  const initial = Math.max(256, Math.round(heap * INITIAL_HEAP_FRACTION));
  return Math.min(heap, initial, INITIAL_HEAP_MAX_MB);
}

/**
 * Honest guidance for small allocations. Returns null when the value is in a sane range.
 *
 * Nothing is blocked: the operator sets the budget, the panel explains what it means.
 */
export function allocationAdvice(allocationMb: number): string | null {
  const allocation = Number(allocationMb) || 0;
  if (allocation < MIN_ALLOCATION_MB) {
    return `The minimum allocation is ${MIN_ALLOCATION_MB} MB.`;
  }
  if (allocation < 1024) {
    return `Heads-up: with ${allocation} MB the Java heap is ${heapMbFor(allocation)} MB. Minecraft`
      + " (Paper/Vanilla with plugins) realistically needs about 1 GB of allocation to boot and hold"
      + " a world; below that the server usually stops with an out-of-memory error. The value is"
      + " accepted anyway — it is your budget.";
  }
  return null;
}
