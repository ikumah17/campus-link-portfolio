import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MainNav } from "@/components/main-nav";
import { MyPage } from "@/components/mypage";

describe("MainNav", () => {
  it("marks only the current page and enables talk", async () => {
    const user = userEvent.setup();
    render(<MainNav current="mypage" />);
    const nav = screen.getByRole("navigation", { name: "メインナビゲーション" });
    expect(within(nav).getAllByRole("listitem")).toHaveLength(4);
    expect(within(nav).getByRole("link", { name: "マイページ" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "探す" })).not.toHaveAttribute("aria-current");
    const before = document.body.innerHTML;
    expect(within(nav).getByRole("link", { name: "トーク" })).toHaveAttribute("href", "/talk");
    expect(document.body.innerHTML).toBe(before);
    expect(within(nav).queryAllByRole("link")).toHaveLength(4);
  });

  it("links plain paths with no mode, and the likes page in place of requests", () => {
    render(<MainNav current="likes" />);
    expect(screen.getByRole("link", { name: "探す" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "いいね" })).toHaveAttribute("href", "/likes");
    expect(screen.getByRole("link", { name: "いいね" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "マイページ" })).toHaveAttribute("href", "/mypage");
    expect(screen.queryByText("申請")).toBeNull();
  });
});

describe("MyPage", () => {
  it("is a minimal fictional settings entry without login or verification claims", () => {
    const { container } = render(<MyPage />);
    expect(screen.getByRole("heading", { level: 1, name: "マイページ" })).toBeInTheDocument();
    expect(screen.getByText("架空アカウントの設定デモ")).toBeInTheDocument();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/ログイン済|本人確認済|認証済|verified/i);
    expect(screen.getByRole("link", { name: "プロフィールを編集" })).toHaveAttribute("href", "/mypage/profile");
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(container.innerHTML).not.toMatch(/https?:\/\//);
  });

  it("links to privacy settings and back to the list", () => {
    render(<MyPage />);
    expect(screen.getByRole("link", { name: "管理画面のデモ" })).toHaveAttribute("href", "/admin");
    expect(screen.getByRole("link", { name: /公開範囲設定/ })).toHaveAttribute("href", "/settings/privacy");
    const nav = screen.getByRole("navigation", { name: "メインナビゲーション" });
    expect(within(nav).getByRole("link", { name: "探す" })).toHaveAttribute("href", "/");
    expect(within(nav).getByRole("link", { name: "マイページ" })).toHaveAttribute("aria-current", "page");
  });
});

it("links to legal drafts", () => {
  render(<MyPage />);
  expect(screen.getByRole("link", { name: "利用規約" })).toHaveAttribute("href", "/terms");
  expect(screen.getByRole("link", { name: "プライバシーポリシー" })).toHaveAttribute("href", "/privacy");
});
