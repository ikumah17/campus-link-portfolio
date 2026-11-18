import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ pause: vi.fn(), resume: vi.fn(), remove: vi.fn(), refresh: vi.fn() }));
vi.mock("@/server/account-actions", () => ({ pauseAccount: m.pause, resumeAccount: m.resume, deleteAccount: m.remove }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: m.refresh }) }));
import { AccountSettings } from "@/components/account-settings";
import { AccountSettingsLive } from "@/components/account-settings-live";
import { DELETE_CONFIRMATION, PAUSE_NOTE } from "@/server/account-rules";
const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("network"));
afterEach(() => { cleanup(); expect(network).not.toHaveBeenCalled(); vi.clearAllMocks(); });
const dialog = () => screen.getByRole("dialog", { name: "退会しますか" });
const submit = () => screen.getByRole("button", { name: "退会する" });
function openDelete() { fireEvent.click(screen.getByRole("button", { name: "退会の手続きへ" })); return dialog(); }

it("demo pauses and resumes in memory and states what pausing means", async () => {
  render(<AccountSettings />);
  expect(screen.getByText(PAUSE_NOTE)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "マイページへ戻る" })).toHaveAttribute("href", "/mypage");
  expect(screen.getByText("利用中です。")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "休止する" }));
  await screen.findByText("休止しました。"); expect(screen.getByText("休止中です。")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "再開する" }));
  await screen.findByText("再開しました。"); expect(screen.getByText("利用中です。")).toBeInTheDocument();
});
it("demo deletion needs the exact word and then shows the completion state", async () => {
  render(<AccountSettings />);
  const panel = openDelete();
  expect(panel).toHaveAttribute("aria-modal", "true");
  expect(panel).toHaveTextContent("退会は取り消せません。つながりは終了し、いいねは消えます。");
  expect(screen.getByRole("link", { name: "プライバシーポリシー" })).toHaveAttribute("href", "/privacy");
  expect(panel.textContent).not.toMatch(/[0-9０-９]/);
  const input = screen.getByLabelText(`確認のため「${DELETE_CONFIRMATION}」と入力してください`);
  expect(document.activeElement).toBe(input);
  for (const value of ["", "退会", " 退会する", "退会するx"]) { fireEvent.change(input, { target: { value } }); expect(submit()).toBeDisabled(); }
  fireEvent.change(input, { target: { value: DELETE_CONFIRMATION } }); expect(submit()).toBeEnabled();
  fireEvent.click(submit());
  expect(await screen.findByRole("heading", { level: 1, name: "退会の手続きが完了しました" })).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("link", { name: "トップへ" })).toHaveAttribute("href", "/welcome");
});
it("the dialog traps focus, closes on Escape and returns focus to its trigger", async () => {
  render(<AccountSettings />);
  const trigger = screen.getByRole("button", { name: "退会の手続きへ" });
  trigger.focus(); const panel = openDelete();
  expect(trigger.closest("[inert]")).not.toBeNull();
  const cancel = screen.getByRole("button", { name: "キャンセル" });
  cancel.focus(); fireEvent.keyDown(cancel, { key: "Tab" });
  expect(document.activeElement).toBe(screen.getByRole("link", { name: "プライバシーポリシー" }));
  fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true }); expect(document.activeElement).toBe(cancel);
  await act(async () => { fireEvent.keyDown(panel, { key: "Escape" }); });
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
it("live starts from the database status and calls only the matching action", async () => {
  m.resume.mockResolvedValue({ status: "ok" });
  render(<AccountSettingsLive accountStatus="deactivated" />);
  expect(document.body.textContent).not.toMatch(/デモ|架空/);
  expect(screen.getByText("休止中です。")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "再開する" }));
  await screen.findByText("再開しました。");
  expect(m.resume).toHaveBeenCalledExactlyOnceWith(); expect(m.pause).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "休止する" })).toBeInTheDocument();
});
it.each([
  ["invalid_state", "アカウントの状態が変わっています。ページを再読み込みしてください。"],
  ["forbidden", "この操作は利用できません。"],
  ["unauthenticated", "ログインし直してください。"],
  ["unavailable", "現在保存できません。時間をおいて再度お試しください。"],
])("live maps pause %s to a calm message", async (status, text) => {
  m.pause.mockResolvedValue({ status });
  render(<AccountSettingsLive accountStatus="active" />);
  fireEvent.click(screen.getByRole("button", { name: "休止する" }));
  await screen.findByText(text);
  expect(screen.getByText("利用中です。")).toBeInTheDocument();
  expect(m.refresh).toHaveBeenCalledTimes(status === "invalid_state" ? 1 : 0);
});
it("live allows one toggle at a time and survives a thrown action", async () => {
  let finish!: (value: { status: string }) => void;
  m.pause.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  render(<AccountSettingsLive accountStatus="active" />);
  const button = screen.getByRole("button", { name: "休止する" });
  fireEvent.click(button); fireEvent.click(button); expect(m.pause).toHaveBeenCalledTimes(1);
  await act(async () => finish({ status: "ok" }));
  m.resume.mockRejectedValue(Error("secret"));
  fireEvent.click(screen.getByRole("button", { name: "再開する" }));
  await screen.findByText("現在保存できません。時間をおいて再度お試しください。");
});
it("a suspended account cannot pause but can still leave", () => {
  render(<AccountSettingsLive accountStatus="suspended" />);
  expect(screen.getByText("このアカウントは停止されています。")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /休止する|再開する/ })).toBeNull();
  expect(screen.getByRole("button", { name: "退会の手続きへ" })).toBeEnabled();
});
it("live deletion sends only the typed word and shows refusals inside the dialog", async () => {
  m.remove.mockResolvedValue({ status: "forbidden" });
  render(<AccountSettingsLive accountStatus="active" />);
  openDelete();
  fireEvent.submit(submit().closest("form")!); expect(m.remove).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: DELETE_CONFIRMATION } });
  fireEvent.click(submit());
  await waitFor(() => expect(dialog()).toHaveTextContent("この操作は利用できません。"));
  expect(m.remove).toHaveBeenCalledExactlyOnceWith(DELETE_CONFIRMATION);
  m.remove.mockRejectedValue(Error("secret")); fireEvent.click(submit());
  await waitFor(() => expect(dialog()).toHaveTextContent("現在保存できません。"));
});
it("a server refresh updates the status in place and keeps the message", async () => {
  m.pause.mockResolvedValue({ status: "ok" });
  const { rerender } = render(<AccountSettingsLive accountStatus="active" />);
  fireEvent.click(screen.getByRole("button", { name: "休止する" }));
  await screen.findByText("休止しました。");
  rerender(<AccountSettingsLive accountStatus="deactivated" />);
  expect(screen.getByText("休止しました。")).toBeInTheDocument(); expect(screen.getByText("休止中です。")).toBeInTheDocument();
  rerender(<AccountSettingsLive accountStatus="active" />);
  expect(screen.getByText("利用中です。")).toBeInTheDocument();
});
