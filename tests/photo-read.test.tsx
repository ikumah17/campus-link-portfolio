// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn(), from: vi.fn(), download: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.create }));
vi.mock("@/lib/supabase/config", () => ({ supabasePublicConfig: () => ({ url: "https://synthetic.supabase.co" }) }));
import { readPhoto } from "@/server/storage/photo-read";
const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const path = `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/${id}.webp`;
const row = { photo_id: id, storage_path: path };
const secret = "sb_secret_fake";
const bytes = new TextEncoder().encode("synthetic webp").buffer;
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", secret);
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  mocks.create.mockReturnValue({ storage: { from: mocks.from } }); mocks.from.mockReturnValue({ download: mocks.download });
  mocks.download.mockResolvedValue({ data: { arrayBuffer: async () => bytes }, error: null });
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("E-3 read-only storage boundary", () => {
  it.each(["../other", path.toUpperCase(), `${path}\n`, `${path}\r`, `${path}\u2028`, `${path}?download=1`, path.replace(".webp", ".png"), path.replace("/", "//"), "profile-photos/" + path])("refuses bad path %# before constructing a client", async (storage_path) => {
    expect(await readPhoto({ ...row, storage_path })).toBeNull(); expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  });
  it("requires the row id to match the object id", async () => {
    expect(await readPhoto({ ...row, photo_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })).toBeNull(); expect(mocks.download).not.toHaveBeenCalled();
  });
  it.each([secret, `e30.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.c2ln`])("uses only the private constant bucket and a nonpersistent client %#", async (key) => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", key);
    expect(await readPhoto(row)).toEqual(bytes);
    expect(mocks.create).toHaveBeenCalledWith("https://synthetic.supabase.co", key, { auth: { persistSession: false, autoRefreshToken: false } });
    expect(mocks.from).toHaveBeenCalledExactlyOnceWith("profile-photos"); expect(mocks.download).toHaveBeenCalledExactlyOnceWith(path);
  });
  it.each([undefined, "", "sb_publishable_fake", `${secret}\n`, "e30.bm90anNvbg.c2ln", `e30.${Buffer.from(JSON.stringify({ role: "anon" })).toString("base64url")}.c2ln`])("refuses missing or non-service keys %#", async (key) => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", key); expect(await readPhoto(row)).toBeNull(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(["error", "missing", "throw", "bytes"])("returns null for %s failures", async (failure) => {
    if (failure === "error") mocks.download.mockResolvedValue({ data: null, error: { message: "private" } });
    if (failure === "missing") mocks.download.mockResolvedValue({ data: null, error: null });
    if (failure === "throw") mocks.download.mockRejectedValue(new Error("private"));
    if (failure === "bytes") mocks.download.mockResolvedValue({ data: { arrayBuffer: async () => { throw new Error("private"); } }, error: null });
    expect(await readPhoto(row)).toBeNull();
  });
  it("has no signing, write or E-1 capability and keeps its service client private", () => {
    const source = readFileSync("src/server/storage/photo-read.ts", "utf8");
    expect(source).toContain('import "server-only"');
    expect(source).not.toMatch(/createSignedUrls?|getPublicUrl|\.upload\(|\.remove\(|\.update\(|\.upsert\(|photo-ingest/);
    expect(source).not.toMatch(/export\s+(?:const|function)\s+(?:serviceClient|key)/);
    expect(source.match(/process\.env\.SUPABASE_SERVICE_ROLE_KEY/g)).toHaveLength(1);
  });
});
