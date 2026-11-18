import { expect, test, type Page, type Locator } from "@playwright/test";

const origin = "http://127.0.0.1:3100";
async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement)) {
      expect(await target.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none"); return;
    }
  }
  throw new Error("Keyboard could not reach control");
}
async function activate(page: Page, target: Locator) { await tabTo(page, target); await page.keyboard.press("Enter"); }
async function checks(page: Page) {
  await expect(page.getByRole("note")).toContainText("実際の資料は扱いません");
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  for (const target of await page.locator("main button, main a, main textarea").all()) {
    const box = await target.boundingBox(); if (!box) continue;
    expect(box.height).toBeGreaterThanOrEqual(43.5); expect(box.width).toBeGreaterThanOrEqual(43.5);
  }
}
async function storage(page: Page) { return page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie })); }

for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
  test(`verification and reviewer keyboard flows, no I/O at ${viewport.width}`, async ({ page, context }) => {
    await page.setViewportSize(viewport);
    const external: string[] = []; const mutations: string[] = []; const storageWrites: string[] = [];
    page.on("request", (r) => { if (!r.url().startsWith(origin + "/")) external.push(r.url()); if (!["GET", "HEAD"].includes(r.method())) mutations.push(r.method()); });
    await context.exposeBinding("recordVerificationStorageWrite", (_source, value: string) => storageWrites.push(value));
    await context.addInitScript(() => {
      const record = (name: string) => { void (window as unknown as { recordVerificationStorageWrite: (name: string) => Promise<void> }).recordVerificationStorageWrite(name); };
      for (const method of ["setItem", "removeItem", "clear"] as const) {
        const original = Storage.prototype[method];
        Object.defineProperty(Storage.prototype, method, { value: function (...args: string[]) { record(method); return Reflect.apply(original, this, args); } });
      }
      const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!;
      Object.defineProperty(Document.prototype, "cookie", { ...descriptor, set(value) { record("cookie"); descriptor.set!.call(this, value); } });
      const originalOpen = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (...args) { record("indexedDB"); return Reflect.apply(originalOpen, this, args); };
    });
    await page.goto("/mypage"); const before = await storage(page);
    await expect(page.getByRole("link", { name: "管理画面のデモ" })).toHaveAttribute("href", "/admin");
    await activate(page, page.getByRole("link", { name: "在学・年齢確認（デモ）" }));
    await expect(page.getByRole("heading", { name: "在学・年齢確認", exact: true })).toBeVisible(); await checks(page);
    for (const kind of ["年齢確認", "在学確認"]) {
      const card = page.getByRole("region", { name: kind });
      await activate(page, card.getByRole("button", { name: "提出（デモ）" }));
      const sample = card.getByRole("button", { name: "架空のサンプル資料1" }); await expect(sample).toBeFocused();
      await page.keyboard.press("Space"); await expect(sample).toHaveAttribute("aria-pressed", "true");
      await activate(page, card.getByRole("button", { name: "提出（デモ）" }));
      await expect(page.getByRole("status")).toHaveText(`${kind}を提出しました（デモ）。`);
      await expect(card.getByRole("button", { name: "提出（デモ）" })).toBeDisabled(); await checks(page);
      await activate(page, card.getByRole("button", { name: "取り下げ" })); await expect(sample).toBeFocused();
      await expect(page.getByRole("status")).toHaveText(`${kind}を取り下げました（デモ）。`);
      await activate(page, card.getByRole("button", { name: "提出（デモ）" }));
    }
    await page.reload(); await expect(page.getByText("未提出", { exact: true })).toHaveCount(2);
    await activate(page, page.getByRole("link", { name: "マイページへ戻る" }));
    await activate(page, page.getByRole("link", { name: "管理画面のデモ" }));
    await activate(page, page.getByRole("link", { name: /学生認証審査/ }));
    await expect(page.getByRole("heading", { name: "審査画面のデモ", exact: true })).toBeVisible(); await checks(page);
    const panel = page.getByRole("tabpanel"); await expect(panel).not.toContainText("2000-02-29");
    await activate(page, panel.getByRole("button")); await expect(page.getByRole("heading", { name: "提出の詳細" })).toBeFocused();
    await expect(page.getByText("2000-02-29", { exact: true })).toBeVisible(); await expect(panel).not.toContainText("2000-02-29"); await checks(page);
    await activate(page, page.getByRole("button", { name: "担当する" })); await expect(page.getByRole("status")).toHaveText("担当しました（デモ）。");
    // apply() focuses this heading on the next animation frame. Wait for that
    // handoff before tabbing, so it cannot steal focus from the next control.
    await expect(page.getByRole("heading", { name: "提出の詳細" })).toBeFocused();
    await activate(page, page.getByRole("button", { name: "担当を外す" }));
    await expect(page.getByRole("heading", { name: "提出の詳細" })).toBeFocused();
    await activate(page, page.getByRole("button", { name: "担当する" }));
    await expect(page.getByRole("heading", { name: "提出の詳細" })).toBeFocused();
    await activate(page, page.getByRole("button", { name: "承認", exact: true })); await expect(page.getByRole("status")).toHaveText("承認しました（デモ）。");
    await expect(page.getByRole("heading", { name: "提出の詳細" })).toBeFocused();
    await tabTo(page, page.getByRole("tab", { name: "提出済み" })); await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "審査中" })).toBeFocused();
    await activate(page, panel.getByRole("button")); await checks(page);
    await activate(page, page.getByRole("button", { name: "却下", exact: true }));
    const reason = page.getByLabel("却下理由（1〜200文字）"); await expect(reason).toBeFocused(); await expect(reason).toHaveAttribute("aria-invalid", "true");
    await page.keyboard.type("Fictional sample reason");
    await activate(page, page.getByRole("button", { name: "却下", exact: true })); await expect(page.getByRole("status")).toHaveText("却下しました（デモ）。");
    await expect(page.getByRole("heading", { name: "提出の詳細" })).toBeFocused();
    await tabTo(page, page.getByRole("tab", { name: "審査中" })); await page.keyboard.press("ArrowRight");
    await expect(panel.getByRole("button")).toHaveCount(2);
    await page.keyboard.press("ArrowRight"); await expect(panel.getByRole("button")).toHaveCount(2); await expect(panel).not.toContainText("2000-02-29"); await checks(page);
    await page.reload(); await expect(page.getByRole("tab", { name: "提出済み" })).toHaveAttribute("aria-selected", "true");
    expect(await storage(page)).toEqual(before); expect(await context.cookies()).toEqual([]);
    expect(external).toEqual([]); expect(mutations).toEqual([]); expect(storageWrites).toEqual([]);
  });
}
