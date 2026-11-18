// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCsp, newNonce, REPORTING_ENDPOINTS } from "@/lib/csp";

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
const directives = (policy: string) => Object.fromEntries(policy.split(";").filter(Boolean).map((part) => {
  const [name, ...values] = part.trim().split(/\s+/);
  return [name, values];
}));

describe("Content Security Policy", () => {
  it.each([false, true])("sets all enforcing directives, dev=%s", (dev) => {
    const policy = buildCsp("test-nonce", { dev });
    expect(directives(policy)).toEqual({
      "default-src": ["'self'"],
      "script-src": ["'self'", "'nonce-test-nonce'", "'strict-dynamic'", ...(dev ? ["'unsafe-eval'"] : [])],
      "style-src": ["'self'", dev ? "'unsafe-inline'" : "'nonce-test-nonce'"],
      "img-src": ["'self'", "data:"],
      "font-src": ["'self'"],
      "connect-src": ["'self'"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'self'"],
      "frame-ancestors": ["'none'"],
      "report-uri": ["/api/csp-report"],
      "report-to": ["csp-endpoint"],
    });
    expect(directives(policy)["script-src"]).not.toContain("'unsafe-inline'");
    expect(policy.includes("'unsafe-eval'")).toBe(dev);
    expect(policy).not.toContain("upgrade-insecure-requests");
  });
  it("names the report group that the Reporting-Endpoints header defines", () => {
    expect(REPORTING_ENDPOINTS).toBe('csp-endpoint="/api/csp-report"');
  });
  it("does not read environment or include Supabase in demo policies", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ignored.supabase.co");
    try {
      expect(directives(buildCsp("test-nonce", { dev: false }))["connect-src"]).toEqual(["'self'"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each([
    ["https://example.supabase.co/", "https://example.supabase.co", "wss://example.supabase.co"],
    ["http://localhost:54321/", "http://localhost:54321", "wss://localhost:54321"],
  ])("allows only the configured Supabase origin for connections: %s", (supabaseUrl, origin, websocket) => {
    const policy = directives(buildCsp("test-nonce", { dev: false, supabaseUrl }));
    expect(policy["connect-src"]).toEqual(["'self'", origin, websocket]);
    expect(policy["img-src"]).toEqual(["'self'", "data:"]);
    expect(policy["script-src"]).toEqual(["'self'", "'nonce-test-nonce'", "'strict-dynamic'"]);
  });
  it("generates fresh base64 nonces from at least 128 cryptographic random bits", () => {
    const random = vi.spyOn(crypto, "getRandomValues");
    const first = newNonce(), second = newNonce();
    expect(first === second).toBe(false);
    for (const nonce of [first, second]) {
      expect(/^[A-Za-z0-9+/]+={0,2}$/.test(nonce)).toBe(true);
      expect(Buffer.from(nonce, "base64").byteLength).toBeGreaterThanOrEqual(16);
    }
    expect(random).toHaveBeenCalledTimes(2);
    expect(random.mock.calls.every(([bytes]) => bytes instanceof Uint8Array && bytes.byteLength >= 16)).toBe(true);
  });
});
