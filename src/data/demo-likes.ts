import { DAY, type LikesState } from "@/lib/likes-demo";

export const demoViewer = "demo-viewer";
// はると (demo-2) has liked the viewer, so liking back makes a match; ゆう (demo-4) is already matched for the chat demo.
export function createDemoLikes(): LikesState {
  const now = Date.UTC(2026, 9, 30, 12);
  return { now, connections: [[demoViewer, "demo-4"]], likes: [
    { liker: "demo-2", liked: demoViewer, createdAt: now - DAY },
  ] };
}
