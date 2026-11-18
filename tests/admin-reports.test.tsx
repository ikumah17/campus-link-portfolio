import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AdminProvider } from "@/lib/admin-demo";
import { AdminReports } from "@/components/admin-reports";
import { AdminDashboard } from "@/components/admin-dashboard";

describe("admin reports", () => {
  it("shows navigation, demo notice and open counts", () => {
    render(<AdminProvider><AdminDashboard /></AdminProvider>);
    expect(screen.getByRole("note")).toHaveTextContent("実際のアクセス制御・監査・保存はありません");
    expect(screen.getByRole("link", { name: /学生認証審査/ })).toHaveAttribute("href", "/admin/verifications");
    expect(screen.getByRole("link", { name: /通報/ })).toHaveTextContent("2件");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });
  it("navigates tabs with arrow/home/end and blocks the party report", async () => {
    const user = userEvent.setup({ delay: null }); render(<AdminProvider><AdminReports /></AdminProvider>);
    await user.click(screen.getByRole("tab", { name: "未対応" })); await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "確認中" })).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveTextContent("申請（旧機能）");
    await user.keyboard("{End}"); expect(screen.getByRole("tab", { name: "見送り" })).toHaveFocus();
    await user.keyboard("{Home}");
    await user.click(screen.getByRole("button", { name: /プロフィール/ }));
    expect(screen.getByText("この通報は担当できません")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText("担当者自身が当事者の架空サンプル。")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { name: "通報の詳細" })).toHaveFocus());
  });
  it("shows fictional snapshot, validates note, then triages and actions", async () => {
    const user = userEvent.setup({ delay: null }); render(<AdminProvider><AdminReports /></AdminProvider>);
    await user.click(screen.getByRole("button", { name: /メッセージ/ }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "通報の詳細" })).toHaveFocus());
    expect(screen.getByRole("blockquote")).toHaveTextContent("架空のメッセージ");
    expect(screen.queryByRole("button", { name: "対応済みにする" })).not.toBeInTheDocument();
    const note = screen.getByRole("textbox", { name: "対応メモ（任意）" });
    await user.click(note); await user.paste("あ".repeat(1001));
    expect(screen.getByText("1001 / 1000文字")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "確認中にする" }));
    expect(screen.getByRole("alert")).toHaveTextContent("1000文字以内"); expect(note).toHaveFocus();
    await user.clear(note); await user.paste("架空の対応メモ");
    await user.click(screen.getByRole("button", { name: "確認中にする" }));
    expect(screen.getByRole("status")).toHaveTextContent("確認中に変更");
    expect(screen.getByText("対応メモ：架空の対応メモ")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "対応済みにする" }));
    expect(screen.getByRole("status")).toHaveTextContent("対応済みに変更");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "対応済み" }));
    expect(within(screen.getByRole("tabpanel")).getByRole("button", { name: /メッセージ/ })).toBeInTheDocument();
  });
});
