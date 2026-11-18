import { expect, test, type Page } from "@playwright/test";
import { demoProfiles } from "../src/data/demo-profiles";

const ORIGIN = "http://127.0.0.1:3100";
// Screenshots are regenerated output; committed artifacts are only written when CAMPUS_LINK_SCREENSHOT_DIR points at docs/artifacts.
const shots = process.env.CAMPUS_LINK_SCREENSHOT_DIR ?? "test-results/screenshots";

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

async function expectLastContentAboveFooter(page: Page) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const lastBottom = await page.locator("dl").evaluate((e) => e.getBoundingClientRect().bottom);
  const footerTop = await page.getByRole("group", { name: "プロフィールへの操作" }).evaluate((e) => e.getBoundingClientRect().top);
  expect(lastBottom).toBeLessThanOrEqual(footerTop);
}

for (const width of [375, 768, 1440]) {
  test(`detail layout is intact for all profiles at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const external = recordExternal(page);
    for (const profile of demoProfiles) {
      await page.goto(`/profiles/${profile.id}`);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(profile.name);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      await expectLastContentAboveFooter(page);
    }
    await page.goto(`/profiles/${demoProfiles[0].id}`);
    await page.screenshot({ path: `${shots}/detail-${width}.png`, fullPage: true });
    await page.screenshot({ path: `${shots}/detail-${width}-viewport.png` });
    expect(external).toEqual([]);
  });
}

test("200% zoom equivalent (720 css px viewport) keeps detail usable", async ({ page }) => {
  // Equivalent viewport only; this is not a real browser zoom test.
  await page.setViewportSize({ width: 720, height: 450 });
  const external = recordExternal(page);
  await page.goto(`/profiles/${demoProfiles[1].id}`);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await expect(page.getByRole("link", { name: "一覧へ戻る" })).toBeVisible();
  await expect(page.getByRole("button", { name: "はるとにいいねを返す" })).toBeInViewport();
  await page.screenshot({ path: `${shots}/detail-zoom200-1440.png` });
  await expectLastContentAboveFooter(page);
  expect(external).toEqual([]);
});

test("every card opens the matching detail with one bio and its purposes, and back returns to the list", async ({ page }) => {
  const external = recordExternal(page);
  for (const profile of demoProfiles) {
    await page.goto("/");
    await page.getByRole("link", { name: `${profile.name}のプロフィールを見る` }).click();
    await expect(page).toHaveURL(`${ORIGIN}/profiles/${profile.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`${profile.name}${profile.age}`);
    await expect(page.getByText(profile.bio)).toBeVisible();
    await expect(page.locator("main")).not.toContainText(/モード|恋愛|利用目的/);
    await expect(page.getByText(profile.affiliation)).toBeVisible();
    await expect(page.getByText(profile.gender, { exact: false }).first()).toBeVisible();
    for (const hobby of profile.hobbies) await expect(page.getByRole("list", { name: "趣味" }).getByText(hobby)).toBeVisible();
    await expect(page.getByText("目的", { exact: true })).toHaveCount(profile.purposes.length ? 1 : 0);

    await page.getByRole("link", { name: "一覧へ戻る" }).click();
    await expect(page).toHaveURL(`${ORIGIN}/`);
    await page.goBack();
    await expect(page).toHaveURL(`${ORIGIN}/profiles/${profile.id}`);
  }
  expect(external).toEqual([]);
});

test("a mode in a direct URL is ignored", async ({ page }) => {
  const external = recordExternal(page);
  const p = demoProfiles[2];
  for (const url of [`/profiles/${p.id}`, `/profiles/${p.id}?mode=romance`, `/profiles/${p.id}?mode=friends`, `/profiles/${p.id}?mode=admin`]) {
    const res = await page.goto(url);
    expect(res?.status()).toBe(200);
    await expect(page.getByText(p.bio)).toBeVisible();
    await expect(page.getByRole("link", { name: "一覧へ戻る" })).toHaveAttribute("href", "/");
  }
  for (const url of ["/?mode=friends", "/?mode=bogus", "/"]) {
    await page.goto(url);
    await expect(page.getByText(demoProfiles[0].bio)).toBeVisible();
    await expect(page.getByRole("button", { name: "恋愛" })).toHaveCount(0);
  }
  await page.goto(`/profiles/${demoProfiles[0].id}`);
  await page.screenshot({ path: `${shots}/detail-375.png`, fullPage: true });
  expect(external).toEqual([]);
});

test("unknown profile ids return 404 with a way back", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  const external = recordExternal(page);
  for (const id of ["demo-4", "DEMO-1", "unknown", "constructor"]) {
    const res = await page.goto(`/profiles/${id}`);
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "プロフィールが見つかりません" })).toBeVisible();
  }
  await page.screenshot({ path: `${shots}/not-found-375.png` });
  await page.getByRole("link", { name: "一覧へ戻る" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/`);
  expect(external).toEqual([]);
});

test("detail is keyboard operable, focus is visible and never hidden by the fixed footer, targets are 44px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`/profiles/${demoProfiles[0].id}`);
  const footer = page.getByRole("group", { name: "プロフィールへの操作" });
  const footerTop = await footer.evaluate((e) => e.getBoundingClientRect().top);

  // The root layout's skip link is always the first keyboard stop.
  const order = ["本文へスキップ", "一覧へ戻る", "その他（準備中）", "あおいにいいね", "ブロック"];
  for (const name of order) {
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    await expect(focused).toHaveAccessibleName(name);
    expect(await focused.evaluate((e) => getComputedStyle(e).outlineStyle)).not.toBe("none");
    const inFooter = await focused.evaluate((e) => !!e.closest('[role="group"]'));
    if (!inFooter) expect((await focused.boundingBox())!.y + (await focused.boundingBox())!.height).toBeLessThanOrEqual(footerTop);
  }

  for (const el of [...(await page.getByRole("button").all()), ...(await page.getByRole("link").all())]) {
    const box = await el.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(43.5);
    expect(box!.width).toBeGreaterThanOrEqual(43.5);
  }

  await page.getByRole("link", { name: "一覧へ戻る" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${ORIGIN}/`);
});

test("Discover card links are reachable by keyboard without being hidden by the fixed nav", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");
  const navTop = await page.getByRole("navigation").evaluate((e) => e.getBoundingClientRect().top);
  for (const profile of demoProfiles.filter((p) => p.id !== "demo-2")) {
    const link = page.getByRole("link", { name: `${profile.name}のプロフィールを見る` });
    // Tab forward until the card link has focus.
    for (let i = 0; i < 20 && !(await link.evaluate((e) => e === document.activeElement)); i++) await page.keyboard.press("Tab");
    await expect(link).toBeFocused();
    const box = (await link.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(navTop);
  }
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${ORIGIN}/profiles/${demoProfiles[2].id}`);
});

test("disabled detail actions do nothing", async ({ page }) => {
  await page.goto(`/profiles/${demoProfiles[1].id}`);
  const url = page.url();
  const before = await page.locator("main").innerHTML();
  page.on("dialog", () => {
    throw new Error("unexpected dialog");
  });
  for (const name of ["その他（準備中）"]) {
    const btn = page.getByRole("button", { name });
    await expect(btn).toHaveAttribute("aria-disabled", "true");
    await btn.click({ force: true });
  }
  expect(page.url()).toBe(url);
  expect(await page.locator("main").innerHTML()).toBe(before);
});
