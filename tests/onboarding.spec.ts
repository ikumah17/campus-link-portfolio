import { expect, test, type Page, type Locator } from "@playwright/test";

const ORIGIN = "http://127.0.0.1:3100";
const email = "fictional-ui004@example.invalid";
const password = "demo-only-password";
const birth = "2000-02-29";
function recordExternal(page: Page) {
  const external: string[] = [];
  page.on("request", (r) => { if (!r.url().startsWith(ORIGIN)) external.push(r.url()); });
  return external;
}
async function storage(page: Page) {
  return page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie }));
}
async function screenChecks(page: Page) {
  await expect(page.getByRole("note")).toContainText("入力内容は保存されません");
  await expect(page.getByRole("navigation")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  for (const target of await page.locator('main button, main a, main select, main input:not([type="radio"]):not([type="checkbox"]), main textarea, main label:has(input[type="radio"]), main label:has(input[type="checkbox"])').all()) {
    if (!(await target.isVisible())) continue;
    const box = (await target.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(43.5);
    expect(box.width).toBeGreaterThanOrEqual(43.5);
  }
}
// Reach controls solely through Tab, asserting the actual keyboard focus ring.
async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 45; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement)) {
      expect(await target.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");
      return;
    }
  }
  throw new Error(`Keyboard could not reach ${await target.getAttribute("id")}`);
}

for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
  test(`full local flow, no external request or storage at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const external = recordExternal(page);
    const mutations: string[] = [];
    page.on("request", (r) => { if (!["GET", "HEAD"].includes(r.method())) mutations.push(r.url()); });
    await page.goto("/mypage");
    // Wait for the route transition before starting the heading assertion's budget.
    await Promise.all([
      page.waitForURL(`${ORIGIN}/welcome`),
      page.getByRole("link", { name: "登録画面のデモ" }).click(),
    ]);
    await expect(page.getByRole("heading", { name: /学生生活に、/ })).toBeVisible();
    const before = await storage(page);
    await screenChecks(page);
    await page.getByRole("link", { name: "新規登録", exact: true }).click();
    await expect(page.getByRole("heading", { name: "新規登録", exact: true })).toBeVisible(); await screenChecks(page);
    await page.getByLabel("メールアドレス").fill(email); await page.getByLabel("パスワード", { exact: true }).fill(password);
    await page.getByRole("button", { name: "入力デモを始める" }).click();
    await expect(page).toHaveURL(`${ORIGIN}/onboarding`); await screenChecks(page);
    await page.getByLabel("表示名").fill("架空のデモ"); await page.getByLabel("女性", { exact: true }).check(); await page.getByLabel("生年月日").fill(birth); await page.getByLabel("18歳以上です").check();
    await page.getByRole("button", { name: "次へ" }).click(); await screenChecks(page);
    await page.getByLabel("学校", { exact: true }).selectOption({ index: 1 }); await page.getByLabel("学科", { exact: true }).selectOption({ index: 1 }); await page.getByLabel("クラス", { exact: true }).selectOption({ index: 1 });
    await page.getByRole("button", { name: "次へ" }).click(); await screenChecks(page);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    await page.getByRole("button", { name: /（写真3）$/ }).click(); await page.getByRole("button", { name: /（写真1）$/ }).click();
    await expect(page.getByRole("list", { name: "写真の選択順" }).getByRole("listitem").first()).toContainText("写真3（メイン）");
    await page.getByRole("button", { name: "次へ" }).click(); await screenChecks(page);
    await page.getByLabel("友達がほしい").check(); await page.getByLabel("自己紹介（任意）").fill("架空の自己紹介です。");
    await page.getByRole("button", { name: "確認へ" }).click(); await screenChecks(page);
    await expect(page.getByText(birth, { exact: true })).toBeVisible();
    if (process.env.CAMPUS_LINK_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.CAMPUS_LINK_SCREENSHOT_DIR}/confirmation-${viewport.width}.png`, fullPage: true });
    await page.getByRole("button", { name: "デモのプロフィールを作成" }).click(); await screenChecks(page);
    await expect(page.getByText("デモのため保存されていません。在学・年齢確認は今後の工程です。")).toBeVisible();
    expect(await storage(page)).toEqual(before);
    await page.getByRole("link", { name: "架空のプロフィールを見る" }).click(); await expect(page).toHaveURL(`${ORIGIN}/`);
    await page.goto("/onboarding"); await page.reload(); await expect(page.getByLabel("表示名")).toHaveValue(""); await expect(page.getByLabel("生年月日")).toHaveValue("");
    expect(await storage(page)).toEqual(before); expect(external).toEqual([]); expect(mutations).toEqual([]);
  });

  test(`login clears password without authenticating at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport); const external = recordExternal(page);
    await page.goto("/welcome"); const before = await storage(page);
    await page.getByRole("link", { name: "ログイン", exact: true }).click();
    await expect(page.getByRole("heading", { name: "ログイン", exact: true })).toBeVisible(); await screenChecks(page);
    await page.getByRole("button", { name: "ログインを試す" }).click(); await expect(page.getByLabel("メールアドレス")).toBeFocused();
    await page.getByLabel("メールアドレス").fill(email); await page.getByLabel("パスワード", { exact: true }).fill(password);
    await page.getByRole("button", { name: "ログインを試す" }).click();
    await expect(page.getByRole("status")).toHaveText("デモのためログインは行われません"); await expect(page.getByLabel("パスワード", { exact: true })).toHaveValue("");
    expect(await storage(page)).toEqual(before); expect(external).toEqual([]);
  });

  test(`keyboard-only signup and onboarding at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport); const external = recordExternal(page);
    await page.goto("/welcome"); const before = await storage(page);
    await tabTo(page, page.getByRole("link", { name: "新規登録", exact: true })); await page.keyboard.press("Enter");
    await tabTo(page, page.getByLabel("メールアドレス")); await page.keyboard.type(email);
    await tabTo(page, page.getByLabel("パスワード", { exact: true })); await page.keyboard.type(password);
    await page.keyboard.press("Enter"); await expect(page).toHaveURL(`${ORIGIN}/onboarding`);
    await tabTo(page, page.getByLabel("表示名")); await page.keyboard.type("Demo");
    await tabTo(page, page.getByLabel("女性", { exact: true })); await page.keyboard.press("Space");
    await tabTo(page, page.getByLabel("生年月日"));
    await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft");
    // The app's Japanese lang makes Chrome's native date segments year/month/day.
    await page.keyboard.type("2000"); await page.keyboard.press("ArrowRight"); await page.keyboard.type("02"); await page.keyboard.press("ArrowRight"); await page.keyboard.type("29");
    await expect(page.getByLabel("生年月日")).toHaveValue(birth);
    await tabTo(page, page.getByLabel("18歳以上です")); await page.keyboard.press("Space");
    await tabTo(page, page.getByRole("button", { name: "次へ" })); await page.keyboard.press("Enter");
    for (const name of ["学校", "学科", "クラス"]) {
      await tabTo(page, page.getByLabel(name, { exact: true })); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
    }
    await tabTo(page, page.getByRole("button", { name: "次へ" })); await page.keyboard.press("Enter");
    await tabTo(page, page.getByRole("button", { name: /（写真1）$/ })); await page.keyboard.press("Space");
    await tabTo(page, page.getByRole("button", { name: "次へ" })); await page.keyboard.press("Enter");
    await tabTo(page, page.getByLabel("友達がほしい")); await page.keyboard.press("Space");
    await tabTo(page, page.getByLabel("自己紹介（任意）")); await page.keyboard.type("Fictional bio");
    await tabTo(page, page.getByRole("button", { name: "確認へ" })); await page.keyboard.press("Enter");
    await tabTo(page, page.getByRole("button", { name: "デモのプロフィールを作成" })); await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "デモの完了" })).toBeFocused();
    await tabTo(page, page.getByRole("link", { name: "架空のプロフィールを見る" })); await page.keyboard.press("Enter"); await expect(page).toHaveURL(`${ORIGIN}/`);
    expect(await storage(page)).toEqual(before); expect(external).toEqual([]);
  });
}
