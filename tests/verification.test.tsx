import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Verification } from "@/components/verification";
import { MyPage } from "@/components/mypage";

describe("verification user demo", () => {
  it("links both screens from mypage", () => {
    render(<MyPage />);
    expect(screen.getByRole("link", { name: "在学・年齢確認（デモ）" })).toHaveAttribute("href", "/verification");
    expect(screen.getByRole("link", { name: "管理画面のデモ" })).toHaveAttribute("href", "/admin");
  });
  it.each(["年齢確認", "在学確認"])("validates, submits, blocks duplicates, withdraws and resubmits %s", async (kind) => {
    const user = userEvent.setup(); render(<Verification />);
    const card = within(screen.getByRole("region", { name: kind }));
    await user.click(card.getByRole("button", { name: "提出（デモ）" }));
    const sample = card.getByRole("button", { name: "架空のサンプル資料1" });
    expect(sample).toHaveFocus(); expect(sample).toHaveAttribute("aria-invalid", "true"); expect(sample).toHaveAccessibleDescription("架空のサンプル資料を1〜3点選んでください。");
    await user.click(sample); expect(sample).toHaveAttribute("aria-pressed", "true");
    await user.click(sample); expect(sample).toHaveAttribute("aria-pressed", "false"); await user.click(sample);
    await user.click(card.getByRole("button", { name: "提出（デモ）" }));
    expect(screen.getByRole("status")).toHaveTextContent(`${kind}を提出しました（デモ）。`);
    expect(card.getByText("提出済み")).toBeInTheDocument(); expect(card.getByRole("button", { name: "提出（デモ）" })).toBeDisabled();
    await user.click(card.getByRole("button", { name: "提出（デモ）" })); expect(card.getByText("提出済み")).toBeInTheDocument();
    await user.click(card.getByRole("button", { name: "取り下げ" }));
    expect(screen.getByRole("status")).toHaveTextContent(`${kind}を取り下げました（デモ）。`); expect(sample).toHaveFocus();
    expect(card.getByRole("button", { name: "提出（デモ）" })).toBeEnabled();
    await user.click(card.getByRole("button", { name: "提出（デモ）" })); expect(card.getByText("提出済み")).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument(); expect(document.querySelector('input[type="file"]')).toBeNull();
  });
  it("discards state on remount", async () => {
    const user = userEvent.setup(); const view = render(<Verification />);
    await user.click(screen.getAllByRole("button", { name: "架空のサンプル資料1" })[0]); view.unmount(); render(<Verification />);
    expect(screen.getAllByText("未提出")).toHaveLength(2); expect(screen.getAllByRole("button", { name: "架空のサンプル資料1" })[0]).toHaveAttribute("aria-pressed", "false");
  });
});
