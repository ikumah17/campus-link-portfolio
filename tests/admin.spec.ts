import { expect, test, type Page, type Locator } from "@playwright/test";

// Reach controls exclusively by Tab / Shift+Tab; do not synthesize pointer clicks or focus().
async function reach(page: Page, target: Locator) {
  for (let i = 0; i < 220; i++) {
    if (await target.evaluate((node) => node === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Control was not keyboard reachable");
}
async function activate(page: Page, target: Locator) { await reach(page, target); await page.keyboard.press("Enter"); }
async function layout(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  for (const control of await page.locator('button:visible, a:visible, input:visible, textarea:visible').all()) {
    const box = await control.boundingBox(); expect(box!.width).toBeGreaterThanOrEqual(43.5); expect(box!.height).toBeGreaterThanOrEqual(43.5);
  }
  await expect(page.getByRole("navigation", { name: "メインナビゲーション" })).toHaveCount(0);
}
for (const [width, height] of [[375, 812], [768, 1024], [1440, 900]]) {
  test(`admin keyboard workflow remains local at ${width}`, async ({ page, context }) => {
    await page.setViewportSize({ width, height }); const external: string[] = [];
    page.on("request", (request) => { if (!request.url().startsWith("http://127.0.0.1:3100")) external.push(request.url()); });
    await page.addInitScript(() => {
      const writes: string[] = []; (window as unknown as { __adminWrites: string[] }).__adminWrites = writes;
      Storage.prototype.setItem = function () { writes.push("storage"); };
      Object.defineProperty(document, "cookie", { configurable: true, get: () => "", set: () => { writes.push("cookie"); } });
    });
    await page.goto("/mypage");
    await activate(page, page.getByRole("link", { name: "管理画面のデモ" }));
    await expect(page.getByRole("heading", { name: "管理画面のデモ" })).toBeVisible(); await layout(page);
    await activate(page, page.getByRole("link", { name: /^通報/ }));
    await expect(page.getByRole("heading", { name: "通報", exact: true })).toBeVisible(); await layout(page);
    await activate(page, page.getByRole("button", { name: /プロフィール/ }));
    await expect(page.getByText("この通報は担当できません")).toBeVisible();
    await expect(page.getByRole("heading", { name: "通報の詳細" })).toBeFocused();
    await activate(page, page.getByRole("button", { name: /メッセージ/ }));
    await expect(page.getByRole("blockquote")).toContainText("架空のメッセージ");
    await reach(page, page.getByRole("textbox", { name: "対応メモ（任意）" })); await page.keyboard.type("Fictional note"); await layout(page);
    await activate(page, page.getByRole("button", { name: "確認中にする" }));
    await expect(page.getByRole("status")).toContainText("確認中に変更");
    await activate(page, page.getByRole("button", { name: "対応済みにする" }));
    await expect(page.getByRole("status")).toContainText("対応済みに変更");
    await activate(page, page.getByRole("link", { name: "管理画面へ戻る" }));
    await expect(page.getByRole("link", { name: /^通報/ })).toContainText("1件");
    await activate(page, page.getByRole("link", { name: /学校・学科・クラス/ }));
    await expect(page.getByRole("heading", { name: "学校・学科・クラス", exact: true })).toBeVisible(); await layout(page);
    const department = page.getByRole("region", { name: "デモ学科A1（架空）", exact: true });
    const add = department.getByRole("button", { name: "クラスを追加" });
    await activate(page, add);
    await expect(page.getByRole("textbox", { name: "名前" })).toBeFocused();
    await page.keyboard.type("Fictional class"); await layout(page);
    await activate(page, page.getByRole("button", { name: "保存する" })); await expect(add).toBeFocused();
    const row = page.getByRole("region", { name: "Fictional class", exact: true });
    await activate(page, row.getByRole("switch")); await expect(row).toContainText("無効");
    await expect(row.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    await expect(page.getByRole("button", { name: /削除/ })).toHaveCount(0); await layout(page);
    expect(await page.evaluate(() => (window as unknown as { __adminWrites: string[] }).__adminWrites)).toEqual([]);
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
    expect(await context.cookies()).toEqual([]); expect(external).toEqual([]);
    await page.reload(); await expect(row).toHaveCount(0);
    await activate(page, page.getByRole("link", { name: "管理画面へ戻る" }));
    await expect(page.getByRole("link", { name: /^通報/ })).toContainText("2件");
    await activate(page, page.getByRole("link", { name: /学生認証審査/ }));
    await expect(page.getByRole("heading", { name: "審査画面のデモ" })).toBeVisible();
    await activate(page, page.getByRole("link", { name: "管理画面へ戻る" }));
    await expect(page.getByRole("heading", { name: "管理画面のデモ" })).toBeVisible();
  });
}
