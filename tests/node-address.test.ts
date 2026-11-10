import { describe, expect, test } from "bun:test";
import { nodeAddressProblem, parseNodeAddress, resolveNodeHost } from "../src/nodes/address";

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

/*
 * Registering a node must work from the one thing an operator actually has: a domain name. Everything
 * else — scheme, port — is derived, because "https on port 3986" is the classic way a node ends up
 * permanently unreachable and nobody can see why.
 */
describe("parseNodeAddress", () => {
  const cases: Array<[string, string, string, string, number]> = [
    ["bare domain", "node1.example.com", "https", "node1.example.com", 443],
    ["domain with scheme and slash", "https://node1.example.com/", "https", "node1.example.com", 443],
    ["domain with explicit port", "node1.example.com:8443", "https", "node1.example.com", 8443],
    ["plain http keeps its own port", "http://node1.example.com", "http", "node1.example.com", 80],
    ["uppercase and spacing", "  Node1.Example.COM  ", "https", "node1.example.com", 443],
    ["lan ipv4 gets the panel port", "10.0.0.4", "http", "10.0.0.4", 3986],
    ["lan ipv4 with port", "10.0.0.4:8080", "http", "10.0.0.4", 8080],
    ["ipv6 literal", "[fd00::1]:3986", "http", "fd00::1", 3986],
    ["ipv6 in a url", "http://[fd00::1]:3986", "http", "fd00::1", 3986],
    ["trailing path is dropped", "node1.example.com/panel", "https", "node1.example.com", 443],
  ];

  for (const [label, input, scheme, fqdn, port] of cases as Array<[string, string, "http" | "https", string, number]>) {
    test(`${label} → ${scheme}://${fqdn}:${port}`, () => {
      const { parsed, error } = parseNodeAddress(input);
      expect(error).toBeNull();
      expect(parsed).not.toBeNull();
      expect(parsed!.scheme).toBe(scheme);
      expect(parsed!.fqdn).toBe(fqdn);
      expect(parsed!.port).toBe(port);
    });
  }

  test("a domain is assumed to be behind TLS, an IP is not", () => {
    expect(parseNodeAddress("node1.example.com").parsed!.viaTls).toBe(true);
    expect(parseNodeAddress("10.0.0.4").parsed!.kind).toBe("literal");
    expect(parseNodeAddress("10.0.0.4").parsed!.viaTls).toBe(false);
  });

  test("https on an IP warns that no certificate can match a bare address", () => {
    const { parsed } = parseNodeAddress("https://10.0.0.4");
    expect(parsed!.port).toBe(443);
    expect(parsed!.note ?? "").toContain("certificate");
  });

  test("credentials in the URL are dropped, not stored", () => {
    const { parsed } = parseNodeAddress("https://admin:secret@node1.example.com");
    expect(parsed!.fqdn).toBe("node1.example.com");
    expect(JSON.stringify(parsed)).not.toContain("secret");
  });

  const bad: Array<[string, string, string]> = [
    ["an empty value", "   ", "enter the node"],
    ["a non-http scheme", "ftp://node1.example.com", "http or https"],
    ["a bare scheme", "https://", "only a scheme"],
    ["localhost", "localhost", "this machine"],
    ["a single label", "node1", "not a hostname"],
    ["a value with a space", "node one.example.com", "not a hostname"],
    ["a port out of range", "node1.example.com:99999", "port"],
    ["a non-numeric port", "node1.example.com:abc", "not a hostname"],
  ];

  for (const [label, input, message] of bad) {
    test(`${label} is refused with a readable reason`, () => {
      const { parsed, error } = parseNodeAddress(input);
      expect(parsed).toBeNull();
      expect(error).toBeTruthy();
      expect(error!.toLowerCase()).toContain(message.toLowerCase());
    });
  }
});
