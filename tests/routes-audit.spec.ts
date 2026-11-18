import { expect, test } from "@playwright/test";
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { demoDisclaimer } from "../src/components/demo-disclaimer";

// One seeded id per dynamic route; existing profile-detail/talk specs cover 404s.
const verificationDetailRoute = "/admin/verifications/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const reportDetailRoute = "/admin/reports/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const routes = [
  "/", "/welcome", "/signup", "/login", "/onboarding", "/verification",
  "/search", "/profiles/demo-1", "/likes", "/requests", "/talk", "/talk/demo-4",
  "/mypage", "/mypage/profile", "/settings/privacy", "/settings/blocks", "/settings/account", "/settings/account/deleted", "/admin",
  "/admin/reports", "/admin/verifications", "/admin/affiliations", "/admin/mfa",
  "/admin/staff", "/admin/accounts", "/terms", "/privacy", "/auth/confirmed",
  verificationDetailRoute, reportDetailRoute,
];

test("audit inventory covers every app page", () => {
  const root = join(process.cwd(), "src/app");
  function pages(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry): string[] => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return pages(path);
      if (entry.name !== "page.tsx") return [];
      const route = relative(root, dir).split(sep).join("/").replace("profiles/[id]", "profiles/demo-1").replace("talk/[id]", "talk/demo-4").replace("admin/verifications/[id]", verificationDetailRoute.slice(1)).replace("admin/reports/[id]", reportDetailRoute.slice(1));
      return [`/${route}`];
    });
  }
  expect(routes.toSorted()).toEqual(pages(root).toSorted());
});

for (const route of routes) {
  // /auth/confirmed needs a real confirmation session, so the demo answers 404 like /auth/confirm (SEC-005).
  const unavailableInDemo = route === "/admin/mfa" || route === "/admin/staff" || route === "/admin/accounts" || route === "/auth/confirmed" || route === verificationDetailRoute || route === reportDetailRoute;
  test(`shared quality on ${route} at all three viewports`, async ({ page, context }) => {
    const external: string[] = [], writes: string[] = [], errors: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).origin !== "http://127.0.0.1:3100") external.push(request.url());
    });
    page.on("console", (message) => {
      // MFA and the live review detail are absent in demo. Only the exact document
      // 404 notification is allowed; resource, runtime and other console errors fail.
      const expectedDocument404 = unavailableInDemo
        && message.location().url === `http://127.0.0.1:3100${route}`
        && message.text() === "Failed to load resource: the server responded with a status of 404 (Not Found)";
      if (message.type() === "error" && !expectedDocument404) errors.push(`${message.location().url}: ${message.text()}`);
    });
    page.on("pageerror", (error) => errors.push(error.message));
    // Same cross-navigation binding approach as verification.spec.ts: records survive goto.
    await context.exposeBinding("recordAuditWrite", (_source, value: string) => { writes.push(value); });
    await context.addInitScript(() => {
      const record = (name: string) => { void (window as unknown as { recordAuditWrite: (name: string) => Promise<void> }).recordAuditWrite(name); };
      for (const method of ["setItem", "removeItem", "clear"] as const) {
        const original = Storage.prototype[method];
        Storage.prototype[method] = function (...args: string[]) { record(`storage.${method}`); return Reflect.apply(original, this, args); };
      }
      const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!;
      Object.defineProperty(Document.prototype, "cookie", { ...cookie, set(value) { record("cookie"); cookie.set!.call(this, value); } });
      const open = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (...args) { record("indexedDB"); return Reflect.apply(open, this, args); };
    });
    for (const [width, height] of [[375, 812], [768, 1024], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      const response = await page.goto(route);
      expect(response?.status()).toBe(unavailableInDemo ? 404 : 200);
      if (unavailableInDemo) await expect(page.locator("h1")).toHaveText("ページが見つかりません");
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page.locator("h1")).toBeVisible();
      await expect(page.getByRole("main")).toHaveCount(1);
      // The demo disclaimer is on every page, once, as plain text outside main.
      const disclaimer = page.getByText(demoDisclaimer, { exact: true });
      await expect(disclaimer).toHaveCount(1);
      await expect(disclaimer).toBeVisible();
      expect(await disclaimer.evaluate((element) => element.closest("main") === null)).toBe(true);
      const skip = page.getByRole("link", { name: "本文へスキップ" });
      // Onboarding intentionally focuses its step heading after hydration.
      // Reach the shared skip link by keyboard even when focus starts there.
      for (let i = 0; i < 80; i++) {
        await page.keyboard.press("Tab");
        if (await skip.evaluate((element) => element === document.activeElement)) break;
      }
      await expect(skip).toBeFocused();
      await expect(skip).toBeInViewport({ ratio: 1 });
      await page.keyboard.press("Enter");
      await expect(page.getByRole("main")).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${route} at ${width}`).toBeLessThanOrEqual(0);
      // Native radio/checkbox glyphs are measured through their containing labels,
      // as in onboarding.spec.ts and search.spec.ts. Other controls have no exception.
      for (const target of await page.locator('a, button, select, textarea, input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]), label:has(input[type="radio"]), label:has(input[type="checkbox"]), [role="button"], [role="switch"], [role="tab"]').all()) {
        if (!await target.isVisible()) continue;
        const box = (await target.boundingBox())!;
        const name = await target.getAttribute("aria-label") ?? await target.textContent();
        expect(box.width, `${route} at ${width}: ${name} width`).toBeGreaterThanOrEqual(43.5);
        expect(box.height, `${route} at ${width}: ${name} height`).toBeGreaterThanOrEqual(43.5);
      }
      expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
      expect(await context.cookies()).toEqual([]);
      expect(writes).toEqual([]); expect(external).toEqual([]); expect(errors).toEqual([]);
    }
  });
}
