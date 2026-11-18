// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn(), from: vi.fn(), upload: vi.fn(), remove: vi.fn(), rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.create }));
vi.mock("@/lib/supabase/config", () => ({ supabasePublicConfig: () => ({ url: "https://synthetic.supabase.co" }) }));
import { deleteStoredPhoto, registerPhoto, storePhoto } from "@/server/storage/photo-ingest";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const photoId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const path = `${userId}/${photoId}.webp`;
// Synthetic strings only; never load an environment file.
const secret = "sb_secret_fake";
const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.c3ludGhldGlj`;
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", secret);
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  mocks.create.mockReturnValue({ storage: { from: mocks.from }, rpc: mocks.rpc });
  mocks.from.mockReturnValue({ upload: mocks.upload, remove: mocks.remove });
  mocks.upload.mockResolvedValue({ error: null }); mocks.remove.mockResolvedValue({ error: null });
  mocks.rpc.mockResolvedValue({ data: { ok: true, code: "ok", ref: photoId }, error: null });
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("private E-1 storage adapter", () => {
  it.each([
    { label: "missing", key: undefined }, { label: "empty", key: "" },
    { label: "publishable", key: "sb_publishable_synthetic" }, { label: "anon JWT", key: jwt("anon") },
    { label: "malformed JWT", key: "e30.bm90LWpzb24.c2ln" }, { label: "wrong role", key: jwt("authenticated") },
    { label: "trailing newline", key: `${secret}\n` },
    { label: "trailing carriage return", key: `${secret}\r` },
    { label: "trailing Unicode line separator", key: `${secret}\u2028` },
  ])("refuses $label keys without leaking their value", async ({ key }) => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", key);
    for (const operation of [() => storePhoto(userId, photoId, Buffer.from("webp")), () => registerPhoto(userId, path), () => deleteStoredPhoto(userId, photoId)]) {
      const error = await operation().catch((value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Photo storage unavailable");
      if (key) expect(String(error)).not.toContain(key);
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each([{ label: "secret", key: secret }, { label: "service-role JWT", key: jwt("service_role") }])("accepts a $label only in a private nonpersistent client", async ({ key }) => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", key);
    const bytes = Buffer.from("synthetic re-encoded content");
    expect(await storePhoto(userId, photoId, bytes)).toBe(path);
    expect(mocks.create).toHaveBeenCalledWith("https://synthetic.supabase.co", key, { auth: { persistSession: false, autoRefreshToken: false } });
    expect(mocks.from).toHaveBeenCalledWith("profile-photos");
    expect(mocks.upload).toHaveBeenCalledWith(path, bytes, { contentType: "image/webp", upsert: false });
  });
  it("registers through the checked RPC adapter and deletes precisely one object", async () => {
    expect(await registerPhoto(userId, path)).toEqual({ code: "ok", data: { ref: photoId } });
    expect(mocks.rpc).toHaveBeenCalledWith("service_register_photo", { p_user: userId, p_path: path });
    await deleteStoredPhoto(userId, photoId);
    expect(mocks.remove).toHaveBeenCalledWith([path]);
  });
  it.each(["invalid_state", "not_available"])("uses callRpc's refusal mapping for %s", async (code) => {
    mocks.rpc.mockResolvedValue({ data: { ok: false, code, message: "private DB message" }, error: null });
    expect(await registerPhoto(userId, path)).toEqual({ code, data: null });
  });
  it.each(["validation", "forbidden"])("uses callRpc's exception mapping for %s", async (message) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message } });
    expect(await registerPhoto(userId, path)).toEqual({ code: message, data: null });
  });
  it("throws on storage failures with a fixed message", async () => {
    mocks.upload.mockResolvedValue({ error: { message: secret } });
    mocks.remove.mockResolvedValue({ error: { message: secret } });
    await expect(storePhoto(userId, photoId, Buffer.alloc(1))).rejects.toThrow(/^Photo storage unavailable$/);
    await expect(deleteStoredPhoto(userId, photoId)).rejects.toThrow(/^Photo storage unavailable$/);
  });
  it("rejects path injection before constructing a service client", async () => {
    await expect(storePhoto("../other", photoId, Buffer.alloc(1))).rejects.toThrow();
    await expect(deleteStoredPhoto(userId, `${photoId}\n`)).rejects.toThrow();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("keeps the key reference local and never issues delivery URLs", () => {
    const source = readFileSync("src/server/storage/photo-ingest.ts", "utf8");
    expect(source.match(/process\.env\.SUPABASE_SERVICE_ROLE_KEY/g)).toHaveLength(1);
    expect(source).not.toMatch(/createSignedUrls?|getPublicUrl/);
    expect(source).not.toMatch(/export\s+(?:const|function)\s+(?:serviceClient|key)/);
  });
});
