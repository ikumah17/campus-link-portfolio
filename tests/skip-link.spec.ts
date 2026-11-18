import { expect, test, type Page } from "@playwright/test";
import { demoProfiles } from "../src/data/demo-profiles";

const ORIGIN = "http://127.0.0.1:3100";

test("shared layout loads without resource or runtime console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "本文へスキップ" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  expect(errors).toEqual([]);
});

const ROUTES = [
  { name: "Discover", path: "/" },
  { name: "profile", path: `/profiles/${demoProfiles[0].id}` },
  { name: "profile not found", path: "/profiles/unknown" },
  { name: "My Page", path: "/mypage" },
  { name: "profile edit", path: "/mypage/profile" },
  { name: "likes", path: "/likes" },
  { name: "privacy settings", path: "/settings/privacy" },
];

function recordExternal(page: Page) {
  const external: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith(ORIGIN)) external.push(r.url());
  });
  return external;
}

async function horizontalOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

for (const width of [375, 1440]) {
  for (const route of ROUTES) {
    test(`skip link moves keyboard focus into main on ${route.name} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const external = recordExternal(page);
      await page.goto(route.path);

      const skip = page.getByRole("link", { name: "本文へスキップ" });
      await expect(page.getByRole("main")).toHaveCount(1);
      expect(await page.locator("#main-content").count()).toBe(1);
      await expect(skip).not.toBeInViewport();

      // Native keyboard: the first Tab lands on the skip link, which becomes visible.
      await page.keyboard.press("Tab");
      await expect(skip).toBeFocused();
      await expect(skip).toBeInViewport({ ratio: 1 });
      expect(await skip.evaluate((e) => e.matches(":focus-visible"))).toBe(true);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

      await page.keyboard.press("Enter");
      await expect(page.getByRole("main")).toBeFocused();
      const url = new URL(page.url());
      expect(url.pathname + url.search).toBe(route.path);
      await expect(skip).not.toBeInViewport();

      // The next Tab continues inside the main content, not back at the top of the document.
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.querySelector("main")!.contains(document.activeElement))).toBe(true);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      expect(external).toEqual([]);
    });
  }
}

test("Discover keeps conditions cleared on the page when the skip link is used", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto("/?min=19");
  await page.getByRole("button", { name: "条件をクリア" }).click();
  // The conditions live only in the replaced URL now; the fragment link must resolve against it.
  await page.getByRole("link", { name: "本文へスキップ" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  const url = new URL(page.url());
  expect(url.pathname + url.search).toBe("/");
  await expect(page.getByRole("article")).toHaveCount(3);
});
