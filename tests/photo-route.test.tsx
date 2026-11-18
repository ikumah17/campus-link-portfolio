// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ mode: vi.fn(), create: vi.fn(), user: vi.fn(), rpc: vi.fn(), account: vi.fn(), read: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: mocks.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: mocks.create }));
vi.mock("@/server/storage/photo-read", () => ({ readPhoto: mocks.read }));
import { GET, dynamic } from "@/app/media/photos/[photoId]/route";
const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const row = { photo_id: id, storage_path: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/${id}.webp` };
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
// my_account (ACCOUNT-003) is its own mock, so mocks.rpc sees only the authorization RPC.
const client = { auth: { getUser: mocks.user },
  rpc: (name: string, args: Record<string, unknown>) => name === "my_account" ? mocks.account(name, args) : mocks.rpc(name, args) };
const bytes = new TextEncoder().encode("synthetic webp").buffer;
const get = (photoId = id) => GET(new Request(`https://campus.example/media/photos/${encodeURIComponent(photoId)}?path=ignored&bucket=ignored`), { params: Promise.resolve({ photoId }) });
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  mocks.mode.mockReturnValue("supabase"); mocks.create.mockResolvedValue(client);
  mocks.user.mockResolvedValue({ data: { user: { id: other, is_anonymous: false } }, error: null });
  mocks.rpc.mockResolvedValue({ data: [row], error: null }); mocks.read.mockResolvedValue(bytes);
  mocks.account.mockResolvedValue({ data: [{ account_status: "active" }], error: null });
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
const fingerprint = async (response: Response) => ({ status: response.status, headers: [...response.headers], bytes: [...new Uint8Array(await response.arrayBuffer())] });
const denied = { status: 404, headers: [["cache-control", "no-store"]], bytes: [] };

describe("photo delivery authorization per request", () => {
  it("returns exact private headers and bytes and remains dynamic", async () => {
    expect(dynamic).toBe("force-dynamic");
    const response = await get();
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toEqual({
      "content-type": "image/webp", "cache-control": "private, max-age=120", vary: "Cookie",
      "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin",
    });
    expect(await response.arrayBuffer()).toEqual(bytes);
    expect(mocks.rpc).toHaveBeenCalledWith("authorize_photo_delivery", { p_photo_ids: [id] });
    expect(mocks.read).toHaveBeenCalledWith(row);
    expect(mocks.user.mock.invocationCallOrder[0]).toBeLessThan(mocks.rpc.mock.invocationCallOrder[0]);
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(mocks.read.mock.invocationCallOrder[0]);
  });
  it("reauthorizes repeated requests, including after access is removed", async () => {
    expect((await get()).status).toBe(200);
    mocks.rpc.mockResolvedValueOnce({ data: [], error: null });
    expect(await fingerprint(await get())).toEqual(denied);
    expect(mocks.rpc).toHaveBeenCalledTimes(2); expect(mocks.read).toHaveBeenCalledTimes(1);
  });
  it("creates no client in demo mode", async () => {
    mocks.mode.mockReturnValue("demo");
    expect(await fingerprint(await get())).toEqual(denied);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
  });
  it.each(["x", id.toUpperCase(), `${id}\n`, `../${id}`, ""])("refuses malformed ids %# before creating a client", async (value) => {
    expect(await fingerprint(await get(value))).toEqual(denied); expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each([
    { data: { user: null }, error: null },
    { data: { user: { is_anonymous: true } }, error: null },
    { data: { user: {} }, error: null },
    { data: { user: { is_anonymous: false } }, error: { message: "private" } },
  ])("uses the identical refusal for missing, anonymous or invalid sessions %#", async (result) => {
    mocks.user.mockResolvedValue(result);
    expect(await fingerprint(await get())).toEqual(denied);
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
  });
  it.each([
    { data: [], error: null }, // Includes refused, missing and removed photos.
    { data: [{ ...row, photo_id: other }], error: null },
    { data: [row, row], error: null }, { data: [null], error: null },
    { data: [{ photo_id: id }], error: null },
    { data: { ok: false, code: "not_available" }, error: null },
    { data: [row], error: { message: "private" } },
    { data: null, error: { status: 401 } },
  ])("never calls E-3 without exactly the authorized matching row %#", async (result) => {
    mocks.rpc.mockResolvedValue(result);
    expect(await fingerprint(await get())).toEqual(denied); expect(mocks.read).not.toHaveBeenCalled();
  });
  it.each(["create", "user", "rpc", "read"] as const)("returns the same empty refusal on thrown %s errors without logging", async (operation) => {
    const log = vi.spyOn(console, "error"); const warn = vi.spyOn(console, "warn");
    mocks[operation].mockRejectedValue(new Error("private provider error"));
    expect(await fingerprint(await get())).toEqual(denied);
    expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
    if (operation !== "read") expect(mocks.read).not.toHaveBeenCalled();
  });
  it("reads no account for another person's photo", async () => {
    expect((await get()).status).toBe(200); expect(mocks.account).not.toHaveBeenCalled();
  });
  it.each(["active", "deactivated", "suspended"])("delivers a %s caller's own photo after one account read", async (status) => {
    mocks.user.mockResolvedValue({ data: { user: { id: owner, is_anonymous: false } }, error: null });
    mocks.account.mockResolvedValue({ data: [{ account_status: status }], error: null });
    expect((await get()).status).toBe(200);
    expect(mocks.account).toHaveBeenCalledExactlyOnceWith("my_account", {});
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(mocks.account.mock.invocationCallOrder[0]);
    expect(mocks.account.mock.invocationCallOrder[0]).toBeLessThan(mocks.read.mock.invocationCallOrder[0]);
  });
  it.each([
    { data: [{ account_status: "deleted" }], error: null },   // ACCOUNT-003, where the database predates order 17
    { data: [], error: null }, { data: [{}], error: null }, { data: null, error: { message: "private" } }, "throw",
  ])("refuses an own photo identically for a deleted or unreadable account %#", async (result) => {
    mocks.user.mockResolvedValue({ data: { user: { id: owner, is_anonymous: false } }, error: null });
    if (result === "throw") mocks.account.mockRejectedValue(new Error("private provider error"));
    else mocks.account.mockResolvedValue(result);
    expect(await fingerprint(await get())).toEqual(denied); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("uses the same refusal for storage read failure", async () => {
    mocks.read.mockResolvedValue(null); expect(await fingerprint(await get())).toEqual(denied);
  });
});
