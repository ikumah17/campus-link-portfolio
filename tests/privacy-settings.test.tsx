import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PrivacySettings } from "@/components/privacy-settings";
import { DemoPrivacyProvider } from "@/components/demo-privacy-provider";
import { createPrivacyDemo, type PrivacyGateway } from "@/lib/privacy-gateway";
import { defaultPrivacySettings } from "@/data/demo-privacy";

afterEach(() => vi.restoreAllMocks());
const save = () => screen.getByRole("button", { name: "デモ設定を保存" });
async function mount(gateway: PrivacyGateway = createPrivacyDemo()) {
  const view = render(<DemoPrivacyProvider gateway={gateway}><PrivacySettings /></DemoPrivacyProvider>);
  await waitFor(() => expect(save()).toBeEnabled());
  return view;
}
it("keeps notice, defaults, semantics and mode-preserving links", async () => {
  await mount();
  expect(screen.getByRole("note")).toHaveTextContent("デモ：設定はこの画面を開いている間だけ保持され、実際の表示制限には反映されません。");
  expect(screen.getByRole("link", { name: "マイページへ戻る" })).toHaveAttribute("href", "/mypage");
  expect(screen.getAllByRole("switch").map((s) => s.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false", "false"]);
  expect(screen.getByRole("switch", { name: "同じ学科に表示しない" })).toHaveAccessibleDescription("同じ学科のユーザーにプロフィールを表示しません。");
});
it("toggles all switches, adds/removes seed targets and saves without any storage access", async () => {
  const spies = ["getItem", "setItem", "removeItem", "clear", "key"].map((method) => vi.spyOn(Storage.prototype, method as "getItem"));
  const user = userEvent.setup();
  const gateway = createPrivacyDemo();
  await mount(gateway);
  for (const control of screen.getAllByRole("switch")) await user.click(control);
  await user.click(screen.getByRole("button", { name: /非表示対象を管理/ }));
  for (const name of ["デモ学校A（架空）", "デモ学科A1（架空）", "デモクラスA1-1（架空）"]) await user.click(screen.getByRole("button", { name: `${name}を追加` }));
  const remove = screen.getByRole("button", { name: "デモ学科A1（架空）を解除" });
  remove.focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("button", { name: "デモ学科A1（架空）を追加" })).toHaveFocus();
  expect(screen.getByRole("button", { name: /非表示対象を管理/ })).toHaveTextContent("2件指定中");
  await user.click(save());
  expect(screen.getByRole("status")).toHaveTextContent("デモ設定を保存しました。");
  expect(await gateway.getMySettings()).toMatchObject({ code: "ok", data: { hideSameClass: false, hideSameDepartment: true, hideSameSchool: true, showDepartment: true, showClass: true, hiddenDepartmentIds: [] } });
  await user.click(screen.getAllByRole("switch")[0]);
  expect(screen.getByRole("status")).toHaveTextContent("未保存の変更があります。");
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});
for (const code of ["validation", "rate_limited"] as const) it(`shows ${code} without success and editing clears the error`, async () => {
  const user = userEvent.setup();
  await mount({ getMySettings: async () => ({ code: "ok", data: defaultPrivacySettings() }), updatePrivacySettings: async () => ({ code, data: null }) });
  await user.click(save());
  expect(screen.getByRole("alert")).toHaveTextContent(code === "validation" ? "設定内容を確認してください" : "しばらくしてから再度お試しください");
  expect(screen.getByRole("status")).not.toHaveTextContent("保存しました");
  await user.click(screen.getAllByRole("switch")[0]);
  expect(screen.getByRole("alert")).toBeEmptyDOMElement();
});
it("resets a new demo provider to safe defaults", async () => {
  const user = userEvent.setup();
  const view = await mount();
  await user.click(screen.getAllByRole("switch")[0]);
  await user.click(save());
  view.unmount();
  await mount();
  expect(screen.getAllByRole("switch")[0]).toHaveAttribute("aria-checked", "true");
});

it("does not announce an older save as success for a draft edited while saving", async () => {
  const user = userEvent.setup();
  let resolve!: (value: Awaited<ReturnType<PrivacyGateway["updatePrivacySettings"]>>) => void;
  await mount({ getMySettings: async () => ({ code: "ok", data: defaultPrivacySettings() }), updatePrivacySettings: () => new Promise((done) => { resolve = done; }) });
  await user.click(save());
  expect(save()).toBeDisabled();
  await user.click(screen.getAllByRole("switch")[0]);
  resolve({ code: "ok", data: defaultPrivacySettings() });
  await waitFor(() => expect(save()).toBeEnabled());
  expect(screen.getByRole("status")).toHaveTextContent("未保存の変更があります。");
});
