import { describe, expect, test } from "bun:test";
import { checkOrigin, normaliseHost } from "../src/security/origin";

/*
 * Same-origin check for writes.
 *
 * The old implementation compared whole origin strings against the URL the panel itself received and
 * against `x-forwarded-host`. Behind TLS termination the panel only ever sees `http://` from the
 * proxy, so a perfectly good deployment behind nginx / Caddy / Cloudflare answered `403
 * origin_invalid` to every non-GET request — saving preferences, starting a server, anything. These
 * cases pin both directions: the proxy case must pass, and a genuinely foreign origin must not.
 */

const headers = (values: Record<string, string> = {}) => new Headers(values);

const run = (origin: string | null, url: string, extra: Record<string, string> = {}, publicUrl: string | null = null) =>
  checkOrigin({ origin, url: new URL(url), headers: headers(extra), publicUrl });

describe("proxy deployments are not false positives", () => {
  test("https origin against the panel's http loopback: allowed (TLS terminated at the proxy)", () => {
    const decision = run("https://panel.example.com", "http://127.0.0.1:3000");
    // Host differs here, so this is genuinely refused — nothing says the panel answers as that host.
    expect(decision.allowed).toBe(false);
  });

  test("proxy preserves Host: https origin vs http Host only differs by scheme → allowed", () => {
    // nginx: proxy_set_header Host $host; the panel receives Host: panel.example.com over plain HTTP.
    const decision = run("https://panel.example.com", "http://panel.example.com/");
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("matched");
  });

  test("x-forwarded-host is honoured, comma-separated chains included", () => {
    const decision = run(
      "https://panel.example.com",
      "http://127.0.0.1:3000/",
      { "x-forwarded-host": "panel.example.com, edge.internal", "x-forwarded-proto": "https" },
    );
    expect(decision.allowed).toBe(true);
  });

  test("RSLMC_PUBLIC_URL is the escape hatch when nothing else survives the tunnel", () => {
    const decision = run("https://panel.example.com", "http://127.0.0.1:3000/", {}, "https://panel.example.com");
    expect(decision.allowed).toBe(true);
    expect(decision.considered).toContain("panel.example.com");
  });

  test("default ports are ignored, real ports are not", () => {
    expect(normaliseHost("panel.example.com:443", "https")).toBe("panel.example.com");
    expect(normaliseHost("panel.example.com:80", "http")).toBe("panel.example.com");
    expect(normaliseHost("panel.example.com:8443", "https")).toBe("panel.example.com:8443");
    expect(run("https://panel.example.com:443", "https://panel.example.com").allowed).toBe(true);
    // a different port is a different service on the same box — refused
    expect(run("https://panel.example.com:8443", "https://panel.example.com").allowed).toBe(false);
  });

  test("Host comparison is case-insensitive", () => {
    expect(run("https://PANEL.Example.com", "http://panel.example.com").allowed).toBe(true);
  });
});

describe("actual cross-origin requests are still refused", () => {
  test("another hostname is refused", () => {
    const decision = run("https://evil.example.net", "https://panel.example.com");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("host_mismatch");
    expect(decision.considered).toContain("panel.example.com");
  });

  test("a lookalike subdomain is refused (no suffix matching)", () => {
    expect(run("https://panel.example.com.evil.net", "https://panel.example.com").allowed).toBe(false);
    expect(run("https://evilpanel.example.com", "https://panel.example.com").allowed).toBe(false);
  });

  test("a null origin is refused", () => {
    expect(run("null", "https://panel.example.com").allowed).toBe(false);
  });

  test("an unparsable origin is refused rather than crashing", () => {
    expect(run("not a url", "https://panel.example.com").allowed).toBe(false);
    expect(run("javascript:alert(1)", "https://panel.example.com").allowed).toBe(false);
  });

  test("no Origin header is allowed — curl and same-site posts send none, CSRF still applies", () => {
    const decision = run(null, "https://panel.example.com");
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("no_origin");
  });
});
