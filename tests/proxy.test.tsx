// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { CookieMethodsServer } from "@supabase/ssr";
const ssr = vi.hoisted(() => {
  // Next's node runtime installs this global before any of its request stores load; the adapter tests below need it.
  (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= process.getBuiltinModule("node:async_hooks").AsyncLocalStorage;
  return { createServerClient: vi.fn() };
});
vi.mock("@supabase/ssr", () => ssr);
import { adapter } from "next/dist/server/web/adapter";
import { proxy, config } from "@/proxy";
import { buildCsp } from "@/lib/csp";

let claims: Record<string, unknown> | null;
let authError: object | null;
let updateCookies: ((cookies: CookieMethodsServer) => void) | undefined;
let fetchSpy: ReturnType<typeof vi.spyOn>;
const getClaims = vi.fn();
beforeEach(() => {
  claims = null;
  authError = null;
  updateCookies = undefined;
  vi.stubEnv("CAMPUS_LINK_BACKEND", "supabase");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_fake");
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  ssr.createServerClient.mockImplementation((_url, _key, options) => ({ auth: { getClaims: getClaims.mockImplementation(async () => {
    updateCookies?.(options.cookies);
    return { data: claims ? { claims } : null, error: authError };
  }) } }));
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
const request = (path: string) => new NextRequest(new URL(path, "https://campus.example"));
function expectCsp(response: Response, forwarded: boolean, supabase = true) {
  const policy = response.headers.get("content-security-policy");
  const nonce = policy?.match(/'nonce-([^']+)'/)?.[1];
  expect(Boolean(nonce)).toBe(true);
  expect(policy === buildCsp(nonce!, { dev: process.env.NODE_ENV === "development", supabaseUrl: supabase ? "https://example.supabase.co" : undefined })).toBe(true);
  expect(response.headers.has("content-security-policy-report-only")).toBe(false);
  expect(response.headers.get("reporting-endpoints")).toBe('csp-endpoint="/api/csp-report"');
  if (forwarded) {
    expect(response.headers.get("x-middleware-request-x-nonce") === nonce).toBe(true);
    expect(response.headers.get("x-middleware-request-content-security-policy") === policy).toBe(true);
  }
  return nonce;
}
describe("session proxy", () => {
  it("is inert by default, even when public config exists", async () => {
    vi.stubEnv("CAMPUS_LINK_BACKEND", undefined);
    const result = await proxy(request("/admin"));
    expect(result.headers.get("x-middleware-next")).toBe("1");
    expect(ssr.createServerClient).not.toHaveBeenCalled();
    expect(getClaims).not.toHaveBeenCalled();
    expectCsp(result, true, false);
  });
  it("replaces untrusted nonce/CSP request headers and uses a fresh nonce per request", async () => {
    vi.stubEnv("CAMPUS_LINK_BACKEND", "demo");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", undefined);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", undefined);
    const incoming = request("/");
    incoming.headers.set("x-nonce", "attacker-nonce");
    incoming.headers.set("Content-Security-Policy", "script-src 'unsafe-inline'");
    const first = expectCsp(await proxy(incoming), true, false);
    const second = expectCsp(await proxy(request("/")), true, false);
    expect(first === second).toBe(false);
    expect(first === "attacker-nonce").toBe(false);
    expect(ssr.createServerClient).not.toHaveBeenCalled();
  });
  it.each(["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"])("fails closed with missing or invalid %s", async (variable) => {
    for (const value of [undefined, "invalid"]) {
      vi.stubEnv(variable, value);
      await expect(proxy(request("/"))).rejects.toThrow(`Invalid or missing ${variable}`);
    }
    expect(ssr.createServerClient).not.toHaveBeenCalled();
  });
  it.each(["/", "/talk", "/admin", "/talk?mode=friends&test=1"])("redirects unauthenticated %s with its relative path and query", async (path) => {
    const result = await proxy(request(path));
    const location = new URL(result.headers.get("location")!);
    expect(location.origin).toBe("https://campus.example");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe(path);
    expectCsp(result, false);
  });
  it.each(["//evil.example", "/\\evil", "https://x", "/%2fevil.example", "/%5cevil", "/%00evil", "/bad%"])("drops next attack case %#", async (path) => {
    const incoming = request("/");
    // Supply the raw path deliberately: URL parsers can normalise the attack before Proxy runs.
    Object.defineProperty(incoming, "nextUrl", { value: { pathname: path, search: "" } });
    const location = new URL((await proxy(incoming)).headers.get("location")!);
    expect(location.searchParams.has("next")).toBe(false);
  });
  it.each(["/" + "a".repeat(512), "/talk?query=" + "a".repeat(512)])("drops an over-long next path or query %#", async (path) => {
    const location = new URL((await proxy(request(path))).headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.has("next")).toBe(false);
  });
  it.each(["/welcome", "/login", "/signup", "/auth", "/auth/", "/auth/callback?code=fake", "/media/photos/x", "/settings/account/deleted", "/api/csp-report", "/terms", "/privacy"])("passes public path %s", async (path) => {
    const result = await proxy(request(path));
    expect(result.headers.get("x-middleware-next")).toBe("1");
    expect(getClaims).toHaveBeenCalledOnce();
    expectCsp(result, true);
  });
  it.each(["/welcome/private", "/login-extra", "/signup/private", "/authentication", "/mediafoo", "/settings/account", "/settings/account/deleted/x", "/settings/account/deletedx", "/api", "/api/", "/api/csp-report/x", "/api/csp-reportx", "/api/other", "/api/realtime-token", "/terms/x", "/terms/", "/termsx", "/privacy2", "/privacy/x", "/privacy/", "/settings/privacy", "/mypage"])("does not widen public paths: %s", async (path) => {
    expect((await proxy(request(path))).status).toBe(307);
  });
  it("passes valid verified claims", async () => {
    claims = { sub: "fake-user" };
    expect((await proxy(request("/admin"))).headers.get("x-middleware-next")).toBe("1");
  });
  it.each([[undefined, false], ["1", true]])("passes the shared HttpOnly cookie options (VERCEL=%s)", async (vercel, secure) => {
    vi.stubEnv("VERCEL", vercel);
    await proxy(request("/talk"));
    expect(ssr.createServerClient.mock.calls[0][2].cookieOptions).toEqual({ httpOnly: true, secure });
  });
  it("does not trust claims alongside an auth error", async () => {
    claims = { sub: "fake-user" };
    authError = { message: "invalid JWT" };
    expect((await proxy(request("/admin"))).status).toBe(307);
  });
  it.each([false, true])("preserves cookies and cache headers on pass-through/redirect: claims=%s", async (authenticated) => {
    claims = authenticated ? { sub: "fake-user" } : null;
    const incoming = request("/talk");
    incoming.cookies.set("old", "fake-old");
    updateCookies = (cookies) => {
      expect(cookies.getAll()).toContainEqual({ name: "old", value: "fake-old" });
      cookies.setAll!([{ name: "token", value: "fake-token", options: { path: "/", httpOnly: true, secure: true, sameSite: "lax" } }], { "Cache-Control": "private, no-store", Expires: "0", Pragma: "no-cache" });
      cookies.setAll!([{ name: "other", value: "fake-other", options: { path: "/" } }], {});
    };
    const result = await proxy(incoming);
    expectCsp(result, authenticated);
    expect(result.cookies.get("token")).toMatchObject({ value: "fake-token", httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    expect(result.cookies.get("other")?.value).toBe("fake-other");
    expect(incoming.cookies.get("token")?.value).toBe("fake-token");
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(result.headers.get("expires")).toBe("0");
    expect(result.headers.get("pragma")).toBe("no-cache");
    if (authenticated) expect(result.headers.get("x-middleware-request-cookie")).toContain("token=fake-token");
  });
  // FIX-001: the Location on the wire, after Next's own proxy adapter, is a path and query on the host the browser used.
  async function served(path: string, host: string, cookie?: string) {
    const { response } = await adapter({
      handler: proxy, page: "/proxy",
      request: { url: `http://${host}${path}`, headers: { host, ...(cookie ? { cookie } : {}) }, method: "GET", nextConfig: {}, signal: new AbortController().signal },
    });
    return response;
  }
  it.each(["127.0.0.1:3207", "localhost:3207", "campus.example"])("answers an anonymous protected page on %s with a relative /login Location", async (host) => {
    updateCookies = (cookies) => {
      expect(cookies.getAll()).toContainEqual({ name: "old", value: "fake-old" });
      cookies.setAll!([{ name: "token", value: "", options: { path: "/", maxAge: 0 } }], { "Cache-Control": "private, no-store", Expires: "0", Pragma: "no-cache" });
    };
    const result = await served("/talk?mode=friends&x=%2F", host, "old=fake-old");
    expect(result.status).toBe(307);
    expect(result.headers.get("location")).toBe(`/login?next=${encodeURIComponent("/talk?mode=friends&x=%2F")}`);
    expectCsp(result, false);
    expect(result.headers.get("set-cookie")).toContain("token=;");
    expect([result.headers.get("cache-control"), result.headers.get("expires"), result.headers.get("pragma")]).toEqual(["private, no-store", "0", "no-cache"]);
  });
  it("keeps the adapter's public-path and signed-in pass-through", async () => {
    expect((await served("/login", "127.0.0.1:3207")).headers.get("x-middleware-next")).toBe("1");
    claims = { sub: "fake-user" };
    const signedIn = await served("/talk", "127.0.0.1:3207");
    expect([signedIn.status, signedIn.headers.get("location"), signedIn.headers.get("x-middleware-next")]).toEqual([200, null, "1"]);
  });
  it("excludes Next assets and image files with the matcher", () => {
    const matcher = new RegExp(`^${config.matcher[0]}$`);
    for (const path of ["/_next/static/chunk.js", "/_next/image", "/favicon.ico", "/photo.webp", "/photo.avif"]) expect(matcher.test(path)).toBe(false);
    for (const path of ["/", "/talk", "/admin"]) expect(matcher.test(path)).toBe(true);
  });
});
