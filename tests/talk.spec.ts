import { expect, test, type Page } from "@playwright/test";

async function keyboardActivate(page: Page, name: string, role: "button" | "link" = "button") {
  await page.getByRole(role, { name, exact: true }).focus(); await page.keyboard.press("Enter");
}
async function layoutChecks(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const target of await page.locator('button, main a, nav a, textarea').all()) {
    if (!await target.isVisible()) continue;
    const box = await target.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(43.5); expect(box!.width).toBeGreaterThanOrEqual(43.5);
  }
}
for (const [width, height] of [[375, 812], [768, 1024], [1440, 900]]) {
  test(`chat after a match, send, paging and privacy at ${width}`, async ({ page, context }) => {
    await page.setViewportSize({ width, height });
    const external: string[] = [];
    page.on("request", (r) => { if (new URL(r.url()).origin !== "http://127.0.0.1:3100") external.push(r.url()); });
    await page.addInitScript(() => {
      const writes: string[] = [];
      Object.defineProperty(window, "__chatWrites", { value: writes });
      for (const method of ["setItem", "removeItem", "clear"] as const) Storage.prototype[method] = function () { writes.push(`storage.${method}`); throw new Error("unexpected storage write"); };
      const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!;
      Object.defineProperty(document, "cookie", { get: () => cookie.get!.call(document), set: () => { writes.push("cookie"); throw new Error("unexpected cookie write"); } });
      indexedDB.open = () => { writes.push("indexedDB"); throw new Error("unexpected database"); };
    });
    await page.goto("/likes");
    await keyboardActivate(page, "はるとにいいねを返す"); await expect(page.getByRole("status")).toHaveText("マッチしました。トークで話せます。");
    await keyboardActivate(page, "トークを開く", "link");
    await expect(page).toHaveURL(/\/talk\/demo-2$/);
    await expect(page.getByRole("heading", { name: "はると" })).toBeVisible();
    await expect(page.getByRole("log")).toContainText("まだメッセージはありません。");
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await layoutChecks(page);
    const body = page.getByLabel("メッセージ", { exact: true });
    await body.focus(); await page.keyboard.type("テストの架空メッセージ");
    await page.keyboard.press("Enter"); await page.keyboard.type("2行目");
    await page.keyboard.press("Control+Enter");
    await expect(body).toHaveValue(""); await expect(body).toBeFocused();
    await expect(page.getByRole("status")).toContainText("送信しました");
    await expect(page.getByRole("log").getByRole("listitem")).toHaveCount(1);
    const last = await page.getByRole("log").getByRole("listitem").last().boundingBox();
    const composer = await body.boundingBox(); expect(last!.y + last!.height).toBeLessThanOrEqual(composer!.y);
    await keyboardActivate(page, "トーク一覧へ戻る", "link");
    await expect(page).toHaveURL(/\/talk$/);
    await expect(page.getByRole("main").getByRole("link").first()).toContainText("テストの架空メッセージ");
    await expect(page.getByRole("link", { name: "トーク", exact: true })).toHaveAttribute("aria-current", "page");
    const seeded = page.getByRole("main").getByRole("link").filter({ hasText: "ゆう（架空）" });
    await expect(seeded).toContainText("未読"); await seeded.focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("log").getByRole("listitem")).toHaveCount(30);
    await layoutChecks(page);
    const log = page.getByRole("log"); await log.evaluate((el) => { el.scrollTop = 0; });
    const anchor = page.getByText("架空の会話 7：おすすめの本について話しています。", { exact: true });
    const before = await anchor.boundingBox();
    await keyboardActivate(page, "以前のメッセージ");
    await expect(log.getByRole("listitem")).toHaveCount(36);
    const after = await anchor.boundingBox(); expect(Math.abs(after!.y - before!.y)).toBeLessThan(2);
    await expect(page.getByRole("button", { name: "以前のメッセージ" })).toHaveCount(0);
    await body.focus(); await page.keyboard.type("button send");
    await page.keyboard.press("Tab"); await expect(page.getByRole("button", { name: "送信", exact: true })).toBeFocused();
    await page.keyboard.press("Enter"); await expect(body).toHaveValue(""); await expect(body).toBeFocused();
    await expect(log.getByRole("listitem")).toHaveCount(37);
    const lastSeeded = await log.getByRole("listitem").last().boundingBox(); const logBox = await log.boundingBox();
    expect(lastSeeded!.y).toBeGreaterThanOrEqual(logBox!.y); expect(lastSeeded!.y + lastSeeded!.height).toBeLessThanOrEqual(logBox!.y + logBox!.height + 1);
    await keyboardActivate(page, "トーク一覧へ戻る", "link");
    await expect(page.getByRole("main").getByRole("link").filter({ hasText: "ゆう（架空）" })).not.toContainText("未読");
    await layoutChecks(page);
    expect(await page.evaluate(() => (window as unknown as { __chatWrites: string[] }).__chatWrites)).toEqual([]);
    expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
    expect(await context.cookies()).toEqual([]); expect(external).toEqual([]);
    await page.reload(); await expect(page.getByRole("main").getByRole("link").filter({ hasText: "はると" })).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("link").filter({ hasText: "ゆう（架空）" })).toContainText("未読");
  });
}
test("unknown and inaccessible rooms share an unavailable view", async ({ page }) => {
  for (const id of ["unknown", "demo-3"]) {
    await page.goto(`/talk/${id}`);
    await expect(page.getByRole("heading", { name: "この会話は表示できません" })).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "トーク一覧へ戻る" })).toHaveAttribute("href", "/talk");
  }
});

// The chat room fills the height left under the demo disclaimer, so the message box stays on screen
// without page scrolling. Without the disclaimer (the hosted backend) it is exactly the viewport height.
for (const [width, height] of [[375, 812], [768, 1024], [1440, 900]]) {
  test(`chat room keeps the message box on screen below the disclaimer at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/talk/demo-4");
    const main = page.getByRole("main");
    const disclaimer = page.getByText(/^個人制作のデモです。/);
    const input = page.getByRole("textbox", { name: "メッセージ" });
    const send = page.getByRole("button", { name: "送信", exact: true });
    const pageScroll = () => page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    await expect(disclaimer).toBeVisible();
    await expect(input).toBeInViewport({ ratio: 1 });
    await expect(send).toBeInViewport({ ratio: 1 });
    expect(await pageScroll()).toBeLessThanOrEqual(0);
    const top = (await disclaimer.boundingBox())!, room = (await main.boundingBox())!;
    expect(Math.abs(room.y - (top.y + top.height))).toBeLessThan(1);
    expect(Math.abs(room.y + room.height - height)).toBeLessThan(1);
    expect(Math.abs(room.width - Math.min(width, 672))).toBeLessThan(1);

    await disclaimer.evaluate((element) => element.remove());
    const alone = (await main.boundingBox())!;
    expect(Math.abs(alone.y)).toBeLessThan(1);
    expect(Math.abs(alone.height - height)).toBeLessThan(1);
    await expect(input).toBeInViewport({ ratio: 1 });
    expect(await pageScroll()).toBeLessThanOrEqual(0);
  });
}
