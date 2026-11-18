// @vitest-environment node
// SEC-015: the proxy no longer runs for /api/photos, so Next never buffers an upload body before the route. The route
// alone refuses a request without a usable session: the real @supabase/ssr and my_account answer 401, with the body
// unread and no-store. A stale access token that Supabase can still refresh passes the account check, and the
// refreshed session cookies are written through Next's cookie store.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ store: { getAll: (): { name: string; value: string }[] => [], set: (..._args: unknown[]) => {} } }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => h.store }));
import * as staticInfo from "next/dist/build/analysis/get-page-static-info";
import type { ProxyMatcher } from "next/dist/build/analysis/get-page-static-info";
import { getMiddlewareRouteMatcher } from "next/dist/shared/lib/router/utils/middleware-route-matcher";
import { RequestCookies, ResponseCookies } from "next/dist/compiled/@edge-runtime/cookies";
import { config } from "@/proxy";
import { photoUploadLocks } from "@/server/photo-upload";
import { POST } from "@/app/api/photos/route";
// Next exports this at runtime but leaves it out of its type declarations.
const { getMiddlewareMatchers } = staticInfo as unknown as { getMiddlewareMatchers(matchers: string[], nextConfig: object): ProxyMatcher[] };

const sub = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (exp: number) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, exp, iat: exp - 3600, aud: "authenticated", role: "authenticated", session_id: "fake-session" })}.fake_signature`;
const user = { id: sub, aud: "authenticated", role: "authenticated", email: "fake@example.invalid", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const now = () => Math.floor(Date.now() / 1000);
const session = (exp: number) => ({ access_token: jwt(exp), refresh_token: "fake-refresh", token_type: "bearer", expires_in: 3600, expires_at: exp, user });
const staleCookie = () => `sb-example-auth-token=base64-${b64(session(now() - 60))}`;

let fresh: string;
let refreshWorks: boolean;
let rpcAuthorization: (string | null)[];
let setCookies: Headers;
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  refreshWorks = true; rpcAuthorization = []; setCookies = new Headers();
  vi.stubEnv("CAMPUS_LINK_BACKEND", "supabase");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_fake");
  vi.stubEnv("VERCEL", undefined);
  fresh = session(now() + 3600).access_token;
  // Only the fake Auth refresh and my_account answer; every other request fails the test.
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === "https://example.supabase.co" && url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
      if (!refreshWorks) return Response.json({ code: "refresh_token_not_found", message: "Invalid Refresh Token" }, { status: 400 });
      return Response.json({ ...session(now() + 3600), access_token: fresh });
    }
    if (url.origin === "https://example.supabase.co" && url.pathname === "/rest/v1/rpc/my_account") {
      const authorization = request.headers.get("authorization");
      rpcAuthorization.push(authorization);
      // PostgREST: my_account is granted to authenticated only, so any other caller gets 401 (42501).
      if (authorization !== `Bearer ${fresh}`) return Response.json({ code: "42501", message: "permission denied" }, { status: 401 });
      return Response.json([{ user_id: sub }]);
    }
    throw new Error("Network forbidden");
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); expect(photoUploadLocks.held()).toBe(0); });

function useCookies(cookie: string | null) {
  const request = new RequestCookies(new Headers(cookie ? { cookie } : {}));
  const response = new ResponseCookies(setCookies);
  h.store.getAll = () => request.getAll();
  h.store.set = (name, value, options) => { response.set(name as string, value as string, options as object); };
}
/** A same-origin upload whose body records whether anything pulled it. */
function upload(origin = "http://campus.test") {
  const state = { pulled: false };
  const body = new ReadableStream<Uint8Array>({ pull() { state.pulled = true; } }, { highWaterMark: 0 });
  const init: RequestInit & { duplex?: "half" } = { method: "POST", body, duplex: "half", headers: {
    host: "campus.test", origin, "sec-fetch-site": "same-origin",
    "content-type": "multipart/form-data; boundary=x", "content-length": "1024",
  } };
  return { request: new Request("http://campus.test/api/photos", init), state };
}
async function expectRefused(response: Response, http: number, status: string, state: { pulled: boolean }, request: Request) {
  expect(response.status).toBe(http);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
  expect(await response.json()).toEqual({ status });
  expect(state.pulled).toBe(false); expect(request.bodyUsed).toBe(false);
}

describe("the proxy does not run for /api/photos", () => {
  // Compiled by Next's own middleware matcher code, which tries the raw and the decoded pathname.
  const matches = getMiddlewareRouteMatcher(getMiddlewareMatchers(config.matcher, {}));
  const proxied = (path: string) => matches(path, { headers: {} } as never, {});
  it("skips exactly /api/photos", () => {
    expect(proxied("/api/photos")).toBe(false);
    // Variants are still proxied, so none of them skips the login redirect; none of them is the upload route.
    for (const path of ["/api/photos/", "/api/photos/x", "/api/photosx", "/API/photos", "/api/photos.rsc", "/api/photos.json"]) {
      expect(proxied(path), path).toBe(true);
    }
  });
});

describe("the route refuses a request without a usable session before the body", () => {
  it("answers 401 with no session cookie", async () => {
    useCookies(null);
    const { request, state } = upload();
    await expectRefused(await POST(request), 401, "unauthenticated", state, request);
    expect(rpcAuthorization).toHaveLength(1); expect(rpcAuthorization[0]).not.toBe(`Bearer ${fresh}`);
  });
  it("answers 401 for a stale session whose refresh fails", async () => {
    refreshWorks = false; useCookies(staleCookie());
    const { request, state } = upload();
    await expectRefused(await POST(request), 401, "unauthenticated", state, request);
    expect(rpcAuthorization.every((value) => value !== `Bearer ${fresh}`)).toBe(true);
  });
  it("refreshes a stale session in the route and writes the new cookies", async () => {
    useCookies(staleCookie());
    // Holding this user's lock stops the route right after the account check, still before the body.
    const release = photoUploadLocks.acquire(sub)!;
    try {
      const { request, state } = upload();
      await expectRefused(await POST(request), 429, "rate_limited", state, request);
    } finally {
      release();
    }
    expect(rpcAuthorization).toEqual([`Bearer ${fresh}`]);
    const written = setCookies.getSetCookie().filter((line) => line.startsWith("sb-"));
    expect(written.length).toBeGreaterThan(0);
    for (const line of written) expect(line.toLowerCase()).toContain("httponly");
  });
  it("refuses a cross-origin request before any session work", async () => {
    useCookies(staleCookie());
    const { request, state } = upload("http://evil.test");
    await expectRefused(await POST(request), 403, "invalid", state, request);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
