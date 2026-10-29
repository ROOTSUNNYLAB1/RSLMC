import { describe, expect, test } from "bun:test";
import {
  normalisePublicHost, playAddress, playHost, splitHostPort, validatePublicPort,
} from "../src/shared/address";

describe("player-facing address", () => {
  test("without a public host the internal address is shown unchanged", () => {
    const parts = { bindIp: "0.0.0.0", port: 25565 };
    expect(playAddress(parts, "203.0.113.5")).toBe("203.0.113.5:25565");
    expect(playAddress({ ...parts, publicHost: null, publicPort: null }, "203.0.113.5")).toBe("203.0.113.5:25565");
    expect(playAddress({ ...parts, publicHost: "   " }, "203.0.113.5")).toBe("203.0.113.5:25565");
  });

  test("a tunnel host without a port is shown without a port", () => {
    // playit.gg style: the tunnel owns the port, so appending the internal one would be wrong.
    expect(playAddress({ bindIp: "0.0.0.0", port: 25565, publicHost: "calm-forest.playit.gg" }, "203.0.113.5"))
      .toBe("calm-forest.playit.gg");
    expect(playHost({ bindIp: "0.0.0.0", port: 25565, publicHost: "calm-forest.playit.gg" }, "203.0.113.5"))
      .toBe("calm-forest.playit.gg");
  });

  test("an explicit public port is appended", () => {
    expect(playAddress({ bindIp: "0.0.0.0", port: 25565, publicHost: "tunnel.example.com", publicPort: 25590 }, "203.0.113.5"))
      .toBe("tunnel.example.com:25590");
  });

  test("host and port typed into one field are split", () => {
    expect(splitHostPort("tunnel.example.com:25590")).toEqual({ host: "tunnel.example.com", port: 25590 });
    expect(splitHostPort("tunnel.example.com")).toEqual({ host: "tunnel.example.com", port: null });
    expect(splitHostPort("tunnel.example.com:99999")).toEqual({ host: "tunnel.example.com:99999", port: null });
    expect(playAddress({ bindIp: "0.0.0.0", port: 25565, publicHost: "tunnel.example.com:25590" }, "203.0.113.5"))
      .toBe("tunnel.example.com:25590");
  });

  test("pasted URLs are normalised into a bare host", () => {
    expect(normalisePublicHost("https://Play.Example.com/")).toBe("play.example.com");
    expect(normalisePublicHost("  tcp://play.example.com:25565  ")).toBe("play.example.com:25565");
    expect(normalisePublicHost("")).toBeNull();
    expect(normalisePublicHost(null)).toBeNull();
    expect(normalisePublicHost("play.example.com")).toBe("play.example.com");
    expect(normalisePublicHost("192.0.2.10")).toBe("192.0.2.10");
    expect(() => normalisePublicHost("not a host!")).toThrow();
  });

  test("public ports are validated, empty means default", () => {
    expect(validatePublicPort("")).toBeNull();
    expect(validatePublicPort(null)).toBeNull();
    expect(validatePublicPort(25565)).toBe(25565);
    expect(() => validatePublicPort(0)).toThrow();
    expect(() => validatePublicPort(70000)).toThrow();
    expect(() => validatePublicPort("abc")).toThrow();
  });
});

describe("public address hardening", () => {
  test("private, loopback and link-local IP literals are rejected with an explanation", () => {
    for (const host of [
      "127.0.0.1", "10.1.2.3", "192.168.1.10", "172.16.5.4", "169.254.169.254", "0.0.0.0",
      "100.64.0.1", "localhost",
    ]) {
      expect(() => normalisePublicHost(host)).toThrow(/private or local address/i);
    }
  });

  test("public IPs and tunnel domains still work", () => {
    expect(normalisePublicHost("https://calm-forest.playit.gg/")).toBe("calm-forest.playit.gg");
    expect(normalisePublicHost("play.example.com:25565")).toBe("play.example.com:25565");
    expect(normalisePublicHost("203.0.113.10")).toBe("203.0.113.10");
    expect(normalisePublicHost("   ")).toBeNull();
  });

  test("a scheme and path cannot smuggle a metadata endpoint through", () => {
    expect(() => normalisePublicHost("http://169.254.169.254/latest/meta-data")).toThrow();
    expect(() => normalisePublicHost("http://127.0.0.1:22")).toThrow();
  });
});
