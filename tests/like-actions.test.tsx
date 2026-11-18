// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ mode: "supabase", create: vi.fn(), rpc: vi.fn(), revalidate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: () => m.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: m.create }));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidate }));
import { likeUser, unlikeUser } from "@/server/like-actions";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", conv = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
beforeEach(() => { vi.clearAllMocks(); m.mode = "supabase"; m.create.mockResolvedValue({ rpc: m.rpc }); m.rpc.mockResolvedValue({ data: { ok: true, code: "ok", ref: null }, error: null }); });
afterEach(() => expect(fetchSpy).not.toHaveBeenCalled());
it("rejects every invalid target before creating a client", async () => {
  for (const target of [`${id}\n`, "bad", id.toUpperCase(), null, 1, undefined]) {
    expect(await likeUser(target)).toEqual({ status: "validation" });
    expect(await unlikeUser(target)).toEqual({ status: "validation" });
  }
  expect(m.create).not.toHaveBeenCalled();
});
it("sends only the target and answers a like, a match and a take back", async () => {
  expect(await likeUser(id)).toEqual({ status: "ok" });
  expect(m.rpc).toHaveBeenLastCalledWith("like_user", { p_target: id });
  m.rpc.mockResolvedValue({ data: { ok: true, code: "ok", ref: conv }, error: null });
  expect(await likeUser(id)).toEqual({ status: "ok", conversationId: conv });
  m.rpc.mockResolvedValue({ data: { ok: true, code: "ok", ref: null }, error: null });
  expect(await unlikeUser(id)).toEqual({ status: "ok" });
  expect(m.rpc).toHaveBeenLastCalledWith("unlike_user", { p_target: id });
  for (const path of ["/", "/likes", "/talk"]) expect(m.revalidate).toHaveBeenCalledWith(path);
});
it("fails closed on a malformed match reference", async () => {
  m.rpc.mockResolvedValue({ data: { ok: true, code: "ok", ref: "private" }, error: null });
  expect(await likeUser(id)).toEqual({ status: "unavailable" });
});
it.each(["not_available", "already_connected", "rate_limited"])("preserves refusal %s without refreshing", async (code) => {
  m.rpc.mockResolvedValue({ data: { ok: false, code }, error: null });
  expect(await likeUser(id)).toEqual({ status: code });
  expect(m.revalidate).not.toHaveBeenCalled();
});
it.each([["P0001", "validation", "validation"], ["P0001", "forbidden", "unavailable"], ["PGRST301", "provider secret", "unauthenticated"], ["PGRST202", "not found", "unavailable"], ["XX000", "provider secret", "unavailable"]])("sanitizes %s %s", async (code, message, status) => {
  m.rpc.mockResolvedValue({ data: null, error: { code, message } });
  expect(await unlikeUser(id)).toEqual({ status });
});
it("handles throws and demo without any client", async () => {
  m.create.mockRejectedValue(new Error("private"));
  expect(await likeUser(id)).toEqual({ status: "unavailable" });
  m.create.mockClear(); m.mode = "demo";
  expect(await likeUser(id)).toEqual({ status: "unavailable" });
  expect(await unlikeUser(id)).toEqual({ status: "unavailable" });
  expect(m.create).not.toHaveBeenCalled();
});
