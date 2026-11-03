import { describe, expect, test } from "bun:test";
import { nodeAddressProblem, resolveNodeHost } from "../src/nodes/address";

/*
 * A node address is stored by an administrator and then re-fetched by the panel every 15 seconds for
 * as long as the node exists, so validating it once (and on every beat) matters. The rules:
 *   · cloud metadata endpoints are never a node — they hand out credentials;
 *   · wildcard addresses are not a destination;
 *   · loopback IS allowed (two panels on one machine is a real setup) — the "points at itself" case
 *     is caught separately by the port comparison in assertNoSelfLoop;
 *   · a normal LAN or public address is fine, because that is what multi-node is for.
 */
describe("node addresses", () => {
  test("cloud metadata endpoints are refused", () => {
    expect(nodeAddressProblem("169.254.169.254")).toContain("metadata");
    expect(nodeAddressProblem("100.100.100.200")).toContain("metadata");
    expect(nodeAddressProblem("fd00:ec2::254")).toContain("metadata");
  });

  test("link-local addresses are refused", () => {
    expect(nodeAddressProblem("169.254.10.20")).toContain("metadata");
    expect(nodeAddressProblem("fe80::1")).toContain("link-local");
  });

  test("wildcard addresses are refused", () => {
    expect(nodeAddressProblem("0.0.0.0")).toContain("wildcard");
    expect(nodeAddressProblem("::")).toContain("wildcard");
  });

  test("LAN and public addresses are accepted — that is the normal setup", () => {
    for (const host of ["10.0.0.15", "192.168.1.20", "172.16.4.9", "203.0.113.7", "node1.example.com"]) {
      expect(nodeAddressProblem(host)).toBeNull();
    }
  });

  test("loopback is accepted (the self-loop case is a port comparison, not a host one)", () => {
    expect(nodeAddressProblem("127.0.0.1")).toBeNull();
    expect(nodeAddressProblem("::1")).toBeNull();
  });

  test("an empty address is refused", () => {
    expect(nodeAddressProblem("  ")).toContain("empty");
  });

  test("a hostname that resolves into a refused range is refused", async () => {
    // `localhost` resolves to a loopback address, which is allowed; metadata hosts do not resolve
    // here, so this exercises the literal path plus the "cannot resolve" tolerance.
    const result = await resolveNodeHost("169.254.169.254");
    expect(result.problem).toContain("metadata");
    expect(result.addresses).toEqual([]);
  });

  test("an unresolvable name is not treated as a refusal (the node may just be offline)", async () => {
    const result = await resolveNodeHost("definitely-not-a-real-host.invalid");
    expect(result.problem).toBeNull();
  });
});
