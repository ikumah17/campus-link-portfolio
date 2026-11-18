"use client";

import { LikeControlsView, NO_LIKE, useLikeRunner } from "@/components/like-controls";
import { likeUser, unlikeUser } from "@/server/like-actions";
import type { LikeState } from "@/lib/likes-demo";

// The live like buttons of the detail page and the discovery cards (like_user / unlike_user, docs/43 §4.3, Q8).
export function LikeControlsLive({ id, name, initial = NO_LIKE, compact }: { id: string; name: string; initial?: LikeState; compact?: boolean }) {
  const { state, busy, status, like, unlike } = useLikeRunner(initial, { like: () => likeUser(id), unlike: () => unlikeUser(id) });
  return <LikeControlsView name={name} state={state} busy={busy} status={status} onLike={like} onUnlike={unlike} compact={compact} />;
}
