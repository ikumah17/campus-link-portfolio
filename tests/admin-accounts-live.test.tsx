import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SuspendedRow } from "@/server/admin-accounts";
const m = vi.hoisted(() => ({ reactivate: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: m.push, refresh: m.refresh }) }));
vi.mock("@/server/admin-account-actions", () => ({ reactivateSuspendedAccount: m.reactivate }));
import { AdminAccountsLive } from "@/components/admin-accounts-live";
const first: SuspendedRow = { userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", shortId: "#aaaaaaaa", name: "架空一", suspendedAt: "2026-11-01T15:30:00+00:00", reason: "harassment" };
const second: SuspendedRow = { userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", shortId: "#bbbbbbbb", name: "架空二", suspendedAt: null, reason: null };
const third: SuspendedRow = { userId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", shortId: "#cccccccc", name: "架空三", suspendedAt: "2026-11-05T00:00:00+00:00", reason: "manual_review" };
const rows = [first, second, third];
const generic = "現在操作できません。時間をおいて再度お試しください。";
let network: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks(); m.reactivate.mockResolvedValue({ status: "ok" });
  network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("network"));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { expect(network).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
const open = (name: string) => {
  const item = screen.getByRole("heading", { level: 2, name }).closest("li")!;
  const trigger = within(item).getByRole("button", { name: "停止を解除" });
  fireEvent.click(trigger);
  return trigger;
};
it("lists the name, short id, suspension date (JST) and reason label of each account", () => {
  const { container } = render(<AdminAccountsLive rows={rows} />);
  expect(screen.getByRole("heading", { level: 1, name: "停止中のアカウント" })).toHaveFocus();
  expect(screen.getAllByRole("heading", { level: 2 }).map(h => h.textContent)).toEqual(["架空一", "架空二", "架空三"]);
  for (const text of ["ID #aaaaaaaa", "ID #bbbbbbbb", "2026/11/02", "2026/11/05", "嫌がらせ", "manual_review"]) expect(screen.getByText(text)).toBeInTheDocument();
  expect(screen.getAllByText("記録なし")).toHaveLength(2);
  expect(screen.getAllByRole("button", { name: "停止を解除" })).toHaveLength(3);
  expect(container.textContent).not.toMatch(/aaaaaaaa-aaaa|bbbbbbbb-bbbb/);
  expect(screen.getByRole("link", { name: "管理画面へ戻る" })).toHaveAttribute("href", "/admin");
});
it("shows the empty state", () => {
  render(<AdminAccountsLive rows={[]} />);
  expect(screen.getByText("停止中のアカウントはありません。")).toBeInTheDocument();
  expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
});
it("asks for confirmation and cancels without a call, returning focus", async () => {
  render(<AdminAccountsLive rows={rows} />);
  const trigger = open("架空二");
  const dialog = screen.getByRole("dialog", { name: "停止を解除" });
  expect(dialog).toHaveAccessibleDescription("架空二（ID #bbbbbbbb）の停止を解除し、利用できる状態に戻します。");
  expect(within(dialog).getByRole("button", { name: "キャンセル" })).toHaveFocus();
  fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(m.reactivate).not.toHaveBeenCalled();
});
it("Escape closes the dialog without a call", () => {
  render(<AdminAccountsLive rows={rows} />); open("架空一");
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); expect(m.reactivate).not.toHaveBeenCalled();
});
it.each([
  ["ok", "停止を解除しました。", 1], ["invalid_state", "状態が変わったため解除できませんでした。", 1], ["forbidden", "この操作の権限がありません。", 0],
  ["invalid", "入力内容を確認してください。", 0], ["unauthenticated", "再度ログインしてください。", 0], ["unavailable", generic, 0],
])("reactivates by user id and shows %s", async (status, message, refreshes) => {
  m.reactivate.mockResolvedValue({ status });
  render(<AdminAccountsLive rows={rows} />); open("架空三");
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "解除する" }));
  expect(await screen.findByText(message)).toHaveAttribute("role", "status");
  expect(m.reactivate).toHaveBeenCalledExactlyOnceWith(third.userId);
  expect(m.refresh).toHaveBeenCalledTimes(refreshes);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("contains a thrown failure", async () => {
  m.reactivate.mockRejectedValue(Error("private"));
  render(<AdminAccountsLive rows={rows} />); open("架空一");
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "解除する" }));
  await screen.findByText(generic); expect(screen.queryByText(/private/)).not.toBeInTheDocument(); expect(m.refresh).not.toHaveBeenCalled();
});
it("serializes the reactivation and ignores a repeated confirm", async () => {
  let finish!: (r: { status: string }) => void; m.reactivate.mockImplementation(() => new Promise(r => { finish = r; }));
  render(<AdminAccountsLive rows={rows} />); open("架空一");
  const confirm = within(screen.getByRole("dialog")).getByRole("button", { name: "解除する" });
  fireEvent.click(confirm); fireEvent.click(confirm);
  expect(m.reactivate).toHaveBeenCalledOnce();
  for (const button of screen.getAllByRole("button", { name: "停止を解除" })) expect(button).toBeDisabled();
  await act(async () => { finish({ status: "ok" }); });
  expect(m.reactivate).toHaveBeenCalledOnce();
  expect(await screen.findByText("停止を解除しました。")).toBeInTheDocument();
});
it("after reactivation the refreshed list no longer has the account", async () => {
  const { rerender } = render(<AdminAccountsLive rows={rows} />); open("架空一");
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "解除する" }));
  await screen.findByText("停止を解除しました。");
  expect(m.refresh).toHaveBeenCalledOnce();
  rerender(<AdminAccountsLive rows={[second, third]} />);
  expect(screen.queryByRole("heading", { level: 2, name: "架空一" })).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveFocus());
});
