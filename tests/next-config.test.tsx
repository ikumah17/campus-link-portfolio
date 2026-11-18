// @vitest-environment node
// SEC-007 (SECREVIEW-001 L-3): photos upload through POST /api/photos, so every Server Action keeps Next's
// default body limit. A raised serverActions.bodySizeLimit would apply to every action, signed in or not.
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import nextConfig from "../next.config";

// SEC-016: the proxied body copy is 1 MiB plus 256 KiB. Next ends a body over it early, so a truncated Server Action
// body must still exceed the 1 MiB action limit, even after the last whole 64 KiB socket read before the cut.
const ACTION_LIMIT = 1024 * 1024;

it("bounds the proxied body copy just above the Server Action limit", () => {
  const limit = nextConfig.experimental?.proxyClientMaxBodySize;
  expect(limit).toBe(1_310_720);
  expect(Number(limit) - 4 * 64 * 1024).toBe(ACTION_LIMIT);
  expect(nextConfig.experimental?.middlewareClientMaxBodySize).toBeUndefined();
});

it("sets no Server Action body size limit", () => {
  expect(nextConfig.experimental?.serverActions?.bodySizeLimit).toBeUndefined();
  expect(readFileSync("next.config.ts", "utf8")).not.toMatch(/bodySizeLimit|serverActions/);
});

it("keeps the upload out of Server Actions", () => {
  const actions = readFileSync("src/server/photo-actions.ts", "utf8");
  expect(actions).not.toMatch(/uploadPhoto|arrayBuffer|reencodePhoto/);
  expect(readFileSync("src/components/photo-manager.tsx", "utf8")).toContain('fetch("/api/photos"');
});

// FIX-008: dev resources (/_next/hmr) accept another origin only when CAMPUS_LINK_DEV_ORIGINS names it for `npm run dev`.
async function loadConfig(env: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.resetModules();
  return (await import("../next.config")).default;
}
afterEach(() => vi.unstubAllEnvs());

it("sets no allowed dev origin by default and commits no address", async () => {
  expect((await loadConfig({ CAMPUS_LINK_DEV_ORIGINS: undefined })).allowedDevOrigins).toBeUndefined();
  expect((await loadConfig({ CAMPUS_LINK_DEV_ORIGINS: " , " })).allowedDevOrigins).toBeUndefined();
  expect(readFileSync("next.config.ts", "utf8")).not.toMatch(/\d+[.]\d+[.]\d+[.]\d+/);
});

it("allows the listed dev origins only when the env value is set", async () => {
  const config = await loadConfig({ CAMPUS_LINK_DEV_ORIGINS: "192.0.2.10, campus-pc.local,," });
  expect(config.allowedDevOrigins).toEqual(["192.0.2.10", "campus-pc.local"]);
});

it("never applies dev origins in a production build", async () => {
  const config = await loadConfig({ CAMPUS_LINK_DEV_ORIGINS: "192.0.2.10", NODE_ENV: "production" });
  expect(config.allowedDevOrigins).toBeUndefined();
});
