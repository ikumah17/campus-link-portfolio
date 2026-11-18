// @vitest-environment node
// MOBILE-API-001 with the real supabase-js and auth-rate (only fetch and next/headers are fakes): what the mobile
// routes actually send. The sign-in reserves before Auth, reads my_account with the new session's own token, revokes
// a deleted account's sessions globally, trusts x-real-ip only on Vercel, and no request or answer carries a cookie.
// A Bearer route sends the caller's token to Auth and to PostgREST, never the publishable key alone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ headers: new Headers(), cookies: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => h.headers, cookies: h.cookies }));
import { POST as signIn } from "@/app/api/mobile/auth/signin/route";
import { GET as deliver } from "@/app/api/mobile/photos/[photoId]/route";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const photoId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);
const jwt = (sessionId: string) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: userId, exp: now() + 3600, iat: now(), aud: "authenticated", role: "authenticated", session_id: sessionId })}.fake_signature`;
const access = jwt("synthetic-session");
const user = { id: userId, aud: "authenticated", role: "authenticated", email: "fiction@example.invalid", is_anonymous: false,
  app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
type Sent = { method: string; path: string; authorization: string | null; apikey: string | null; cookie: string | null; body: unknown };
let sent: Sent[];
let accountStatus: string;
let fetchSpy: ReturnType<typeof vi.spyOn>;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => {
  sent = []; accountStatus = "active"; h.headers = new Headers();
  h.cookies.mockImplementation(() => { throw new Error("cookies read"); });
  vi.stubEnv("CAMPUS_LINK_BACKEND", "supabase");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_fake");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_fake");
  vi.stubEnv("VERCEL", undefined);
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = request.body ? await request.text() : "";
    sent.push({ method: request.method, path: url.pathname + url.search, authorization: request.headers.get("authorization"),
      apikey: request.headers.get("apikey"), cookie: request.headers.get("cookie"), body: text ? JSON.parse(text) : null });
    if (url.origin !== "https://example.supabase.co") throw new Error("Unexpected host");
    if (url.pathname === "/rest/v1/rpc/service_reserve_signin") return json({ ok: true, code: "ok", ref: null });
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") {
      return json({ access_token: access, refresh_token: "synthetic-refresh", token_type: "bearer", expires_in: 3600, expires_at: now() + 3600, user });
    }
    if (url.pathname === "/rest/v1/rpc/my_account") return json([{ user_id: userId, account_status: accountStatus }]);
    if (url.pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
    if (url.pathname === "/auth/v1/user") return json(user);
    if (url.pathname === "/rest/v1/rpc/authorize_photo_delivery") return json([]);
    throw new Error(`Unexpected request ${url.pathname}`);
  });
});
afterEach(() => {
  for (const request of sent) expect(request.cookie, request.path).toBeNull();
  expect(h.cookies).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
const credentials = () => {
  const body = JSON.stringify({ email: "fiction@example.invalid", password: "fiction-pass-123" });
  return new Request("http://campus.test/api/mobile/auth/signin", { method: "POST", body,
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), cookie: "sb-example-auth-token=x" } });
};

describe("sign-in on the wire", () => {
  it("reserves, signs in, reads my_account with the new token and returns the session in the body only", async () => {
    const response = await signIn(credentials());
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    const body = await response.json();
    expect(body.status).toBe("ok"); expect(body.session.access_token).toBe(access); expect(body.session.refresh_token).toBe("synthetic-refresh");
    expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /rest/v1/rpc/service_reserve_signin", "POST /auth/v1/token?grant_type=password", "POST /rest/v1/rpc/my_account",
    ]);
    // Off Vercel there is no trusted IP, as on the web.
    expect(sent[0].body).toEqual({ p_email: "fiction@example.invalid", p_ip: null });
    expect(sent[0].authorization).toBe("Bearer sb_secret_fake");
    expect(sent[1].authorization).toBe("Bearer sb_publishable_fake");
    expect(sent[2].authorization).toBe(`Bearer ${access}`);
  });
  it("trusts x-real-ip only on Vercel", async () => {
    h.headers = new Headers({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" });
    await signIn(credentials());
    expect(sent[0].body).toEqual({ p_email: "fiction@example.invalid", p_ip: null });
    sent = [];
    vi.stubEnv("VERCEL", "1");
    await signIn(credentials());
    expect(sent[0].body).toEqual({ p_email: "fiction@example.invalid", p_ip: "203.0.113.7" });
  });
  it("revokes every session of a deleted account with its own token and returns none", async () => {
    accountStatus = "deleted";
    const response = await signIn(credentials());
    expect(response.status).toBe(401);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ status: "failed" });
    expect(text).not.toContain(access);
    expect(sent.at(-1)).toMatchObject({ method: "POST", path: "/auth/v1/logout?scope=global", authorization: `Bearer ${access}` });
  });
});

describe("a Bearer route on the wire", () => {
  it("checks the token with Auth and sends it, not a cookie, on the RPC", async () => {
    const response = await deliver(new Request(`http://campus.test/api/mobile/photos/${photoId}`, {
      headers: { authorization: `Bearer ${access}`, cookie: "sb-example-auth-token=x" },
    }), { params: Promise.resolve({ photoId }) });
    expect(response.status).toBe(404);
    expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /auth/v1/user", "POST /rest/v1/rpc/authorize_photo_delivery"]);
    for (const request of sent) {
      expect(request.authorization).toBe(`Bearer ${access}`);
      expect(request.apikey).toBe("sb_publishable_fake");
    }
  });
  it("sends nothing for a cookie without a Bearer token", async () => {
    const response = await deliver(new Request(`http://campus.test/api/mobile/photos/${photoId}`, {
      headers: { cookie: `sb-example-auth-token=base64-${b64({ access_token: access })}` },
    }), { params: Promise.resolve({ photoId }) });
    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
