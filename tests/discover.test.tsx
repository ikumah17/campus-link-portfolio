import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Discover } from "@/components/discover";
import { DemoLikesProvider } from "@/components/demo-likes-provider";
import { demoProfiles } from "@/data/demo-profiles";
import { createDemoLikes, demoViewer } from "@/data/demo-likes";
import { purposeText } from "@/lib/onboarding-rules";

// One list since order 34: はると (demo-2) liked the viewer and stays visible, so liking back is possible from the card.
const visibleProfiles = demoProfiles;

describe("Discover", () => {
  beforeEach(() => window.history.replaceState(null, "", "/"));

  it("renders brand heading, landmarks and all fictional profiles", async () => {
    render(<Discover />);
    await screen.findByRole("link", { name: "あおいのプロフィールを見る" });
    expect(screen.getByRole("heading", { level: 1, name: "Campus Link" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "メインナビゲーション" })).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(visibleProfiles.length);
    expect(screen.getByText(/すべて架空のデモデータ/)).toBeInTheDocument();
  });

  it("shows only adult fictional profiles with demo affiliation and alt text", async () => {
    render(<Discover />);
    await screen.findByRole("link", { name: "あおいのプロフィールを見る" });
    for (const p of demoProfiles) {
      expect(p.age).toBeGreaterThanOrEqual(18);
      expect(p.image).toMatch(/^\/demo-profile-\d\.svg$/);
    }
    expect(screen.getAllByText(/麻生専門学校グループ（デモ所属）/)).toHaveLength(visibleProfiles.length);
    for (const img of screen.getAllByRole("img")) expect(img).toHaveAttribute("alt", expect.stringContaining("架空"));
  });

  it("has no mode toggle, ignores a mode in the URL, and shows one bio and the purposes", async () => {
    window.history.replaceState(null, "", "/?mode=friends");
    const { container } = render(<Discover />);
    await screen.findByRole("link", { name: "あおいのプロフィールを見る" });
    expect(screen.queryByRole("group", { name: "表示モード" })).toBeNull();
    expect(container.textContent).not.toMatch(/恋愛|モード|申請/);
    for (const p of demoProfiles) {
      const card = screen.getByRole("article", { name: new RegExp(p.name) });
      expect(card).toHaveTextContent(p.bio);
      if (p.purposes.length) expect(within(card).getByText(purposeText(p.purposes))).toBeInTheDocument();
      expect(within(card).getByRole("link", { name: `${p.name}のプロフィールを見る` })).toHaveAttribute("href", `/profiles/${p.id}`);
    }
    expect(screen.getByRole("link", { name: "検索条件" })).toHaveAttribute("href", "/search");
  });

  it("likes from a card and takes it back, and likes back a person who liked the viewer", async () => {
    const user = userEvent.setup();
    render(<DemoLikesProvider initialState={createDemoLikes()}><Discover /></DemoLikesProvider>);
    await screen.findByRole("link", { name: "あおいのプロフィールを見る" });
    const aoi = screen.getByRole("article", { name: /あおい/ });
    await user.click(within(aoi).getByRole("button", { name: "あおいにいいね" }));
    expect(within(aoi).getByRole("status")).toHaveTextContent("いいねしました。");
    expect(within(aoi).getByText("いいね済み")).toBeInTheDocument();
    await user.click(within(aoi).getByRole("button", { name: "あおいへのいいねを取り消す" }));
    expect(within(aoi).getByRole("status")).toHaveTextContent("いいねを取り消しました。");
    const haruto = screen.getByRole("article", { name: /はると/ });
    expect(within(haruto).getByText("あなたにいいねしています")).toBeInTheDocument();
    await user.click(within(haruto).getByRole("button", { name: "はるとにいいねを返す" }));
    expect(within(haruto).getByRole("status")).toHaveTextContent("マッチしました。トークで話せます。");
    expect(within(haruto).getByRole("link", { name: "トークを開く" })).toHaveAttribute("href", "/talk/demo-2");
  });

  it("leaves out people the viewer liked, matched or blocked", async () => {
    const state = { ...createDemoLikes(), likes: [{ liker: demoViewer, liked: "demo-1", createdAt: 0 }], connections: [[demoViewer, "demo-2"]] as [string, string][], blocks: [{ blocked_id: "demo-3", blocked_name_snapshot: null, created_at: 0 }] };
    render(<DemoLikesProvider initialState={state}><Discover /></DemoLikesProvider>);
    expect(await screen.findByText("条件に合うプロフィールはありません")).toBeInTheDocument();
  });

  it("keeps the shared nav links plain", async () => {
    render(<Discover />);
    await screen.findByRole("link", { name: "あおいのプロフィールを見る" });
    const nav = screen.getByRole("navigation", { name: "メインナビゲーション" });
    expect(within(nav).getByRole("link", { name: "探す" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "探す" })).toHaveAttribute("href", "/");
    expect(within(nav).getByRole("link", { name: "いいね" })).toHaveAttribute("href", "/likes");
    expect(within(nav).getByRole("link", { name: "トーク" })).toHaveAttribute("href", "/talk");
    expect(within(nav).getByRole("link", { name: "マイページ" })).toHaveAttribute("href", "/mypage");
  });

  it("contains no emoji or external URLs", () => {
    const { container } = render(<Discover />);
    expect(container.innerHTML).not.toMatch(/https?:\/\//);
    expect(container.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
