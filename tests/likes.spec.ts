import { expect, test } from "@playwright/test";

for (const [width, height] of [[375, 812], [768, 1024], [1440, 900]]) {
  test(`memory-only like flow with keyboard and no overflow at ${width}`, async ({ page, context }) => {
    await page.setViewportSize({ width, height });
    const external: string[] = [];
    page.on("request", (r) => { if (new URL(r.url()).origin !== "http://127.0.0.1:3100") external.push(r.url()); });
    await page.addInitScript(() => {
      const writes: string[] = [];
      Object.defineProperty(window, "__likeWrites", { value: writes });
      for (const method of ["setItem", "removeItem", "clear"] as const) {
        Storage.prototype[method] = function () { writes.push(`storage.${method}`); throw new Error("unexpected storage mutation"); };
      }
      const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!;
      Object.defineProperty(document, "cookie", { get: () => cookie.get!.call(document), set: () => { writes.push("cookie"); throw new Error("unexpected cookie mutation"); } });
      indexedDB.open = () => { writes.push("indexedDB"); throw new Error("unexpected database"); };
    });
    // A mode in the URL is ignored (order 34: one list).
    await page.goto("/profiles/demo-1?mode=friends");
    await expect(page.locator("body")).not.toContainText(/モード|申請/);
    const like = page.getByRole("button", { name: "あおいにいいね" });
    await like.focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toHaveText("いいねしました。");
    await expect(page.getByText("いいね済み")).toBeVisible();
    const nav = page.getByRole("navigation");
    await nav.getByRole("link", { name: "いいね" }).focus(); await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/likes$/);
    await expect(page.getByRole("heading", { level: 1, name: "いいね" })).toBeVisible();
    await expect(page.getByText("お互いにいいねすると、マッチしてトークで話せます。")).toBeVisible();
    await expect(nav.getByRole("link", { name: "いいね" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("tab", { name: "いいねされた" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel")).toContainText("はると");
    await page.getByRole("tab", { name: "いいねされた" }).focus(); await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "いいねした" })).toBeFocused();
    await expect(page.getByRole("tabpanel")).toContainText("あおい");
    await expect(page.getByRole("tabpanel")).toContainText("友達がほしい・趣味仲間がほしい");
    for (const element of await page.locator("main button, nav a").all()) {
      const box = await element.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(43.5); expect(box!.width).toBeGreaterThanOrEqual(43.5);
    }
    await page.getByRole("button", { name: "あおいへのいいねを取り消す" }).focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toHaveText("いいねを取り消しました。");
    await expect(page.getByText("まだいいねしていません。")).toBeVisible();
    await expect(page.getByRole("tabpanel").getByRole("link", { name: "探す" })).toHaveAttribute("href", "/");
    await page.getByRole("tab", { name: "いいねした" }).focus(); await page.keyboard.press("Home");
    await expect(page.getByRole("tab", { name: "いいねされた" })).toBeFocused();
    await page.getByRole("button", { name: "はるとにいいねを返す" }).focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toHaveText("マッチしました。トークで話せます。");
    await expect(page.getByText("まだいいねはありません。")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("link", { name: "トークを開く" }).click();
    await expect(page).toHaveURL(/\/talk\/demo-2$/);
    await expect(page.getByRole("textbox")).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __likeWrites: string[] }).__likeWrites)).toEqual([]);
    expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
    expect(await context.cookies()).toEqual([]); expect(external).toEqual([]);
    await page.goto("/likes"); await expect(page.getByRole("button", { name: "はるとにいいねを返す" })).toBeVisible();
  });
}

test("the old request page forwards to the likes page", async ({ page }) => {
  await page.goto("/requests?mode=friends");
  await expect(page).toHaveURL(/\/likes$/);
  await expect(page.getByRole("heading", { level: 1, name: "いいね" })).toBeVisible();
});

test("a discovery card likes and takes back, and blocked people leave the likes lists", async ({ page }) => {
  await page.goto("/");
  const card = page.getByRole("article", { name: /ことね/ });
  await card.getByRole("button", { name: "ことねにいいね" }).click();
  await expect(card.getByRole("status")).toHaveText("いいねしました。");
  await card.getByRole("button", { name: "ことねへのいいねを取り消す" }).click();
  await expect(card.getByRole("status")).toHaveText("いいねを取り消しました。");
  await card.getByRole("button", { name: "ことねにいいね" }).click();
  await page.getByRole("navigation").getByRole("link", { name: "いいね" }).click();
  await page.getByRole("tab", { name: "いいねした" }).click();
  await expect(page.getByRole("tabpanel")).toContainText("ことね");
  // Blocking ことね and はると removes the likes both ways; neither list shows them.
  for (const [id, name] of [["demo-3", "ことね"], ["demo-2", "はると"]]) {
    await page.getByRole("tabpanel").getByRole("link", { name: new RegExp(name) }).first().click();
    await expect(page).toHaveURL(new RegExp(`/profiles/${id}$`));
    await page.getByRole("button", { name: "ブロック" }).click();
    await page.getByRole("button", { name: "ブロックする" }).click();
    await page.getByRole("button", { name: "閉じる" }).click();
    await page.getByRole("link", { name: "一覧へ戻る" }).click();
    await expect(page.getByRole("article", { name: new RegExp(name) })).toHaveCount(0);
    await page.getByRole("navigation").getByRole("link", { name: "いいね" }).click();
  }
  await expect(page.getByText("まだいいねはありません。")).toBeVisible();
  await page.getByRole("tab", { name: "いいねした" }).click();
  await expect(page.getByText("まだいいねしていません。")).toBeVisible();
});
