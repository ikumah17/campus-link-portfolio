"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useDemoLikes } from "@/components/demo-likes-provider";
import { demoViewer } from "@/data/demo-likes";
import { applyAction, likeState as demoLikeState, type LikeState } from "@/lib/likes-demo";
import { primaryButton, secondaryButton } from "@/components/ui-tokens";

// Texts of docs/43 §4.1 and §4.3; the demo and the live screens use the same ones.
export const LIKE_TEXT = {
  liked: "いいねしました。", matched: "マッチしました。トークで話せます。", unliked: "いいねを取り消しました。",
  likedMe: "あなたにいいねしています", iLiked: "いいね済み",
} as const;
export type LikeOutcome = "ok" | "validation" | "not_available" | "already_connected" | "rate_limited" | "unauthenticated" | "unavailable";
export const likeMessages: Record<Exclude<LikeOutcome, "ok">, string> = {
  validation: "この相手には、いまいいねできません。", not_available: "この相手には、いまいいねできません。",
  already_connected: "すでにマッチしています。", rate_limited: "今日はこれ以上いいねできません。時間をおいてお試しください。",
  unauthenticated: "ログインし直してください。", unavailable: "現在ご利用いただけません。時間をおいて再度お試しください。",
};
export const NO_LIKE: LikeState = { iLiked: false, likedMe: false, conversationId: null };
// A match whose conversation id is unknown (already_connected) opens the talk list.
export const talkHref = (state: LikeState) => state.conversationId ? `/talk/${state.conversationId}` : "/talk";
type Answer = { status: LikeOutcome; conversationId?: string };
export type LikeRunner = { like: () => Promise<Answer>; unlike: () => Promise<Answer> };

// One person's like state (get_like_state) and its buttons: like, liked + take back, like back, or open the talk.
export function LikeControlsView({ name, state, busy, status, onLike, onUnlike, compact = false }: { name: string; state: LikeState & { matched?: boolean }; busy: boolean; status: string; onLike: () => void; onUnlike: () => void; compact?: boolean }) {
  const size = compact ? "min-h-11 px-5 text-sm" : "";
  const matched = state.conversationId !== null || state.matched;
  return <div className="flex flex-col gap-2">
    {matched ? <Link href={talkHref(state)} className={`${primaryButton} ${size}`}>トークを開く</Link>
      : state.iLiked ? <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-[15px] text-ink-soft">{LIKE_TEXT.iLiked}</p><button type="button" disabled={busy} aria-label={`${name}へのいいねを取り消す`} onClick={onUnlike} className="min-h-11 rounded-full border border-line px-5 text-sm text-ink-soft disabled:opacity-50">取り消す</button></div>
      : state.likedMe ? <><p className="text-[15px] text-ink-soft">{LIKE_TEXT.likedMe}</p><button type="button" disabled={busy} aria-label={`${name}にいいねを返す`} onClick={onLike} className={`${primaryButton} ${size} disabled:opacity-50`}>いいねを返す</button></>
      : <button type="button" disabled={busy} aria-label={`${name}にいいね`} onClick={onLike} className={`${secondaryButton} ${size} gap-2 disabled:opacity-50`}><HeartIcon />いいね</button>}
    <p role="status" className="min-h-6 text-sm leading-6">{status}</p>
  </div>;
}
export function HeartIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 19.5s-7-4.3-7-9.4A3.9 3.9 0 0 1 12 7.9a3.9 3.9 0 0 1 7 2.2c0 5.1-7 9.4-7 9.4Z" />
  </svg>;
}

// Shared by the live screens (like-controls-live.tsx): runs one call at a time and turns the answer into the next state and text.
export function useLikeRunner(initial: LikeState, runner: LikeRunner, onDone?: () => void) {
  const [state, setState] = useState<LikeState & { matched?: boolean }>(initial);
  const [busy, setBusy] = useState(false), [status, setStatus] = useState("");
  const running = useRef(false);
  async function run(kind: "like" | "unlike") {
    if (running.current) return;
    running.current = true; setBusy(true);
    let answer: Answer;
    try { answer = await runner[kind](); } catch { answer = { status: "unavailable" }; }
    if (answer.status === "ok") {
      if (kind === "unlike") { setState((s) => ({ ...s, iLiked: false })); setStatus(LIKE_TEXT.unliked); }
      else if (answer.conversationId) { setState({ iLiked: false, likedMe: false, conversationId: answer.conversationId }); setStatus(LIKE_TEXT.matched); }
      else { setState((s) => ({ ...s, iLiked: true })); setStatus(LIKE_TEXT.liked); }
    } else {
      if (answer.status === "already_connected") setState({ iLiked: false, likedMe: false, conversationId: null, matched: true });
      setStatus(likeMessages[answer.status]);
    }
    running.current = false; setBusy(false);
    if (answer.status === "ok") onDone?.();
  }
  return { state, busy, status, like: () => void run("like"), unlike: () => void run("unlike") };
}

// The demo state lives in the shared provider, so the detail page, the cards and the likes page agree.
export function LikeControlsDemo({ id, name, compact }: { id: string; name: string; compact?: boolean }) {
  const { state, dispatch, getState } = useDemoLikes();
  const [status, setStatus] = useState("");
  const current = demoLikeState(state, demoViewer, id) ?? NO_LIKE;
  function act(type: "like" | "unlike") {
    const action = { type, me: demoViewer, target: id };
    const result = applyAction(getState(), action);
    dispatch(action);
    setStatus(result.code !== "ok" ? likeMessages[result.code] : type === "unlike" ? LIKE_TEXT.unliked : result.conversationId ? LIKE_TEXT.matched : LIKE_TEXT.liked);
  }
  return <LikeControlsView name={name} state={current} busy={false} status={status} onLike={() => act("like")} onUnlike={() => act("unlike")} compact={compact} />;
}
