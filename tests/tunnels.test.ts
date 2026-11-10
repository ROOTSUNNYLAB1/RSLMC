import { describe, expect, test } from "bun:test";
import { openSecret, sealSecret, isSealedSecret, secretFingerprint, resetSecretKeyCache } from "../src/security/secrets";
import { buildArgs, parseQuickHostname, scrubLogLine, validateHostname } from "../src/tunnels/manager";
import { downloadAssetName, downloadUrl } from "../src/tunnels/cloudflared";
import { nodeBaseUrl } from "../src/nodes/client";

/*
 * Cloudflare Tunnel, for nodes.
 *
 * The interesting failures here are not "the tunnel will not start" — cloudflared says that itself.
 * They are the quiet ones: a hostname that looks accepted but can never answer, a token that ends up
 * in a log line, a node address that grows a `:443` nobody typed, and a stored token readable by
 * anyone who copies the database. Each of those has a test.
 */

describe("tunnel tokens are stored sealed, not readable", () => {
  test("a sealed token round-trips and does not contain the plaintext", () => {
    const token = "eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwifQ==";
    const sealed = sealSecret(token)!;
    expect(isSealedSecret(sealed)).toBe(true);
    expect(sealed).not.toContain(token);
    expect(openSecret(sealed)).toBe(token);
  });

  test("an empty value seals to null so 'not set' stays 'not set'", () => {
    expect(sealSecret("")).toBeNull();
    expect(sealSecret("   ")).toBeNull();
    expect(openSecret(null)).toBeNull();
  });

  test("a tampered ciphertext fails to open instead of decrypting to garbage", () => {
    const sealed = sealSecret("a-real-tunnel-token")!;
    const parts = sealed.split(":");
    const data = parts[3];
    // Flip one character of the ciphertext: GCM's auth tag must reject it.
    parts[3] = (data[0] === "A" ? "B" : "A") + data.slice(1);
    expect(openSecret(parts.join(":"))).toBeNull();
  });

  test("a value sealed with a different key does not open", () => {
    const sealed = sealSecret("token-for-the-old-install")!;
    const original = process.env.RSLMC_SECRET;
    try {
      process.env.RSLMC_SECRET = "x".repeat(40);
      resetSecretKeyCache();
      expect(openSecret(sealed)).toBeNull();
    } finally {
      if (original === undefined) delete process.env.RSLMC_SECRET;
      else process.env.RSLMC_SECRET = original;
      resetSecretKeyCache();
    }
  });

  test("the fingerprint identifies a token without revealing it", () => {
    const sealed = sealSecret("eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwifQ==")!;
    const fingerprint = secretFingerprint(sealed)!;
    expect(fingerprint.length).toBeGreaterThan(3);
    expect(fingerprint).not.toContain("eyJhIjoi");
  });
});

describe("the hostname an operator types is checked before Cloudflare sees it", () => {
  test("plain domains are accepted and normalised", () => {
    expect(validateHostname("node1.example.com").hostname).toBe("node1.example.com");
    expect(validateHostname("  Node1.Example.COM  ").hostname).toBe("node1.example.com");
    // Pasting the whole URL is the common mistake; it is fixed rather than refused.
    expect(validateHostname("https://node1.example.com/").hostname).toBe("node1.example.com");
    expect(validateHostname("node1.example.com:8443").hostname).toBe("node1.example.com");
    expect(validateHostname("").hostname).toBeNull(); // optional: quick mode has none yet
  });

  test("hostnames that can never answer are refused with a reason", () => {
    expect(validateHostname("node1").error).toContain("no dot");
    expect(validateHostname("10.0.0.5").error).toContain("IP address");
    expect(validateHostname("node1.example.com").error).toBeNull();
    expect(validateHostname("localhost").error).toContain("public domain");
    expect(validateHostname("funny-name.trycloudflare.com").error).toContain("quick mode");
    expect(validateHostname("node one.example.com").error).toContain("valid hostname");
  });
});

describe("quick tunnels", () => {
  test("the hostname is picked out of cloudflared's own output", () => {
    const line = "2026-11-10T10:44:02Z INF |  https://sweet-piano-sunrise-42.trycloudflare.com  |";
    expect(parseQuickHostname(line)).toBe("sweet-piano-sunrise-42.trycloudflare.com");
    expect(parseQuickHostname("INF Registered tunnel connection connIndex=0")).toBeNull();
    // Only the host, never the URL: the panel builds `https://host` itself.
    expect(parseQuickHostname("https://abc-def.trycloudflare.com")).toBe("abc-def.trycloudflare.com");
  });

  test("a token that somehow reaches a log line is redacted", () => {
    const withToken = "run --token eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoiYWJjZGVmZ2hpamsifQ";
    const scrubbed = scrubLogLine(withToken)!;
    expect(scrubbed).not.toContain("eyJhIjoi");
    expect(scrubbed).toContain("«redacted»");
  });
});

describe("how cloudflared is invoked", () => {
  const base = { mode: "token" as const, local_scheme: "http", local_host: "127.0.0.1", local_port: 3986 };

  test("token mode runs the named tunnel with the token, quick mode points at the local port", () => {
    const tokenArgs = buildArgs(base, "tok_123");
    expect(tokenArgs).toContain("run");
    expect(tokenArgs).toContain("--token");
    expect(tokenArgs[tokenArgs.indexOf("--token") + 1]).toBe("tok_123");
    expect(tokenArgs).toContain("--no-autoupdate");

    const quickArgs = buildArgs({ ...base, mode: "quick" }, null);
    expect(quickArgs).toContain("--url");
    expect(quickArgs[quickArgs.indexOf("--url") + 1]).toBe("http://127.0.0.1:3986");
    expect(quickArgs).not.toContain("--token");
  });

  test("token mode with no token is refused before a process is spawned", () => {
    expect(() => buildArgs(base, null)).toThrow(/token/i);
  });
});

describe("the download is the right one for this machine", () => {
  test("every supported platform maps to an asset Cloudflare publishes", () => {
    const asset = downloadAssetName();
    if (process.platform === "linux" || process.platform === "darwin" || process.platform === "win32") {
      expect(asset).toBeTruthy();
      expect(downloadUrl()).toContain("github.com/cloudflare/cloudflared/releases/latest/download/");
      expect(downloadUrl()).toContain(asset!);
    }
  });
});

describe("a node reached through a tunnel has a clean address", () => {
  test("the default port for the scheme is not appended", () => {
    // What the operator typed in Cloudflare is `https://node1.example.com` — not `…:443`.
    expect(nodeBaseUrl({ scheme: "https", fqdn: "node1.example.com", port: 443 })).toBe("https://node1.example.com");
    expect(nodeBaseUrl({ scheme: "http", fqdn: "node1.example.com", port: 80 })).toBe("http://node1.example.com");
    // Anything else is a real port and must stay.
    expect(nodeBaseUrl({ scheme: "https", fqdn: "node1.example.com", port: 8443 })).toBe("https://node1.example.com:8443");
    expect(nodeBaseUrl({ scheme: "http", fqdn: "10.0.0.4", port: 3986 })).toBe("http://10.0.0.4:3986");
  });
});
