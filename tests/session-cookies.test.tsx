// @vitest-environment node
// SEC-010: the real @supabase/ssr refreshes an old session (written before this change without HttpOnly) and rewrites
// every sb- cookie as HttpOnly, through Next's own proxy adapter and through createServerSupabase. Secure only on Vercel.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => {
  // Next's node runtime installs this global before any of its request stores load; the adapter needs it.
  (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= process.getBuiltinModule("node:async_hooks").AsyncLocalStorage;
  return { store: { getAll: (): { name: string; value: string }[] => [], set: (..._args: unknown[]) => {} } };
});
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => h.store }));
import { adapter } from "next/dist/server/web/adapter";
import { RequestCookies, ResponseCookies } from "next/dist/compiled/@edge-runtime/cookies";
import { proxy } from "@/proxy";
import { createServerSupabase } from "@/lib/supabase/server";

const sub = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (exp: number) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, exp, iat: exp - 3600, aud: "authenticated", role: "authenticated", session_id: "fake-session" })}.fake_signature`;
const user = { id: sub, aud: "authenticated", role: "authenticated", email: "fake@example.invalid", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const now = () => Math.floor(Date.now() / 1000);
function session(exp: number) {
  return { access_token: jwt(exp), refresh_token: "fake-refresh", token_type: "bearer", expires_in: 3600, expires_at: exp, user };
}
// The pre-change cookie: same name and encoding, an expired access token, and the browser sends no attributes.
const oldCookie = () => `sb-example-auth-token=base64-${b64(session(now() - 60))}`;

let fetchSpy: ReturnType<typeof vi.spyOn>;
let refreshes: number;
beforeEach(() => {
  refreshes = 0;
  vi.stubEnv("CAMPUS_LINK_BACKEND", "supabase");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_fake");
  vi.stubEnv("VERCEL", undefined);
  // Only the two fake Auth endpoints answer; every other request fails the test.
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://example.supabase.co" && url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
      refreshes++;
      return Response.json(session(now() + 3600));
    }
    if (url.origin === "https://example.supabase.co" && url.pathname === "/auth/v1/user") return Response.json(user);
    throw new Error("Network forbidden");
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function sessionCookies(setCookies: string[]) {
  const written = setCookies.filter((line) => line.startsWith("sb-"));
  expect(written.length).toBeGreaterThan(0);
  return written.map((line) => line.split(";").slice(1).map((part) => part.trim().toLowerCase()));
}
function expectAttributes(setCookies: string[], vercel: boolean) {
  for (const attributes of sessionCookies(setCookies)) {
    expect(attributes).toContain("httponly");
    expect(attributes.includes("secure")).toBe(vercel);
    expect(attributes).toContain("path=/");
    expect(attributes).toContain("samesite=lax");
  }
}

describe("session cookies", () => {
  it.each([false, true])("the proxy rewrites a refreshed session cookie as HttpOnly (Vercel=%s)", async (vercel) => {
    if (vercel) vi.stubEnv("VERCEL", "1");
    const host = "127.0.0.1:3207";
    const { response } = await adapter({
      handler: proxy, page: "/proxy",
      request: { url: `http://${host}/talk`, headers: { host, cookie: oldCookie() }, method: "GET", nextConfig: {}, signal: new AbortController().signal },
    });
    expect(refreshes).toBe(1);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expectAttributes(response.headers.getSetCookie(), vercel);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it.each([false, true])("createServerSupabase writes the refreshed session cookie as HttpOnly (Vercel=%s)", async (vercel) => {
    if (vercel) vi.stubEnv("VERCEL", "1");
    const request = new RequestCookies(new Headers({ cookie: oldCookie() }));
    const headers = new Headers();
    const response = new ResponseCookies(headers);
    h.store.getAll = () => request.getAll();
    h.store.set = (name, value, options) => { response.set(name as string, value as string, options as object); };
    const supabase = await createServerSupabase();
    const { data, error } = await supabase.auth.getClaims();
    expect(error).toBeNull();
    expect(data?.claims.sub).toBe(sub);
    expect(refreshes).toBe(1);
    expectAttributes(headers.getSetCookie(), vercel);
  });
});
