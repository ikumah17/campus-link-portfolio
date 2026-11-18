import { expect, test, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const ORIGIN = "http://127.0.0.1:3100";
// Same WCAG 2.1 AA serious/critical gate as a11y.spec.ts (A11Y-001).
async function audit(page: Page, info: TestInfo, state: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const violations = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  await info.attach(state, { body: JSON.stringify({ url: page.url(), violations: results.violations }, null, 2), contentType: "application/json" });
  expect(violations.map((v) => ({ rule: v.id, nodes: v.nodes.map((n) => n.target) }))).toEqual([]);
}
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const width of [390, 768, 1280]) {
  test(`demo account settings at ${width}`, async ({ page }, info) => {
    const external: string[] = [];
    page.on("request", (r) => { if (!r.url().startsWith(ORIGIN)) external.push(r.url()); });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/mypage");
    await page.getByRole("link", { name: "アカウント" }).click();
    await expect(page).toHaveURL(/\/settings\/account$/);
    await expect(page.getByRole("heading", { level: 1, name: "アカウント" })).toBeVisible();
    await expect(page.getByRole("note")).toContainText("デモ");
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await audit(page, info, "account");

    await page.getByRole("button", { name: "休止する" }).click();
    await expect(page.getByText("休止中です。")).toBeVisible();
    await page.getByRole("button", { name: "再開する" }).click();
    await expect(page.getByText("利用中です。")).toBeVisible();

    await page.getByRole("button", { name: "退会の手続きへ" }).click();
    const dialog = page.getByRole("dialog", { name: "退会しますか" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox")).toBeFocused();
    await expect(dialog.getByRole("button", { name: "退会する" })).toBeDisabled();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await audit(page, info, "delete-dialog");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "退会の手続きへ" })).toBeFocused();

    await page.getByRole("button", { name: "退会の手続きへ" }).click();
    await dialog.getByRole("textbox").fill("退会する");
    await dialog.getByRole("button", { name: "退会する" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "退会の手続きが完了しました" })).toBeVisible();
    await audit(page, info, "deleted");
    // In-memory only: a reload starts from an active demo account again.
    await page.reload();
    await expect(page.getByText("利用中です。")).toBeVisible();
    expect(external).toEqual([]);
  });
}
