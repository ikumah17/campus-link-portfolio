import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Onboarding } from "@/components/onboarding";
import OnboardingPage from "@/app/onboarding/page";
import type { OnboardingResult } from "@/server/onboarding-actions";

const mocks = vi.hoisted(() => ({ save: vi.fn(), complete: vi.fn(), upload: vi.fn(), remove: vi.fn(), reorder: vi.fn(), photos: vi.fn(), refresh: vi.fn(), mode: vi.fn(), create: vi.fn(), load: vi.fn(), rpc: vi.fn(), redirect: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/onboarding-actions", () => ({ saveOnboarding: mocks.save, completeOnboarding: mocks.complete, refreshOnboardingPhotos: mocks.refresh }));
vi.mock("@/server/photo-actions", () => ({ removePhoto: mocks.remove, reorderPhotos: mocks.reorder }));
vi.mock("@/server/my-photos", () => ({ listMyPhotos: mocks.photos }));
vi.mock("@/lib/backend", () => ({ backendMode: mocks.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: mocks.create }));
vi.mock("@/server/affiliation-master", () => ({ loadAffiliationMaster: mocks.load }));
vi.mock("@/server/rpc", () => ({ callRpc: mocks.rpc }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
const master = [{ id: "00000000-0000-4000-8000-000000000001", name: "架空の対象校", departments: [{ id: "00000000-0000-4000-8000-000000000002", name: "架空の対象学科", classes: [{ id: "00000000-0000-4000-8000-000000000003", name: "架空の対象クラス" }] }] }];
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  // SEC-007: the photo manager uploads with fetch("/api/photos"); every other request stays forbidden.
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input !== "/api/photos" || init?.method !== "POST") throw new Error("Network forbidden");
    const { status } = await mocks.upload(init.body);
    return Response.json({ status }, { status: status === "ok" ? 200 : 400 });
  });
  mocks.save.mockResolvedValue({ status: "saved_needs_photo" });
  mocks.complete.mockResolvedValue({ status: "completed" });
  mocks.photos.mockResolvedValue([]);
  mocks.upload.mockResolvedValue({ status: "ok", photoId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
  mocks.refresh.mockResolvedValue(["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]);
  mocks.remove.mockResolvedValue({ status: "ok" });
  mocks.mode.mockReturnValue("supabase");
  mocks.create.mockResolvedValue({});
  mocks.load.mockResolvedValue(master);
  mocks.rpc.mockResolvedValue({ code: "ok", data: [{ profile_completed: false }] });
  mocks.redirect.mockImplementation((path: string) => { throw new Error(`REDIRECT:${path}`); });
});
afterEach(() => {
  for (const [input, init] of fetchSpy.mock.calls) expect([input, (init as RequestInit | undefined)?.method]).toEqual(["/api/photos", "POST"]);
  vi.restoreAllMocks();
});

async function confirm() {
  const user = userEvent.setup({ delay: null });
  render(<Onboarding backend={{ master }} />);
  expect(screen.queryByRole("note")).not.toBeInTheDocument();
  await user.type(screen.getByLabelText("表示名"), "架空の名前");
  await user.click(screen.getByLabelText("女性"));
  fireEvent.change(screen.getByLabelText("生年月日"), { target: { value: "2000-02-29" } });
  await user.click(screen.getByLabelText("18歳以上です"));
  await user.click(screen.getByRole("button", { name: "次へ" }));
  expect(screen.getByRole("option", { name: "架空の対象校" })).toHaveValue(master[0].id);
  expect(screen.queryByRole("option", { name: /デモ学校/ })).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("学校"), master[0].id);
  await user.selectOptions(screen.getByLabelText("学科"), master[0].departments[0].id);
  await user.selectOptions(screen.getByLabelText("クラス"), master[0].departments[0].classes[0].id);
  await user.click(screen.getByRole("button", { name: "次へ" }));
  expect(screen.getByText("写真は、次の保存のあとで登録します。")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /（写真1）$/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "次へ" }));
  await user.click(screen.getByLabelText("話し相手がほしい"));
  await user.click(screen.getByLabelText("友達がほしい"));
  await user.type(screen.getByLabelText("自己紹介（任意）"), "架空の自己紹介");
  await user.click(screen.getByRole("button", { name: "確認へ" }));
  expect(screen.queryByRole("region", { name: "写真の確認" })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "入力内容の確認" })).toHaveFocus();
  return user;
}

describe("Supabase onboarding form", () => {
  it("loads the master, skips photo selection and submits once with the collected input", async () => {
    const user = await confirm();
    await user.click(screen.getByRole("button", { name: "プロフィールを保存" }));
    expect(await screen.findByText("プロフィールを保存しました。写真を1枚以上登録してください。")).toBeInTheDocument();
    expect(screen.getByLabelText("写真を追加")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "プロフィールを完成" })).toBeDisabled();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save).toHaveBeenCalledWith({ displayName: "架空の名前", gender: "female", birthDate: "2000-02-29", adultDeclared: true, schoolId: master[0].id, departmentId: master[0].departments[0].id, classId: master[0].departments[0].classes[0].id, purposes: ["friends", "talk"], bio: "架空の自己紹介" });
    expect(screen.queryByRole("link", { name: "架空のプロフィールを見る" })).not.toBeInTheDocument();
  });
  it("shows completion and verification link", async () => {
    mocks.save.mockResolvedValue({ status: "completed" });
    const user = await confirm(); await user.click(screen.getByRole("button", { name: "プロフィールを保存" }));
    expect(await screen.findByText("プロフィールを作成しました。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "在学・年齢確認へ" })).toHaveAttribute("href", "/verification");
    expect(screen.getByRole("heading", { name: "プロフィールの保存" })).toHaveFocus();
  });
  it("shows the purposes and bio for review, validates the bio length and allows no purposes", async () => {
    const user = await confirm();
    const review = screen.getByRole("region", { name: "目的と自己紹介の確認" });
    expect(review).toHaveTextContent("友達がほしい・話し相手がほしい");
    expect(review).toHaveTextContent("架空の自己紹介");
    expect(document.body.textContent).not.toMatch(/モード|恋愛/);
    await user.click(screen.getByRole("button", { name: "目的と自己紹介を編集" }));
    expect(screen.getByText("プロフィールに表示されます。選ばなくてもかまいません。")).toBeInTheDocument();
    await user.click(screen.getByLabelText("友達がほしい"));
    await user.click(screen.getByLabelText("話し相手がほしい"));
    const bio = screen.getByLabelText("自己紹介（任意）");
    fireEvent.change(bio, { target: { value: "😀".repeat(501) } });
    expect(screen.getByText("501 / 500文字")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "確認へ" }));
    expect(screen.getByRole("heading", { name: "目的と自己紹介" })).toBeInTheDocument();
    expect(bio).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("自己紹介は500文字以内で入力してください。")).toBeInTheDocument();
    expect(mocks.save).not.toHaveBeenCalled();
    fireEvent.change(bio, { target: { value: "" } });
    await user.click(screen.getByRole("button", { name: "確認へ" }));
    expect(screen.getByRole("region", { name: "目的と自己紹介の確認" })).toHaveTextContent("未選択");
    expect(screen.getByRole("region", { name: "目的と自己紹介の確認" })).toHaveTextContent("自己紹介なし");
    await user.click(screen.getByRole("button", { name: "プロフィールを保存" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ purposes: [], bio: "" }));
  });
  it.each([
    [{ status: "invalid", step: 0 }, "入力内容を確認してください。", "基本情報"],
    [{ status: "invalid", step: 1 }, "入力内容を確認してください。", "所属"],
    [{ status: "invalid", step: 2 }, "入力内容を確認してください。", "写真"],
    [{ status: "invalid", step: 3 }, "入力内容を確認してください。", "目的と自己紹介"],
    [{ status: "invalid" }, "入力内容を確認してください。", "入力内容の確認"],
    [{ status: "birth_locked", step: 0 }, "年齢確認後は生年月日を変更できません。", "入力内容の確認"],
    [{ status: "unauthenticated" }, "ログインの有効期限が切れました。", "入力内容の確認"],
    [{ status: "unavailable" }, "現在保存できません。時間をおいて再度お試しください。", "入力内容の確認"],
  ] as const)("shows safe outcome %# and returns to the invalid step", async (result, message, heading) => {
    mocks.save.mockResolvedValue(result);
    const user = await confirm(); await user.click(screen.getByRole("button", { name: "プロフィールを保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    if (result.status === "invalid" && "step" in result) expect(screen.getByRole("heading", { name: heading })).toHaveFocus();
    if (result.status === "unauthenticated") expect(screen.getByRole("link", { name: "ログインへ" })).toHaveAttribute("href", "/login?next=/onboarding");
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });
  it("locks the pending form against repeated submits and navigation, then allows retry", async () => {
    let finish!: (result: OnboardingResult) => void;
    mocks.save.mockReturnValue(new Promise<OnboardingResult>((resolve) => { finish = resolve; }));
    await confirm();
    const button = screen.getByRole("button", { name: "プロフィールを保存" });
    const form = button.closest("form")!;
    fireEvent.submit(form); fireEvent.submit(form);
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(button).toBeDisabled(); expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "戻る" })).toBeDisabled();
    await act(async () => { finish({ status: "unavailable" }); });
    expect(button).not.toBeDisabled(); expect(button).toHaveAttribute("aria-busy", "false");
    mocks.save.mockResolvedValue({ status: "saved_needs_photo" });
    fireEvent.submit(form);
    expect(await screen.findByText("プロフィールを保存しました。写真を1枚以上登録してください。")).toBeInTheDocument();
    expect(mocks.save).toHaveBeenCalledTimes(2);
  });
  it("maps an action transport rejection to the unavailable message", async () => {
    mocks.save.mockRejectedValue(new Error("private provider detail"));
    const user = await confirm(); await user.click(screen.getByRole("button", { name: "プロフィールを保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("現在保存できません。時間をおいて再度お試しください。");
    expect(screen.queryByText("private provider detail")).not.toBeInTheDocument();
  });
});

describe("onboarding page backend gate", () => {
  it("blocks completion after an upload until canonical photo order can be read", async () => {
    mocks.rpc.mockResolvedValue({ code: "ok", data: [{ profile_completed: false, has_profile: true }] });
    mocks.photos.mockResolvedValue(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
    mocks.refresh.mockResolvedValueOnce(null);
    render(await OnboardingPage());
    const complete = screen.getByRole("button", { name: "プロフィールを完成" });
    expect(complete).toBeEnabled();
    const user = userEvent.setup({ delay: null });
    await user.upload(screen.getByLabelText("写真を追加"), new File(["synthetic"], "synthetic.webp", { type: "image/webp" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("現在保存できません。");
    expect(complete).toBeDisabled();
    await user.click(complete);
    expect(mocks.complete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "写真を再読み込み" }));
    await waitFor(() => expect(complete).toBeEnabled());
    expect(mocks.upload).toHaveBeenCalledOnce();
  });
  it("keeps demo inert", async () => {
    mocks.mode.mockReturnValue("demo");
    render(await OnboardingPage());
    expect(screen.getByRole("note")).toBeInTheDocument();
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("passes only the master to the backend form", async () => {
    const page = await OnboardingPage();
    expect(page.props).toEqual({ backend: { master } }); render(page);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(mocks.rpc).toHaveBeenCalledWith({}, "my_account");
  });
  it("redirects completed profiles even if master is unavailable", async () => {
    mocks.load.mockResolvedValue(null);
    mocks.rpc.mockResolvedValue({ code: "ok", data: [{ profile_completed: true }] });
    await expect(OnboardingPage()).rejects.toThrow("REDIRECT:/mypage");
  });
  it.each([{ initialPhotos: [] }, { initialPhotos: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"] }])("resumes a saved profile at the photo step, with initial ids %#", async ({ initialPhotos }) => {
    mocks.rpc.mockResolvedValue({ code: "ok", data: [{ profile_completed: false, has_profile: true }] });
    mocks.photos.mockResolvedValue(initialPhotos);
    const page = await OnboardingPage({ searchParams: Promise.resolve({}) }); render(page);
    expect(mocks.photos).toHaveBeenCalledExactlyOnceWith({});
    expect(screen.getByRole("heading", { name: "プロフィールの保存" })).toBeInTheDocument();
    expect(screen.queryByLabelText("表示名")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "入力内容を修正する" })).toHaveAttribute("href", "/onboarding?edit=1");
    const button = screen.getByRole("button", { name: "プロフィールを完成" });
    if (initialPhotos.length) expect(button).not.toBeDisabled(); else expect(button).toBeDisabled();
  });
  it("opens the form explicitly for edit=1 without listing photos", async () => {
    mocks.rpc.mockResolvedValue({ code: "ok", data: [{ profile_completed: false, has_profile: true }] });
    render(await OnboardingPage({ searchParams: Promise.resolve({ edit: "1" }) }));
    expect(screen.getByLabelText("表示名")).toBeInTheDocument(); expect(mocks.photos).not.toHaveBeenCalled();
  });
  it.each([false, undefined, "true", 1])("requires has_profile exactly true to resume: %s", async (has_profile) => {
    mocks.rpc.mockResolvedValue({ code: "ok", data: [{ profile_completed: false, has_profile }] });
    render(await OnboardingPage()); expect(screen.getByLabelText("表示名")).toBeInTheDocument(); expect(mocks.photos).not.toHaveBeenCalled();
  });
  it("renders unavailable for a null photo list", async () => {
    mocks.rpc.mockResolvedValue({ code: "ok", data: [{ profile_completed: false, has_profile: true }] }); mocks.photos.mockResolvedValue(null);
    render(await OnboardingPage());
    expect(screen.getByRole("alert")).toHaveTextContent("現在保存できません。時間をおいて再度お試しください。");
    expect(screen.queryByLabelText("写真を追加")).not.toBeInTheDocument(); expect(screen.queryByLabelText("表示名")).not.toBeInTheDocument();
  });
  it.each([{}, { edit: "1" }])("shows a deleted account only the fixed message, never the form or a redirect %#", async (query) => {
    mocks.rpc.mockResolvedValue({ code: "ok", data: [{ profile_completed: true, has_profile: true, account_status: "deleted" }] });
    const view = render(await OnboardingPage({ searchParams: Promise.resolve(query) }));
    expect(screen.getByRole("alert")).toHaveTextContent("現在保存できません。時間をおいて再度お試しください。");
    expect(view.container.querySelector("form")).toBeNull();
    expect(mocks.redirect).not.toHaveBeenCalled(); expect(mocks.photos).not.toHaveBeenCalled();
  });
  it.each(["active", "deactivated", "suspended"])("still redirects a completed %s account to mypage", async (account_status) => {
    mocks.rpc.mockResolvedValue({ code: "ok", data: [{ profile_completed: true, has_profile: true, account_status }] });
    await expect(OnboardingPage({ searchParams: Promise.resolve({ edit: "1" }) })).rejects.toThrow("REDIRECT:/mypage");
  });
  it.each(["master", "rpc", "no-row", "malformed", "throw"])("renders one message and no form on %s failure", async (failure) => {
    if (failure === "master") mocks.load.mockResolvedValue(null);
    if (failure === "rpc") mocks.rpc.mockResolvedValue({ code: "unauthenticated", data: null });
    if (failure === "no-row") mocks.rpc.mockResolvedValue({ code: "ok", data: [] });
    if (failure === "malformed") mocks.rpc.mockResolvedValue({ code: "ok", data: [{}] });
    if (failure === "throw") mocks.create.mockRejectedValue(new Error("private DB detail"));
    const view = render(await OnboardingPage());
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(view.container.querySelector("form")).toBeNull();
    expect(view.container).not.toHaveTextContent("private DB detail");
  });
});

describe("photo step completion", () => {
  const initial = ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
  it("returns to details when editing from the photo step and clears completion errors", async () => {
    mocks.complete.mockResolvedValue({ status: "needs_details" });
    render(<Onboarding backend={{ master, initialPhotos: initial }} />); const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "プロフィールを完成" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("入力内容を確認してください。");
    await user.click(screen.getByRole("link", { name: "入力内容を修正する" }));
    expect(screen.getByRole("heading", { name: "基本情報" })).toHaveFocus();
    expect(screen.getByLabelText("表示名")).toBeInTheDocument(); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("enables completion only after a successful upload, and disables it again after removal", async () => {
    const user = await confirm(); await user.click(screen.getByRole("button", { name: "プロフィールを保存" }));
    const complete = await screen.findByRole("button", { name: "プロフィールを完成" }); expect(complete).toBeDisabled();
    await user.upload(screen.getByLabelText("写真を追加"), new File(["synthetic"], "synthetic.webp", { type: "image/webp" }));
    await waitFor(() => expect(complete).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: "削除" })); await waitFor(() => expect(complete).toBeDisabled());
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("completes the profile after upload and keeps the existing success link", async () => {
    render(<Onboarding backend={{ master, initialPhotos: initial }} />); const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "プロフィールを完成" }));
    expect(await screen.findByText("プロフィールを作成しました。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "在学・年齢確認へ" })).toHaveAttribute("href", "/verification");
    expect(screen.queryByLabelText("写真を追加")).not.toBeInTheDocument(); expect(mocks.complete).toHaveBeenCalledExactlyOnceWith();
  });
  it.each([
    ["needs_photo", "写真を1枚以上登録してください。"],
    ["needs_details", "入力内容を確認してください。"],
    ["unauthenticated", "ログインの有効期限が切れました。"],
    ["unavailable", "現在保存できません。時間をおいて再度お試しください。"],
  ])("shows completion outcome %s and allows retry", async (status, message) => {
    mocks.complete.mockResolvedValue({ status }); render(<Onboarding backend={{ master, initialPhotos: initial }} />);
    await userEvent.setup({ delay: null }).click(screen.getByRole("button", { name: "プロフィールを完成" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "プロフィールを完成" })).not.toBeDisabled();
    if (status === "needs_details") expect(screen.getByRole("link", { name: "入力内容を修正する" })).toHaveAttribute("href", "/onboarding?edit=1");
    if (status === "unauthenticated") expect(screen.getByRole("link", { name: "ログインへ" })).toHaveAttribute("href", "/login?next=/onboarding");
    expect(screen.queryByText("プロフィールを作成しました。")).not.toBeInTheDocument();
  });
  it("locks completion and photo actions together and permits no repeated completion", async () => {
    let finish!: (value: { status: string }) => void; mocks.complete.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<Onboarding backend={{ master, initialPhotos: initial }} />);
    const complete = screen.getByRole("button", { name: "プロフィールを完成" });
    fireEvent.click(complete); fireEvent.click(complete);
    await waitFor(() => expect(mocks.complete).toHaveBeenCalledOnce());
    expect(complete).toBeDisabled(); expect(complete).toHaveAttribute("aria-busy", "true");
    expect(screen.getByLabelText("写真を追加")).toBeDisabled(); expect(screen.getByRole("button", { name: "削除" })).toBeDisabled();
    await act(async () => { finish({ status: "unavailable" }); }); expect(complete).not.toBeDisabled();
  });
  it("disables completion while a photo action is pending and catches completion transport errors", async () => {
    let finish!: (value: { status: string; photoId: string }) => void;
    mocks.upload.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<Onboarding backend={{ master, initialPhotos: initial }} />);
    const user = userEvent.setup({ delay: null });
    await user.upload(screen.getByLabelText("写真を追加"), new File(["synthetic"], "synthetic.webp", { type: "image/webp" }));
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce());
    const complete = screen.getByRole("button", { name: "プロフィールを完成" }); expect(complete).toBeDisabled();
    fireEvent.click(complete); expect(mocks.complete).not.toHaveBeenCalled();
    await act(async () => { finish({ status: "ok", photoId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }); });
    mocks.complete.mockRejectedValue(new Error("private provider detail")); await user.click(complete);
    expect(await screen.findByRole("alert")).toHaveTextContent("現在保存できません。時間をおいて再度お試しください。");
    expect(screen.queryByText("private provider detail")).not.toBeInTheDocument();
  });
});
