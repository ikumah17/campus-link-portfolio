// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import sharp from "sharp";
const mocks = vi.hoisted(() => ({ mode: vi.fn(), user: vi.fn(), userRpc: vi.fn(), service: vi.fn(),
  serviceRpc: vi.fn(), from: vi.fn(), upload: vi.fn(), remove: vi.fn(), uuid: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: mocks.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: mocks.user }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.service }));
vi.mock("@/lib/supabase/config", () => ({ supabasePublicConfig: () => ({ url: "https://synthetic.supabase.co" }) }));
vi.mock("node:crypto", async (importOriginal) => ({ ...await importOriginal<typeof import("node:crypto")>(), randomUUID: mocks.uuid }));
import * as images from "@/server/storage/photo-image";
import { removePhoto, reorderPhotos } from "@/server/photo-actions";
// SEC-007: the upload moved from a Server Action to the module that POST /api/photos calls.
import { uploadPhoto } from "@/server/photo-upload";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const photoId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const otherId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const path = `${userId}/${photoId}.webp`;
const privateMessage = "private DB or storage message";
const ok = (ref: string | null = null) => ({ data: { ok: true, code: "ok", ref }, error: null });
const account = () => ({ data: [{ user_id: userId }], error: null });
const refusal = (code: string) => ({ data: { ok: false, code, message: privateMessage }, error: null });
const realReencode = images.reencodePhoto;
let png: Buffer;
let events: string[];
let fetchSpy: ReturnType<typeof vi.spyOn>;
let decode: MockInstance<typeof images.reencodePhoto>;
beforeAll(async () => { png = await sharp({ create: { width: 20, height: 10, channels: 3, background: "white" } }).png().toBuffer(); });
beforeEach(() => {
  vi.resetAllMocks(); events = [];
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_fake");
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  mocks.mode.mockReturnValue("supabase"); mocks.uuid.mockReturnValue(photoId);
  mocks.user.mockResolvedValue({ rpc: mocks.userRpc });
  mocks.userRpc.mockImplementation(async (name: string) => { events.push(name); return name === "my_account" ? account() : ok(photoId); });
  mocks.service.mockReturnValue({ storage: { from: mocks.from }, rpc: mocks.serviceRpc });
  mocks.from.mockReturnValue({ upload: mocks.upload, remove: mocks.remove });
  mocks.upload.mockImplementation(async () => { events.push("upload"); return { error: null }; });
  mocks.serviceRpc.mockImplementation(async () => { events.push("register"); return ok(photoId); });
  mocks.remove.mockImplementation(async () => { events.push("delete"); return { error: null }; });
  decode = vi.spyOn(images, "reencodePhoto").mockImplementation(async (bytes) => { events.push("reencode"); return realReencode(bytes); });
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function form(bytes: Uint8Array = png): FormData {
  const data = new FormData();
  // Deliberately misleading name and type: the decoder must inspect the content.
  data.set("photo", new File([new Uint8Array(bytes)], "synthetic.svg", { type: "image/svg+xml" }));
  return data;
}
function safe(result: unknown) {
  const serialized = JSON.stringify(result);
  for (const value of [privateMessage, userId, path, "synthetic.svg"]) expect(serialized).not.toContain(value);
}
function noStorage() { expect(mocks.service).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled(); }

describe("demo isolation and upload boundaries", () => {
  it("returns unavailable from every demo action before doing any work", async () => {
    mocks.mode.mockReturnValue("demo");
    expect(await uploadPhoto(form())).toEqual({ status: "unavailable" });
    expect(await removePhoto(photoId)).toEqual({ status: "unavailable" });
    expect(await reorderPhotos([photoId])).toEqual({ status: "unavailable" });
    expect(mocks.user).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled(); noStorage();
  });
  it.each(["missing", "string", "empty"])("rejects a %s file before constructing any client", async (kind) => {
    const data = new FormData();
    if (kind === "string") data.set("photo", "not a file");
    if (kind === "empty") data.set("photo", new File([], "empty.png"));
    expect(await uploadPhoto(data)).toEqual({ status: "invalid" });
    expect(mocks.user).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled(); noStorage();
  });
  it("rejects 4 MiB + 1 before reading bytes or creating clients", async () => {
    const data = form(new Uint8Array(4_194_305));
    const read = vi.spyOn(data.get("photo") as File, "arrayBuffer");
    expect(await uploadPhoto(data)).toEqual({ status: "too_large" });
    expect(read).not.toHaveBeenCalled(); expect(mocks.user).not.toHaveBeenCalled(); noStorage();
  });
  it("allows exactly 4 MiB to reach the decoder", async () => {
    decode.mockResolvedValue(Buffer.from("reencoded"));
    expect(await uploadPhoto(form(new Uint8Array(4_194_304)))).toEqual({ status: "ok", photoId });
    expect(decode.mock.calls[0][0]).toHaveLength(4_194_304);
  });
  it("authenticates before decoding invalid input", async () => {
    expect(await uploadPhoto(form(Buffer.from("not an image")))).toEqual({ status: "invalid" });
    expect(events).toEqual(["my_account", "reserve_photo_upload", "reencode"]); noStorage();
  });
  it("does not read bytes or decode for a request without a session", async () => {
    mocks.userRpc.mockResolvedValue({ data: null, error: { status: 401, message: privateMessage } });
    const data = form(); const read = vi.spyOn(data.get("photo") as File, "arrayBuffer");
    const result = await uploadPhoto(data);
    expect(result).toEqual({ status: "unauthenticated" }); safe(result);
    expect(read).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled(); noStorage();
  });
  it.each([[], [null], [{}], [{ user_id: otherId }, { user_id: userId }], [{ user_id: 3 }],
    [{ user_id: userId.toUpperCase() }], [{ user_id: `${userId}\n` }], { ref: userId }])("rejects malformed my_account rows %#", async (data) => {
    mocks.userRpc.mockResolvedValue({ data, error: null });
    const result = await uploadPhoto(form());
    expect(result).toEqual({ status: "unavailable" }); safe(result);
    expect(decode).not.toHaveBeenCalled(); noStorage();
  });
  it("ignores a supplied userId and stores only the re-encoded bytes in the required order", async () => {
    const data = form(); data.set("userId", otherId);
    const result = await uploadPhoto(data);
    expect(result).toEqual({ status: "ok", photoId }); safe(result);
    expect(events).toEqual(["my_account", "reserve_photo_upload", "reencode", "upload", "register"]);
    expect(mocks.userRpc.mock.calls).toEqual([["my_account", {}], ["reserve_photo_upload", {}]]);
    expect(mocks.upload).toHaveBeenCalledWith(path, expect.any(Buffer), { contentType: "image/webp", upsert: false });
    const stored = mocks.upload.mock.calls[0][1] as Buffer;
    expect(stored.equals(png)).toBe(false); expect((await sharp(stored).metadata()).format).toBe("webp");
    expect(mocks.serviceRpc).toHaveBeenCalledWith("service_register_photo", { p_user: userId, p_path: path });
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("maps a failed upload without attempting registration or deletion", async () => {
    mocks.upload.mockResolvedValue({ error: { message: privateMessage } });
    const result = await uploadPhoto(form());
    expect(result).toEqual({ status: "unavailable" }); safe(result);
    expect(mocks.serviceRpc).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("maps a missing service configuration to unavailable", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", undefined);
    expect(await uploadPhoto(form())).toEqual({ status: "unavailable" }); noStorage();
  });
});

describe("SEC-004 upload reservation before the decode", () => {
  const reserveWith = (response: () => Promise<unknown>) =>
    mocks.userRpc.mockImplementation(async (name: string) => { events.push(name); return name === "my_account" ? account() : response(); });
  async function noDecode(data: FormData, status: string) {
    const read = vi.spyOn(data.get("photo") as File, "arrayBuffer");
    const result = await uploadPhoto(data);
    expect(result).toEqual({ status }); safe(result);
    expect(events).toEqual(["my_account", "reserve_photo_upload"]);
    expect(read).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled(); noStorage();
  }
  it("maps rate_limited without reading, decoding or storing the file", async () => {
    reserveWith(async () => refusal("rate_limited"));
    await noDecode(form(), "rate_limited");
  });
  it("maps an expired session during the reservation to unauthenticated", async () => {
    reserveWith(async () => ({ data: null, error: { status: 401, message: privateMessage } }));
    await noDecode(form(), "unauthenticated");
  });
  it.each([
    ["not_available", async () => refusal("not_available")],
    ["invalid_state", async () => refusal("invalid_state")],
    ["unknown code", async () => refusal("unknown")],
    ["forbidden", async () => ({ data: null, error: { code: "P0001", message: "forbidden" } })],
    ["validation", async () => ({ data: null, error: { code: "P0001", message: "validation" } })],
    ["missing function", async () => ({ data: null, error: { code: "PGRST202", message: privateMessage }, status: 404 })],
    ["transport", async () => ({ data: null, error: { message: privateMessage } })],
    ["rows", async () => ({ data: [], error: null })],
    ["null data", async () => ({ data: null, error: null })],
    ["ok without code", async () => ({ data: { ok: true }, error: null })],
    ["thrown", async () => { throw new Error(privateMessage); }],
  ] as const)("fails closed on an unreadable reservation answer (%s): no decode", async (_, response) => {
    reserveWith(response);
    await noDecode(form(), "unavailable");
  });
});

describe("registration compensation", () => {
  const failures = [
    { label: "capacity", response: refusal("invalid_state"), status: "too_many" },
    ...["not_available", "already_pending", "already_connected", "rate_limited", "unknown"].map((code) => ({ label: code, response: refusal(code), status: "unavailable" })),
    ...["validation", "forbidden"].map((message) => ({ label: message, response: { data: null, error: { code: "P0001", message } }, status: "unavailable" })),
    { label: "transport", response: { data: null, error: { message: privateMessage } }, status: "unavailable" },
    { label: "unauthenticated service", response: { data: null, error: { status: 401 } }, status: "unavailable" },
    { label: "wrong ref", response: ok(otherId), status: "unavailable" },
    { label: "null ref", response: ok(), status: "unavailable" },
    { label: "unexpected rows", response: { data: [], error: null }, status: "unavailable" },
  ];
  for (const cleanupFails of [false, true]) {
    it.each(failures)(`cleans up $label, cleanup failure = ${cleanupFails}`, async ({ response, status }) => {
      mocks.serviceRpc.mockResolvedValue(response);
      if (cleanupFails) mocks.remove.mockRejectedValue(new Error(privateMessage));
      const result = await uploadPhoto(form());
      expect(result).toEqual({ status }); safe(result);
      expect(mocks.remove).toHaveBeenCalledExactlyOnceWith([path]);
    });
  }
  it("also compensates a thrown registration failure", async () => {
    mocks.serviceRpc.mockRejectedValue(new Error(privateMessage));
    expect(await uploadPhoto(form())).toEqual({ status: "unavailable" });
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith([path]);
  });
});

describe("owner-session removal", () => {
  it.each([null, 1, "bad", photoId.toUpperCase(), `${photoId}\n`, `../${photoId}`])("rejects malformed ids %# without calls", async (id) => {
    expect(await removePhoto(id)).toEqual({ status: "invalid" });
    expect(mocks.user).not.toHaveBeenCalled(); noStorage();
  });
  it.each(["invalid_state", "not_available", "validation", "forbidden", "unavailable", "unauthenticated"])("does not touch storage on %s", async (code) => {
    mocks.userRpc.mockImplementation(async (name: string) => name === "my_account" ? account() :
      code === "validation" || code === "forbidden" ? { data: null, error: { code: "P0001", message: code } } :
      code === "unauthenticated" ? { data: null, error: { status: 401, message: privateMessage } } : refusal(code));
    const result = await removePhoto(photoId);
    expect(result).toEqual({ status: code === "invalid_state" ? "last_photo" : code === "unauthenticated" ? "unauthenticated" : "unavailable" }); safe(result);
    expect(mocks.userRpc.mock.calls).toEqual([["my_account", {}], ["remove_photo", { p_photo: photoId }]]); noStorage();
  });
  it.each([false, true])("deletes only after the user's successful RPC, deletion failure = %s", async (fails) => {
    if (fails) mocks.remove.mockImplementation(async () => { events.push("delete"); throw new Error(privateMessage); });
    const result = await removePhoto(photoId);
    expect(result).toEqual({ status: "ok" }); safe(result);
    expect(events).toEqual(["my_account", "remove_photo", "delete"]);
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith([path]);
    expect(mocks.serviceRpc).not.toHaveBeenCalled();
  });
  it.each([{ data: [], error: null }, { data: null, error: { status: 401 } }])("requires a valid current account %#", async (response) => {
    mocks.userRpc.mockResolvedValue(response);
    expect(await removePhoto(photoId)).toEqual({ status: response.error ? "unauthenticated" : "unavailable" });
    expect(mocks.userRpc).toHaveBeenCalledExactlyOnceWith("my_account", {}); noStorage();
  });
});

describe("user-only reordering", () => {
  it.each([null, {}, "bad", [], [photoId, photoId], [photoId.toUpperCase()], [`${photoId}\n`], [null], Array(2), Array(7).fill(photoId)])("rejects invalid arrays %# without calls", async (ids) => {
    expect(await reorderPhotos(ids)).toEqual({ status: "invalid" });
    expect(mocks.user).not.toHaveBeenCalled(); noStorage();
  });
  it("passes ordered UUIDs to only the user's RPC client", async () => {
    expect(await reorderPhotos([otherId, photoId])).toEqual({ status: "ok" });
    expect(mocks.userRpc).toHaveBeenCalledExactlyOnceWith("reorder_photos", { p_ids: [otherId, photoId] }); noStorage();
  });
  it.each(["invalid_state", "validation", "unauthenticated"])("maps %s without returning DB details", async (code) => {
    mocks.userRpc.mockResolvedValue(code === "validation" ? { data: null, error: { code: "P0001", message: code } } :
      code === "unauthenticated" ? { data: null, error: { status: 401, message: privateMessage } } : refusal(code));
    const result = await reorderPhotos([photoId]);
    expect(result).toEqual({ status: code === "unauthenticated" ? "unauthenticated" : "unavailable" }); safe(result); noStorage();
  });
});

it("catches client failures without logging or serializing private exceptions", async () => {
  const log = vi.spyOn(console, "error"); mocks.user.mockRejectedValue(new Error(privateMessage));
  for (const result of [await uploadPhoto(form()), await removePhoto(photoId), await reorderPhotos([photoId])]) {
    expect(result).toEqual({ status: "unavailable" }); safe(result);
  }
  expect(log).not.toHaveBeenCalled(); noStorage();
});
