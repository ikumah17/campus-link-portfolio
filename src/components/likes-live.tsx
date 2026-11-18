"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { SafetyControlsLive } from "@/components/safety-controls-live";
import { LikesView, type LikeRow } from "@/components/likes-view";
import { likeUser, unlikeUser } from "@/server/like-actions";
import type { LiveLike } from "@/server/like-data";
import { secondaryButton } from "@/components/ui-tokens";

export type LikesCursor = { at: string; id: string } | null;
const row = ({ profile: p }: LiveLike): LikeRow => ({
  id: p.id, name: p.name, age: p.age, school: p.school, purposes: p.purposes,
  image: p.photoIds[0] ? { src: `/media/photos/${p.photoIds[0]}`, alt: `${p.name}の写真` } : null, href: `/profiles/${p.id}`,
  extra: <SafetyControlsLive kind="profile" id={p.id} name={p.name} block />,
});
const nextHref = (tab: "received" | "sent", next: LikesCursor) => next && `/likes?tab=${tab}&at=${encodeURIComponent(next.at)}&id=${next.id}`;
export function LikesLive({ received, sent, next, tab = "received" }: { received: LiveLike[]; sent: LiveLike[]; next: { received: LikesCursor; sent: LikesCursor }; tab?: "received" | "sent" }) {
  const router = useRouter();
  const more = (tab: "received" | "sent") => { const href = nextHref(tab, next[tab]); return href ? <Link href={href} prefetch={false} className={`${secondaryButton} mt-6`}>さらに表示</Link> : null; };
  return <LikesView received={received.map(row)} sent={sent.map(row)} onLikeBack={likeUser} onUnlike={unlikeUser} initialTab={tab === "sent" ? 1 : 0} more={[more("received"), more("sent")]} onDone={() => router.refresh()} />;
}
