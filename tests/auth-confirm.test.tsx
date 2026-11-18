// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendMutableCookies, MutableRequestCookiesAdapter } from "next/dist/server/web/spec-extension/adapters/request-cookies";
import { RequestCookies } from "next/dist/server/web/spec-extension/cookies";
import { GET } from "@/app/auth/confirm/route";

const mocks = vi.hoisted(() => {
  // Next's node runtime installs this global before its request stores load; the cookie store below needs it.
  (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= process.getBuiltinModule("node:async_hooks").AsyncLocalStorage;
  return { mode: vi.fn(), create: vi.fn(), exchange: vi.fn(), verify: vi.fn(), rpc: vi.fn(), signOut: vi.fn(), cookies: vi.fn(), ssr: vi.fn() };
});
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.ssr }));
vi.mock("@/lib/backend", () => ({ backendMode: mocks.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: mocks.create }));
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  mocks.mode.mockReturnValue("supabase");
  mocks.create.mockResolvedValue({ auth: { exchangeCodeForSession: mocks.exchange, verifyOtp: mocks.verify, signOut: mocks.signOut }, rpc: mocks.rpc });
  mocks.exchange.mockResolvedValue({ error: null });
  mocks.verify.mockResolvedValue({ error: null });
  mocks.rpc.mockResolvedValue({ data: [{ account_status: null }], error: null });
  mocks.signOut.mockResolvedValue({ error: null });
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function response(query: string) {
  const result = await GET(new Request(`https://campus.example/auth/confirm?${query}`));
  expect(result.headers.get("Cache-Control")).toBe("no-store");
  expect(result.headers.get("Location")).not.toContain("fiction-code");
  expect(result.headers.get("Location")).not.toContain("fiction-token");
  expect(result.headers.get("Location")).toMatch(/^\/(?!\/)/);
  expect(result.headers.get("Location")).not.toContain("campus.example");
  return result;
}
// Every success lands on the account interstitial (SEC-005 L-2), never straight on next.
// FIX-001: the Location is relative (path and query), so the browser stays on the host it requested.
function confirmed(next?: string) {
  return `/auth/confirmed${next ? `?next=${encodeURIComponent(next)}` : ""}`;
}
describe("email confirmation callback", () => {
  it("exchanges a code and shows the account interstitial without a next", async () => {
    expect((await response("code=fiction-code")).headers.get("Location")).toBe(confirmed());
    expect(mocks.exchange).toHaveBeenCalledWith("fiction-code");
    expect(mocks.verify).not.toHaveBeenCalled();
  });
  it.each(["email", "signup"])("verifies a token_hash for %s", async (type) => {
    expect((await response(`token_hash=fiction-token&type=${type}&next=%2Ftalk`)).headers.get("Location")).toBe(confirmed("/talk"));
    expect(mocks.verify).toHaveBeenCalledWith({ token_hash: "fiction-token", type });
    expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it.each(["token_hash=fiction-token&type=recovery", "token_hash=fiction-token&type=invite", "token_hash=fiction-token&type=EMAIL", "token_hash=fiction-token", "type=email", "", "code="])("rejects malformed or unsupported callbacks %# without a client", async (query) => {
    expect((await response(query)).headers.get("Location")).toBe("/login?error=confirm");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(["code-error", "token-error", "code-throw", "token-throw", "client-throw"])("fails closed on %s", async (kind) => {
    if (kind === "code-error") mocks.exchange.mockResolvedValue({ error: { message: "private error" } });
    if (kind === "token-error") mocks.verify.mockResolvedValue({ error: { message: "private error" } });
    if (kind === "code-throw") mocks.exchange.mockRejectedValue(new Error("private error"));
    if (kind === "token-throw") mocks.verify.mockRejectedValue(new Error("private error"));
    if (kind === "client-throw") mocks.create.mockRejectedValue(new Error("private error"));
    const query = kind.startsWith("token") ? "token_hash=fiction-token&type=email" : "code=fiction-code";
    expect((await response(query)).headers.get("Location")).toBe("/login?error=confirm");
  });
  it.each(["code=fiction-code", "token_hash=fiction-token&type=email"])("passes only a safe next to the interstitial (%s)", async (query) => {
    for (const next of ["/talk?x=1", "/a#b", "//evil.example", "/\\evil", "/%2f%2fevil", "/%5cevil", "https://evil.example", "/has space", "/%E0%A4%A", "/" + "a".repeat(512)]) {
      const raw = (await response(`${query}&next=${encodeURIComponent(next)}`)).headers.get("Location")!;
      expect(raw.startsWith("/auth/confirmed")).toBe(true);
      const location = new URL(raw, "http://127.0.0.1:3207");
      const expected = next === "/talk?x=1" || next === "/a#b" ? next : null;
      expect([location.origin, location.pathname, location.hash]).toEqual(["http://127.0.0.1:3207", "/auth/confirmed", ""]);
      expect([...location.searchParams]).toEqual(expected ? [["next", expected]] : []);
    }
  });
  it.each([null, "active", "deactivated", "suspended"])("keeps the session of a %s account after one my_account read", async (status) => {
    mocks.rpc.mockResolvedValue({ data: [{ account_status: status }], error: null });
    expect((await response("code=fiction-code&next=%2Ftalk")).headers.get("Location")).toBe(confirmed("/talk"));
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("my_account", {});
    expect(mocks.exchange.mock.invocationCallOrder[0]).toBeLessThan(mocks.rpc.mock.invocationCallOrder[0]);
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
  it.each(["code", "token", "signout-error", "signout-throw"])("ends every session of a deleted account and answers like a failed link (%s)", async (kind) => {
    mocks.rpc.mockResolvedValue({ data: [{ account_status: "deleted" }], error: null });
    if (kind === "signout-error") mocks.signOut.mockResolvedValue({ error: { message: "private error" } });
    if (kind === "signout-throw") mocks.signOut.mockRejectedValue(new Error("private error"));
    const query = kind === "token" ? "token_hash=fiction-token&type=email&next=%2Fmypage" : "code=fiction-code&next=%2Fmypage";
    const deleted = await response(query);
    expect(deleted.headers.get("Location")).toBe("/login?error=confirm");
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "global" });
    mocks.exchange.mockResolvedValue({ error: { message: "private error" } });
    mocks.verify.mockResolvedValue({ error: { message: "private error" } });
    const failed = await response(query);
    expect([deleted.status, [...deleted.headers]]).toEqual([failed.status, [...failed.headers]]);
  });
  it.each([
    { data: [], error: null }, { data: [{ account_status: "active" }, { account_status: "active" }], error: null }, { data: [{}], error: null },
    { data: null, error: { code: "P0001", message: "forbidden" } }, { data: null, error: { message: "private error" } }, "throw",
  ])("fails closed with a local sign-out when the account cannot be read %#", async (result) => {
    if (result === "throw") mocks.rpc.mockRejectedValue(new Error("private error"));
    else mocks.rpc.mockResolvedValue(result);
    expect((await response("code=fiction-code")).headers.get("Location")).toBe("/login?error=confirm");
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
  });
  it("never reads the account after a failed exchange", async () => {
    mocks.exchange.mockResolvedValue({ error: { message: "private error" } });
    await response("code=fiction-code");
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.signOut).not.toHaveBeenCalled();
  });
  it("answers the same relative Location whatever host request.url carries", async () => {
    for (const origin of ["http://localhost:3207", "http://127.0.0.1:3207", "https://campus.example"]) {
      const result = await GET(new Request(`${origin}/auth/confirm?code=fiction-code&next=%2Ftalk%3Fx%3D%252F`));
      expect([result.status, result.headers.get("Location")]).toEqual([307, confirmed("/talk?x=%2F")]);
    }
  });
  // The real createServerSupabase writes the session through cookies(), Next's mutable request store in a route handler;
  // Next's app-route module then merges those writes into the returned Response with appendMutableCookies, replayed here.
  it.each(["code=fiction-code", "token_hash=fiction-token&type=email"])("keeps the session cookies set during the exchange (%s)", async (query) => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_fake");
    const mutable = MutableRequestCookiesAdapter.wrap(new RequestCookies(new Headers()));
    mocks.cookies.mockResolvedValue(mutable);
    mocks.ssr.mockImplementation((_url, _key, { cookies }) => {
      const write = async () => { cookies.setAll([{ name: "sb-fake-auth-token", value: "fake-session", options: { path: "/", httpOnly: true, sameSite: "lax", secure: true } }]); return { error: null }; };
      return { auth: { exchangeCodeForSession: write, verifyOtp: write, signOut: mocks.signOut }, rpc: mocks.rpc };
    });
    const actual = await vi.importActual<typeof import("@/lib/supabase/server")>("@/lib/supabase/server");
    mocks.create.mockImplementation(actual.createServerSupabase);
    const result = await response(`${query}&next=%2Ftalk`);
    const headers = new Headers(result.headers);
    expect(appendMutableCookies(headers, mutable)).toBe(true);
    expect(headers.getSetCookie()).toEqual([expect.stringMatching(/^sb-fake-auth-token=fake-session; Path=\/; Secure; HttpOnly; SameSite=lax$/i)]);
    expect([result.status, headers.get("Location"), headers.get("Cache-Control")]).toEqual([307, confirmed("/talk"), "no-store"]);
  });
  it("returns 404 in demo mode without a client", async () => {
    mocks.mode.mockReturnValue("demo");
    expect((await GET(new Request("https://campus.example/auth/confirm?code=fiction-code"))).status).toBe(404);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
