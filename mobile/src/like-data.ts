import { gate, getProfile, parseProfile, type Gated, type LiveProfile } from "./discover-data";
import { callRpc, isUuid, type RpcClient } from "./rpc";

// MOBILE-LIKES-001 (docs/43 §2.4–§2.7, §4.1, §4.3): ports of the web's src/server/like-data.ts and like-actions.ts.
// The database shows only visible, not matched people and decides every like; this only projects. A match answers ok
// with the new conversation's id; forbidden (a paused or suspended account) shows as unavailable, as on the web.
export const LIKES_PAGE_SIZE = 50;
export type LikeDirection = "sent" | "received";
export type LiveLike = { id: string; likedAt: string; profile: LiveProfile };
export type LikeState = { iLiked: boolean; likedMe: boolean; conversationId: string | null };
export type LikeCursor = { at: string; id: string };
export type LikesPage = { status: "ok"; likes: LiveLike[]; next: LikeCursor | null };
export type LikeStatus = "ok" | "validation" | "not_available" | "already_connected" | "rate_limited" | "unauthenticated" | "unavailable";
export type LikeAnswer = { status: LikeStatus; conversationId?: string };
type Failure = { status: "unauthenticated" | "unavailable" };
const fail = (code: string): Failure => ({ status: code === "unauthenticated" ? "unauthenticated" : "unavailable" });

export async function listLikes(client: RpcClient, direction: LikeDirection, before?: LikeCursor): Promise<Failure | LikesPage> {
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
      if (!isUuid(row.counterpart_id) || typeof row.liked_at !== "string" || !profile || profile.id !== row.counterpart_id) return fail("unavailable");
      likes.push({ id: row.counterpart_id, likedAt: row.liked_at, profile });
    }
    const last = likes.at(-1);
    return { status: "ok", likes, next: likes.length === LIKES_PAGE_SIZE && last ? { at: last.likedAt, id: last.id } : null };
  } catch { return fail("unavailable"); }
}

// src/app/likes/page.tsx: the gate, then both lists; either failing fails the screen.
export type LikeLists = { status: "ok"; received: LikesPage; sent: LikesPage };
export function loadLikes(client: RpcClient): Promise<Gated<LikeLists>> {
  return gate<LikeLists>(client, async () => {
    const [received, sent] = await Promise.all([listLikes(client, "received"), listLikes(client, "sent")]);
    if (received.status === "unauthenticated" || sent.status === "unauthenticated") return { status: "unauthenticated" };
    return received.status === "ok" && sent.status === "ok" ? { status: "ok", received, sent } : { status: "unavailable" };
  });
}

// state null: the person is not visible (missing, blocked, hidden or ineligible look the same).
export async function getLikeState(client: RpcClient, id: string): Promise<Failure | { status: "ok"; state: LikeState | null }> {
  try {
    if (!isUuid(id)) return fail("unavailable");
    const r = await callRpc(client, "get_like_state", { p_target: id });
    if (r.code !== "ok") return fail(r.code);
    if (!Array.isArray(r.data) || r.data.length > 1) return fail("unavailable");
    if (!r.data.length) return { status: "ok", state: null };
    const row = r.data[0] as Record<string, unknown> | null;
    if (!row || typeof row.i_liked !== "boolean" || typeof row.liked_me !== "boolean" || !(row.conversation_id === null || isUuid(row.conversation_id))) return fail("unavailable");
    return { status: "ok", state: { iLiked: row.i_liked, likedMe: row.liked_me, conversationId: row.conversation_id as string | null } };
  } catch { return fail("unavailable"); }
}

// src/app/profiles/[id]/page.tsx: a malformed id is the same "not viewable" as a missing or hidden profile. A shown
// profile also reads its like state; null when it could not be read, and the buttons then start from "いいね".
export type ProfilePage = { status: "ok"; profile: LiveProfile | null; likeState: LikeState | null };
export function loadProfile(client: RpcClient, id: unknown): Promise<Gated<ProfilePage>> {
  if (!isUuid(id)) return Promise.resolve({ status: "ok", profile: null, likeState: null });
  return gate<ProfilePage>(client, async () => {
    const result = await getProfile(client, id);
    if (result.status !== "ok") return result;
    if (!result.profile) return { status: "ok", profile: null, likeState: null };
    const like = await getLikeState(client, id);
    if (like.status === "unauthenticated") return like;
    return { status: "ok", profile: result.profile, likeState: like.status === "ok" ? like.state : null };
  });
}

const known: LikeStatus[] = ["ok", "validation", "not_available", "already_connected", "rate_limited", "unauthenticated"];
async function perform(client: RpcClient, name: "like_user" | "unlike_user", target: unknown): Promise<LikeAnswer> {
  try {
    if (!isUuid(target)) return { status: "validation" };
    const result = await callRpc(client, name, { p_target: target });
    if (result.code !== "ok") return { status: known.includes(result.code as LikeStatus) ? result.code as LikeStatus : "unavailable" };
    const ref = !Array.isArray(result.data) ? result.data.ref : null;
    if (ref !== null && !isUuid(ref)) return { status: "unavailable" };
    return ref ? { status: "ok", conversationId: ref } : { status: "ok" };
  } catch { return { status: "unavailable" }; }
}
export const likeUser = (client: RpcClient, target: unknown) => perform(client, "like_user", target);
export const unlikeUser = (client: RpcClient, target: unknown) => perform(client, "unlike_user", target);
