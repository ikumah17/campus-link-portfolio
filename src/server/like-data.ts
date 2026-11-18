import "server-only";
import { callRpc, type RpcClient } from "@/server/rpc";
import { UUID, parseProfile, type LiveProfile } from "@/server/discover-data";
// Likes (order 34, docs/43 §2.4, §2.7). The database shows only visible, not matched people; this only projects.
export const LIKES_PAGE_SIZE = 50;
export type LikeDirection = "sent" | "received";
export type LiveLike = { id: string; likedAt: string; profile: LiveProfile };
export type LikeState = { iLiked: boolean; likedMe: boolean; conversationId: string | null };
type Failure = { status: "unauthenticated" | "unavailable" };
const fail = (code: string): Failure => ({ status: code === "unauthenticated" ? code : "unavailable" });
const uuid = (v: unknown): v is string => typeof v === "string" && v.length === 36 && UUID.test(v);
export type LikesPage = { status: "ok"; likes: LiveLike[]; next: { at: string; id: string } | null };
export async function listLikes(client: RpcClient, direction: LikeDirection, before?: { at: string; id: string }): Promise<Failure | LikesPage> {
  try {
    if (direction !== "sent" && direction !== "received") return fail("unavailable");
    const r = await callRpc(client, "list_my_likes", { p_direction: direction, p_before_at: before?.at ?? null, p_before_id: before?.id ?? null, p_limit: LIKES_PAGE_SIZE });
    if (r.code !== "ok") return fail(r.code);
    if (!Array.isArray(r.data)) return fail("unavailable");
    const likes: LiveLike[] = [];
    for (const value of r.data) {
      if (!value || typeof value !== "object") return fail("unavailable");
      const row = value as Record<string, unknown>;
      const profile = parseProfile(row.counterpart);
      if (!uuid(row.counterpart_id) || typeof row.liked_at !== "string" || !profile || profile.id !== row.counterpart_id) return fail("unavailable");
      likes.push({ id: row.counterpart_id, likedAt: row.liked_at, profile });
    }
    const last = likes.at(-1);
    return { status: "ok", likes, next: likes.length === LIKES_PAGE_SIZE && last ? { at: last.likedAt, id: last.id } : null };
  } catch { return fail("unavailable"); }
}
// state null: the person is not visible (missing, blocked, hidden or ineligible look the same).
export async function getLikeState(client: RpcClient, id: string): Promise<Failure | { status: "ok"; state: LikeState | null }> {
  try {
    if (!uuid(id)) return fail("unavailable");
    const r = await callRpc(client, "get_like_state", { p_target: id });
    if (r.code !== "ok") return fail(r.code);
    if (!Array.isArray(r.data) || r.data.length > 1) return fail("unavailable");
    if (!r.data.length) return { status: "ok", state: null };
    const row = r.data[0] as Record<string, unknown> | null;
    if (!row || typeof row.i_liked !== "boolean" || typeof row.liked_me !== "boolean" || !(row.conversation_id === null || uuid(row.conversation_id))) return fail("unavailable");
    return { status: "ok", state: { iLiked: row.i_liked, likedMe: row.liked_me, conversationId: row.conversation_id as string | null } };
  } catch { return fail("unavailable"); }
}
