import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { dialHost, measureGamePort, pingBars, tcpHandshake } from "../src/services/ping";

/*
 * The ping next to the address has to be a measurement, not a decoration.
 *
 * These tests dial real sockets: one that is listening (a genuine handshake, so a real number comes
 * back) and one that is not (a genuine refusal, which must not be reported as "0 ms").
 */

async function listeningPort(): Promise<{ port: number; close: () => Promise<void>; connections: () => number }> {
  let count = 0;
  const server = createServer((socket) => {
    count += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    connections: () => count,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function closedPort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", () => resolve()));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;                                   // nothing is listening here any more
}

describe("addressing", () => {
  test("a wildcard bind is dialled over loopback", () => {
    expect(dialHost("0.0.0.0")).toBe("127.0.0.1");
    expect(dialHost("::")).toBe("::1");
    expect(dialHost("")).toBe("127.0.0.1");
  });

  test("a specific bind address is used as-is", () => {
    expect(dialHost("10.241.99.5")).toBe("10.241.99.5");
    expect(dialHost("192.168.1.7")).toBe("192.168.1.7");
  });
});

describe("a real handshake", () => {
  test("a listening port answers, and the number is finite", async () => {
    const listener = await listeningPort();
    try {
      const result = await tcpHandshake("127.0.0.1", listener.port);
      expect(result.reason).toBeNull();
      expect(result.ms).not.toBeNull();
      expect(result.ms!).toBeGreaterThanOrEqual(0);
      expect(result.ms!).toBeLessThan(2000);      // loopback, even on a loaded CI box
    } finally {
      await listener.close();
    }
  });

  test("measureGamePort takes three samples when the port is open", async () => {
    const listener = await listeningPort();
    try {
      const result = await measureGamePort("0.0.0.0", listener.port);
      expect(result.reachable).toBe(true);
      expect(result.reason).toBeNull();
      expect(result.samples).toHaveLength(3);
      expect(result.target).toBe(`127.0.0.1:${listener.port}`);
      expect(result.ms).not.toBeNull();
      // Every sample really reached the listener.
      expect(listener.connections()).toBe(3);
    } finally {
      await listener.close();
    }
  });
});

describe("nothing listening", () => {
  test("a closed port is a refusal, not a ping of zero", async () => {
    const port = await closedPort();
    const result = await tcpHandshake("127.0.0.1", port);
    expect(result.ms).toBeNull();
    expect(result.reason === "refused" || result.reason === "timeout").toBe(true);
  });

  test("measureGamePort stops after the first refusal instead of burning three timeouts", async () => {
    const port = await closedPort();
    const started = performance.now();
    const result = await measureGamePort("127.0.0.1", port);
    expect(result.reachable).toBe(false);
    expect(result.ms).toBeNull();
    expect(result.samples).toEqual([]);
    expect(result.reason).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("an impossible port is refused before anything is dialled", async () => {
    expect((await tcpHandshake("127.0.0.1", 0)).reason).toBe("invalid");
    expect((await tcpHandshake("127.0.0.1", 99999)).reason).toBe("invalid");
    expect((await measureGamePort("", 0)).reachable).toBe(false);
  });

  test("an unresolvable host is reported as such", async () => {
    const result = await tcpHandshake("this-host-does-not-exist.invalid", 25565, 1500);
    expect(result.ms).toBeNull();
    expect(["unresolved", "timeout", "refused"]).toContain(result.reason as string);
  });
});

describe("Minecraft-style bars", () => {
  test("the thresholds are the ones the tooltip advertises", () => {
    expect(pingBars(5)).toBe(5);
    expect(pingBars(40)).toBe(5);
    expect(pingBars(41)).toBe(4);
    expect(pingBars(80)).toBe(4);
    expect(pingBars(81)).toBe(3);
    expect(pingBars(150)).toBe(3);
    expect(pingBars(151)).toBe(2);
    expect(pingBars(300)).toBe(2);
    expect(pingBars(301)).toBe(1);
    expect(pingBars(5000)).toBe(1);
  });

  test("no answer means no bars at all", () => {
    expect(pingBars(null)).toBe(0);
  });
});
