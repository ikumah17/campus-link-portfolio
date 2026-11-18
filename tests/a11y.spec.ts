import { expect, test, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";

// Read the canonical inventory without importing a spec (which registers its tests).
// Resolve literal constants too; unfamiliar entries fail instead of silently losing coverage.
const inventory = readFileSync(new URL("./routes-audit.spec.ts", import.meta.url), "utf8");
const routeBlock = inventory.match(/export const routes = \[([\s\S]*?)\];/)?.[1];
if (!routeBlock) throw new Error("Missing route inventory");
const allRoutes = routeBlock.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
  if (/^"\/[^"\n]*"$/.test(entry)) return JSON.parse(entry) as string;
  if (/^[a-zA-Z]+$/.test(entry)) {
    const value = inventory.match(new RegExp(`const ${entry} = "([^"\\n]+)";`))?.[1];
    if (value) return value;
  }
  throw new Error(`Unsupported route inventory entry: ${entry}`);
});
// /auth/confirmed needs a real confirmation session and answers 404 in the demo (SEC-005).
const unavailableInDemo = new Set([
  "/admin/mfa", "/admin/staff", "/admin/accounts", "/auth/confirmed",
  "/admin/verifications/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "/admin/reports/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
]);
const routes = allRoutes.filter((route) => !unavailableInDemo.has(route));
async function audit(page: Page, info: TestInfo, state: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const violations = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  await info.attach(state, { body: JSON.stringify({ url: page.url(), violations: results.violations }, null, 2), contentType: "application/json" });
  expect(violations.map((v) => ({ rule: v.id, count: v.nodes.length, nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })) }))).toEqual([]);
}
for (const width of [390, 768, 1280]) {
  for (const route of routes) {
    test(`axe ${route} at ${width}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      expect((await page.goto(route))?.status()).toBe(200);
      await expect(page.locator("h1")).toBeVisible();
      await audit(page, info, "route");
    });
  }
  test(`axe open states at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/search");
    await expect(page.getByRole("heading", { name: "検索条件" })).toBeVisible();
    await audit(page, info, "search-conditions");
    await page.goto("/talk/demo-4");
    await expect(page.getByRole("textbox")).toBeVisible();
    await page.getByRole("textbox").fill("アクセシビリティ検査");
    await audit(page, info, "chat-composer");
    await page.getByRole("button", { name: "ブロック・通報" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "ブロック", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("button", { name: "ブロックする" })).toBeVisible();
    await audit(page, info, "confirmation-dialog");
  });
}
// TEST-010: empty, error, feedback and opened states the demo can render, at the A11Y-002 widths.
for (const width of [390, 1280]) {
  test(`axe like and talk states at ${width}`, async ({ page }, info) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/profiles/demo-1");
    await audit(page, info, "like-detail-none");
    await page.getByRole("button", { name: "あおいにいいね" }).click();
    await expect(page.getByRole("status")).toHaveText("いいねしました。");
    await audit(page, info, "like-detail-liked");
    await page.getByRole("navigation").getByRole("link", { name: "いいね", exact: true }).click();
    await expect(page.getByRole("tabpanel")).toContainText("はると");
    await audit(page, info, "likes-received");
    await page.getByRole("tab", { name: "いいねした" }).click();
    await expect(page.getByRole("tabpanel")).toContainText("あおい");
    await audit(page, info, "likes-sent");
    await page.getByRole("button", { name: "あおいへのいいねを取り消す" }).click();
    await expect(page.getByText("まだいいねしていません。")).toBeVisible();
    await audit(page, info, "likes-sent-empty");
    await page.getByRole("tab", { name: "いいねされた" }).click();
    await page.getByRole("button", { name: "はるとにいいねを返す" }).click();
    await expect(page.getByRole("status")).toHaveText("マッチしました。トークで話せます。");
    await expect(page.getByText("まだいいねはありません。")).toBeVisible();
    await audit(page, info, "likes-matched-empty");
    await page.getByRole("link", { name: "トークを開く" }).click();
    await expect(page.getByRole("log")).toContainText("まだメッセージはありません。");
    await audit(page, info, "talk-room-empty");
    await page.getByRole("link", { name: "トーク一覧へ戻る" }).click();
    await expect(page).toHaveURL(/\/talk$/);
    await audit(page, info, "talk-list-new-room");
    // A matched person leaves Discover; the matched detail state is checked in tests/a11y-live-errors.test.tsx.
    await page.getByRole("link", { name: "探す" }).click();
    await expect(page.getByRole("article", { name: /はると/ })).toHaveCount(0);
    await page.goto("/profiles/demo-2");
    await expect(page.getByText("あなたにいいねしています")).toBeVisible();
    await audit(page, info, "like-detail-liked-me");
    await page.goto("/mypage/profile");
    await page.getByRole("button", { name: "保存する" }).click();
    await expect(page.getByRole("status")).toContainText("保存しました");
    await audit(page, info, "profile-edit-saved");
    await page.goto("/talk/unknown");
    await expect(page.getByRole("heading", { name: "この会話は表示できません" })).toBeVisible();
    await audit(page, info, "talk-room-unavailable");
  });
  test(`axe search, sign-in and verification states at ${width}`, async ({ page }, info) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/?min=120");
    await expect(page.getByText("条件に合うプロフィールはありません")).toBeVisible();
    await audit(page, info, "search-no-results");
    await page.goto("/search?min=25&max=30&g=female");
    await page.getByLabel("上限年齢").fill("20");
    await page.getByRole("button", { name: "この条件で探す" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toHaveText("下限は上限以下にしてください。");
    await audit(page, info, "search-form-error");
    await page.goto("/login");
    await page.getByLabel("メールアドレス").fill("fictional-test010@example.invalid");
    await page.getByLabel("パスワード", { exact: true }).fill("demo-only-password");
    await page.getByRole("button", { name: "ログインを試す" }).click();
    await expect(page.getByRole("status")).toHaveText("デモのためログインは行われません");
    await audit(page, info, "login-feedback");
    await page.goto("/verification");
    const card = page.getByRole("region", { name: "年齢確認" });
    await card.getByRole("button", { name: "架空のサンプル資料1" }).click();
    await card.getByRole("button", { name: "提出（デモ）" }).click();
    await expect(page.getByRole("status")).toHaveText("年齢確認を提出しました（デモ）。");
    await audit(page, info, "verification-submitted");
  });
  test(`axe admin detail states at ${width}`, async ({ page }, info) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/verifications");
    await page.getByRole("tabpanel").getByRole("button").first().click();
    await expect(page.getByRole("heading", { name: "提出の詳細" })).toBeVisible();
    await audit(page, info, "admin-verification-detail");
    await page.getByRole("button", { name: "担当する" }).click();
    await expect(page.getByRole("status")).toHaveText("担当しました（デモ）。");
    await page.getByRole("button", { name: "却下", exact: true }).click();
    await expect(page.getByLabel("却下理由（1〜200文字）")).toHaveAttribute("aria-invalid", "true");
    await audit(page, info, "admin-verification-rejection-error");
    await page.goto("/admin/reports");
    await page.getByRole("button", { name: /プロフィール/ }).click();
    await expect(page.getByText("この通報は担当できません")).toBeVisible();
    await audit(page, info, "admin-report-detail-unassignable");
    await page.getByRole("button", { name: /メッセージ/ }).click();
    await expect(page.getByRole("blockquote")).toContainText("架空のメッセージ");
    await audit(page, info, "admin-report-detail");
    await page.goto("/admin/affiliations");
    await page.getByRole("region", { name: "デモ学科A1（架空）", exact: true }).getByRole("button", { name: "クラスを追加" }).click();
    await expect(page.getByRole("textbox", { name: "名前" })).toBeVisible();
    await audit(page, info, "admin-affiliations-add-form");
  });
}
// TEST-011: every onboarding step the demo renders, and each step's client validation error.
async function toPhotoStep(page: Page) {
  await page.getByLabel("表示名", { exact: true }).fill("架空のデモ");
  await page.getByLabel("女性", { exact: true }).check();
  await page.getByLabel("生年月日", { exact: true }).fill("2000-02-29");
  await page.getByLabel("18歳以上です", { exact: true }).check();
  await page.getByRole("button", { name: "次へ", exact: true }).click();
  await page.getByLabel("学校", { exact: true }).selectOption({ index: 1 });
  await page.getByLabel("学科", { exact: true }).selectOption({ index: 1 });
  await page.getByLabel("クラス", { exact: true }).selectOption({ index: 1 });
  await page.getByRole("button", { name: "次へ", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "写真" })).toBeVisible();
}
for (const width of [390, 1280]) {
  // The photo buttons' names start with their visible text (label-content-name-mismatch, UI-013).
  test(`axe onboarding photo step and its error at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/onboarding");
    await toPhotoStep(page);
    await expect(page.getByRole("button", { name: "選択する（写真1）", exact: true })).toBeVisible();
    await audit(page, info, "onboarding-photos");
    await page.getByRole("button", { name: "次へ", exact: true }).click();
    await expect(page.getByRole("button", { name: /（写真1）$/ })).toHaveAttribute("aria-invalid", "true");
    await audit(page, info, "onboarding-photos-error");
  });
  test(`axe onboarding steps and validation errors at ${width}`, async ({ page }, info) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/onboarding");
    const next = page.getByRole("button", { name: "次へ", exact: true });
    await next.click();
    for (const label of ["表示名", "生年月日", "18歳以上です"]) await expect(page.getByLabel(label, { exact: true })).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("性別を選んでください。")).toBeVisible();
    await audit(page, info, "onboarding-basic-required-errors");
    const underage = new Date();
    underage.setFullYear(underage.getFullYear() - 10);
    await page.getByLabel("表示名", { exact: true }).fill("架空のデモ");
    await page.getByLabel("女性", { exact: true }).check();
    await page.getByLabel("生年月日", { exact: true }).fill(underage.toISOString().slice(0, 10));
    await page.getByLabel("18歳以上です", { exact: true }).check();
    await next.click();
    await expect(page.getByLabel("生年月日", { exact: true })).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel("表示名", { exact: true })).toHaveAttribute("aria-invalid", "false");
    await audit(page, info, "onboarding-basic-underage-error");
    await page.getByLabel("生年月日", { exact: true }).fill("2000-02-29");
    await next.click();
    await expect(page.getByRole("heading", { level: 1, name: "所属" })).toBeVisible();
    await audit(page, info, "onboarding-affiliation");
    await next.click();
    await expect(page.getByLabel("学校", { exact: true })).toHaveAttribute("aria-invalid", "true");
    await audit(page, info, "onboarding-affiliation-error");
    await page.getByLabel("学校", { exact: true }).selectOption({ index: 1 });
    await page.getByLabel("学科", { exact: true }).selectOption({ index: 1 });
    await page.getByLabel("クラス", { exact: true }).selectOption({ index: 1 });
    await next.click();
    await expect(page.getByRole("heading", { level: 1, name: "写真" })).toBeVisible();
    await next.click();
    await expect(page.getByRole("button", { name: /（写真1）$/ })).toHaveAttribute("aria-invalid", "true");
    await page.getByRole("button", { name: /（写真1）$/ }).click();
    await next.click();
    await expect(page.getByRole("heading", { level: 1, name: "目的と自己紹介" })).toBeVisible();
    await audit(page, info, "onboarding-purposes");
    const confirm = page.getByRole("button", { name: "確認へ", exact: true });
    await page.getByLabel("友達がほしい").check();
    const bio = page.getByLabel("自己紹介（任意）");
    await bio.fill("あ".repeat(501));
    await confirm.click();
    await expect(bio).toHaveAttribute("aria-invalid", "true");
    await audit(page, info, "onboarding-bio-length-error");
    await bio.fill("架空の自己紹介です。");
    await confirm.click();
    await expect(page.getByRole("heading", { level: 1, name: "入力内容の確認" })).toBeVisible();
    await audit(page, info, "onboarding-confirmation");
    await page.getByRole("button", { name: "デモのプロフィールを作成" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "デモの完了" })).toBeVisible();
    await audit(page, info, "onboarding-demo-complete");
  });
}
