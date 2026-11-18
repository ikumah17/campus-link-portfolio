import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StaffRow } from "@/server/admin-staff";
const m = vi.hoisted(() => ({ grant: vi.fn(), revoke: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: m.push, refresh: m.refresh }) }));
vi.mock("@/server/admin-staff-actions", () => ({ grantRole: m.grant, revokeRole: m.revoke }));
import { AdminStaffLive } from "@/components/admin-staff-live";
const me: StaffRow = { handle: "a".repeat(64), label: "担当 #aaaaaaaa", name: "管理担当", roles: ["admin"], acting: [true], isMe: true };
const other: StaffRow = { handle: "b".repeat(64), label: "担当 #bbbbbbbb", name: null, roles: ["moderator", "reviewer"], acting: [true, true], isMe: false };
const rows = [me, other], email = "staff@example.invalid";
const generic = "現在操作できません。時間をおいて再度お試しください。";
let network: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks(); m.grant.mockResolvedValue({ status: "ok" }); m.revoke.mockResolvedValue({ status: "ok" });
  network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("network"));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { expect(network).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
function fill() { fireEvent.change(screen.getByLabelText("メールアドレス"), { target: { value: email } }); }
function open(role = "通報対応") { const trigger = screen.getByRole("button", { name: `${role}を外す` }); fireEvent.click(trigger); return trigger; }
it("lists only names, labels, active roles and self marker with an accessible grant form", () => {
  const { container } = render(<AdminStaffLive rows={rows} />);
  expect(screen.getByRole("heading", { level: 1, name: "担当者と役割" })).toHaveFocus();
  for (const text of ["管理担当", "名前未設定", "あなた", me.label, other.label]) expect(screen.getByText(text)).toBeInTheDocument();
  for (const text of ["通報対応", "学生認証審査"]) expect(screen.getByText(text, { selector: "span" })).toBeInTheDocument();
  expect(screen.getByLabelText("メールアドレス")).toHaveAttribute("type", "email");
  expect(screen.getByLabelText("メールアドレス")).toHaveAttribute("autocomplete", "off");
  expect(container.innerHTML).not.toMatch(/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa|bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb|user_id|granted_by/);
  expect(screen.getByRole("link", { name: "管理画面へ戻る" })).toHaveAttribute("href", "/admin");
});
it("shows an empty list state", () => { render(<AdminStaffLive rows={[]} />); expect(screen.getByText("担当者はいません。")).toBeInTheDocument(); });
const noAdmin = "働いている管理者がいません。運用の手順（docs/38 §2）で付け直してください。", inactive = "無効（要素の変更後）";
it("labels only the roles that do not act, next to the role, and keeps their revoke buttons", () => {
  render(<AdminStaffLive rows={[me, { ...other, acting: [false, true] }]} />);
  const labels = screen.getAllByText(inactive);
  expect(labels).toHaveLength(1);
  expect(labels[0].closest("li")).toHaveTextContent("通報対応");
  expect(labels[0]).toHaveClass("text-muted");
  expect(screen.getByRole("button", { name: "通報対応を外す" })).toBeEnabled();
  expect(screen.queryByText(noAdmin)).not.toBeInTheDocument();
});
it.each([
  ["the only admin role does not act", [{ ...me, acting: [false] }, other]],
  ["no row holds admin", [other]],
  ["the list is empty", []],
])("shows the no-acting-admin line when %s", (_, list) => {
  render(<AdminStaffLive rows={list as StaffRow[]} />);
  expect(screen.getByText(noAdmin)).toBeInTheDocument();
});
it("hides the no-acting-admin line when another admin acts, even if the caller's admin does not", () => {
  render(<AdminStaffLive rows={[{ ...me, acting: [false] }, { ...other, roles: ["admin"], acting: [true] }]} />);
  expect(screen.queryByText(noAdmin)).not.toBeInTheDocument();
  expect(screen.getAllByText(inactive)).toHaveLength(1);
});
it.each([
  ["ok", "役割を付与しました。"], ["not_found", "該当するアカウントがありません。"], ["invalid_state", "すでにその役割があります。"],
  ["mfa_required", "二段階認証（TOTP）を登録済みのアカウントにだけ役割を付けられます。"],
  ["forbidden", "この操作の権限がありません。"], ["invalid", "入力内容を確認してください。"], ["unauthenticated", "再度ログインしてください。"], ["unavailable", generic],
])("shows grant %s and clears the email", async (status, message) => {
  m.grant.mockResolvedValue({ status }); render(<AdminStaffLive rows={rows} />); fill();
  fireEvent.change(screen.getByLabelText("役割"), { target: { value: "moderator" } });
  fireEvent.click(screen.getByRole("button", { name: "付与する" }));
  await screen.findByText(message); expect(screen.getByLabelText("メールアドレス")).toHaveValue("");
  expect(screen.queryByText(email)).not.toBeInTheDocument(); expect(m.grant).toHaveBeenCalledExactlyOnceWith(email, "moderator");
  expect(m.refresh).toHaveBeenCalledTimes(status === "ok" ? 1 : 0);
});
it("contains a thrown grant failure and clears the email", async () => {
  m.grant.mockRejectedValue(Error("private")); render(<AdminStaffLive rows={rows} />); fill(); fireEvent.click(screen.getByRole("button", { name: "付与する" }));
  await screen.findByText(generic); expect(screen.getByLabelText("メールアドレス")).toHaveValue(""); expect(screen.queryByText(/private/)).not.toBeInTheDocument();
});
it("serializes grant across the whole page and ignores repeated form submits", async () => {
  let finish!: (r: { status: string }) => void; m.grant.mockImplementation(() => new Promise(r => { finish = r; }));
  const { container } = render(<AdminStaffLive rows={rows} />); fill(); fireEvent.click(screen.getByRole("button", { name: "付与する" }));
  for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
  fireEvent.submit(container.querySelector("form")!); fireEvent.click(screen.getByRole("button", { name: "管理者を外す" }));
  expect(m.grant).toHaveBeenCalledTimes(1); expect(m.revoke).not.toHaveBeenCalled(); expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await act(async () => finish({ status: "ok" })); expect(screen.getByRole("button", { name: "付与する" })).toBeEnabled();
});
it("traps focus, handles Escape and returns to the exact trigger", () => {
  render(<AdminStaffLive rows={rows} />); const trigger = open();
  const dialog = screen.getByRole("dialog"), cancel = within(dialog).getByRole("button", { name: "キャンセル" }), confirm = within(dialog).getByRole("button", { name: "外す" });
  expect(cancel).toHaveFocus(); fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true }); expect(confirm).toHaveFocus();
  fireEvent.keyDown(confirm, { key: "Tab" }); expect(cancel).toHaveFocus();
  fireEvent(dialog, new Event("cancel", { cancelable: true })); expect(trigger).toHaveFocus(); expect(m.revoke).not.toHaveBeenCalled();
});
it("keeps pending focus with both Tab directions, ignores Escape and serializes all actions", async () => {
  let finish!: (r: { status: string }) => void; m.revoke.mockImplementation(() => new Promise(r => { finish = r; }));
  const { container } = render(<AdminStaffLive rows={rows} />); const trigger = open(); const dialog = screen.getByRole("dialog"), confirm = within(dialog).getByRole("button", { name: "外す" });
  confirm.focus(); fireEvent.click(confirm); expect(dialog).toHaveFocus();
  for (const shiftKey of [false, true]) { fireEvent.keyDown(dialog, { key: "Tab", shiftKey }); expect(dialog).toHaveFocus(); }
  const cancel = new Event("cancel", { cancelable: true }); fireEvent(dialog, cancel); expect(cancel.defaultPrevented).toBe(true); expect(dialog).toHaveAttribute("open");
  for (const button of screen.getAllByRole("button")) { expect(button).toBeDisabled(); fireEvent.click(button); }
  fireEvent.submit(container.querySelector("form")!);
  expect(m.revoke).toHaveBeenCalledExactlyOnceWith(other.handle, "moderator"); expect(m.grant).not.toHaveBeenCalled();
  await act(async () => finish({ status: "ok" })); await screen.findByText("役割を外しました。");
  await waitFor(() => expect(trigger).toHaveFocus()); expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); expect(m.refresh).toHaveBeenCalledTimes(1);
});
it.each([
  ["invalid_state", "状態が変わったか、最後の管理者のため外せません。"], ["forbidden", "この操作の権限がありません。"],
  ["invalid", "入力内容を確認してください。"], ["unauthenticated", "再度ログインしてください。"], ["unavailable", generic], ["not_found", generic],
  ["mfa_required", generic],
])("shows revoke %s", async (status, message) => {
  m.revoke.mockResolvedValue({ status }); render(<AdminStaffLive rows={rows} />); open(); fireEvent.click(screen.getByRole("button", { name: "外す" }));
  await screen.findByText(message); expect(m.refresh).not.toHaveBeenCalled(); expect(m.push).not.toHaveBeenCalled();
});
it("shows the own-admin warning and redirects home after revocation", async () => {
  render(<AdminStaffLive rows={rows} />); open("管理者");
  expect(screen.getByText("外すと、この画面を使えなくなります。")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "外す" })); await screen.findByText("役割を外しました。");
  expect(m.revoke).toHaveBeenCalledExactlyOnceWith(me.handle, "admin"); expect(m.push).toHaveBeenCalledExactlyOnceWith("/"); expect(m.refresh).not.toHaveBeenCalled();
});
it("shows no self-admin warning for other roles or other people, and returns focus after failure", async () => {
  m.revoke.mockRejectedValue(Error("private")); render(<AdminStaffLive rows={rows} />); const trigger = open("学生認証審査");
  expect(screen.queryByText("外すと、この画面を使えなくなります。")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "外す" })); await screen.findByText(generic); await waitFor(() => expect(trigger).toHaveFocus());
});
it("falls back to the heading when a refreshed list removes the trigger", async () => {
  let finish!: (r: { status: string }) => void; m.revoke.mockImplementation(() => new Promise(r => { finish = r; }));
  const { rerender } = render(<AdminStaffLive rows={rows} />); open(); fireEvent.click(screen.getByRole("button", { name: "外す" }));
  rerender(<AdminStaffLive rows={[me]} />); await act(async () => finish({ status: "ok" }));
  expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
});
