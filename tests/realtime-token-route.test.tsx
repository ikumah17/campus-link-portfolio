// @vitest-environment node
// SEC-010: GET /api/realtime-token authorizes by getClaims(), then answers only the same user's access token and expiry.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ create: vi.fn(), getClaims: vi.fn(), getSession: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: m.create }));
import * as route from "@/app/api/realtime-token/route";

const sub = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const session = { access_token: "fake-access-token", refresh_token: "fake-refresh-token", expires_at: 1_900_000_000, expires_in: 3600, token_type: "bearer", user: { id: sub, email: "fake@example.invalid" } };
let fetchSpy: ReturnType<typeof vi.spyOn>;
let logs: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  vi.stubEnv("CAMPUS_LINK_BACKEND", "supabase");
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  logs = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
  m.getClaims.mockResolvedValue({ data: { claims: { sub } }, error: null });
  m.getSession.mockResolvedValue({ data: { session }, error: null });
  m.create.mockResolvedValue({ auth: { getClaims: m.getClaims, getSession: m.getSession } });
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  for (const log of logs) expect(log).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const get = (headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) =>
  route.GET(new Request("https://campus.example/api/realtime-token", { headers: { cookie: "sb-example-auth-token=fake-cookie", ...headers } }));
async function expectEmpty(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({});
}

describe("realtime token route", () => {
  it("answers 404 in demo mode without touching the session", async () => {
    for (const value of [undefined, "demo"]) {
      vi.stubEnv("CAMPUS_LINK_BACKEND", value);
      const response = await get();
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
    }
    expect(m.create).not.toHaveBeenCalled();
  });

  it("returns only the access token and its expiry to the same verified user", async () => {
    for (const headers of [{ "sec-fetch-site": "same-origin" }, {}] as Record<string, string>[]) {
      const response = await get(headers);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toContain("application/json");
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ token: "fake-access-token", expiresAt: 1_900_000_000 });
      for (const leak of ["fake-refresh-token", "refresh", sub, "fake@example.invalid", "fake-cookie"]) expect(text.includes(leak)).toBe(false);
    }
    // Authorization comes first: the session is read only after verified claims.
    expect(m.getClaims.mock.invocationCallOrder[0]).toBeLessThan(m.getSession.mock.invocationCallOrder[0]);
  });

  it.each([
    ["no claims", { data: null, error: null }],
    ["an auth error", { data: { claims: { sub } }, error: { message: "invalid JWT" } }],
    ["claims without sub", { data: { claims: {} }, error: null }],
    ["an empty sub", { data: { claims: { sub: "" } }, error: null }],
  ])("answers 401 for %s without reading the session", async (_name, result) => {
    m.getClaims.mockResolvedValue(result);
    await expectEmpty(await get(), 401);
    expect(m.getSession).not.toHaveBeenCalled();
  });

  it.each([
    ["no session", null],
    ["another user's session", { ...session, user: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } }],
    ["a session without a user", { ...session, user: undefined }],
    ["no access token", { ...session, access_token: "" }],
    ["no expiry", { ...session, expires_at: undefined }],
  ])("answers 401 for %s", async (_name, value) => {
    m.getSession.mockResolvedValue({ data: { session: value }, error: null });
    await expectEmpty(await get(), 401);
  });

  it("answers 401 when the session cannot be read", async () => {
    m.getClaims.mockRejectedValue(new Error("auth unavailable"));
    await expectEmpty(await get(), 401);
    m.getClaims.mockResolvedValue({ data: { claims: { sub } }, error: null });
    m.create.mockRejectedValue(new Error("config"));
    await expectEmpty(await get(), 401);
  });

  it.each(["cross-site", "same-site", "none", ""])("answers 403 for Sec-Fetch-Site %j before reading the session", async (site) => {
    await expectEmpty(await get({ "sec-fetch-site": site }), 403);
    expect(m.create).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const)("answers %s with 405", async (method) => {
    const response = route[method]();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
    expect(m.create).not.toHaveBeenCalled();
  });
});
