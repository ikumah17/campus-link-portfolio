import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthDemoForm } from "@/components/auth-demo-form";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
beforeEach(() => push.mockClear());

describe("auth screens are local demos", () => {
  for (const kind of ["signup", "login"] as const) {
    it(`${kind}: associates errors and focuses the first invalid field`, async () => {
      // No debounce/timer behaviour is under test; avoid a timer turn per key.
      const user = userEvent.setup({ delay: null }); render(<AuthDemoForm kind={kind} />);
      const email = screen.getByLabelText("メールアドレス"); const password = screen.getByLabelText("パスワード");
      expect(password).toHaveAttribute("autocomplete", kind === "signup" ? "new-password" : "current-password");
      await user.click(screen.getByRole("button", { name: /^(入力デモを始める|ログインを試す)$/ }));
      expect(email).toHaveFocus(); expect(email).toHaveAccessibleDescription("メールアドレスの形式を確認してください。");
      await user.type(email, "fiction@example.invalid"); await user.click(screen.getByRole("button", { name: /^(入力デモを始める|ログインを試す)$/ }));
      expect(password).toHaveFocus(); expect(password).toHaveAttribute("aria-invalid", "true");
      await user.paste("a".repeat(73)); await user.click(screen.getByRole("button", { name: /^(入力デモを始める|ログインを試す)$/ })); expect(password).toHaveFocus();
      await user.clear(password); await user.type(password, "demo-pass-123"); await user.click(screen.getByRole("button", { name: /^(入力デモを始める|ログインを試す)$/ }));
      expect(password).toHaveValue("");
      if (kind === "signup") expect(push).toHaveBeenCalledWith("/onboarding");
      else { expect(push).not.toHaveBeenCalled(); expect(screen.getByRole("status")).toHaveTextContent("デモのためログインは行われません"); }
      expect(screen.getByRole("note")).toHaveTextContent("入力内容は保存されません");
      expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    });
  }
});

it.each(["signup", "login"] as const)("%s hides the password until the toggle shows it, keeping the value (FIX-006)", async (kind) => {
  const user = userEvent.setup({ delay: null }); render(<AuthDemoForm kind={kind} />);
  const password = screen.getByLabelText("パスワード");
  expect(password).toHaveAttribute("type", "password");
  await user.type(password, "demo-pass-123");
  await user.click(screen.getByRole("button", { name: "パスワードを表示" }));
  expect(password).toHaveAttribute("type", "text"); expect(password).toHaveValue("demo-pass-123");
  expect(screen.getByRole("button", { name: "パスワードを隠す" })).toHaveTextContent("隠す");
  await user.click(screen.getByRole("button", { name: "パスワードを隠す" }));
  expect(password).toHaveAttribute("type", "password"); expect(password).toHaveValue("demo-pass-123");
  expect(screen.getByRole("button", { name: "パスワードを表示" })).toHaveTextContent("表示");
  expect(push).not.toHaveBeenCalled();
});

it("links to legal drafts", () => {
  render(<AuthDemoForm kind="signup" />);
  expect(screen.getByRole("link", { name: "利用規約" })).toHaveAttribute("href", "/terms");
  expect(screen.getByRole("link", { name: "プライバシーポリシー" })).toHaveAttribute("href", "/privacy");
});
