import { expect, test, type Page, type Locator } from "@playwright/test";

async function activate(locator: Locator) { await locator.focus(); await locator.press("Enter"); }
async function layout(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  for (const control of await page.locator('button:visible, a:visible').all()) {
    const box = await control.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(43.5); expect(box!.height).toBeGreaterThanOrEqual(43.5);
  }
}
for (const [width, height] of [[375, 812], [768, 1024], [1440, 900]]) {
  test(`safety flow is keyboard accessible, local and reversible at ${width}`, async ({ page, context }) => {
    await page.setViewportSize({ width, height });
    const external: string[] = [];
    page.on("request", (r) => { if (!r.url().startsWith("http://127.0.0.1:3100")) external.push(r.url()); });
    await page.addInitScript(() => {
      const writes: string[] = []; (window as unknown as { __safetyWrites: string[] }).__safetyWrites = writes;
      Storage.prototype.setItem = function () { writes.push("storage"); };
      Object.defineProperty(document, "cookie", { configurable: true, get: () => "", set: () => { writes.push("cookie"); } });
    });
    await page.goto("/talk/demo-4");
    const message = page.getByRole("button", { name: "メッセージ 36 を通報" });
    await expect(message).toBeVisible(); await layout(page);
    await activate(message);
    let dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("blockquote")).toContainText("架空の会話 36");
    await expect(dialog.getByRole("radio", { name: "嫌がらせ" })).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(dialog.getByRole("button", { name: "キャンセル" })).toBeFocused();
    await page.keyboard.press("Tab"); await expect(dialog.getByRole("radio", { name: "嫌がらせ" })).toBeFocused();
    await layout(page);
    await activate(dialog.getByRole("button", { name: "通報する（デモ）" }));
    await expect(dialog.getByRole("status")).toHaveText("通報を受け付けました（デモ）");
    await page.keyboard.press("Escape"); await expect(message).toBeFocused();
    const menu = page.getByRole("button", { name: "ブロック・通報" });
    await activate(menu); await page.keyboard.press("Escape"); await expect(menu).toBeFocused();
    await activate(menu); await activate(page.getByRole("dialog").getByRole("button", { name: "ブロック", exact: true }));
    dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "ブロックする" })).toBeFocused();
    await activate(dialog.getByRole("button", { name: "ブロックする" }));
    await expect(dialog.getByRole("status")).toContainText("ブロックしました");
    await activate(dialog.getByRole("button", { name: "閉じる" }));
    await activate(page.getByRole("link", { name: "トーク一覧へ戻る" }));
    await expect(page.getByText("つながりはまだありません。")).toBeVisible();
    await activate(page.getByRole("link", { name: "マイページ", exact: true }));
    await activate(page.getByRole("link", { name: "ブロック中のユーザー" }));
    await expect(page.getByText("ゆう（架空）", { exact: true })).toBeVisible();
    await expect(page.getByText("report-1", { exact: true })).toBeVisible(); await layout(page);
    const unblock = page.getByRole("button", { name: "ブロック解除", exact: true });
    await activate(unblock); dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/つながりは元に戻りません/)).toBeVisible();
    await page.keyboard.press("Escape"); await expect(unblock).toBeFocused();
    await activate(unblock); await activate(page.getByRole("dialog").getByRole("button", { name: "ブロック解除", exact: true }));
    await expect(page.getByRole("dialog").getByRole("status")).toContainText("ブロックを解除しました");
    await activate(page.getByRole("dialog").getByRole("button", { name: "閉じる" }));
    await expect(page.getByText("ブロック中のユーザーはいません。")).toBeVisible();
    await activate(page.getByRole("link", { name: "トーク", exact: true }));
    await expect(page.getByText("つながりはまだありません。")).toBeVisible();
    await activate(page.getByRole("link", { name: "探す", exact: true }));
    const profile = page.getByRole("link", { name: "あおいのプロフィールを見る" });
    await activate(profile);
    const report = page.getByRole("button", { name: "通報", exact: true });
    await activate(report); dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox").focus(); await page.keyboard.type("Fictional report");
    await activate(dialog.getByRole("button", { name: "通報する（デモ）" }));
    await expect(dialog.getByRole("status")).toHaveText("通報を受け付けました（デモ）");
    await page.keyboard.press("Escape"); await expect(report).toBeFocused();
    await activate(page.getByRole("button", { name: "ブロック", exact: true }));
    await activate(page.getByRole("dialog").getByRole("button", { name: "ブロックする" }));
    await expect(page.getByRole("dialog").getByRole("status")).toContainText("ブロックしました");
    await activate(page.getByRole("dialog").getByRole("button", { name: "閉じる" }));
    await expect(page.getByRole("heading", { name: "このプロフィールは表示できません" })).toBeVisible();
    await activate(page.getByRole("link", { name: "一覧へ戻る" }));
    await expect(profile).toHaveCount(0); await layout(page);
    expect(await page.evaluate(() => (window as unknown as { __safetyWrites: string[] }).__safetyWrites)).toEqual([]);
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
    expect(await context.cookies()).toEqual([]); expect(external).toEqual([]);
    await page.reload(); await expect(profile).toBeVisible();
    await activate(page.getByRole("link", { name: "トーク", exact: true }));
    await expect(page.getByRole("main").getByText("ゆう（架空）", { exact: true })).toBeVisible();
  });
}
