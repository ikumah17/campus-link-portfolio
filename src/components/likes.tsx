"use client";

import { useDemoLikes } from "@/components/demo-likes-provider";
import { LikesView, type LikeRow } from "@/components/likes-view";
import { demoViewer } from "@/data/demo-likes";
import { applyAction, DEMO_NOTICE, listMine, type DemoLikeRow } from "@/lib/likes-demo";

const row = ({ profile: p }: DemoLikeRow): LikeRow => ({ id: p.id, name: p.name, age: p.age, school: p.affiliation, purposes: p.purposes, image: { src: p.image, alt: p.imageAlt }, href: `/profiles/${p.id}` });
export function Likes() {
  const { state, dispatch, getState } = useDemoLikes();
  const { received, sent } = listMine(state, demoViewer);
  function act(type: "like" | "unlike", target: string) {
    const action = { type, me: demoViewer, target };
    const result = applyAction(getState(), action);
    dispatch(action);
    return Promise.resolve({ status: result.code, conversationId: result.conversationId });
  }
  return <LikesView notice={DEMO_NOTICE} received={received.map(row)} sent={sent.map(row)} onLikeBack={(id) => act("like", id)} onUnlike={(id) => act("unlike", id)} />;
}
