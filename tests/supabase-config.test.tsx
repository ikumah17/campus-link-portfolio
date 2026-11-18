// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backendMode } from "@/lib/backend";
import { ConfigError, supabasePublicConfig } from "@/lib/supabase/config";

const ssr = vi.hoisted(() => ({ createServerClient: vi.fn() }));
const cookieStore = vi.hoisted(() => ({ getAll: vi.fn(() => []), set: vi.fn() }));
vi.mock("@supabase/ssr", () => ssr);
vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));
vi.mock("server-only", () => ({}));
import { createServerSupabase } from "@/lib/supabase/server";

const jwt = (role: unknown) => `${btoa('{"alg":"HS256"}')}.${btoa(JSON.stringify({ role })).replace(/=/g, "")}.fake_signature`;
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_fake");
  vi.stubEnv("VERCEL", undefined);
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("backend mode", () => {
  it.each([undefined, "demo", "SUPABASE", "supabase ", "supabase"])("enables only the exact opt-in %s", (value) => {
    vi.stubEnv("CAMPUS_LINK_BACKEND", value);
    expect(backendMode()).toBe(value === "supabase" ? "supabase" : "demo");
  });
});
describe("public config", () => {
  it("accepts the publishable key", () => expect(supabasePublicConfig()).toEqual({ url: "https://example.supabase.co", publishableKey: "sb_publishable_fake" }));
  it("accepts a legacy anon JWT", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", jwt("anon"));
    expect(supabasePublicConfig().publishableKey).toBe(jwt("anon"));
  });
  it.each(["sb_secret_fake", jwt("service_role"), jwt("authenticated"), jwt(null), "", "nonsense", "a.bad.c", "sb_publishable_", "sb_publishable_fake "])("rejects invalid key case %# without disclosing it", (key) => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", key);
    expect(() => supabasePublicConfig()).toThrow(ConfigError);
    try { supabasePublicConfig(); } catch (error) {
      expect(String(error)).toContain("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
      if (key) expect(String(error)).not.toContain(key);
    }
  });
  it.each(["https://evil.example", "http://evil.example", "http://example.supabase.co", "https://example.supabase.co.evil.example", "https://user:pass@example.supabase.co", "https://example.supabase.co/path", "http://localhost:4000"])("rejects unsafe URL case %# without disclosing it", (url) => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", url);
    expect(() => supabasePublicConfig()).toThrow(ConfigError);
    try { supabasePublicConfig(); } catch (error) {
      expect(String(error)).toContain("NEXT_PUBLIC_SUPABASE_URL");
      expect(String(error)).not.toContain(url);
    }
  });
  it.each(["http://localhost:54321", "http://127.0.0.1:54321", "https://example.supabase.co/"])("accepts allowed URL %s", (url) => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", url);
    expect(supabasePublicConfig().url).toBe(url);
  });
  it.each(["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"])("names missing %s", (variable) => {
    vi.stubEnv(variable, undefined);
    expect(() => supabasePublicConfig()).toThrow(variable);
  });
});
describe("client factories", () => {
  it("creates a new server client per request and tolerates read-only component cookies", async () => {
    ssr.createServerClient.mockReturnValueOnce({ id: 1 }).mockReturnValueOnce({ id: 2 });
    expect(await createServerSupabase()).not.toEqual(await createServerSupabase());
    const options = ssr.createServerClient.mock.calls[0][2];
    // SEC-010: the shared options; the browser client (tests/realtime-token-cache.test.tsx) writes no cookie.
    expect(options.cookieOptions).toEqual({ httpOnly: true, secure: false });
    expect(options.cookies.getAll()).toEqual([]);
    options.cookies.setAll([{ name: "token", value: "fake", options: { httpOnly: true } }]);
    expect(cookieStore.set).toHaveBeenCalledWith("token", "fake", { httpOnly: true });
    cookieStore.set.mockImplementationOnce(() => { throw new Error("read-only cookies"); });
    expect(() => options.cookies.setAll([{ name: "token", value: "fake", options: {} }])).not.toThrow();
  });
  it("marks server session cookies Secure only on Vercel", async () => {
    vi.stubEnv("VERCEL", "1");
    await createServerSupabase();
    expect(ssr.createServerClient.mock.calls[0][2].cookieOptions).toEqual({ httpOnly: true, secure: true });
  });
});
