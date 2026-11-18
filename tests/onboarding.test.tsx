// The existing unit project discovers .test.tsx only. Import the spec-owned pure
// test module so npm test executes it without changing the shared Vitest config.
import "./onboarding-validation.test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Onboarding } from "@/components/onboarding";
import { MyPage } from "@/components/mypage";
import { demoAffiliations } from "@/data/demo-affiliations";

describe("onboarding demo", () => {
  it("links mypage to the demo", () => { render(<MyPage />); expect(screen.getByRole("link", { name: "登録画面のデモ" })).toHaveAttribute("href", "/welcome"); });
  it("validates every step, resets children, orders photos, edits and completes", async () => {
    // Validation/focus are synchronous; per-key timer turns add only test load.
    const user = userEvent.setup({ delay: null }); render(<Onboarding />);
    const next = () => user.click(screen.getByRole("button", { name: "次へ" }));
    await next(); await waitFor(() => expect(screen.getByLabelText("表示名")).toHaveFocus());
    await user.type(screen.getByLabelText("表示名"), "架空の名前"); await next();
    await waitFor(() => expect(screen.getByLabelText("女性")).toHaveFocus());
    await user.click(screen.getByLabelText("女性")); await next();
    await waitFor(() => expect(screen.getByLabelText("生年月日")).toHaveFocus());
    await user.type(screen.getByLabelText("生年月日"), "2000-02-29"); await next();
    await waitFor(() => expect(screen.getByLabelText("18歳以上です")).toHaveFocus());
    await user.click(screen.getByLabelText("18歳以上です")); await next();
    expect(screen.getByRole("heading", { name: "所属" })).toHaveFocus();
    await next(); await waitFor(() => expect(screen.getByLabelText("学校")).toHaveFocus());
    const [a, b] = demoAffiliations;
    await user.selectOptions(screen.getByLabelText("学校"), a.id); await next();
    await waitFor(() => expect(screen.getByLabelText("学科")).toHaveFocus());
    await user.selectOptions(screen.getByLabelText("学科"), a.departments[0].id); await next();
    await waitFor(() => expect(screen.getByLabelText("クラス")).toHaveFocus());
    await user.selectOptions(screen.getByLabelText("クラス"), a.departments[0].classes[0].id);
    await user.selectOptions(screen.getByLabelText("学科"), a.departments[1].id); expect(screen.getByLabelText("クラス")).toHaveValue("");
    await user.selectOptions(screen.getByLabelText("学校"), b.id); expect(screen.getByLabelText("学科")).toHaveValue(""); expect(screen.getByLabelText("クラス")).toHaveValue(""); expect(screen.getByLabelText("クラス")).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("学科"), b.departments[0].id); await user.selectOptions(screen.getByLabelText("クラス"), b.departments[0].classes[0].id); await next();
    await next(); await waitFor(() => expect(screen.getByRole("button", { name: /（写真1）$/ })).toHaveFocus());
    await user.click(screen.getByRole("button", { name: /（写真2）$/ })); await user.click(screen.getByRole("button", { name: /（写真1）$/ }));
    expect(screen.getByRole("button", { name: /（写真2）$/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("list", { name: "写真の選択順" })).getAllByRole("listitem")[0]).toHaveTextContent("写真2（メイン）");
    await user.click(screen.getByRole("button", { name: /（写真2）$/ })); expect(screen.getByRole("button", { name: /（写真2）$/ })).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: /（写真2）$/ })); await next();
    expect(screen.queryByText(/モード|恋愛/)).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("自己紹介（任意）")); await user.paste("a".repeat(501));
    await user.click(screen.getByRole("button", { name: "確認へ" })); await waitFor(() => expect(screen.getByLabelText("自己紹介（任意）")).toHaveFocus());
    await user.clear(screen.getByLabelText("自己紹介（任意）")); await user.type(screen.getByLabelText("自己紹介（任意）"), "架空の自己紹介");
    await user.click(screen.getByLabelText("勉強仲間がほしい")); await user.click(screen.getByLabelText("恋人がほしい"));
    await user.click(screen.getByRole("button", { name: "確認へ" }));
    expect(screen.getByText("恋人がほしい・勉強仲間がほしい")).toBeInTheDocument();
    for (const title of ["基本情報", "所属", "写真", "目的と自己紹介"]) {
      await user.click(screen.getByRole("button", { name: `${title}を編集` })); expect(screen.getByRole("heading", { name: title })).toHaveFocus();
      while (!screen.queryByRole("heading", { name: "入力内容の確認" })) await user.click(screen.getByRole("button", { name: /^(次へ|確認へ)$/ }));
    }
    expect(screen.getByText("2000-02-29")).toBeInTheDocument(); expect(screen.getByText("架空の自己紹介")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "デモのプロフィールを作成" }));
    expect(screen.getByText("デモのため保存されていません。在学・年齢確認は今後の工程です。")).toBeInTheDocument(); expect(screen.getByRole("heading", { name: "デモの完了" })).toHaveFocus();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  }, 20000);
  it("unmounting discards all draft data", async () => {
    const user = userEvent.setup({ delay: null }); const view = render(<Onboarding />); await user.type(screen.getByLabelText("表示名"), "架空の名前"); view.unmount(); render(<Onboarding />); expect(screen.getByLabelText("表示名")).toHaveValue("");
  });
});
