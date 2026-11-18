import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthForm } from "@/components/auth-form";
import { LogoutButton, LogoutEverywhereButton, NotMyAccountButton } from "@/components/logout-button";
import { authMessages, passwordHint, passwordMessages, type AuthFormState } from "@/lib/auth-validation";

const mocks = vi.hoisted(() => ({ signUp: vi.fn(), signIn: vi.fn(), signOut: vi.fn(), signOutEverywhere: vi.fn(), decline: vi.fn() }));
vi.mock("@/server/auth-actions", () => ({ signUpAction: mocks.signUp, signInAction: mocks.signIn, signOutAction: mocks.signOut, signOutEverywhereAction: mocks.signOutEverywhere, declineConfirmedAction: mocks.decline }));
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  mocks.signUp.mockResolvedValue({ status: "sent" });
  mocks.signIn.mockResolvedValue({ status: "failed" });
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
async function submit() {
  const user = userEvent.setup({ delay: null });
  fireEvent.change(screen.getByLabelText("メールアドレス"), { target: { value: "fiction@example.invalid" } });
  fireEvent.change(screen.getByLabelText("パスワード"), { target: { value: "Fiction-pass-123" } });
  await user.click(screen.getByRole("button", { name: /新規登録|ログイン/ }));
}
describe("real auth form", () => {
  it.each(["login", "signup"] as const)("%s has one heading, autocomplete and no demo notice", (kind) => {
    render(<AuthForm kind={kind} />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(kind === "signup" ? "新規登録" : "ログイン");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(screen.queryByText(/デモ/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("メールアドレス")).toHaveAttribute("autocomplete", "email");
    expect(screen.getByLabelText("パスワード")).toHaveAttribute("autocomplete", kind === "signup" ? "new-password" : "current-password");
    expect(screen.getByRole("link", { name: "ウェルカムへ戻る" })).toHaveAttribute("href", "/welcome");
  });
  it.each(["login", "signup"] as const)("%s hides the password until the toggle shows it, keeping the value (FIX-006)", async (kind) => {
    const user = userEvent.setup({ delay: null });
    render(<AuthForm kind={kind} />);
    const password = screen.getByLabelText("パスワード");
    expect(password).toHaveAttribute("type", "password");
    fireEvent.change(password, { target: { value: "Fiction-pass-123" } });
    const toggle = screen.getByRole("button", { name: "パスワードを表示" });
    expect(toggle).toHaveTextContent("表示");
    expect(toggle).toHaveAttribute("type", "button");
    expect(toggle).toHaveAttribute("aria-controls", "auth-password");
    await user.click(toggle);
    expect(password).toHaveAttribute("type", "text");
    expect(password).toHaveValue("Fiction-pass-123");
    expect(screen.getByRole("button", { name: "パスワードを隠す" })).toHaveTextContent("隠す");
    await user.click(screen.getByRole("button", { name: "パスワードを隠す" }));
    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveValue("Fiction-pass-123");
    expect(mocks.signIn).not.toHaveBeenCalled();
    expect(mocks.signUp).not.toHaveBeenCalled();
  });
  it("validates locally, focuses first invalid field, clears every attempted password", async () => {
    const user = userEvent.setup({ delay: null });
    render(<AuthForm kind="signup" />);
    const email = screen.getByLabelText("メールアドレス");
    const password = screen.getByLabelText("パスワード");
    fireEvent.change(password, { target: { value: "short" } });
    await user.click(screen.getByRole("button", { name: /^(新規登録|ログイン)$/ }));
    expect(email).toHaveFocus();
    expect(email).toHaveAccessibleDescription("メールアドレスの形式を確認してください。");
    expect(password).toHaveValue("");
    fireEvent.change(email, { target: { value: "a@b.co" } });
    fireEvent.change(password, { target: { value: "あ".repeat(24) + "a" } });
    await user.click(screen.getByRole("button", { name: /^(新規登録|ログイン)$/ }));
    expect(password).toHaveFocus();
    expect(password).toHaveAttribute("aria-invalid", "true");
    expect(password).toHaveValue("");
    expect(mocks.signUp).not.toHaveBeenCalled();
  });
  it("shows the new-password rule in plain words on sign-up only, and one plain message per broken rule (FIX-005)", async () => {
    const user = userEvent.setup({ delay: null });
    const view = render(<AuthForm kind="signup" />);
    const password = screen.getByLabelText("パスワード");
    expect(password.getAttribute("aria-describedby")).toBe("auth-password-hint auth-password-error");
    expect(screen.getByText(passwordHint)).toHaveAttribute("id", "auth-password-hint");
    fireEvent.change(screen.getByLabelText("メールアドレス"), { target: { value: "a@b.co" } });
    for (const [value, message] of [
      ["Ab1!", passwordMessages.short], ["password123", passwordMessages.uppercase], ["Password123", passwordMessages.symbol],
      ["Pass word12!", passwordMessages.characters], ["Ｐassword12!", passwordMessages.characters],
    ] as const) {
      fireEvent.change(password, { target: { value } });
      await user.click(screen.getByRole("button", { name: /^(新規登録|ログイン)$/ }));
      expect(password).toHaveAccessibleDescription(`${passwordHint} ${message}`);
      expect(password).toHaveValue("");
    }
    expect(mocks.signUp).not.toHaveBeenCalled();
    expect(view.container.textContent).not.toMatch(/UTF|バイト/);
    view.unmount();
    render(<AuthForm kind="login" />);
    expect(screen.queryByText(passwordHint)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("メールアドレス"), { target: { value: "a@b.co" } });
    fireEvent.change(screen.getByLabelText("パスワード"), { target: { value: "password123" } });
    await user.click(screen.getByRole("button", { name: /^(新規登録|ログイン)$/ }));
    await waitFor(() => expect(mocks.signIn).toHaveBeenCalledTimes(1));
  });
  it.each(["sent", "failed", "rate_limited", "unavailable", "invalid"] as const)("announces the shared %s message and clears the submitted password", async (status) => {
    mocks.signUp.mockResolvedValue({ status } satisfies AuthFormState);
    render(<AuthForm kind="signup" />);
    await submit();
    expect(await screen.findByRole(status === "sent" ? "status" : "alert")).toHaveTextContent(authMessages[status]);
    expect(screen.getByLabelText("パスワード")).toHaveValue("");
    expect(mocks.signUp).toHaveBeenCalledTimes(1);
    const data = mocks.signUp.mock.calls[0][1] as FormData;
    expect(data.get("password")).toBe("Fiction-pass-123");
    expect(data.get("email")).toBe("fiction@example.invalid");
  });
  it("uses signin and renders server field errors", async () => {
    mocks.signIn.mockResolvedValue({ status: "invalid", fieldErrors: { email: "メールアドレスの形式を確認してください。" } });
    render(<AuthForm kind="login" />);
    await submit();
    await waitFor(() => expect(screen.getByLabelText("メールアドレス")).toHaveAttribute("aria-invalid", "true"));
    expect(mocks.signIn).toHaveBeenCalledTimes(1);
    expect(mocks.signUp).not.toHaveBeenCalled();
  });
  it.each(["/talk?x=1", "//evil.example", "/%5cevil", undefined])("only includes a safe hidden next %#", (next) => {
    const { container } = render(<AuthForm kind="login" next={next} />);
    const hidden = container.querySelector('input[name="next"]');
    if (next === "/talk?x=1") expect(hidden).toHaveValue(next);
    else expect(hidden).toBeNull();
  });
  it("does not include next in signup", () => {
    const { container } = render(<AuthForm kind="signup" next="/talk" />);
    expect(container.querySelector('input[name="next"]')).toBeNull();
  });
  it("announces confirmation failure", () => {
    render(<AuthForm kind="login" confirmError />);
    expect(screen.getByRole("alert")).toHaveTextContent(authMessages.confirmError);
  });
  it("keeps the password empty while the server action is pending", async () => {
    let finish!: (value: AuthFormState) => void;
    mocks.signUp.mockReturnValue(new Promise<AuthFormState>((resolve) => { finish = resolve; }));
    render(<AuthForm kind="signup" />);
    await submit();
    expect(screen.getByLabelText("パスワード")).toHaveValue("");
    expect(screen.getByRole("button", { name: /^(新規登録|ログイン)$/ })).toBeDisabled();
    finish({ status: "sent" });
    await waitFor(() => expect(screen.getByRole("button", { name: /^(新規登録|ログイン)$/ })).toBeEnabled());
  });
  it("submits the logout action from its accessible button", async () => {
    mocks.signOut.mockResolvedValue({ status: "unavailable" });
    render(<LogoutButton />);
    expect(screen.getByRole("button", { name: "ログアウト" })).toHaveClass("min-h-12");
    await userEvent.setup({ delay: null }).click(screen.getByRole("button"));
    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledOnce());
  });
  it.each([
    ["すべての端末からログアウト", LogoutEverywhereButton, "signOutEverywhere", "min-h-11"],
    ["自分のアカウントではありません", NotMyAccountButton, "decline", "min-h-12"],
  ] as const)("submits only its own action from 「%s」", async (name, Control, action, size) => {
    mocks[action].mockResolvedValue({ status: "unavailable" });
    render(<Control />);
    expect(screen.getByRole("button", { name })).toHaveClass(size);
    await userEvent.setup({ delay: null }).click(screen.getByRole("button", { name }));
    await waitFor(() => expect(mocks[action]).toHaveBeenCalledOnce());
    for (const other of ["signOut", "signOutEverywhere", "decline"] as const) if (other !== action) expect(mocks[other]).not.toHaveBeenCalled();
  });
});

it("links to legal drafts", () => {
  render(<AuthForm kind="signup" />);
  expect(screen.getByRole("link", { name: "利用規約" })).toHaveAttribute("href", "/terms");
  expect(screen.getByRole("link", { name: "プライバシーポリシー" })).toHaveAttribute("href", "/privacy");
});
