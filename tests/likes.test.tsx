import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ProfileDetail } from "@/components/profile-detail";
import { Likes } from "@/components/likes";
import { DemoLikesProvider } from "@/components/demo-likes-provider";
import { demoProfiles } from "@/data/demo-profiles";
import { createDemoLikes, demoViewer as me } from "@/data/demo-likes";
import type { LikesState } from "@/lib/likes-demo";

const detail = (state = createDemoLikes(), id = 0) => render(<DemoLikesProvider initialState={state}><ProfileDetail profile={demoProfiles[id]} /></DemoLikesProvider>);
const likes = (state = createDemoLikes()) => render(<DemoLikesProvider initialState={state}><Likes /></DemoLikesProvider>);

describe("demo likes page", () => {
  it("shows the fixed texts, the tabs and the nav without any mode", async () => {
    const user = userEvent.setup(); const { container } = likes();
    expect(screen.getByRole("heading", { level: 1, name: "いいね" })).toBeInTheDocument();
    expect(screen.getByText("お互いにいいねすると、マッチしてトークで話せます。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "いいね" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "いいね" })).toHaveAttribute("href", "/likes");
    expect(screen.getByRole("link", { name: "探す" })).toHaveAttribute("href", "/");
    expect(container.textContent).not.toMatch(/恋愛|モード|申請/);
    expect(screen.getByRole("tab", { name: "いいねされた" })).toHaveAttribute("aria-selected", "true");
    screen.getByRole("tab", { name: "いいねされた" }).focus(); await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "いいねした" })).toHaveFocus();
    expect(screen.getByText("まだいいねしていません。")).toBeInTheDocument();
    expect(within(screen.getByRole("tabpanel")).getByRole("link", { name: "探す" })).toHaveAttribute("href", "/");
    await user.keyboard("{Home}"); expect(screen.getByRole("tab", { name: "いいねされた" })).toHaveFocus();
  });
  it("likes back to a match, then offers the talk and shows the empty list", async () => {
    const user = userEvent.setup(); likes();
    const card = within(screen.getByRole("tabpanel")).getByRole("listitem");
    expect(card).toHaveTextContent("はると"); expect(card).toHaveTextContent("友達がほしい・話し相手がほしい");
    expect(within(card).getByRole("link", { name: /はると/ })).toHaveAttribute("href", "/profiles/demo-2");
    await user.click(screen.getByRole("button", { name: "はるとにいいねを返す" }));
    expect(screen.getByRole("status")).toHaveTextContent("マッチしました。トークで話せます。");
    expect(screen.getByRole("status")).toHaveFocus();
    expect(screen.getByRole("link", { name: "トークを開く" })).toHaveAttribute("href", "/talk/demo-2");
    expect(screen.getByText("まだいいねはありません。")).toBeInTheDocument();
  });
  it("takes a like back from the sent list", async () => {
    const user = userEvent.setup();
    const state: LikesState = { ...createDemoLikes(), likes: [{ liker: me, liked: "demo-3", createdAt: 1 }] };
    likes(state);
    expect(screen.getByText("まだいいねはありません。")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "いいねした" }));
    await user.click(screen.getByRole("button", { name: "ことねへのいいねを取り消す" }));
    expect(screen.getByRole("status")).toHaveTextContent("いいねを取り消しました。");
    expect(screen.getByText("まだいいねしていません。")).toBeInTheDocument();
  });
  it("leaves out blocked people from both lists", () => {
    const state: LikesState = { ...createDemoLikes(), likes: [{ liker: "demo-2", liked: me, createdAt: 1 }, { liker: me, liked: "demo-3", createdAt: 1 }], blocks: [{ blocked_id: "demo-2", blocked_name_snapshot: null, created_at: 0 }, { blocked_id: "demo-3", blocked_name_snapshot: null, created_at: 0 }] };
    likes(state);
    expect(within(screen.getByRole("tabpanel")).queryByRole("listitem")).not.toBeInTheDocument();
  });
});

describe("demo detail like states", () => {
  it("likes, then shows liked with take back", async () => {
    const user = userEvent.setup(); const { container } = detail();
    expect(container.textContent).not.toMatch(/モード|申請/);
    expect(screen.getByText("目的")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "あおいにいいね" }));
    expect(screen.getByRole("status")).toHaveTextContent("いいねしました。");
    expect(screen.getByText("いいね済み")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "あおいへのいいねを取り消す" }));
    expect(screen.getByRole("status")).toHaveTextContent("いいねを取り消しました。");
    expect(screen.getByRole("button", { name: "あおいにいいね" })).toBeInTheDocument();
  });
  it("shows a like from the other person and makes a match", async () => {
    const user = userEvent.setup(); detail(createDemoLikes(), 1);
    expect(screen.getByText("あなたにいいねしています")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "はるとにいいねを返す" }));
    expect(screen.getByRole("status")).toHaveTextContent("マッチしました。トークで話せます。");
    expect(screen.getByRole("link", { name: "トークを開く" })).toHaveAttribute("href", "/talk/demo-2");
  });
  it("shows the talk for a matched person and the refusals", async () => {
    const user = userEvent.setup();
    detail({ ...createDemoLikes(), connections: [[me, "demo-1"]] });
    expect(screen.getByRole("link", { name: "トークを開く" })).toHaveAttribute("href", "/talk/demo-1");
    const view = render(<DemoLikesProvider initialState={{ ...createDemoLikes(), attempts: 100 }}><ProfileDetail profile={demoProfiles[2]} /></DemoLikesProvider>);
    await user.click(within(view.container).getByRole("button", { name: "ことねにいいね" }));
    expect(within(view.container).getByRole("status")).toHaveTextContent("今日はこれ以上いいねできません。時間をおいてお試しください。");
  });
  it("refuses an unknown person with the fixed text", async () => {
    const user = userEvent.setup();
    render(<DemoLikesProvider><ProfileDetail profile={{ ...demoProfiles[0], id: "unknown" }} /></DemoLikesProvider>);
    await user.click(screen.getByRole("button", { name: "あおいにいいね" }));
    expect(screen.getByRole("status")).toHaveTextContent("この相手には、いまいいねできません。");
  });
});
