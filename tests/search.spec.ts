import { expect, test, type Page } from "@playwright/test";
async function activate(page: Page, name: string) {
  const control = page.getByRole("button", { name, exact: true });
  await control.focus(); await page.keyboard.press("Enter");
}
async function layout(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const control of await page.locator("button:visible, a:visible, input[type=number]:visible, label:has(input[type=checkbox]):visible").all()) {
    const box = (await control.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(43.5); expect(box.height).toBeGreaterThanOrEqual(43.5);
  }
  expect(await page.locator("main").innerText()).not.toMatch(/\d+件/);
}
for (const [width, height] of [[375, 812], [768, 1024], [1440, 900]]) {
  test(`URL-only keyboard search flow at ${width}`, async ({ page, context }) => {
    await page.setViewportSize({ width, height });
    const external: string[] = [];
    page.on("request", (r) => { if (!r.url().startsWith("http://127.0.0.1:3100")) external.push(r.url()); });
    await page.addInitScript(() => {
      const writes: string[] = []; (window as unknown as { searchWrites: string[] }).searchWrites = writes;
      Storage.prototype.setItem = () => { writes.push("storage"); };
      Object.defineProperty(document, "cookie", { configurable: true, get: () => "", set: () => { writes.push("cookie"); } });
    });
    await page.goto("/?mode=friends");
    await expect(page.getByRole("article")).toHaveCount(3);
    const search = page.getByRole("link", { name: "検索条件" });
    await search.focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "検索条件" })).toBeVisible(); await layout(page);
    await page.getByLabel("下限年齢").focus(); await page.keyboard.type("20");
    await page.keyboard.press("Tab"); await expect(page.getByLabel("上限年齢")).toBeFocused(); await page.keyboard.type("20");
    await page.keyboard.press("Tab"); await expect(page.getByLabel("女性", { exact: true })).toBeFocused(); await page.keyboard.press("Space");
    await page.getByLabel("デモ学校A（架空）").focus(); await page.keyboard.press("Space");
    await activate(page, "この条件で探す"); await expect(page).toHaveURL(/\/\?min=20&max=20&g=female&s=/);
    await expect(page.getByRole("article")).toHaveCount(1); await expect(page.getByText("20〜20歳")).toBeVisible(); await layout(page);
    await page.reload(); await expect(page.getByRole("article")).toHaveCount(1);
    expect(new URL(page.url()).searchParams.get("min")).toBe("20");
    await activate(page, "条件をクリア"); await expect(page).toHaveURL("http://127.0.0.1:3100/"); await expect(page.getByRole("article")).toHaveCount(3);
    await page.goto("/?mode=friends&mode=friends&min=17&max=121&g=unknown&s=unknown");
    await expect(page.getByRole("button", { name: "恋愛", exact: true })).toHaveCount(0);
    await expect(page.getByRole("article")).toHaveCount(3); await expect(page.getByRole("button", { name: "条件をクリア", exact: true })).toHaveCount(0);
    await page.goto("/?min=120"); await expect(page.getByText("条件に合うプロフィールはありません")).toBeVisible(); await layout(page);
    expect(await page.evaluate(() => (window as unknown as { searchWrites: string[] }).searchWrites)).toEqual([]);
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]); expect(await context.cookies()).toEqual([]); expect(external).toEqual([]);
  });
}
test("form errors focus first invalid field and clear restores keyboard editing", async ({ page }) => {
  await page.goto("/search?min=25&max=30&g=female");
  await page.getByLabel("上限年齢").fill("20"); await activate(page, "この条件で探す");
  await expect(page.getByLabel("下限年齢")).toBeFocused(); await expect(page.getByRole("main").getByRole("alert")).toHaveText("下限は上限以下にしてください。");
  await activate(page, "条件をクリア"); await expect(page.getByLabel("下限年齢")).toBeFocused();
  await expect(page.getByLabel("女性", { exact: true })).not.toBeChecked(); await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await activate(page, "この条件で探す"); await expect(page).toHaveURL("http://127.0.0.1:3100/");
});
