// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { getLikeState, listLikes, LIKES_PAGE_SIZE } from "@/server/like-data";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", conv = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const profile = { user_id: id, display_name: "葵", age: 22, gender: "female", school_name: "大学", department_name: null, class_name: null, bio: null, purposes: ["hobby"], hobbies: null, photo_ids: [id], birth_date: "private" };
const row = { counterpart_id: id, liked_at: "2026-11-17T00:00:00+00:00", counterpart: profile };
const client = (data: unknown, error: object | null = null) => ({ rpc: vi.fn(async () => ({ data, error })) });
const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
afterEach(() => expect(fetchSpy).not.toHaveBeenCalled());
it("projects only the allowed fields and passes the keyset cursor", async () => {
  const c = client([row]);
  const r = await listLikes(c, "received", { at: row.liked_at, id });
  expect(c.rpc).toHaveBeenCalledWith("list_my_likes", { p_direction: "received", p_before_at: row.liked_at, p_before_id: id, p_limit: LIKES_PAGE_SIZE });
  expect(r).toEqual({ status: "ok", next: null, likes: [{ id, likedAt: row.liked_at, profile: expect.objectContaining({ name: "葵", purposes: ["hobby"] }) }] });
  expect(JSON.stringify(r)).not.toMatch(/birth_date|private/);
  const first = client([]); await listLikes(first, "sent");
  expect(first.rpc).toHaveBeenCalledWith("list_my_likes", { p_direction: "sent", p_before_at: null, p_before_id: null, p_limit: LIKES_PAGE_SIZE });
});
it("returns the next cursor only for a full page", async () => {
  const r = await listLikes(client(Array.from({ length: LIKES_PAGE_SIZE }, () => row)), "sent");
  expect(r).toMatchObject({ status: "ok", next: { at: row.liked_at, id } });
});
it("fails the whole list on any malformed row or direction", async () => {
  for (const bad of [null, {}, { ...row, counterpart: null }, { ...row, counterpart_id: "x" }, { ...row, liked_at: 1 }, { ...row, counterpart: { ...profile, user_id: conv } }, { ...row, counterpart: { ...profile, purposes: ["romance"] } }, { ...row, counterpart: { ...profile, purposes: null } }])
    expect(await listLikes(client([row, bad]), "received")).toEqual({ status: "unavailable" });
  expect(await listLikes(client({}), "received")).toEqual({ status: "unavailable" });
  expect(await listLikes(client([]), "both" as never)).toEqual({ status: "unavailable" });
});
it.each([["PGRST301", "unauthenticated"], ["P0001", "unavailable"], ["XX000", "unavailable"]])("sanitizes %s", async (code, status) => {
  expect(await listLikes(client(null, { code, message: "private" }), "sent")).toEqual({ status });
  expect(await getLikeState(client(null, { code, message: "private" }), id)).toEqual({ status });
});
it("reads the four like states and treats no row as not visible", async () => {
  const state = (r: object) => getLikeState(client([r]), id);
  expect(await state({ i_liked: false, liked_me: false, conversation_id: null })).toEqual({ status: "ok", state: { iLiked: false, likedMe: false, conversationId: null } });
  expect(await state({ i_liked: true, liked_me: false, conversation_id: null })).toMatchObject({ state: { iLiked: true } });
  expect(await state({ i_liked: false, liked_me: true, conversation_id: null })).toMatchObject({ state: { likedMe: true } });
  expect(await state({ i_liked: false, liked_me: false, conversation_id: conv })).toMatchObject({ state: { conversationId: conv } });
  expect(await getLikeState(client([]), id)).toEqual({ status: "ok", state: null });
  for (const bad of [{ i_liked: "yes", liked_me: false, conversation_id: null }, { i_liked: false, liked_me: false, conversation_id: "x" }, null])
    expect(await getLikeState(client([bad]), id)).toEqual({ status: "unavailable" });
  expect(await getLikeState(client([{}, {}]), id)).toEqual({ status: "unavailable" });
  const c = client([]); expect(await getLikeState(c, "bad")).toEqual({ status: "unavailable" }); expect(c.rpc).not.toHaveBeenCalled();
});
