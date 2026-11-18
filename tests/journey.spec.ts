import { expect, test } from "@playwright/test";

test("connected fictional demo journey without external I/O or persistence", async ({ page, context }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const external: string[] = [], writes: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== "http://127.0.0.1:3100") external.push(request.url());
  });
  // Cross-document write recorder, following verification.spec.ts, so the explicit
  // demo navigation gap below cannot discard earlier write attempts.
  await context.exposeBinding("recordJourneyWrite", (_source, value: string) => { writes.push(value); });
  await context.addInitScript(() => {
    const record = (name: string) => { void (window as unknown as { recordJourneyWrite: (name: string) => Promise<void> }).recordJourneyWrite(name); };
    for (const method of ["setItem", "removeItem", "clear"] as const) {
      const original = Storage.prototype[method];
      Storage.prototype[method] = function (...args: string[]) { record(`storage.${method}`); return Reflect.apply(original, this, args); };
    }
    const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!;
    Object.defineProperty(Document.prototype, "cookie", { ...cookie, set(value) { record("cookie"); cookie.set!.call(this, value); } });
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args) { record("indexedDB"); return Reflect.apply(open, this, args); };
  });
  await page.goto("/welcome");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("学生生活に、");
  await page.getByRole("link", { name: "新規登録", exact: true }).click();
  await expect(page.getByRole("heading", { name: "新規登録", exact: true })).toBeVisible();
  await page.getByLabel("メールアドレス").fill("qa-fictional@example.invalid");
  await page.getByLabel("パスワード", { exact: true }).fill("fictional-demo-password");
  await page.getByRole("button", { name: "入力デモを始める" }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByLabel("表示名").fill("架空のQA");
  await page.getByLabel("女性", { exact: true }).check();
  await page.getByLabel("生年月日").fill("2000-02-29");
  await page.getByLabel("18歳以上です").check();
  await page.getByRole("button", { name: "次へ" }).click();
  for (const name of ["学校", "学科", "クラス"]) await page.getByLabel(name, { exact: true }).selectOption({ index: 1 });
  await page.getByRole("button", { name: "次へ" }).click();
  await page.getByRole("button", { name: /（写真1）$/ }).click();
  await page.getByRole("button", { name: "次へ" }).click();
  await page.getByLabel("友達がほしい").check();
  await page.getByLabel("自己紹介（任意）").fill("架空の自己紹介です。");
  await page.getByRole("button", { name: "確認へ" }).click();
  await expect(page.getByText("友達がほしい", { exact: true })).toBeVisible();
  await expect(page.getByText("2000-02-29", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "デモのプロフィールを作成" }).click();
  await expect(page.getByRole("heading", { name: "デモの完了" })).toBeVisible();
  await page.getByRole("link", { name: "在学・年齢確認へ（デモ）" }).click();
  await expect(page.getByRole("heading", { name: "在学・年齢確認", exact: true })).toBeVisible();
  for (const kind of ["年齢確認", "在学確認"]) {
    const card = page.getByRole("region", { name: kind });
    await card.getByRole("button", { name: "架空のサンプル資料1" }).click();
    await card.getByRole("button", { name: "提出（デモ）" }).click();
    await expect(page.getByRole("status")).toHaveText(`${kind}を提出しました（デモ）。`);
  }
  await page.getByRole("link", { name: "マイページへ戻る" }).click();
  await page.getByRole("navigation").getByRole("link", { name: "探す", exact: true }).click();
  await page.getByRole("link", { name: "検索条件", exact: true }).click();
  await expect(page.getByRole("heading", { name: "検索条件" })).toBeVisible();
  await page.getByLabel("下限年齢").fill("20"); await page.getByLabel("上限年齢").fill("20");
  await page.getByRole("button", { name: "この条件で探す" }).click();
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.getByRole("link", { name: "あおいのプロフィールを見る" }).click();
  await expect(page).toHaveURL(/\/profiles\/demo-1$/);
  await page.getByRole("button", { name: "あおいにいいね" }).click();
  await expect(page.getByRole("status")).toHaveText("いいねしました。");
  await page.getByRole("navigation").getByRole("link", { name: "いいね", exact: true }).click();
  await page.getByRole("button", { name: "はるとにいいねを返す" }).click();
  await expect(page.getByRole("status")).toHaveText("マッチしました。トークで話せます。");
  await page.getByRole("navigation").getByRole("link", { name: "トーク", exact: true }).click();
  await page.getByRole("main").getByRole("link").filter({ hasText: "はると" }).click();
  await expect(page).toHaveURL(/\/talk\/demo-2$/);
  await page.getByLabel("メッセージ", { exact: true }).fill("架空の統合テストメッセージ");
  await page.getByRole("button", { name: "送信", exact: true }).click();
  await expect(page.getByRole("log")).toContainText("架空の統合テストメッセージ");
  await expect(page.getByRole("status")).toContainText("送信しました");
  await page.getByRole("button", { name: "ブロック・通報" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "通報", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "通報する（デモ）" }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toHaveText("通報を受け付けました（デモ）");
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "トーク一覧へ戻る" }).click();
  await page.getByRole("navigation").getByRole("link", { name: "マイページ", exact: true }).click();
  await page.getByRole("link", { name: /公開範囲設定/ }).click();
  await page.getByRole("switch", { name: "同じ学校に表示しない" }).click();
  await page.getByRole("button", { name: "デモ設定を保存" }).click();
  await expect(page.getByRole("status")).toHaveText("デモ設定を保存しました。");
  await page.getByRole("link", { name: "マイページへ戻る" }).click();
  await page.getByRole("link", { name: "管理画面のデモ" }).click();
  await expect(page.getByRole("heading", { name: "管理画面のデモ" })).toBeVisible();
  await page.getByRole("link", { name: /^通報/ }).click();
  // Admin demo has a separate seeded report model, not the report just submitted.
  await page.getByRole("button", { name: /メッセージ/ }).click();
  await expect(page.getByRole("blockquote")).toContainText("架空のメッセージ");
  await page.getByRole("button", { name: "確認中にする" }).click();
  await expect(page.getByRole("status")).toContainText("確認中に変更");
  await page.getByRole("button", { name: "対応済みにする" }).click();
  await expect(page.getByRole("status")).toContainText("対応済みに変更");
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  expect(await context.cookies()).toEqual([]); expect(writes).toEqual([]); expect(external).toEqual([]);
});
