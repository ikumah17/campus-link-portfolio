import { getDemoProfile, type DemoProfile } from "@/data/demo-profiles";
import type { Block } from "@/lib/safety-gateway";

// The demo mirrors like_user / unlike_user / list_my_likes / get_like_state (order 34, docs/43 §2.4-§2.7) in memory.
export const DAY = 86_400_000;
export const LIKE_DAILY_LIMIT = 100;
export const DEMO_NOTICE = "デモ：いいねは架空のもので、どこにも送信・保存されません。";
export type Outcome = "ok" | "validation" | "not_available" | "already_connected" | "rate_limited";
export type DemoLike = { liker: string; liked: string; createdAt: number };
// attempts: like and unlike attempts today, refused ones included (rate_policy 'like').
export type LikesState = { now: number; likes: DemoLike[]; connections: [string, string][]; attempts?: number; blocks?: Block[]; endedConnections?: { members: [string, string]; reason: "blocked" }[] };
// conversationId: the new conversation of a match; the demo chat names a conversation by the partner's id.
export type Result = { code: Outcome; state: LikesState; conversationId?: string };
export type LikeState = { iLiked: boolean; likedMe: boolean; conversationId: string | null };
const pair = (a: string, b: string, me: string, target: string) => (a === me && b === target) || (b === me && a === target);
const connected = (state: LikesState, me: string, target: string) => state.connections.some(([a, b]) => pair(a, b, me, target));
const visible = (state: LikesState, target: string) => !!getDemoProfile(target) && !state.blocks?.some((b) => b.blocked_id === target);

function attempt(input: LikesState, me: string, target: string): Result | LikesState {
  if (!target || target === me) return { code: "validation", state: input };
  const attempts = input.attempts ?? 0;
  const state = { ...input, attempts: attempts + 1 };
  return attempts >= LIKE_DAILY_LIMIT ? { code: "rate_limited", state } : state;
}
export function like(input: LikesState, me: string, target: string): Result {
  const state = attempt(input, me, target);
  if ("code" in state) return state;
  if (!visible(state, target)) return { code: "not_available", state };
  if (connected(state, me, target)) return { code: "already_connected", state };
  const mine = state.likes.some((l) => l.liker === me && l.liked === target);
  if (!state.likes.some((l) => l.liker === target && l.liked === me)) {
    return { code: "ok", state: mine ? state : { ...state, likes: [...state.likes, { liker: me, liked: target, createdAt: state.now }] } };
  }
  // A match removes both likes and opens the conversation.
  return { code: "ok", conversationId: target, state: { ...state,
    likes: state.likes.filter((l) => !pair(l.liker, l.liked, me, target)),
    connections: [...state.connections, [me, target]],
  } };
}
export function unlike(input: LikesState, me: string, target: string): Result {
  const state = attempt(input, me, target);
  if ("code" in state) return state;
  return { code: "ok", state: { ...state, likes: state.likes.filter((l) => !(l.liker === me && l.liked === target)) } };
}
// null: the person is not visible (missing or blocked look the same).
export function likeState(state: LikesState, me: string, target: string): LikeState | null {
  if (target === me || !visible(state, target)) return null;
  return {
    iLiked: state.likes.some((l) => l.liker === me && l.liked === target),
    likedMe: state.likes.some((l) => l.liker === target && l.liked === me),
    conversationId: connected(state, me, target) ? target : null,
  };
}
export type DemoLikeRow = { profile: DemoProfile; likedAt: number };
export function listMine(state: LikesState, me: string): { received: DemoLikeRow[]; sent: DemoLikeRow[] } {
  const rows = (mine: (l: DemoLike) => boolean, other: (l: DemoLike) => string) => state.likes.filter(mine)
    .filter((l) => visible(state, other(l)) && !connected(state, me, other(l)))
    .sort((a, b) => b.createdAt - a.createdAt || other(b).localeCompare(other(a)))
    .flatMap((l) => { const profile = getDemoProfile(other(l)); return profile ? [{ profile, likedAt: l.createdAt }] : []; });
  return { received: rows((l) => l.liked === me, (l) => l.liker), sent: rows((l) => l.liker === me, (l) => l.liked) };
}
export type LikeAction = { type: "like"; me: string; target: string } | { type: "unlike"; me: string; target: string } | { type: "block"; me: string; target: string; name: string | null } | { type: "unblock"; target: string };
export function applyAction(state: LikesState, action: LikeAction): Result {
  switch (action.type) {
    case "block": {
      if (action.me === action.target) return { code: "validation", state };
      const existing = state.blocks ?? [];
      const ended = state.connections.filter(([a, b]) => pair(a, b, action.me, action.target));
      // Blocking removes the likes both ways; unblocking does not bring them back.
      return { code: "ok", state: { ...state,
        blocks: existing.some((b) => b.blocked_id === action.target) ? existing : [...existing, { blocked_id: action.target, blocked_name_snapshot: action.name, created_at: state.now }],
        likes: state.likes.filter((l) => !pair(l.liker, l.liked, action.me, action.target)),
        connections: state.connections.filter(([a, b]) => !pair(a, b, action.me, action.target)),
        endedConnections: [...(state.endedConnections ?? []), ...ended.map((members) => ({ members, reason: "blocked" as const }))],
      } };
    }
    case "unblock": return { code: "ok", state: { ...state, blocks: state.blocks?.filter((b) => b.blocked_id !== action.target) } };
    case "like": return like(state, action.me, action.target);
    case "unlike": return unlike(state, action.me, action.target);
  }
}
export function likesReducer(state: LikesState, action: LikeAction): LikesState { return applyAction(state, action).state; }
