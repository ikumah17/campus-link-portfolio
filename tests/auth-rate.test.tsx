// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn(), rpc: vi.fn(), headers: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.create }));
vi.mock("@/lib/supabase/config", () => ({ supabasePublicConfig: () => ({ url: "https://synthetic.supabase.co" }) }));
import { reserveSignIn, reserveSignUp } from "@/server/auth-rate";

// Synthetic strings only; never load an environment file.
const secret = "sb_secret_fake";
const email = "fiction@example.invalid";
const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.c3ludGhldGlj`;
let fetchSpy: ReturnType<typeof vi.spyOn>;
let logs: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", secret);
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  logs = ["log", "warn", "error", "info", "debug"].map((method) => vi.spyOn(console, method as "log").mockImplementation(() => {}));
  mocks.create.mockReturnValue({ rpc: mocks.rpc });
  mocks.headers.mockResolvedValue(new Headers());
  mocks.rpc.mockResolvedValue({ data: { ok: true, code: "ok", ref: null }, error: null });
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); for (const log of logs) expect(log).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("SEC-006 sign-in reservation", () => {
  it("calls only service_reserve_signin with the typed address, through a non-persisting service client", async () => {
    expect(await reserveSignIn(email)).toBe("ok");
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith("https://synthetic.supabase.co", secret, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("service_reserve_signin", { p_email: email, p_ip: null });
  });

  it.each([
    { label: "missing", key: undefined }, { label: "empty", key: "" },
    { label: "publishable", key: "sb_publishable_synthetic" }, { label: "anon JWT", key: jwt("anon") },
    { label: "malformed JWT", key: "e30.bm90LWpzb24.c2ln" }, { label: "wrong role", key: jwt("authenticated") },
    { label: "trailing newline", key: `${secret}\n` },
  ])("answers unavailable for $label keys without creating a client", async ({ key }) => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", key);
    expect(await reserveSignIn(email)).toBe("unavailable");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("accepts a service_role JWT key", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", jwt("service_role"));
    expect(await reserveSignIn(email)).toBe("ok");
  });

  it.each([
    ["rate_limited", { data: { ok: false, code: "rate_limited", ref: null }, error: null }, "rate_limited"],
    ["another refusal", { data: { ok: false, code: "invalid_state", ref: null }, error: null }, "unavailable"],
    ["validation", { data: null, error: { code: "P0001", message: "validation" } }, "unavailable"],
    ["forbidden", { data: null, error: { code: "P0001", message: "forbidden" } }, "unavailable"],
    ["missing RPC", { data: null, error: { code: "PGRST202", message: email }, status: 404 }, "unavailable"],
    ["unauthorized", { data: null, error: null, status: 401 }, "unavailable"],
    ["rows", { data: [], error: null }, "unavailable"],
    ["malformed", { data: { ok: true, code: "ok" }, error: null }, "unavailable"],
    ["empty", { data: null, error: null }, "unavailable"],
  ])("maps %s to %s", async (_label, answer, expected) => {
    mocks.rpc.mockResolvedValue(answer);
    expect(await reserveSignIn(email)).toBe(expected);
  });

  it.each(["create", "rpc"] as const)("answers unavailable when %s throws", async (method) => {
    mocks[method].mockImplementation(() => { throw new Error(email); });
    expect(await reserveSignIn(email)).toBe("unavailable");
  });
});

describe("SEC-008 client IP", () => {
  const request = (entries: Record<string, string>) => mocks.headers.mockResolvedValue(new Headers(entries));
  const passedIp = () => mocks.rpc.mock.calls[0][1].p_ip;

  it.each(["203.0.113.7", "2001:db8:85a3::8a2e:370:7334", "::1", "::ffff:198.51.100.4", "2001:DB8::1"])(
    "on Vercel passes a valid x-real-ip %s unchanged", async (ip) => {
      vi.stubEnv("VERCEL", "1");
      request({ "x-real-ip": ip, "x-forwarded-for": "198.51.100.200" });
      expect(await reserveSignIn(email)).toBe("ok");
      expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("service_reserve_signin", { p_email: email, p_ip: ip });
    });

  it.each([undefined, "", "0", "true", "1 ", "production"])("off Vercel (VERCEL=%s) passes no IP, even with both headers set", async (value) => {
    vi.stubEnv("VERCEL", value);
    request({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.7" });
    expect(await reserveSignIn(email)).toBe("ok");
    expect(passedIp()).toBeNull();
    expect(mocks.headers).not.toHaveBeenCalled();
  });

  it("off Vercel ignores a forged x-forwarded-for", async () => {
    request({ "x-forwarded-for": "192.0.2.1, 203.0.113.7" });
    expect(await reserveSignIn(email)).toBe("ok");
    expect(passedIp()).toBeNull();
  });

  it("on Vercel reads only x-real-ip, never x-forwarded-for", async () => {
    vi.stubEnv("VERCEL", "1");
    request({ "x-forwarded-for": "203.0.113.7" });
    expect(await reserveSignIn(email)).toBe("ok");
    expect(passedIp()).toBeNull();
  });

  it.each([
    "not-an-ip", "203.0.113", "203.0.113.256", "203.0.113.7, 192.0.2.1", "203.0.113.7:443", "[2001:db8::1]",
    "fe80::1%eth0", "203.0.113.0/24", "2001:db8::/64", "1".repeat(46), "::ffff:zz",
  ])("on Vercel an invalid x-real-ip %j gives no IP and still reserves by address", async (ip) => {
    vi.stubEnv("VERCEL", "1");
    request({ "x-real-ip": ip });
    expect(await reserveSignIn(email)).toBe("ok");
    expect(passedIp()).toBeNull();
  });

  it("on Vercel a missing x-real-ip, or a headers() failure, gives no IP and still reserves by address", async () => {
    vi.stubEnv("VERCEL", "1");
    expect(await reserveSignIn(email)).toBe("ok");
    mocks.headers.mockRejectedValue(new Error("203.0.113.7"));
    expect(await reserveSignIn(email)).toBe("ok");
    expect(mocks.rpc.mock.calls.map((call) => call[1].p_ip)).toEqual([null, null]);
  });

  it("a per-IP refusal maps to rate_limited", async () => {
    vi.stubEnv("VERCEL", "1");
    request({ "x-real-ip": "203.0.113.7" });
    mocks.rpc.mockResolvedValue({ data: { ok: false, code: "rate_limited", ref: null }, error: null });
    expect(await reserveSignIn(email)).toBe("rate_limited");
  });

  it("fails closed when the database still has only the one-argument RPC (hosted before order 24)", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "not found" }, status: 404 });
    expect(await reserveSignIn(email)).toBe("unavailable");
  });
});

describe("SEC-012 sign-up reservation", () => {
  const request = (entries: Record<string, string>) => mocks.headers.mockResolvedValue(new Headers(entries));

  it("calls only service_reserve_signup with the typed address, through the same non-persisting service client", async () => {
    expect(await reserveSignUp(email)).toBe("ok");
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith("https://synthetic.supabase.co", secret, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("service_reserve_signup", { p_email: email, p_ip: null });
  });

  it.each(["203.0.113.7", "2001:db8:85a3::8a2e:370:7334", "::ffff:198.51.100.4"])("on Vercel passes a valid x-real-ip %s", async (ip) => {
    vi.stubEnv("VERCEL", "1");
    request({ "x-real-ip": ip, "x-forwarded-for": "198.51.100.200" });
    expect(await reserveSignUp(email)).toBe("ok");
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("service_reserve_signup", { p_email: email, p_ip: ip });
  });

  it.each([undefined, "", "0", "true", "production"])("off Vercel (VERCEL=%s) passes no IP and never reads the headers", async (value) => {
    vi.stubEnv("VERCEL", value);
    request({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.7" });
    expect(await reserveSignUp(email)).toBe("ok");
    expect(mocks.rpc.mock.calls[0][1].p_ip).toBeNull();
    expect(mocks.headers).not.toHaveBeenCalled();
  });

  it.each<Record<string, string>>([{}, { "x-forwarded-for": "203.0.113.7" }, { "x-real-ip": "203.0.113.7, 192.0.2.1" }, { "x-real-ip": "fe80::1%eth0" }, { "x-real-ip": "203.0.113.0/24" }])(
    "on Vercel a missing or invalid x-real-ip %j gives no IP and still reserves by address", async (entries) => {
      vi.stubEnv("VERCEL", "1");
      request(entries);
      expect(await reserveSignUp(email)).toBe("ok");
      expect(mocks.rpc.mock.calls[0][1].p_ip).toBeNull();
    });

  it.each([
    ["rate_limited", { data: { ok: false, code: "rate_limited", ref: null }, error: null }, "rate_limited"],
    ["another refusal", { data: { ok: false, code: "invalid_state", ref: null }, error: null }, "unavailable"],
    ["validation", { data: null, error: { code: "P0001", message: "validation" } }, "unavailable"],
    ["forbidden", { data: null, error: { code: "P0001", message: "forbidden" } }, "unavailable"],
    ["missing RPC (hosted before order 25)", { data: null, error: { code: "PGRST202", message: email }, status: 404 }, "unavailable"],
    ["rows", { data: [], error: null }, "unavailable"],
    ["malformed", { data: { ok: true, code: "ok" }, error: null }, "unavailable"],
  ])("maps %s to %s", async (_label, answer, expected) => {
    mocks.rpc.mockResolvedValue(answer);
    expect(await reserveSignUp(email)).toBe(expected);
  });

  it.each([undefined, "sb_publishable_synthetic", jwt("anon")])("answers unavailable for a non-service key %# without creating a client", async (key) => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", key);
    expect(await reserveSignUp(email)).toBe("unavailable");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each(["create", "rpc"] as const)("answers unavailable when %s throws", async (method) => {
    mocks[method].mockImplementation(() => { throw new Error(email); });
    expect(await reserveSignUp(email)).toBe("unavailable");
  });
});
