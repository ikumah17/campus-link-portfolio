// SEC-010: the browser's Realtime token comes from /api/realtime-token, cached until 60 s before expiry.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserSupabase, REALTIME_TOKEN_PATH, realtimeTokenSource } from "@/lib/supabase/browser";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const token = (name: string, expiresAt: number) => json({ token: name, expiresAt });
let fetchMock: ReturnType<typeof vi.fn>;
let socket: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  socket = vi.fn(function () { throw new Error("no WebSocket"); });
  vi.stubGlobal("WebSocket", socket);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_fake");
});
afterEach(() => {
  // Only the same-origin token route is ever fetched, and Realtime never connects in these tests.
  for (const [input] of fetchMock.mock.calls) expect(input).toBe(REALTIME_TOKEN_PATH);
  expect(socket).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("realtime token cache", () => {
  it("fetches once for many calls, same-origin and uncached", async () => {
    let now = 1_000_000_000_000;
    fetchMock.mockResolvedValue(token("first", now / 1000 + 3600));
    const accessToken = realtimeTokenSource(() => now);
    for (let i = 0; i < 5; i++) {
      expect(await accessToken()).toBe("first");
      now += 60_000;
    }
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(REALTIME_TOKEN_PATH, { credentials: "same-origin", cache: "no-store" });
  });

  it("refetches from 60 seconds before expiry", async () => {
    let now = 1_000_000_000_000;
    const expiresAt = now / 1000 + 3600;
    fetchMock.mockResolvedValueOnce(token("first", expiresAt)).mockResolvedValueOnce(token("second", expiresAt + 3600));
    const accessToken = realtimeTokenSource(() => now);
    expect(await accessToken()).toBe("first");
    now = (expiresAt - 61) * 1000;
    expect(await accessToken()).toBe("first");
    now = (expiresAt - 60) * 1000;
    expect(await accessToken()).toBe("second");
    expect(await accessToken()).toBe("second");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight fetch", async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((done) => { resolve = done; }));
    const accessToken = realtimeTokenSource(() => 1_000_000_000_000);
    const calls = [accessToken(), accessToken(), accessToken()];
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(token("shared", 1_000_003_600));
    expect(await Promise.all(calls)).toEqual(["shared", "shared", "shared"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["401", () => json({}, 401)],
    ["the login page's HTML", () => new Response("<!doctype html><title>login</title>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })],
    ["JSON without a token", () => json({ expiresAt: 1_000_003_600 })],
    ["JSON without an expiry", () => json({ token: "x" })],
    ["a JSON array", () => json(["x"])],
    ["malformed JSON", () => new Response("{", { status: 200, headers: { "content-type": "application/json" } })],
    ["a network error", () => { throw new TypeError("Failed to fetch"); }],
  ])("throws on %s, then fetches afresh", async (_name, answer) => {
    fetchMock.mockImplementationOnce(async () => answer());
    const accessToken = realtimeTokenSource(() => 1_000_000_000_000);
    await expect(accessToken()).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(token("recovered", 1_000_003_600));
    expect(await accessToken()).toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("drops the cached token after a failed refresh", async () => {
    let now = 1_000_000_000_000;
    fetchMock.mockResolvedValueOnce(token("first", now / 1000 + 120)).mockResolvedValueOnce(json({}, 401));
    const accessToken = realtimeTokenSource(() => now);
    expect(await accessToken()).toBe("first");
    now += 61_000;
    await expect(accessToken()).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(token("second", now / 1000 + 3600));
    expect(await accessToken()).toBe("second");
  });
});

describe("browser client", () => {
  it("keeps one client per tab and re-authorizes Realtime from the cache on heartbeat", async () => {
    const realNow = Date.now();
    const expiresAt = Math.floor(realNow / 1000) + 3600;
    fetchMock.mockResolvedValueOnce(token("first", expiresAt)).mockResolvedValueOnce(token("second", expiresAt + 3600));
    const client = createBrowserSupabase();
    expect(createBrowserSupabase()).toBe(client);
    // The client is configured with the accessToken option, so it has no cookie- or storage-backed auth.
    expect(() => client.auth.getSession()).toThrow(/accessToken option/);
    await client.realtime.setAuth();
    const realtime = client.realtime as unknown as { accessTokenValue: string | null; heartbeatCallback: (status: string) => void };
    expect(realtime.accessTokenValue).toBe("first");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A heartbeat inside the token's lifetime uses the cache.
    realtime.heartbeatCallback("sent");
    await vi.waitFor(() => expect(realtime.accessTokenValue).toBe("first"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Near expiry the next heartbeat (realtime-js calls the accessToken callback on each one) fetches a fresh token.
    vi.spyOn(Date, "now").mockReturnValue((expiresAt - 30) * 1000);
    realtime.heartbeatCallback("sent");
    await vi.waitFor(() => expect(realtime.accessTokenValue).toBe("second"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
