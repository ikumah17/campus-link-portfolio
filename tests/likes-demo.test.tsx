import { describe, expect, it } from "vitest";
import { createDemoLikes, demoViewer as me } from "@/data/demo-likes";
import { applyAction, like, likeState, LIKE_DAILY_LIMIT, listMine, unlike, type LikesState } from "@/lib/likes-demo";
import { createDiscoverDemo } from "@/lib/discover-gateway";

const empty = (): LikesState => ({ now: 0, likes: [], connections: [] });
describe("demo likes (order 34 semantics)", () => {
  it("likes once, idempotently, and lists both directions without counts", () => {
    const first = like(empty(), me, "demo-1");
    expect(first.code).toBe("ok"); expect(first.conversationId).toBeUndefined();
    const again = like(first.state, me, "demo-1");
    expect(again.state.likes).toHaveLength(1);
    expect(listMine(again.state, me).sent.map((r) => r.profile.id)).toEqual(["demo-1"]);
    expect(listMine(again.state, "demo-1").received.map((r) => r.profile.id)).toEqual([]);
    expect(likeState(again.state, me, "demo-1")).toEqual({ iLiked: true, likedMe: false, conversationId: null });
  });
  it("a like back makes one match, removes both likes and opens the conversation", () => {
    const start = createDemoLikes();
    expect(likeState(start, me, "demo-2")).toEqual({ iLiked: false, likedMe: true, conversationId: null });
    expect(listMine(start, me).received.map((r) => r.profile.id)).toEqual(["demo-2"]);
    const match = like(start, me, "demo-2");
    expect(match).toMatchObject({ code: "ok", conversationId: "demo-2" });
    expect(match.state.likes).toEqual([]);
    expect(match.state.connections).toContainEqual([me, "demo-2"]);
    expect(listMine(match.state, me)).toEqual({ received: [], sent: [] });
    expect(likeState(match.state, me, "demo-2")).toEqual({ iLiked: false, likedMe: false, conversationId: "demo-2" });
    expect(like(match.state, me, "demo-2").code).toBe("already_connected");
  });
  it("takes a like back, idempotently, and keeps a match unchanged", () => {
    const liked = like(empty(), me, "demo-1").state;
    const back = unlike(liked, me, "demo-1");
    expect(back.code).toBe("ok"); expect(back.state.likes).toEqual([]);
    expect(unlike(back.state, me, "demo-1").code).toBe("ok");
    const matched = like(createDemoLikes(), me, "demo-2").state;
    expect(unlike(matched, me, "demo-2").state.connections).toEqual(matched.connections);
  });
  it("refuses self, unknown and blocked people the same way and counts every attempt", () => {
    expect(like(empty(), me, me).code).toBe("validation");
    expect(like(empty(), me, "unknown").code).toBe("not_available");
    const blocked = applyAction(createDemoLikes(), { type: "block", me, target: "demo-2", name: "はると" }).state;
    expect(blocked.likes).toEqual([]);
    expect(like(blocked, me, "demo-2").code).toBe("not_available");
    expect(likeState(blocked, me, "demo-2")).toBeNull();
    expect(listMine(blocked, me).received).toEqual([]);
    const unblocked = applyAction(blocked, { type: "unblock", target: "demo-2" }).state;
    expect(unblocked.likes).toEqual([]);
    let state = empty();
    for (let i = 0; i < LIKE_DAILY_LIMIT; i++) state = (i % 2 ? unlike : like)(state, me, "demo-1").state;
    const refused = like(state, me, "demo-1");
    expect(refused.code).toBe("rate_limited"); expect(refused.state.attempts).toBe(LIKE_DAILY_LIMIT + 1);
    expect(unlike(refused.state, me, "demo-1").code).toBe("rate_limited");
  });
  it("discovery leaves out people the viewer liked or matched, and keeps people who liked the viewer", async () => {
    let state = like(createDemoLikes(), me, "demo-1").state;
    const ids = async () => (await createDiscoverDemo(() => state, me).discoverProfiles({ genders: [], schoolIds: [] })).data.map((p) => p.id);
    expect(await ids()).toEqual(["demo-2", "demo-3"]);
    state = like(state, me, "demo-2").state;
    expect(await ids()).toEqual(["demo-3"]);
  });
});
