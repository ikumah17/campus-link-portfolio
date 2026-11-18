import { expect, test, type Page } from "@playwright/test";

const ORIGIN = "http://127.0.0.1:3100";
// Screenshots are regenerated output; committed artifacts are only written when CAMPUS_LINK_SCREENSHOT_DIR points at docs/artifacts.
const shots = process.env.CAMPUS_LINK_SCREENSHOT_DIR ?? "test-results/screenshots";

const SWITCHES = ["同じクラスに表示しない", "同じ学科に表示しない", "同じ学校に表示しない", "学科名を公開", "クラス名を公開"];
const DEFAULT_CHECKED = ["true", "false", "false", "false", "false"];
const NOTICE = "デモ：設定はこの画面を開いている間だけ保持され、実際の表示制限には反映されません。";

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

async function checkedStates(page: Page) {
  const out: (string | null)[] = [];
  for (const name of SWITCHES) out.push(await page.getByRole("switch", { name }).getAttribute("aria-checked"));
  return out;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const writes: string[] = [];
    Object.assign(window, { privacyWrites: writes });
    for (const method of ["setItem", "removeItem", "clear"] as const) {
      Storage.prototype[method] = () => { writes.push(method); };
    }
    Object.defineProperty(document, "cookie", { get: () => "", set: () => { writes.push("cookie"); } });
  });
});

const footer = (page: Page) => page.getByRole("group", { name: "デモ設定の保存" });
const saveButton = (page: Page) => page.getByRole("button", { name: "デモ設定を保存" });

// The save button is disabled until gateway settings have loaded.
async function openPrivacy(page: Page, url = "/settings/privacy") {
  await page.goto(url);
  await expect(saveButton(page)).toBeEnabled();
}

async function expectContentAboveFooter(page: Page) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const lastBottom = await page.locator("main section").last().evaluate((e) => e.getBoundingClientRect().bottom);
  const footerTop = await footer(page).evaluate((e) => e.getBoundingClientRect().top);
  expect(lastBottom).toBeLessThanOrEqual(footerTop);
}

// Tabs through the whole page and checks each focused control is visible, outlined and not under the fixed footer.
async function expectFocusNeverHidden(page: Page, steps: number) {
  const seen: string[] = [];
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    if ((await focused.count()) === 0) continue;
    seen.push((await focused.getAttribute("aria-label")) ?? (await focused.innerText()));
    expect(await focused.evaluate((e) => getComputedStyle(e).outlineStyle)).not.toBe("none");
    const inFooter = await focused.evaluate((e) => !!e.closest('[aria-label="デモ設定の保存"]'));
    if (inFooter) continue;
    const box = (await focused.boundingBox())!;
    const footerTop = await footer(page).evaluate((e) => e.getBoundingClientRect().top);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(footerTop);
  }
  return seen;
}

async function expectTargets44(page: Page) {
  for (const el of [...(await page.getByRole("button").all()), ...(await page.getByRole("link").all()), ...(await page.getByRole("switch").all())]) {
    if (!(await el.isVisible())) continue;
    const box = (await el.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(43.5);
    expect(box.width).toBeGreaterThanOrEqual(43.5);
  }
}

test("Discover → mypage → privacy and back uses plain URLs and the active nav item", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  const external = recordExternal(page);
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "メインナビゲーション" });
  await expect(nav.getByRole("link", { name: "探す" })).toHaveAttribute("aria-current", "page");

  await nav.getByRole("link", { name: "マイページ" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/mypage`);
  await expect(page.getByRole("heading", { level: 1, name: "マイページ" })).toBeVisible();
  await expect(page.getByText("架空アカウントの設定デモ")).toBeVisible();
  await expect(nav.getByRole("link", { name: "マイページ" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "探す" })).not.toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "トーク" })).toHaveAttribute("href", "/talk");

  await page.getByRole("link", { name: /公開範囲設定/ }).click();
  await expect(page).toHaveURL(`${ORIGIN}/settings/privacy`);
  await expect(page.getByRole("heading", { level: 1, name: "公開範囲設定" })).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);

  await page.getByRole("link", { name: "マイページへ戻る" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/mypage`);
  await nav.getByRole("link", { name: "探す" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/`);

  await page.goBack();
  await expect(page).toHaveURL(`${ORIGIN}/mypage`);
  await page.goBack();
  await expect(page).toHaveURL(`${ORIGIN}/settings/privacy`);
  await expect(page.getByRole("link", { name: "マイページへ戻る" })).toHaveAttribute("href", "/mypage");
  expect(external).toEqual([]);
});

test("a mode in a direct mypage/privacy URL is ignored", async ({ page }) => {
  for (const query of ["", "?mode=friends", "?mode=romance", "?mode=x"]) {
    expect((await page.goto(`/mypage${query}`))?.status()).toBe(200);
    await expect(page.getByRole("link", { name: /公開範囲設定/ })).toHaveAttribute("href", "/settings/privacy");
    await expect(page.getByRole("navigation").getByRole("link", { name: "探す" })).toHaveAttribute("href", "/");
    expect((await page.goto(`/settings/privacy${query}`))?.status()).toBe(200);
    await expect(page.getByRole("link", { name: "マイページへ戻る" })).toHaveAttribute("href", "/mypage");
  }
});

test("seed targets and switches save in memory, rate limit, and reset on reload without storage", async ({ page, context }) => {
  const external = recordExternal(page);
  await openPrivacy(page);
  await expect(page.getByRole("note")).toHaveText(NOTICE);
  expect(await checkedStates(page)).toEqual(DEFAULT_CHECKED);
  for (const name of SWITCHES) await page.getByRole("switch", { name }).click();
  const manage = page.getByRole("button", { name: /非表示対象を管理/ });
  await manage.click();
  await page.getByRole("button", { name: "デモクラスA1-1（架空）を追加" }).click();
  await page.getByRole("button", { name: "デモ学校B（架空）を追加" }).click();
  await page.getByRole("button", { name: "デモ学科B1（架空）を追加" }).click();
  await page.getByRole("button", { name: "デモ学科B1（架空）を解除" }).click();
  await expect(manage).toContainText("2件指定中");
  await saveButton(page).click();
  await expect(footer(page).getByRole("status")).toHaveText("デモ設定を保存しました。");
  for (let n = 1; n < 10; n++) await saveButton(page).click();
  await saveButton(page).click();
  await expect(footer(page).getByRole("alert")).toHaveText("しばらくしてから再度お試しください");
  expect(await page.evaluate(() => (window as unknown as { privacyWrites: string[] }).privacyWrites)).toEqual([]);
  expect(await context.cookies()).toEqual([]);
  await page.reload();
  await expect(saveButton(page)).toBeEnabled();
  expect(await checkedStates(page)).toEqual(DEFAULT_CHECKED);
  await expect(manage).toContainText("0件指定中");
  expect(external).toEqual([]);
});

for (const width of [375, 768, 1440]) {
  test(`mypage and privacy layouts are intact at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : width === 768 ? 1024 : 900 });
    const external = recordExternal(page);

    await page.goto("/mypage");
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    const linkBottom = await page.getByRole("link", { name: /公開範囲設定/ }).evaluate((e) => e.getBoundingClientRect().bottom);
    const navTop = await page.getByRole("navigation").evaluate((e) => e.getBoundingClientRect().top);
    expect(linkBottom).toBeLessThanOrEqual(navTop);
    await expectTargets44(page);
    await page.screenshot({ path: `${shots}/mypage-${width}.png`, fullPage: true });

    await openPrivacy(page);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await expect(saveButton(page)).toBeInViewport();
    await expectContentAboveFooter(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${shots}/privacy-${width}.png`, fullPage: true });
    await page.screenshot({ path: `${shots}/privacy-${width}-viewport.png` });

    await page.getByRole("button", { name: /非表示対象を管理/ }).click();
    await page.getByRole("button", { name: "デモ学校A（架空）を追加" }).click();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await expectContentAboveFooter(page);
    await expectTargets44(page);
    await saveButton(page).click();
    await expect(footer(page).getByRole("status")).toHaveText("デモ設定を保存しました。");
    await expectContentAboveFooter(page);
    await page.screenshot({ path: `${shots}/privacy-targets-${width}.png`, fullPage: true });
    expect(external).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { privacyWrites: string[] }).privacyWrites)).toEqual([]);
    expect(await page.context().cookies()).toEqual([]);
  });
}

test("200% zoom equivalent (720×450 css px) keeps privacy usable and focus clear of the footer", async ({ page }) => {
  // Equivalent viewport only; this is not a real browser zoom test.
  await page.setViewportSize({ width: 720, height: 450 });
  const external = recordExternal(page);
  await openPrivacy(page, "/settings/privacy");
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await expect(saveButton(page)).toBeInViewport();
  await page.screenshot({ path: `${shots}/privacy-zoom200-1440.png` });
  await page.getByRole("button", { name: /非表示対象を管理/ }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator("body").focus();
  const seen = await expectFocusNeverHidden(page, 18);
  expect(seen.length).toBeGreaterThanOrEqual(16);
  await expectContentAboveFooter(page);

  await page.goto("/mypage");
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${shots}/mypage-zoom200-1440.png` });
  expect(external).toEqual([]);
});

test("privacy is keyboard operable with a visible focus order and switch semantics", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await openPrivacy(page, "/settings/privacy");

  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveAccessibleName("本文へスキップ");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveAccessibleName("マイページへ戻る");
  for (const name of SWITCHES) {
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    await expect(focused).toHaveRole("switch");
    await expect(focused).toHaveAccessibleName(name);
  }
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveAccessibleName(/非表示対象を管理/);
  // Collapsed panel content is skipped by Tab.
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveAccessibleName("デモ設定を保存");

  // Space toggles a switch; Enter opens the panel and adds a target.
  await page.getByRole("switch", { name: "同じ学校に表示しない" }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("switch", { name: "同じ学校に表示しない" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: /非表示対象を管理/ }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveAccessibleName("デモ学校A（架空）を追加");
  await page.keyboard.press("Enter");
  await expect(page.locator(":focus")).toHaveAccessibleName("デモ学校A（架空）を解除");

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator("body").focus();
  await expectFocusNeverHidden(page, 16);
  await expectTargets44(page);

  await saveButton(page).focus();
  await page.keyboard.press("Enter");
  await expect(footer(page).getByRole("status")).toHaveText("デモ設定を保存しました。");
  await page.getByRole("link", { name: "マイページへ戻る" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${ORIGIN}/mypage`);
});
