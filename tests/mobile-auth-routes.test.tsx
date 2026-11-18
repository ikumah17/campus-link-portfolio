// @vitest-environment node
// MOBILE-API-001: POST /api/mobile/auth/signin and /signup share the web actions' checks (src/server/auth-core.ts):
// the same validation, reservations, failure floor, deleted-account handling and answers. They read no cookie, set
// none, and the session appears only in the sign-in JSON body.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
const mocks = vi.hoisted(() => ({ mode: vi.fn(), create: vi.fn(), cookieClient: vi.fn(), cookies: vi.fn(), signUp: vi.fn(), signIn: vi.fn(),
  signOut: vi.fn(), rpc: vi.fn(), reserve: vi.fn(), reserveSignUp: vi.fn(), redirect: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: mocks.mode }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.create }));
vi.mock("@/lib/supabase/config", () => ({ supabasePublicConfig: () => ({ url: "https://synthetic.supabase.co", publishableKey: "sb_publishable_fake" }) }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: mocks.cookieClient }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/server/auth-rate", () => ({ reserveSignIn: mocks.reserve, reserveSignUp: mocks.reserveSignUp }));
import * as signin from "@/app/api/mobile/auth/signin/route";
import * as signup from "@/app/api/mobile/auth/signup/route";
import { signInAction, signUpAction } from "@/server/auth-actions";
import { authFieldMessages, passwordMessages } from "@/lib/auth-validation";
import { CREDENTIALS_READ_MS, MAX_CREDENTIALS_BYTES } from "@/server/mobile-credentials";

// FIX-005: meets the sign-up rule.
const password = "Fiction-pass-123";
const email = "fiction@example.invalid";
const privateError = "private provider details";
const CSP = "default-src 'none'; frame-ancestors 'none'";
const session = { access_token: "synthetic-access-token-value", refresh_token: "synthetic-refresh-token-value", token_type: "bearer",
  expires_in: 3600, expires_at: 1_900_000_000, user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email } };
const client = { auth: { signUp: mocks.signUp, signInWithPassword: mocks.signIn, signOut: mocks.signOut }, rpc: mocks.rpc };
let fetchSpy: ReturnType<typeof vi.spyOn>;
let consoleSpies: MockInstance[];
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CAMPUS_LINK_SITE_URL", "");
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((name) => vi.spyOn(console, name));
  mocks.mode.mockReturnValue("supabase");
  mocks.create.mockReturnValue(client);
  mocks.cookieClient.mockResolvedValue(client);
  mocks.cookies.mockImplementation(() => { throw new Error("cookies read"); });
  mocks.rpc.mockResolvedValue({ data: [{ account_status: "active" }], error: null });
  mocks.reserve.mockResolvedValue("ok");
  mocks.reserveSignUp.mockResolvedValue("ok");
  mocks.signUp.mockResolvedValue({ data: {}, error: null });
  mocks.signIn.mockResolvedValue({ data: { session, user: session.user }, error: null });
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.redirect.mockImplementation((path: string) => { throw new Error(`REDIRECT:${path}`); });
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled(); expect(mocks.cookies).not.toHaveBeenCalled();
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
});

type Init = { body?: BodyInit; type?: string | null; length?: string | null; headers?: Record<string, string> };
function request(path: string, value: unknown = { email: ` ${email} `, password }, { body, type = "application/json", length, headers = {} }: Init = {}) {
  const bytes = body ?? new TextEncoder().encode(JSON.stringify(value));
  const all: Record<string, string | null> = { "content-type": type, ...headers,
    "content-length": length === undefined ? String((bytes as Uint8Array).byteLength) : length };
  const init: RequestInit & { duplex?: "half" } = { method: "POST", body: bytes, duplex: "half",
    headers: Object.fromEntries(Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== null)) };
  return new Request(`http://campus.test${path}`, init);
}
const signIn = (value?: unknown, init?: Init) => signin.POST(request("/api/mobile/auth/signin", value, init));
const signUp = (value?: unknown, init?: Init) => signup.POST(request("/api/mobile/auth/signup", value, init));
function form(value: Record<string, unknown>) {
  const data = new FormData();
  for (const [key, field] of Object.entries(value)) if (typeof field === "string") data.set(key, field);
  return data;
}
async function answer(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-security-policy")).toBe(CSP);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  for (const [, value] of response.headers) for (const secret of [session.access_token, session.refresh_token]) expect(value).not.toContain(secret);
  const body = await response.json();
  expect(JSON.stringify(body)).not.toContain(privateError);
  return { http: response.status, body };
}
const noSecrets = (body: unknown) => {
  for (const value of [session.access_token, session.refresh_token, password]) expect(JSON.stringify(body)).not.toContain(value);
};

describe("POST /api/mobile/auth/signin", () => {
  it("returns the session in the JSON body only, from a client that keeps nothing", async () => {
    const { http, body } = await answer(await signIn());
    expect(http).toBe(200);
    expect(body).toEqual({ status: "ok", session: {
      access_token: session.access_token, refresh_token: session.refresh_token, token_type: "bearer", expires_in: 3600, expires_at: 1_900_000_000,
    } });
    expect(mocks.create).toHaveBeenCalledWith("https://synthetic.supabase.co", "sb_publishable_fake", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: "pkce" },
    });
    expect(mocks.cookieClient).not.toHaveBeenCalled();
    expect(mocks.reserve).toHaveBeenCalledWith(email);
    expect(mocks.signIn).toHaveBeenCalledWith({ email, password });
    expect(mocks.rpc).toHaveBeenCalledWith("my_account", {});
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
  it("ignores a cookie and a Bearer token: they authenticate nothing and are never read", async () => {
    mocks.signIn.mockResolvedValue({ data: { session: null, user: null }, error: { status: 400, code: "invalid_credentials", message: privateError } });
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const pending = signIn(undefined, { headers: { cookie: "sb-synthetic-auth-token=base64-x", authorization: "Bearer a.b.c" } });
    await vi.advanceTimersByTimeAsync(1500);
    const { http, body } = await answer(await pending);
    expect([http, body]).toEqual([401, { status: "failed" }]);
  });
  it("answers every wrong password after the 1500 ms floor", async () => {
    mocks.signIn.mockResolvedValue({ data: { session: null, user: null }, error: { status: 400, code: "invalid_credentials", message: privateError } });
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    let settled = false;
    const pending = signIn().finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const { http, body } = await answer(await pending);
    expect([http, body]).toEqual([401, { status: "failed" }]);
  });
  it("ends every session of a deleted account and answers it as a wrong password, after the floor", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ account_status: "deleted" }], error: null });
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    let settled = false;
    const pending = signIn().finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const { http, body } = await answer(await pending);
    expect([http, body]).toEqual([401, { status: "failed" }]); noSecrets(body);
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "global" });
  });
  it("revokes the new session and returns no token when the account cannot be read", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: privateError } });
    const { http, body } = await answer(await signIn());
    expect([http, body]).toEqual([503, { status: "unavailable" }]); noSecrets(body);
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
  it("answers unavailable when Auth returns no session", async () => {
    mocks.signIn.mockResolvedValue({ data: { session: null, user: null }, error: null });
    expect(await answer(await signIn())).toEqual({ http: 503, body: { status: "unavailable" } });
  });
});

// The same scenario through the web action and the app route must give the same AuthFormState.
const parity: [string, Record<string, unknown>, () => void][] = [
  ["a malformed address", { email: "not-an-address", password }, () => {}],
  ["a short password", { email, password: "short" }, () => {}],
  ["missing fields", {}, () => {}],
  ["non-string fields", { email: 1, password: ["x"] }, () => {}],
  ["a rate-limited address or IP", { email, password }, () => mocks.reserve.mockResolvedValue("rate_limited")],
  ["an unavailable reservation", { email, password }, () => mocks.reserve.mockResolvedValue("unavailable")],
  ["a failed reservation", { email, password }, () => mocks.reserve.mockRejectedValue(new Error(privateError))],
  ["an Auth rate limit", { email, password }, () => mocks.signIn.mockResolvedValue({ data: {}, error: { status: 429, message: privateError } })],
  ["an Auth request limit", { email, password }, () => mocks.signIn.mockResolvedValue({ data: {}, error: { code: "over_request_rate_limit" } })],
  ["a wrong password", { email, password }, () => mocks.signIn.mockResolvedValue({ data: {}, error: { status: 400, code: "invalid_credentials" } })],
  ["an unconfirmed address", { email, password }, () => mocks.signIn.mockResolvedValue({ data: {}, error: { status: 400, code: "email_not_confirmed" } })],
  ["a thrown Auth call", { email, password }, () => mocks.signIn.mockRejectedValue(new Error(privateError))],
  ["a deleted account", { email, password }, () => mocks.rpc.mockResolvedValue({ data: [{ account_status: "deleted" }], error: null })],
  ["an unreadable account", { email, password }, () => mocks.rpc.mockResolvedValue({ data: [], error: null })],
];
describe("sign-in answers are the web action's", () => {
  it.each(parity)("for %s", async (_, value, arrange) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    arrange();
    const web = signInAction({ status: "idle" }, form(value));
    await vi.advanceTimersByTimeAsync(1500);
    const webState = await web;
    const webCalls = { reserve: mocks.reserve.mock.calls, signIn: mocks.signIn.mock.calls, signOut: mocks.signOut.mock.calls };
    vi.clearAllMocks(); arrange();
    mocks.create.mockReturnValue(client);
    mocks.cookies.mockImplementation(() => { throw new Error("cookies read"); });
    const app = signIn(value);
    await vi.advanceTimersByTimeAsync(1500);
    const { http, body } = await answer(await app);
    expect(body).toEqual(webState);
    expect(http).toBe({ invalid: 400, failed: 401, rate_limited: 429, unavailable: 503 }[webState.status as string]);
    expect({ reserve: mocks.reserve.mock.calls, signIn: mocks.signIn.mock.calls, signOut: mocks.signOut.mock.calls }).toEqual(webCalls);
    if (webState.status === "invalid") expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("and a success is the web's redirect", async () => {
    await expect(signInAction({ status: "idle" }, form({ email, password }))).rejects.toThrow("REDIRECT:/");
    expect((await answer(await signIn())).body.status).toBe("ok");
  });
});

describe("POST /api/mobile/auth/signup", () => {
  it("answers the same sent for a new and an existing address, with the web's emailRedirectTo", async () => {
    vi.stubEnv("CAMPUS_LINK_SITE_URL", "https://campus.example");
    const results = [];
    for (const result of [{ data: { user: { identities: [{}] } }, error: null }, { data: { user: { identities: [] } }, error: null },
      ...["user_already_exists", "email_exists"].map((code) => ({ data: null, error: { code, message: privateError } }))]) {
      mocks.signUp.mockResolvedValueOnce(result);
      results.push(await answer(await signUp()));
    }
    expect(results).toEqual(Array(4).fill({ http: 200, body: { status: "sent" } }));
    expect(mocks.reserveSignUp).toHaveBeenCalledWith(email);
    expect(mocks.signUp).toHaveBeenCalledWith({ email, password, options: { emailRedirectTo: "https://campus.example/auth/confirm" } });
    expect(mocks.cookieClient).not.toHaveBeenCalled();
  });
  it.each([
    ["a malformed address", { email: "x", password }, () => {}],
    ["a rate-limited reservation", { email, password }, () => mocks.reserveSignUp.mockResolvedValue("rate_limited")],
    ["an unavailable reservation", { email, password }, () => mocks.reserveSignUp.mockResolvedValue("unavailable")],
    ["an Auth email limit", { email, password }, () => mocks.signUp.mockResolvedValue({ data: null, error: { code: "over_email_send_rate_limit" } })],
    ["a weak password", { email, password }, () => mocks.signUp.mockResolvedValue({ data: null, error: { code: "weak_password", message: privateError } })],
    ["an invalid address at Auth", { email, password }, () => mocks.signUp.mockResolvedValue({ data: null, error: { code: "email_address_invalid" } })],
    ["an Auth failure", { email, password }, () => mocks.signUp.mockResolvedValue({ data: null, error: { code: "unexpected_failure" } })],
    ["a thrown Auth call", { email, password }, () => mocks.signUp.mockRejectedValue(new Error(privateError))],
  ] as const)("answers the web action's state for %s", async (_, value, arrange) => {
    arrange();
    const webState = await signUpAction({ status: "idle" }, form(value));
    vi.clearAllMocks(); arrange();
    mocks.create.mockReturnValue(client);
    mocks.cookies.mockImplementation(() => { throw new Error("cookies read"); });
    const { http, body } = await answer(await signUp(value));
    expect(body).toEqual(webState);
    expect(http).toBe({ invalid: 400, rate_limited: 429, unavailable: 503 }[webState.status as string]);
  });
  it("names the field in an invalid answer", async () => {
    mocks.signUp.mockResolvedValue({ data: null, error: { code: "weak_password" } });
    expect((await answer(await signUp())).body).toEqual({ status: "invalid", fieldErrors: { password: passwordMessages.rule } });
  });
  it.each([
    ["Ab1!", passwordMessages.short], ["password123", passwordMessages.uppercase], ["PASSWORD123!", passwordMessages.lowercase],
    ["Password!!", passwordMessages.digit], ["Password123", passwordMessages.symbol], ["Pass word12!", passwordMessages.characters],
    ["Pässword12!", passwordMessages.characters], [`Aa1!${"a".repeat(69)}`, passwordMessages.long],
  ])("refuses the new password %j before Auth with the web's field message (FIX-005)", async (value, message) => {
    const { http, body } = await answer(await signUp({ email, password: value }));
    expect(http).toBe(400);
    expect(body).toEqual({ status: "invalid", fieldErrors: { password: message } });
    expect(mocks.reserveSignUp).not.toHaveBeenCalled();
    expect(mocks.signUp).not.toHaveBeenCalled();
  });
  it("still signs in with an older-style password (FIX-005)", async () => {
    const { http } = await answer(await signIn({ email, password: "password123" }));
    expect(http).toBe(200);
    expect(mocks.signIn).toHaveBeenCalledWith({ email, password: "password123" });
  });
});

describe("the JSON body, for both routes", () => {
  const routes = [["signin", signIn], ["signup", signUp]] as const;
  it("keeps the body small and the read short", () => {
    expect([MAX_CREDENTIALS_BYTES, CREDENTIALS_READ_MS]).toEqual([4096, 10_000]);
  });
  it.each(routes)("%s refuses a non-JSON body, a missing or oversized length and malformed JSON before any reservation", async (_, route) => {
    const cases: [Init, unknown, number][] = [
      [{ type: null }, undefined, 415], [{ type: "application/x-www-form-urlencoded" }, undefined, 415], [{ type: "multipart/form-data" }, undefined, 415],
      [{ length: null }, undefined, 411], [{ length: "abc" }, undefined, 411],
      [{ length: String(MAX_CREDENTIALS_BYTES + 1) }, undefined, 413],
      [{ length: "10" }, { email, password: "x".repeat(5000) }, 413],
      [{ body: new TextEncoder().encode("{not json") }, undefined, 400],
      [{ body: new Uint8Array([0x7b, 0xff, 0x7d]) }, undefined, 400],
      [{}, [email, password], 400], [{}, "text", 400], [{}, null, 400],
    ];
    for (const [init, value, http] of cases) {
      const response = await route(value, init);
      expect(await answer(response), JSON.stringify(init)).toEqual({ http, body: { status: "invalid" } });
    }
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.reserveSignUp).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(routes)("%s accepts a charset parameter", async (_, route) => {
    expect((await route(undefined, { type: "application/json; charset=utf-8" })).status).toBe(200);
  });
  it.each(routes)("%s cancels a body not complete within 10 seconds", async (_, route) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull() {}, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    let settled = false;
    const pending = route(undefined, { body, length: "20" }).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await answer(await pending)).toEqual({ http: 400, body: { status: "invalid" } });
    expect(cancelled).toBe(true);
  });
  it.each([["signin", signin], ["signup", signup]] as const)("%s answers 404 in demo and 405 to other methods", async (_, route) => {
    mocks.mode.mockReturnValue("demo");
    const refused = await route.POST(request("/api/mobile/auth/x"));
    expect(refused.status).toBe(404); expect(refused.headers.get("cache-control")).toBe("no-store");
    for (const method of ["GET", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
      const response = route[method]();
      expect(response.status).toBe(405); expect(response.headers.get("allow")).toBe("POST"); expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.reserveSignUp).not.toHaveBeenCalled();
  });
});
