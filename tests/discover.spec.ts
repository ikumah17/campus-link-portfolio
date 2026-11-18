import { expect, test } from "@playwright/test";

const widths = [375, 768, 1440];
// Screenshots are regenerated output; committed artifacts are only written when CAMPUS_LINK_SCREENSHOT_DIR points at docs/artifacts.
const shots = process.env.CAMPUS_LINK_SCREENSHOT_DIR ?? "test-results/screenshots";

for (const width of widths) {
  test(`layout is intact at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const external: string[] = [];
    page.on("request", (r) => {
      if (!r.url().startsWith("http://127.0.0.1:3100")) external.push(r.url());
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Campus Link" })).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    const cards = page.getByRole("article");
    await expect(cards).toHaveCount(3);
    const columns = await cards.evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().left))).size);
    expect(columns).toBe(width >= 768 ? 2 : 1);

    // The last card must scroll fully above the fixed nav.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const lastBottom = await cards.last().evaluate((e) => e.getBoundingClientRect().bottom);
    const navTop = await page.getByRole("navigation").evaluate((e) => e.getBoundingClientRect().top);
    expect(lastBottom).toBeLessThanOrEqual(navTop);

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${shots}/discover-${width}.png`, fullPage: true });
    await page.screenshot({ path: `${shots}/discover-${width}-viewport.png` });
    expect(external).toEqual([]);
  });
}

test("200% zoom equivalent (720 css px viewport) stays usable", async ({ page }) => {
  // 200% browser zoom on a 1440px window is a 720 css px viewport; 375px at 200% is 187px, below the WCAG 320px reflow baseline.
  await page.setViewportSize({ width: 720, height: 450 });
  await page.goto("/");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByRole("button", { name: "あおいにいいね" })).toBeVisible();
  await page.screenshot({ path: `${shots}/discover-zoom200-1440.png` });
});

test("no mode toggle; the card like works by keyboard with visible focus and 44px targets", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/?mode=friends");
  await expect(page.getByRole("button", { name: "恋愛" })).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(/モード|申請/);
  await expect(page.getByText("週末はカフェや映画館に出かけています").first()).toBeVisible();
  await expect(page.getByText("友達がほしい・趣味仲間がほしい")).toBeVisible();
  const like = page.getByRole("button", { name: "あおいにいいね" });
  await like.focus();
  const outline = await like.evaluate((e) => getComputedStyle(e).outlineStyle);
  expect(outline).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("article", { name: /あおい/ }).getByRole("status")).toHaveText("いいねしました。");
  await expect(page.getByRole("article", { name: /はると/ }).getByText("あなたにいいねしています")).toBeVisible();

  for (const b of [...(await page.getByRole("button").all()), ...(await page.getByRole("link").all())]) {
    const box = await b.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(43.5);
    expect(box!.width).toBeGreaterThanOrEqual(43.5);
  }
});
