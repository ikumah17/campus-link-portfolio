// A11Y-003: axe on the server-failure notices of the live components. Hosted runs cannot
// produce these states without changing hosted settings, so the server actions are mocked
// the way each component's own live test mocks them and every notice is rendered in jsdom.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  refresh: vi.fn(), push: vi.fn(),
  like: vi.fn(), unlike: vi.fn(), saveProfile: vi.fn(),
  safety: vi.fn(),
  chatSend: vi.fn(), latest: vi.fn(), older: vi.fn(), read: vi.fn(),
  submit: vi.fn(), withdraw: vi.fn(),
  save: vi.fn(), complete: vi.fn(), refreshPhotos: vi.fn(),
  removePhoto: vi.fn(), reorderPhotos: vi.fn(), upload: vi.fn(),
  privacy: vi.fn(),
  pause: vi.fn(), resume: vi.fn(), remove: vi.fn(),
  reactivateAccount: vi.fn(), grant: vi.fn(), revoke: vi.fn(),
  updateReport: vi.fn(), suspend: vi.fn(), reactivateReport: vi.fn(),
  saveAffiliation: vi.fn(), toggleAffiliation: vi.fn(),
  enroll: vi.fn(), verify: vi.fn(),
  decide: vi.fn(), release: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: m.refresh, push: m.push }) }));
vi.mock("@/lib/supabase/browser", () => ({ createBrowserSupabase: () => { throw Error("test fallback"); } }));
vi.mock("@/server/like-actions", () => ({ likeUser: m.like, unlikeUser: m.unlike }));
vi.mock("@/server/profile-edit-actions", () => ({ saveMyProfile: m.saveProfile }));
vi.mock("@/server/safety-actions", () => ({ blockProfile: m.safety, blockConversation: m.safety, unblockUser: m.safety, reportProfile: m.safety, reportConversation: m.safety, reportMessage: m.safety }));
vi.mock("@/server/chat-actions", () => ({ sendChatMessage: m.chatSend, latestMessages: m.latest, olderMessages: m.older, markRead: m.read }));
vi.mock("@/server/verification-actions", () => ({ submitVerification: m.submit, withdrawVerification: m.withdraw }));
vi.mock("@/server/onboarding-actions", () => ({ saveOnboarding: m.save, completeOnboarding: m.complete, refreshOnboardingPhotos: m.refreshPhotos }));
vi.mock("@/server/photo-actions", () => ({ removePhoto: m.removePhoto, reorderPhotos: m.reorderPhotos }));
vi.mock("@/server/privacy-actions", () => ({ savePrivacySettings: m.privacy }));
vi.mock("@/server/account-actions", () => ({ pauseAccount: m.pause, resumeAccount: m.resume, deleteAccount: m.remove }));
vi.mock("@/server/admin-account-actions", () => ({ reactivateSuspendedAccount: m.reactivateAccount }));
vi.mock("@/server/admin-staff-actions", () => ({ grantRole: m.grant, revokeRole: m.revoke }));
vi.mock("@/server/admin-report-actions", () => ({ updateReport: m.updateReport, suspendReportTarget: m.suspend, reactivateReportTarget: m.reactivateReport }));
vi.mock("@/server/admin-affiliation-actions", () => ({ saveAffiliation: m.saveAffiliation, setAffiliationActive: m.toggleAffiliation }));
vi.mock("@/server/mfa-actions", () => ({ startTotpEnrollment: m.enroll, verifyTotp: m.verify }));
vi.mock("@/server/admin-verification-actions", () => ({ decideSubmission: m.decide, releaseSubmission: m.release }));

import { LikesLive } from "@/components/likes-live";
import { LikeControlsLive } from "@/components/like-controls-live";
import { likeMessages } from "@/components/like-controls";
import { ProfileEditLive } from "@/components/profile-edit-live";
import { SafetyControlsLive } from "@/components/safety-controls-live";
import { ChatRoomLive } from "@/components/chat-room-live";
import { VerificationLive } from "@/components/verification-live";
import { Onboarding } from "@/components/onboarding";
import { PhotoManager } from "@/components/photo-manager";
import { PrivacySettingsLive } from "@/components/privacy-settings-live";
import { AccountSettingsLive } from "@/components/account-settings-live";
import { AdminAccountsLive } from "@/components/admin-accounts-live";
import { AdminStaffLive } from "@/components/admin-staff-live";
import { AdminReportDetailLive } from "@/components/admin-report-detail-live";
import { AdminAffiliationsLive } from "@/components/admin-affiliations-live";
import { AdminMfa } from "@/components/admin-mfa";
import { AdminVerificationDetail } from "@/components/admin-verification-detail";
import { DELETE_CONFIRMATION, actionMessages } from "@/server/account-rules";
import type { LiveLike } from "@/server/like-data";
import type { VerificationState } from "@/server/verification-data";
import type { SuspendedRow } from "@/server/admin-accounts";
import type { StaffRow } from "@/server/admin-staff";
import type { ReportDetail } from "@/server/admin-reports";
import type { Affiliation } from "@/lib/admin-gateway";
import type { SubmissionDetail } from "@/server/admin-verifications";

// Same tags as tests/a11y.spec.ts. jsdom has no layout, so color-contrast is disabled here;
// the Playwright suites (tests/a11y.spec.ts) check it in a real browser.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
async function expectNoViolations(container: Element) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: TAGS }, rules: { "color-contrast": { enabled: false } } });
  expect(results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
// Waits for a rendered live region of the given role that holds the text, so no case passes on an empty render.
async function notice(role: "alert" | "status", text: string) {
  return waitFor(() => {
    const element = screen.queryAllByRole(role).find(e => e.textContent?.includes(text));
    expect(element, `${role} with "${text}"`).toBeDefined();
    return element!;
  });
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  // SEC-007: only the photo manager's POST /api/photos may reach fetch; it answers JSON { status }.
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input !== "/api/photos" || init?.method !== "POST") throw new Error("Network forbidden");
    const { status } = await m.upload(init.body);
    return Response.json({ status }, { status: status === "ok" ? 200 : 400 });
  });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  m.read.mockResolvedValue({ status: "ok" });
  m.refreshPhotos.mockResolvedValue([]);
});
afterEach(() => {
  for (const [input, init] of fetchSpy.mock.calls) expect([input, (init as RequestInit | undefined)?.method]).toEqual(["/api/photos", "POST"]);
  vi.restoreAllMocks();
});

const refusals = [...Object.keys(likeMessages), "thrown"] as (keyof typeof likeMessages | "thrown")[];
const refusalText = (status: keyof typeof likeMessages | "thrown") => likeMessages[status === "thrown" ? "unavailable" : status];
const answer = (fn: ReturnType<typeof vi.fn>, status: keyof typeof likeMessages | "thrown") => status === "thrown" ? fn.mockRejectedValue(Error("private")) : fn.mockResolvedValue({ status });

describe("likes-live", () => {
  const profile = { id: "person", name: "葵", age: 22, gender: "female" as const, school: "大学", department: null, class: null, bio: "", purposes: ["friends" as const], hobbies: [], photoIds: ["photo"] };
  const like: LiveLike = { id: "person", likedAt: "today", profile };
  const next = { received: null, sent: null };
  it.each(refusals)("like back %s", async status => {
    answer(m.like, status);
    const { container } = render(<LikesLive received={[like]} sent={[]} next={next} />);
    fireEvent.click(screen.getByText("いいねを返す"));
    await notice("status", refusalText(status));
    await expectNoViolations(container);
  });
  it.each(refusals)("take back %s", async status => {
    answer(m.unlike, status);
    const { container } = render(<LikesLive received={[]} sent={[like]} next={next} />);
    fireEvent.click(screen.getByRole("tab", { name: "いいねした" }));
    fireEvent.click(screen.getByText("取り消す"));
    await notice("status", refusalText(status));
    await expectNoViolations(container);
  });
  it("match and both empty lists", async () => {
    m.like.mockResolvedValue({ status: "ok", conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    const { container } = render(<LikesLive received={[like]} sent={[]} next={next} />);
    fireEvent.click(screen.getByText("いいねを返す"));
    await notice("status", "マッチしました。トークで話せます。");
    await expectNoViolations(container);
    fireEvent.click(screen.getByRole("tab", { name: "いいねした" }));
    await expectNoViolations(container);
  });
});

describe("like-controls-live", () => {
  it.each(refusals)("like %s", async status => {
    answer(m.like, status);
    const { container } = render(<main><h1>Profile</h1><LikeControlsLive id="person" name="葵" /></main>);
    fireEvent.click(screen.getByRole("button", { name: "葵にいいね" }));
    await notice("status", refusalText(status));
    await expectNoViolations(container);
  });
  it.each([
    ["liked", { iLiked: true, likedMe: false, conversationId: null }],
    ["liked me", { iLiked: false, likedMe: true, conversationId: null }],
    ["matched", { iLiked: false, likedMe: false, conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }],
  ] as const)("state %s", async (_name, initial) => {
    const { container } = render(<main><h1>Profile</h1><LikeControlsLive id="person" name="葵" initial={initial} /></main>);
    await expectNoViolations(container);
  });
});

describe("profile-edit-live", () => {
  it.each(["ok", "invalid", "unauthenticated", "unavailable"] as const)("save %s", async status => {
    m.saveProfile.mockResolvedValue({ status });
    const { container } = render(<ProfileEditLive initial={{ bio: "", purposes: [] }} />);
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    await notice("status", { ok: "保存しました。", invalid: "入力内容を確認してください。", unauthenticated: "ログインし直してください。", unavailable: "現在保存できません。" }[status]);
    await expectNoViolations(container);
  });
});

describe("safety-controls-live", () => {
  const safetyMessages = {
    validation: "入力内容を確認してください。", not_available: "この操作は利用できません。", rate_limited: "しばらくしてから再度お試しください。",
    unauthenticated: "ログインし直してください。", unavailable: "現在ご利用いただけません。時間をおいて再度お試しください。",
  };
  const statuses = Object.keys(safetyMessages) as (keyof typeof safetyMessages)[];
  it.each(statuses)("profile report %s", async status => {
    m.safety.mockResolvedValue({ status });
    const { container } = render(<main><SafetyControlsLive kind="profile" id="person" /></main>);
    fireEvent.click(screen.getByText("通報"));
    fireEvent.click(screen.getByText("通報する"));
    expect(within(await notice("status", safetyMessages[status]).then(e => e.closest("[role=dialog]") as HTMLElement)).getByText("通報の理由")).toBeInTheDocument();
    await expectNoViolations(container);
  });
  it.each(statuses)("profile block %s", async status => {
    m.safety.mockResolvedValue({ status });
    const { container } = render(<main><SafetyControlsLive kind="profile" id="person" name="葵" block /></main>);
    fireEvent.click(screen.getByText("ブロック"));
    fireEvent.click(screen.getByText("ブロックする"));
    await notice("status", safetyMessages[status]);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await expectNoViolations(container);
  });
  it("conversation block thrown failure", async () => {
    m.safety.mockRejectedValue(Error("private"));
    const { container } = render(<main><SafetyControlsLive kind="conversation" id="conversation" name="葵" block /></main>);
    fireEvent.click(screen.getByText("ブロック・通報"));
    fireEvent.click(screen.getByText("ブロック"));
    fireEvent.click(screen.getByText("ブロックする"));
    await notice("status", safetyMessages.unavailable);
    await expectNoViolations(container);
  });
});

describe("chat-room-live", () => {
  const conversation = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", partner: { name: "Partner", photoId: null }, latest: null, unread: false };
  const message = (id: number, mine = false) => ({ id, mine, body: `body ${id}`, createdAt: "2026-01-01T12:34:00Z", hidden: false });
  const view = (hasOlder = false) => render(<ChatRoomLive conversation={conversation} messages={[message(2)]} hasOlder={hasOlder} />);
  function sendHello() {
    fireEvent.change(screen.getByLabelText("メッセージ"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
  }
  it.each([
    ["unavailable", "メッセージを送信できません。"], ["invalid_state", "メッセージを送信できません。"], ["validation", "メッセージを送信できません。"],
    ["unauthenticated", "メッセージを送信できません。"], ["rate_limited", "しばらくしてから再度お試しください。"], ["thrown", "メッセージを送信できません。"],
  ])("send %s", async (status, text) => {
    if (status === "thrown") m.chatSend.mockRejectedValue(Error("private")); else m.chatSend.mockResolvedValue({ status });
    const { container } = view();
    sendHello();
    await notice("status", text);
    await expectNoViolations(container);
  });
  it.each(["unavailable", "invalid_state", "unauthenticated", "thrown"])("latest %s", async status => {
    if (status === "thrown") m.latest.mockRejectedValue(Error("private")); else m.latest.mockResolvedValue({ status });
    const { container } = view();
    fireEvent.click(screen.getByRole("button", { name: "新しいメッセージを確認" }));
    await notice("status", "メッセージを表示できません。");
    await expectNoViolations(container);
  });
  it.each(["unavailable", "invalid_state", "thrown"])("older %s", async status => {
    if (status === "thrown") m.older.mockRejectedValue(Error("private")); else m.older.mockResolvedValue({ status });
    const { container } = view(true);
    fireEvent.click(screen.getByRole("button", { name: "以前のメッセージ" }));
    await notice("status", "以前のメッセージを表示できません。");
    await expectNoViolations(container);
  });
  it.each(["latest", "send"])("not_available from %s shows the uniform missing view", async source => {
    m.latest.mockResolvedValue({ status: "not_available" }); m.chatSend.mockResolvedValue({ status: "not_available" });
    const { container } = view();
    if (source === "send") sendHello(); else fireEvent.click(screen.getByRole("button", { name: "新しいメッセージを確認" }));
    expect(await screen.findByRole("heading", { level: 1, name: "この会話は表示できません" })).toBeInTheDocument();
    expect(screen.queryByRole("log")).toBeNull();
    await expectNoViolations(container);
  });
});

describe("verification-live", () => {
  const base: VerificationState = { status: "ok", account: { has_profile: true, age_verified: false, affiliation_status: "unconfirmed", affiliation_confirmed: false }, age: null, enrollment: null };
  const row = { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", kind: "age" as const, status: "submitted" as const, created_at: null, decided_at: null, decision_reason: null, valid_until: null };
  const errors: Record<string, string> = {
    invalid: "架空のサンプル資料を1〜3点選んでください。", invalid_state: "状態が変わりました。画面を確認してください。",
    unauthenticated: "ログインの有効期限が切れました。", unavailable: "現在保存できません。時間をおいて再度お試しください。",
  };
  it.each(Object.keys(errors))("submit %s", async status => {
    m.submit.mockResolvedValue({ status });
    const { container } = render(<VerificationLive state={base} />);
    fireEvent.click(within(screen.getByRole("region", { name: "年齢確認" })).getByRole("button", { name: "提出" }));
    await notice("alert", errors[status]);
    if (status === "unauthenticated") expect(screen.getByRole("link", { name: "ログイン" })).toHaveAttribute("href", "/login?next=/verification");
    await expectNoViolations(container);
  });
  it.each(["invalid_state", "unavailable", "thrown"])("withdraw %s", async status => {
    if (status === "thrown") m.withdraw.mockRejectedValue(Error("private")); else m.withdraw.mockResolvedValue({ status });
    const { container } = render(<VerificationLive state={{ ...base, age: row }} />);
    fireEvent.click(within(screen.getByRole("region", { name: "年齢確認" })).getByRole("button", { name: "取り下げ" }));
    await notice("alert", errors[status === "thrown" ? "unavailable" : status]);
    await expectNoViolations(container);
  });
});

describe("onboarding (backend mode)", () => {
  const master = [{ id: "00000000-0000-4000-8000-000000000001", name: "架空の対象校", departments: [{ id: "00000000-0000-4000-8000-000000000002", name: "架空の対象学科", classes: [{ id: "00000000-0000-4000-8000-000000000003", name: "架空の対象クラス" }] }] }];
  const initialPhotos = ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
  async function confirm() {
    const user = userEvent.setup({ delay: null });
    const view = render(<Onboarding backend={{ master }} />);
    await user.type(screen.getByLabelText("表示名"), "架空の名前");
    await user.click(screen.getByLabelText("女性"));
    fireEvent.change(screen.getByLabelText("生年月日"), { target: { value: "2000-02-29" } });
    await user.click(screen.getByLabelText("18歳以上です"));
    await user.click(screen.getByRole("button", { name: "次へ" }));
    await user.selectOptions(screen.getByLabelText("学校"), master[0].id);
    await user.selectOptions(screen.getByLabelText("学科"), master[0].departments[0].id);
    await user.selectOptions(screen.getByLabelText("クラス"), master[0].departments[0].classes[0].id);
    await user.click(screen.getByRole("button", { name: "次へ" }));
    await user.click(screen.getByRole("button", { name: "次へ" }));
    await user.click(screen.getByLabelText("友達がほしい"));
    await user.click(screen.getByRole("button", { name: "確認へ" }));
    await user.click(screen.getByRole("button", { name: "プロフィールを保存" }));
    return view;
  }
  it.each([
    [{ status: "invalid" }, "入力内容を確認してください。"],
    [{ status: "birth_locked" }, "年齢確認後は生年月日を変更できません。"],
    [{ status: "unauthenticated" }, "ログインの有効期限が切れました。"],
    [{ status: "unavailable" }, "現在保存できません。時間をおいて再度お試しください。"],
    ["thrown", "現在保存できません。時間をおいて再度お試しください。"],
  ] as const)("failed save %j", async (result, text) => {
    if (result === "thrown") m.save.mockRejectedValue(Error("private")); else m.save.mockResolvedValue(result);
    const { container } = await confirm();
    await notice("alert", text);
    expect(screen.getByRole("heading", { level: 1, name: "入力内容の確認" })).toBeInTheDocument();
    if (result !== "thrown" && result.status === "unauthenticated") expect(screen.getByRole("link", { name: "ログインへ" })).toHaveAttribute("href", "/login?next=/onboarding");
    await expectNoViolations(container);
  });
  it.each([
    ["needs_photo", "写真を1枚以上登録してください。"], ["needs_details", "入力内容を確認してください。"],
    ["unauthenticated", "ログインの有効期限が切れました。"], ["unavailable", "現在保存できません。時間をおいて再度お試しください。"],
  ])("failed completion %s", async (status, text) => {
    m.complete.mockResolvedValue({ status });
    const { container } = render(<Onboarding backend={{ master, initialPhotos }} />);
    await userEvent.setup({ delay: null }).click(screen.getByRole("button", { name: "プロフィールを完成" }));
    await notice("alert", text);
    if (status === "needs_details") expect(within(await notice("alert", text)).getByRole("link", { name: "入力内容を修正する" })).toHaveAttribute("href", "/onboarding?edit=1");
    if (status === "unauthenticated") expect(screen.getByRole("link", { name: "ログインへ" })).toHaveAttribute("href", "/login?next=/onboarding");
    await expectNoViolations(container);
  });
});

describe("photo-manager", () => {
  const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const photoMessages: Record<string, string> = {
    invalid: "JPEG、PNG、WebPの画像を選んでください。", too_large: "4MB以下の画像を選んでください。", too_many: "写真は6枚までです。",
    rate_limited: "しばらくしてから再度お試しください。", last_photo: "最後の1枚は削除できません。",
    unauthenticated: "ログインの有効期限が切れました。", unavailable: "現在保存できません。時間をおいて再度お試しください。",
  };
  const add = () => userEvent.setup({ delay: null, applyAccept: false }).upload(screen.getByLabelText("写真を追加"), new File(["synthetic"], "synthetic.webp", { type: "image/webp" }));
  it.each(["invalid", "too_large", "too_many", "rate_limited", "unauthenticated", "unavailable"])("upload answered %s", async status => {
    m.upload.mockResolvedValue({ status });
    const { container } = render(<main><PhotoManager initial={[a]} /></main>);
    await add();
    await notice("alert", photoMessages[status]);
    if (status === "unauthenticated") expect(screen.getByRole("link", { name: "ログインへ" })).toHaveAttribute("href", "/login?next=/onboarding");
    await expectNoViolations(container);
  });
  it("refresh after upload returns null", async () => {
    m.upload.mockResolvedValue({ status: "ok" }); m.refreshPhotos.mockResolvedValue(null);
    const { container } = render(<main><PhotoManager initial={[a]} /></main>);
    await add();
    await notice("alert", photoMessages.unavailable);
    expect(screen.getByRole("button", { name: "写真を再読み込み" })).toBeInTheDocument();
    await expectNoViolations(container);
  });
  it.each(["last_photo", "invalid", "unauthenticated", "unavailable"])("remove %s", async status => {
    m.removePhoto.mockResolvedValue({ status });
    const { container } = render(<main><PhotoManager initial={[a, b]} /></main>);
    fireEvent.click(screen.getAllByRole("button", { name: "削除" })[0]);
    await notice("alert", photoMessages[status]);
    await expectNoViolations(container);
  });
  it.each(["invalid", "unauthenticated", "unavailable", "thrown"])("reorder %s", async status => {
    if (status === "thrown") m.reorderPhotos.mockRejectedValue(Error("private")); else m.reorderPhotos.mockResolvedValue({ status });
    const { container } = render(<main><PhotoManager initial={[a, b]} /></main>);
    fireEvent.click(screen.getAllByRole("button", { name: "後へ" })[0]);
    await notice("alert", photoMessages[status === "thrown" ? "unavailable" : status]);
    await expectNoViolations(container);
  });
});

describe("privacy-settings-live", () => {
  const settings = { hideSameClass: true, hideSameDepartment: false, hideSameSchool: false, showDepartment: false, showClass: false, hiddenSchoolIds: [], hiddenDepartmentIds: [], hiddenClassIds: [] };
  it.each([
    ["invalid", "設定を保存できませんでした。選択内容を確認してください。"], ["rate_limited", "しばらくしてから再度お試しください。"],
    ["unauthenticated", "ログインし直してください。"], ["forbidden", "保存できませんでした。時間をおいてもう一度お試しください。"],
    ["unavailable", "保存できませんでした。時間をおいてもう一度お試しください。"], ["thrown", "保存できませんでした。時間をおいてもう一度お試しください。"],
  ])("save %s", async (status, text) => {
    if (status === "thrown") m.privacy.mockRejectedValue(Error("private")); else m.privacy.mockResolvedValue({ status });
    const { container } = render(<PrivacySettingsLive initialSettings={settings} targets={[{ id: "school", kind: "school", label: "School" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    await notice("alert", text);
    await expectNoViolations(container);
  });
});

describe("account-settings", () => {
  const failures = Object.keys(actionMessages) as (keyof typeof actionMessages)[];
  it.each(failures.filter(s => s !== "invalid"))("pause %s", async status => {
    m.pause.mockResolvedValue({ status });
    const { container } = render(<AccountSettingsLive accountStatus="active" />);
    fireEvent.click(screen.getByRole("button", { name: "休止する" }));
    await notice("status", actionMessages[status]);
    await expectNoViolations(container);
  });
  it("resume thrown failure", async () => {
    m.resume.mockRejectedValue(Error("private"));
    const { container } = render(<AccountSettingsLive accountStatus="deactivated" />);
    fireEvent.click(screen.getByRole("button", { name: "再開する" }));
    await notice("status", actionMessages.unavailable);
    await expectNoViolations(container);
  });
  it.each(failures)("delete %s inside the dialog", async status => {
    m.remove.mockResolvedValue({ status });
    const { container } = render(<AccountSettingsLive accountStatus="active" />);
    fireEvent.click(screen.getByRole("button", { name: "退会の手続きへ" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: DELETE_CONFIRMATION } });
    fireEvent.click(screen.getByRole("button", { name: "退会する" }));
    const live = await notice("status", actionMessages[status]);
    expect(live.closest("[role=dialog]")).not.toBeNull();
    await expectNoViolations(container);
  });
});

describe("admin live components", () => {
  const generic = "現在操作できません。時間をおいて再度お試しください。";
  it.each([
    ["invalid_state", "状態が変わったため解除できませんでした。"], ["forbidden", "この操作の権限がありません。"],
    ["invalid", "入力内容を確認してください。"], ["unauthenticated", "再度ログインしてください。"], ["unavailable", generic],
  ])("admin-accounts-live reactivate %s", async (status, text) => {
    m.reactivateAccount.mockResolvedValue({ status });
    const row: SuspendedRow = { userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", shortId: "#aaaaaaaa", name: "架空一", suspendedAt: null, reason: "harassment" };
    const { container } = render(<AdminAccountsLive rows={[row]} />);
    fireEvent.click(screen.getByRole("button", { name: "停止を解除" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "解除する" }));
    await notice("status", text);
    await expectNoViolations(container);
  });

  const staff: StaffRow[] = [
    { handle: "a".repeat(64), label: "担当 #aaaaaaaa", name: "管理担当", roles: ["admin"], acting: [true], isMe: true },
    { handle: "b".repeat(64), label: "担当 #bbbbbbbb", name: null, roles: ["moderator"], acting: [true], isMe: false },
  ];
  it.each([
    ["not_found", "該当するアカウントがありません。"], ["invalid_state", "すでにその役割があります。"],
    ["mfa_required", "二段階認証（TOTP）を登録済みのアカウントにだけ役割を付けられます。"], ["forbidden", "この操作の権限がありません。"],
    ["invalid", "入力内容を確認してください。"], ["unauthenticated", "再度ログインしてください。"], ["unavailable", generic],
  ])("admin-staff-live grant %s", async (status, text) => {
    m.grant.mockResolvedValue({ status });
    const { container } = render(<AdminStaffLive rows={staff} />);
    fireEvent.change(screen.getByLabelText("メールアドレス"), { target: { value: "staff@example.invalid" } });
    fireEvent.click(screen.getByRole("button", { name: "付与する" }));
    expect((await screen.findByText(text)).closest("[role=status],[role=alert]")).not.toBeNull();
    await expectNoViolations(container);
  });
  it.each([
    ["invalid_state", "状態が変わったか、最後の管理者のため外せません。"], ["forbidden", "この操作の権限がありません。"],
    ["invalid", "入力内容を確認してください。"], ["unauthenticated", "再度ログインしてください。"], ["unavailable", generic],
  ])("admin-staff-live revoke %s", async (status, text) => {
    m.revoke.mockResolvedValue({ status });
    const { container } = render(<AdminStaffLive rows={staff} />);
    fireEvent.click(screen.getByRole("button", { name: "通報対応を外す" }));
    fireEvent.click(screen.getByRole("button", { name: "外す" }));
    expect((await screen.findByText(text)).closest("[role=status],[role=alert]")).not.toBeNull();
    await expectNoViolations(container);
  });

  const report: ReportDetail = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", targetLabel: "対象 #12345678", context: "profile", reason: "spam", status: "open", createdAt: "2026-11-07T00:00:00Z", detail: null, evidence: { body: "evidence", createdAt: "2026-11-07T00:00:00Z" } };
  it.each([
    ["invalid_state", "状態が変わったため操作できません。"], ["invalid", "メモは1000文字以内で入力してください。"],
    ["forbidden", "この操作の権限がありません。"], ["unauthenticated", "再度ログインしてください。"], ["unavailable", generic],
  ])("admin-report-detail-live update %s", async (status, text) => {
    m.updateReport.mockResolvedValue({ status });
    const { container } = render(<AdminReportDetailLive report={report} />);
    fireEvent.click(screen.getByRole("button", { name: "確認中にする" }));
    expect((await screen.findByText(text)).closest("[role=status],[role=alert]")).not.toBeNull();
    await expectNoViolations(container);
  });
  it.each([["invalid_state", "この利用者は停止できません。"], ["forbidden", "この操作の権限がありません。"]])("admin-report-detail-live suspend %s", async (status, text) => {
    m.suspend.mockResolvedValue({ status });
    const { container } = render(<AdminReportDetailLive report={report} />);
    fireEvent.click(screen.getByRole("button", { name: "アカウントを停止" }));
    fireEvent.click(screen.getByRole("button", { name: "停止する" }));
    expect((await screen.findByText(text)).closest("[role=status],[role=alert]")).not.toBeNull();
    await expectNoViolations(container);
  });
  it.each([["invalid_state", "この利用者は停止されていません。"], ["forbidden", "この操作の権限がありません。"], ["unavailable", generic]])("admin-report-detail-live reactivate %s", async (status, text) => {
    m.reactivateReport.mockResolvedValue({ status });
    const { container } = render(<AdminReportDetailLive report={report} />);
    fireEvent.click(screen.getByRole("button", { name: "停止を解除" }));
    fireEvent.click(screen.getByRole("button", { name: "再開する" }));
    expect((await screen.findByText(text)).closest("[role=status],[role=alert]")).not.toBeNull();
    await expectNoViolations(container);
  });

  const affiliations: Affiliation[] = [{ id: "school", level: "school", parentId: null, name: "学校A", isActive: true, sortOrder: 2, academicYear: null }];
  it.each([
    ["invalid", "名前は1〜"], ["duplicate", "同じ階層に同名の項目があります。"], ["not_found", "項目が見つかりません。"],
    ["forbidden", "この操作の権限がありません。"], ["unauthenticated", "保存できませんでした。"], ["unavailable", "保存できませんでした。"],
  ])("admin-affiliations-live save %s", async (status, text) => {
    m.saveAffiliation.mockResolvedValue({ status });
    const user = userEvent.setup({ delay: null });
    const { container } = render(<AdminAffiliationsLive rows={affiliations} />);
    await user.click(screen.getByRole("button", { name: "学校Aを編集" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    await notice("alert", text);
    await expectNoViolations(container);
  });
  it("admin-affiliations-live toggle forbidden", async () => {
    m.toggleAffiliation.mockResolvedValue({ status: "forbidden" });
    const { container } = render(<AdminAffiliationsLive rows={affiliations} />);
    fireEvent.click(screen.getByRole("switch", { name: "学校Aの有効状態" }));
    await notice("alert", "この操作の権限がありません。");
    await expectNoViolations(container);
  });

  const submission: SubmissionDetail = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "age", status: "in_review", version: 7, created_at: "2026-11-05T15:30:00Z", documentCount: 1, birth_date: "2000-01-02" };
  it.each([
    ["invalid", "入力内容を確認してください。"], ["invalid_state", "状態が変わりました。一覧から開き直してください。"], ["forbidden", "この操作はできません。"],
    ["unauthenticated", "ログインの有効期限が切れました。"], ["unavailable", "現在保存できません。時間をおいて再度お試しください。"],
  ])("admin-verification-detail decide %s", async (status, text) => {
    m.decide.mockResolvedValue({ status });
    const { container } = render(<AdminVerificationDetail submission={submission} />);
    fireEvent.click(screen.getByRole("button", { name: "承認" }));
    await notice("alert", text);
    await expectNoViolations(container);
  });

  it.each([
    ["invalid_code", "コードが正しくありません。もう一度入力してください。"], ["rate_limited", "試行回数が上限に達しました。しばらくしてからお試しください。"],
    ["unauthenticated", "ログインの有効期限が切れました。"], ["unavailable", "現在確認できません。時間をおいて再度お試しください。"],
  ])("admin-mfa verify %s", async (status, text) => {
    m.verify.mockResolvedValue({ status });
    const { container } = render(<AdminMfa mode="challenge" next="/admin" />);
    const input = screen.getByLabelText("6桁のコード");
    fireEvent.change(input, { target: { value: "012345" } });
    fireEvent.submit(input.closest("form")!);
    await notice("alert", text);
    if (status === "unauthenticated") expect(screen.getByRole("link", { name: "ログイン" })).toHaveAttribute("href", "/login?next=/admin/mfa");
    await expectNoViolations(container);
  });
  it.each([["unavailable", "現在確認できません。時間をおいて再度お試しください。"], ["unauthenticated", "ログインの有効期限が切れました。"]])("admin-mfa enroll %s", async (status, text) => {
    m.enroll.mockResolvedValue({ status });
    const { container } = render(<AdminMfa mode="enroll" next="/admin" />);
    await userEvent.setup({ delay: null }).click(screen.getByRole("button", { name: "認証アプリを設定する" }));
    await notice("alert", text);
    await expectNoViolations(container);
  });
});
