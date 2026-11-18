import { test, expect, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { credentials, evidence, readState } from "./state";
import { confirmTokenHash } from "./lifecycle";
import { totp } from "./totp";
import { Session } from "./concurrency";
import { appGet } from "./request";
import { discover, likeBack, likeOnProfile, likesTab, login, loadedPhoto, openRoom, photoPng, sendMessage, submissionIds, userPage } from "./ui";

// A11Y-002, its own invocation (CAMPUS_E2E_A11Y=1): axe on the screens that render only against hosted Supabase,
// with the rule tags and serious/critical threshold of tests/a11y.spec.ts, at 390 and 1280 px, closed and opened.
// The run's two fictional users go through onboarding and the synthetic verification; e2e-admin approves only those
// submissions, opens the run's own report, and grants and removes a reviewer role on run user A. Run user B (no factor,
// no role) opens the /admin/mfa enrolment form and enters a wrong code, so its factor stays unverified (TEST-005). No
// account deletion is confirmed. TEST-006 follows run user A's own confirmation links (admin generate_link, no email)
// through /auth/confirmed. Evidence keeps the screen, width, state and violation counts by impact only, never the
// key, QR code or code; teardown deletes both users and with them B's unverified factor. TEST-010 adds the live screens'
// empty, gate and opened states on the same users and sessions, and rejects A's first submission once so A's
// /verification is checked after a rejection before A resubmits it and e2e-admin approves it (one more UI sign-in for A).
// TEST-011 adds two refused grants on /admin/staff (no account; B without a factor), which write nothing, and, last,
// A blocks B and unblocks them on /settings/blocks (one more UI sign-in for A, none for e2e-admin).
test.describe.configure({ mode: "serial" });

type Impact = "critical" | "serious" | "moderate" | "minor";
type Row = { screen: string; width: number; state: string; violations: Record<Impact, number>; rules: string[] };
const rows: Row[] = [];
const unreachable: string[] = [];
let emptyState: "audited" | "skipped (other rows)" | "not reached" = "not reached";
function record(status: "pass" | "fail" | "partial") { evidence("a11y", { status, widths: [390, 1280], rows, unreachable, emptyState }); }

// Same tags and threshold as A11Y-001. Failure messages carry rule ids and counts only, never DOM text or targets.
async function audit(page: Page, screen: string, state: string) {
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.passes.length, "axe evaluated rules on the page").toBeGreaterThan(0);
    const violations: Record<Impact, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    for (const v of results.violations) violations[(v.impact ?? "minor") as Impact] += v.nodes.length;
    const rules = results.violations.map(v => `${v.id}:${v.impact}:${v.nodes.length}`);
    rows.push({ screen, width, state, violations, rules });
    record("partial");
    expect.soft(results.violations.filter(v => v.impact === "serious" || v.impact === "critical").map(v => `${v.id}:${v.impact}:${v.nodes.length}`),
      `${screen} at ${width} (${state})`).toEqual([]);
  }
}

let admin: Page | null = null;
let profile: string | null = null;
let reportUrl: string | null = null;
test.afterAll(async () => { await admin?.context().close(); admin = null; });

// adminPage() without its enrolment branch, auditing the challenge form before the code is entered.
async function adminWithMfaAudit(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const local = credentials();
    await login(page, local.admin, "/admin/mfa");
    await page.getByRole("heading", { name: "二段階認証" }).waitFor();
    if (!await page.getByLabel("6桁のコード", { exact: true }).isVisible()) throw new Error("e2e-admin must already have a verified TOTP factor");
    await audit(page, "/admin/mfa", "challenge form");
    const secret = local.adminTotpSecret;
    if (!secret) throw new Error("Missing saved enrollment");
    try {
      const remaining = 30_000 - Date.now() % 30_000;
      await new Promise(resolve => setTimeout(resolve, remaining + 500));
      await page.getByLabel("6桁のコード", { exact: true }).fill(totp(secret), { timeout: 10_000 });
      await page.getByRole("button", { name: "確認", exact: true }).click();
      await page.waitForURL(url => url.pathname === "/admin");
    } catch { throw new Error("Hosted administrator MFA failed (credential details suppressed)"); }
    return page;
  } catch (error) { await context.close(); throw error; }
}

async function onboard(browser: Browser, i: number) {
  const page = await userPage(browser, i, "/onboarding");
  try {
    if (i === 0) {
      await expect(page.getByLabel("表示名", { exact: true })).toBeVisible();
      await audit(page, "/onboarding", "profile step");
    }
    await page.getByLabel("表示名", { exact: true }).fill(readState().users[i].name);
    await page.getByRole("radio", { name: "その他", exact: true }).check();
    await page.getByLabel("生年月日", { exact: true }).fill("2000-01-02");
    await page.getByLabel("18歳以上です", { exact: true }).check();
    await page.getByRole("button", { name: "次へ", exact: true }).click();
    await page.getByLabel("学校", { exact: true }).selectOption("00000000-0000-4000-8000-00000000a001");
    await page.getByLabel("学科", { exact: true }).selectOption("00000000-0000-4000-8000-00000000b011");
    await page.getByLabel("クラス", { exact: true }).selectOption(`00000000-0000-4000-8000-00000000c11${i + 1}`);
    await page.getByRole("button", { name: "次へ", exact: true }).click();
    await page.getByRole("button", { name: "次へ", exact: true }).click();
    await page.getByRole("checkbox", { name: "友達がほしい", exact: true }).check();
    await page.getByLabel("自己紹介（任意）", { exact: true }).fill("架空の動作確認用プロフィールです。");
    await page.getByRole("button", { name: "確認へ", exact: true }).click();
    await page.getByRole("button", { name: "プロフィールを保存", exact: true }).click();
    await page.getByLabel("写真を追加", { exact: true }).setInputFiles({ name: "fictional.png", mimeType: "image/png", buffer: await photoPng() });
    await loadedPhoto(page, "登録した写真 1");
    await page.getByRole("button", { name: "プロフィールを完成", exact: true }).click();
    await expect(page.getByText("プロフィールを作成しました。", { exact: true })).toBeVisible();
  } finally { await page.context().close(); }
}

test("admin MFA challenge and verification detail decision controls (run-owned synthetic submissions)", async ({ browser }) => {
  test.setTimeout(420_000);
  for (let i = 0; i < 2; i++) await onboard(browser, i);
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const page = await userPage(browser, i, "/verification");
    try {
      if (i === 0) {
        await page.goto("/");
        await expect(page.getByRole("link", { name: "確認へ進む", exact: true })).toBeVisible();
        await audit(page, "/", "verification gate");
        await page.goto("/verification");
        await expect(page.getByText("未提出", { exact: true })).toHaveCount(2);
        await audit(page, "/verification", "not submitted");
      }
      for (const title of ["年齢確認", "在学確認"]) {
        const section = page.getByRole("region", { name: title, exact: true });
        await section.getByRole("button", { name: "架空のサンプル資料1", exact: true }).click();
        await section.getByRole("button", { name: "提出", exact: true }).click();
        await expect(section.getByText("提出済み", { exact: true })).toBeVisible();
      }
      await page.reload();
      const own = [...new Set(await submissionIds(page))];
      expect(own.length).toBe(2);
      if (i === 0) await audit(page, "/verification", "both submitted");
      ids.push(...own);
    } finally { await page.context().close(); }
  }
  admin = await adminWithMfaAudit(browser);
  await expect(admin.getByRole("heading", { level: 1, name: "管理画面", exact: true })).toBeVisible();
  await audit(admin, "/admin", "dashboard");
  const audited = new Set<string>();
  let rejected: "age" | "enrollment" | null = null;
  for (const id of ids) {
    await admin.goto("/admin/verifications");
    if (id === ids[0]) await audit(admin, "/admin/verifications", "queue with the run's submissions");
    // Claim only the run's own submission, by its serialized ID (as in 2-verification).
    const index = (await submissionIds(admin)).indexOf(id);
    expect(index, "run-owned submission is in the rendered review queue").toBeGreaterThanOrEqual(0);
    await admin.getByRole("region", { name: "提出一覧" }).getByRole("listitem").nth(index).getByRole("button", { name: "担当する" }).click();
    await expect(admin).toHaveURL(new RegExp(`/admin/verifications/${id}$`));
    await expect.poll(() => admin!.getByAltText("提出資料 1").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    const kind = await admin.getByLabel("有効期限").count() ? "enrollment" : "age";
    if (!audited.has(kind)) {
      audited.add(kind);
      await audit(admin, "/admin/verifications/[id]", `${kind}: decision controls`);
      const reason = admin.getByLabel("却下理由");
      await reason.selectOption({ index: 1 });
      await expect(admin.getByRole("button", { name: "却下", exact: true })).toBeEnabled();
      await audit(admin, "/admin/verifications/[id]", `${kind}: rejection reason selected`);
      await reason.selectOption("");
    }
    // A's first submission is rejected once (TEST-010), then resubmitted and approved below.
    if (id === ids[0]) {
      rejected = kind;
      await admin.getByLabel("却下理由").selectOption({ index: 1 });
      await admin.getByRole("button", { name: "却下", exact: true }).click();
    } else await admin.getByRole("button", { name: "承認", exact: true }).click();
    await expect(admin.getByRole("status")).toHaveText("審査結果を保存しました。");
  }
  expect([...audited].sort()).toEqual(["age", "enrollment"]);
  if (!rejected) throw new Error("No run submission was rejected");
  const a = await userPage(browser, 0, "/verification");
  let resubmitted: string[];
  try {
    const section = a.getByRole("region", { name: rejected === "age" ? "年齢確認" : "在学確認", exact: true });
    await expect(section.getByText("却下", { exact: true })).toBeVisible();
    await audit(a, "/verification", "after a rejection");
    await section.getByRole("button", { name: "架空のサンプル資料1", exact: true }).click();
    await section.getByRole("button", { name: "提出", exact: true }).click();
    await expect(section.getByText("提出済み", { exact: true })).toBeVisible();
    await a.reload();
    resubmitted = await submissionIds(a);
    expect(resubmitted.length).toBe(1);
  } finally { await a.context().close(); }
  await admin.goto("/admin/verifications");
  const index = (await submissionIds(admin)).indexOf(resubmitted[0]);
  expect(index, "resubmitted run-owned submission is in the rendered review queue").toBeGreaterThanOrEqual(0);
  await admin.getByRole("region", { name: "提出一覧" }).getByRole("listitem").nth(index).getByRole("button", { name: "担当する" }).click();
  await expect(admin).toHaveURL(new RegExp(`/admin/verifications/${resubmitted[0]}$`));
  await admin.getByRole("button", { name: "承認", exact: true }).click();
  await expect(admin.getByRole("status")).toHaveText("審査結果を保存しました。");
  if (await admin.getByText("この状態の提出はありません。", { exact: true }).isVisible()) await audit(admin, "/admin/verifications", "empty queue");
  else unreachable.push("/admin/verifications empty queue (other submissions present)");
  await admin.goto("/admin/affiliations");
  await expect(admin.getByRole("heading", { level: 1, name: "学校・学科・クラス" })).toBeVisible();
  await audit(admin, "/admin/affiliations", "master list");
});

test("report detail decision controls and the suspension dialog (opened, then cancelled)", async ({ browser }) => {
  const state = readState();
  const a = await userPage(browser, 0);
  try {
    await discover(a, state.users[1].name);
    await audit(a, "/", "discover with a result");
    await a.goto("/?min=120");
    await expect(a.getByText("条件に合うプロフィールはありません", { exact: true })).toBeVisible();
    await audit(a, "/", "search with no results");
    await a.goto("/search");
    await expect(a.getByRole("heading", { name: "検索条件" })).toBeVisible();
    await audit(a, "/search", "search conditions");
    await (await discover(a, state.users[1].name)).click();
    await expect(a.getByRole("heading", { level: 1 })).toContainText(state.users[1].name);
    profile = new URL(a.url()).pathname;
    await audit(a, "/profiles/[id]", "profile detail");
    await a.getByRole("button", { name: "通報", exact: true }).click();
    await expect(a.getByRole("dialog").getByLabel("詳細（任意）")).toBeVisible();
    await audit(a, "/profiles/[id]", "report dialog");
    await a.getByRole("dialog").getByLabel("詳細（任意）").fill(`架空の通報 ${state.runId}`);
    await a.getByRole("dialog").getByRole("button", { name: "通報する", exact: true }).click();
    await expect(a.getByRole("dialog").getByRole("status")).toHaveText("通報を受け付けました。");
  } finally { await a.context().close(); }
  // Find the exact run report through read-only detail pages, as in 6-moderation.
  await admin!.goto("/admin/reports");
  await audit(admin!, "/admin/reports", "list with the run's report");
  const hrefs = await admin!.locator('a[href^="/admin/reports/"]').evaluateAll(links => links.map(link => link.getAttribute("href")!));
  let found = false;
  for (const href of hrefs) {
    await admin!.goto(href);
    if (await admin!.getByText(`架空の通報 ${state.runId}`, { exact: true }).isVisible()) { found = true; break; }
  }
  expect(found, "exact run-owned report found").toBe(true);
  reportUrl = admin!.url();
  await expect(admin!.getByRole("group", { name: "状態の変更" })).toBeVisible();
  await audit(admin!, "/admin/reports/[id]", "decision controls");
  await admin!.getByRole("button", { name: "アカウントを停止", exact: true }).click();
  const dialog = admin!.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "停止する", exact: true })).toBeVisible();
  await audit(admin!, "/admin/reports/[id]", "suspension dialog");
  await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

// TEST-009: B is suspended from the run's own report (the 6-moderation path), /admin/accounts is checked with B listed
// and with the reactivation dialog open, and B is reactivated there. The finally block reactivates B from the report
// if it is still suspended, so the later chat and MFA steps always see an active B. Rows are found by the run state's
// display name inside hidden(), so neither B's name nor any other row reaches the reporter or evidence.
test("suspended accounts list and the reactivation dialog (run user B suspended, then reactivated)", async () => {
  const name = readState().users[1].name;
  if (!reportUrl) throw new Error("The report step did not record the run-owned report");
  const own = () => admin!.getByRole("listitem").filter({ has: admin!.getByRole("heading", { level: 2, name, exact: true }) });
  let suspended = false;
  try {
    await admin!.goto(reportUrl);
    await admin!.getByRole("button", { name: "アカウントを停止", exact: true }).click();
    suspended = true;   // set before the click, so a failed confirmation still reaches the finally block
    await admin!.getByRole("dialog").getByRole("button", { name: "停止する", exact: true }).click();
    await expect(admin!.getByRole("status")).toHaveText("アカウントを停止しました。");
    await admin!.goto("/admin/accounts");
    await expect(admin!.getByRole("heading", { level: 1, name: "停止中のアカウント", exact: true })).toBeVisible();
    await hidden("Run user B is not listed once in /admin/accounts", () => expect(own()).toHaveCount(1));
    await audit(admin!, "/admin/accounts", "suspended list");
    await hidden("B's reactivation dialog did not open", async () => {
      await own().getByRole("button", { name: "停止を解除", exact: true }).click();
      await expect(admin!.getByRole("dialog").getByRole("button", { name: "解除する", exact: true })).toBeVisible();
    });
    await audit(admin!, "/admin/accounts", "reactivation dialog");
    await admin!.getByRole("dialog").getByRole("button", { name: "解除する", exact: true }).click();
    await expect(admin!.getByRole("main").getByRole("status")).toHaveText("停止を解除しました。");
    suspended = false;
    await hidden("Run user B is still listed after reactivation", () => expect(own()).toHaveCount(0));
    if (await admin!.getByText("停止中のアカウントはありません。", { exact: true }).isVisible()) {
      await audit(admin!, "/admin/accounts", "empty");
      emptyState = "audited";
    } else emptyState = "skipped (other rows)";
    record("partial");
  } finally {
    if (suspended) {
      await admin!.goto(reportUrl);
      await admin!.getByRole("button", { name: "停止を解除", exact: true }).click();
      await admin!.getByRole("dialog").getByRole("button", { name: "再開する", exact: true }).click();
      await expect(admin!.getByRole("status")).toHaveText("アカウントを再開しました。");
    }
  }
});

test("staff screen and the role removal dialog (reviewer granted to run user A, then removed)", async () => {
  const user = readState().users[0];
  await Session.signIn(0, true);   // SEC-003 (order 20): a role is granted only to an account with a verified TOTP factor
  await admin!.goto("/admin/staff");
  await expect(admin!.getByRole("heading", { level: 1, name: "担当者と役割" })).toBeVisible();
  await audit(admin!, "/admin/staff", "list and grant form");
  // TEST-011: two refusals that write nothing (order 14 not_available, order 20 mfa_required for B, who has no factor).
  const state = readState();
  const staffRows = () => admin!.getByRole("main").getByRole("listitem").count();
  const before = await staffRows();
  await hidden("The grant to an address with no account was not refused", async () => {
    await admin!.getByLabel("メールアドレス", { exact: true }).fill(`e2e-no-account-${state.runId}@example.invalid`);
    await admin!.getByRole("combobox", { name: /^役割/ }).selectOption("reviewer");
    await admin!.getByRole("button", { name: "付与する", exact: true }).click();
    await expect(admin!.getByRole("status")).toHaveText("該当するアカウントがありません。");
  });
  await audit(admin!, "/admin/staff", "grant refused: no account");
  await hidden("The grant to run user B (no TOTP factor) was not refused", async () => {
    await admin!.getByLabel("メールアドレス", { exact: true }).fill(state.users[1].email);
    await admin!.getByRole("combobox", { name: /^役割/ }).selectOption("reviewer");
    await admin!.getByRole("button", { name: "付与する", exact: true }).click();
    await expect(admin!.getByRole("status")).toHaveText("二段階認証（TOTP）を登録済みのアカウントにだけ役割を付けられます。");
  });
  await audit(admin!, "/admin/staff", "grant refused: no verified factor");
  await admin!.reload();
  await expect(admin!.getByRole("heading", { level: 1, name: "担当者と役割" })).toBeVisible();
  await hidden("A refused grant changed the staff list", async () => {
    expect(await staffRows()).toBe(before);
    await expect(admin!.getByRole("heading", { level: 2, name: state.users[1].name, exact: true })).toHaveCount(0);
  });
  await admin!.getByLabel("メールアドレス", { exact: true }).fill(user.email);
  await admin!.getByRole("combobox", { name: /^役割/ }).selectOption("reviewer");
  await admin!.getByRole("button", { name: "付与する", exact: true }).click();
  await expect(admin!.getByRole("status")).toHaveText("役割を付与しました。");
  const row = admin!.getByRole("listitem").filter({ has: admin!.getByRole("heading", { name: user.name, exact: true }) });
  await row.getByRole("button", { name: "学生認証審査を外す", exact: true }).click();
  const dialog = admin!.getByRole("dialog", { name: "役割を外す" });
  await expect(dialog).toBeVisible();
  await audit(admin!, "/admin/staff", "role removal dialog");
  await dialog.getByRole("button", { name: "外す", exact: true }).click();
  await expect(admin!.getByRole("status")).toHaveText("役割を外しました。");
  await expect(row).toHaveCount(0);
});

test("live chat room with a received message, then the composer filled", async ({ browser }) => {
  const state = readState();
  if (!profile) throw new Error("The report step did not record B's profile path");
  const a = await userPage(browser, 0, profile);
  const b = await userPage(browser, 1, "/likes");
  try {
    // B has no like and no connection yet (TEST-010 empty states).
    await expect(b.getByText("まだいいねはありません。", { exact: true })).toBeVisible();
    await audit(b, "/likes", "received empty");
    await b.getByRole("tab", { name: "いいねした", exact: true }).click();
    await expect(b.getByText("まだいいねしていません。", { exact: true })).toBeVisible();
    await audit(b, "/likes", "sent empty");
    await b.goto("/talk");
    await expect(b.getByText("つながりはまだありません。", { exact: true })).toBeVisible();
    await audit(b, "/talk", "empty list");
    await expect(a.getByRole("button", { name: `${state.users[1].name}にいいね`, exact: true })).toBeVisible();
    await audit(a, "/profiles/[id]", "like button");
    await likeOnProfile(a, state.users[1].name);
    await audit(a, "/profiles/[id]", "liked");
    const sent = await likesTab(a, "いいねした");
    await expect(sent.filter({ hasText: state.users[1].name })).toHaveCount(1);
    await audit(a, "/likes", "sent like");
    const received = await likesTab(b, "いいねされた");
    await expect(received.filter({ hasText: state.users[0].name })).toHaveCount(1);
    await audit(b, "/likes", "received like");
    await likeBack(b, state.users[0].name);
    await audit(b, "/likes", "matched");
    await openRoom(b, state.users[0].name);
    await sendMessage(b, "架空のメッセージです。");
    await a.goto("/talk");
    await expect(a.getByRole("link").filter({ has: a.getByRole("heading", { name: state.users[1].name, exact: true }) })).toBeVisible();
    await audit(a, "/talk", "list with a room");
    await openRoom(a, state.users[1].name);
    await expect(a.getByRole("log").getByText("架空のメッセージです。", { exact: true })).toBeVisible();
    await audit(a, "/talk/[id]", "room with a received message");
    await a.getByLabel("メッセージ", { exact: true }).fill("アクセシビリティ検査");
    await expect(a.getByRole("button", { name: "送信", exact: true })).toBeEnabled();
    await audit(a, "/talk/[id]", "composer filled");
  } finally { await a.context().close(); await b.context().close(); }
});

test("admin MFA enrolment form for run user B (no factor, no role), then a wrong code", async ({ browser }) => {
  const page = await userPage(browser, 1, "/admin/mfa");
  try {
    // Locator errors can carry DOM snapshots, so the enrolment steps replace them; the key is never read.
    try {
      await page.waitForURL(url => url.pathname === "/admin/mfa");
      await page.getByRole("heading", { level: 1, name: "二段階認証" }).waitFor();
      await page.getByRole("button", { name: "認証アプリを設定する", exact: true }).click({ timeout: 10_000 });
      await expect(page.getByRole("img", { name: "認証アプリに読み取らせるQRコード" })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByLabel("手入力用のキー", { exact: true })).toBeVisible();
      await expect(page.getByLabel("6桁のコード", { exact: true })).toBeVisible();
    } catch { throw new Error("Run user B did not reach the MFA enrolment form (details suppressed)"); }
    await audit(page, "/admin/mfa", "enrolment form");
    try {
      await page.getByLabel("6桁のコード", { exact: true }).fill("000000", { timeout: 10_000 });
      await page.getByRole("button", { name: "確認", exact: true }).click();
      await expect(page.getByRole("main").getByRole("alert")).toHaveText("コードが正しくありません。もう一度入力してください。", { timeout: 20_000 });
      await expect(page).toHaveURL(url => url.pathname === "/admin/mfa");
    } catch { throw new Error("The wrong-code state did not appear (details suppressed)"); }
    await audit(page, "/admin/mfa", "enrolment form: wrong code");
  } finally { await page.context().close(); }
});

// TEST-006: the SEC-005 interstitial against hosted Auth. Tokens come from the admin API's generate_link (no email is
// sent); only hashed_token is used, on the app's own /auth/confirm route. The token, the confirm URL and the address
// never reach evidence or error text: Playwright errors can echo URLs and locators, so each step replaces them.
async function hidden<T>(message: string, step: () => Promise<T>) {
  try { return await step(); } catch { throw new Error(`${message} (details suppressed)`); }
}
// Opens a confirmation link with a normal browser navigation and returns where it settled: route names, the error
// code and two checks, never the URL. FIX-001: the route's 307 carries a relative Location, so the browser stays on
// the suite's host (127.0.0.1) and keeps the session cookie the route just set.
async function openLink(page: Page, hash: string, next: string) {
  const location = await hidden("The confirmation link did not answer with a redirect", async () => {
    let request = (await page.goto(`/auth/confirm?token_hash=${hash}&type=email&next=${encodeURIComponent(next)}`))!.request();
    while (request.redirectedFrom()) request = request.redirectedFrom()!;
    const response = (await request.response())!;
    expect(response.status()).toBe(307);
    await page.waitForLoadState();
    return (await response.headerValue("location"))!;
  });
  const url = new URL(page.url());
  return {
    path: /^\/[a-z/]*$/.test(url.pathname) ? url.pathname : "other", error: url.searchParams.get("error"),
    relativeLocation: location.startsWith("/") && !location.startsWith("//"), sameHost: url.host === new URL(test.info().project.use.baseURL!).host,
  };
}

test("confirmation interstitial: continue, external next and decline, no session, used token (run user A)", async ({ browser }) => {
  const email = readState().users[0].email;
  const first = await confirmTokenHash(0);
  const observed: Record<string, unknown> = {};
  // 1. Continue path: the link's account is shown, then the checked next opens.
  let context = await browser.newContext();
  try {
    const page = await context.newPage();
    const landed = await openLink(page, first, "/mypage");
    observed.firstLink = landed;
    if (landed.path !== "/auth/confirmed" || !landed.relativeLocation || !landed.sameHost) { evidence("confirmedInterstitial", observed); throw new Error(`The first link landed on ${landed.path} (${landed.error})`); }
    await hidden("The interstitial did not show the link's account", async () => {
      expect(new URL(page.url()).searchParams.get("next")).toBe("/mypage");
      await expect(page.getByRole("heading", { level: 1, name: "このアカウントでログインしました" })).toBeVisible();
      await expect(page.getByText(email, { exact: true })).toBeVisible();
    });
    await audit(page, "/auth/confirmed", "confirmation interstitial");
    await hidden("Continue did not open /mypage", async () => {
      await page.getByRole("link", { name: "続ける", exact: true }).click();
      await page.waitForURL(url => url.pathname === "/mypage");
    });
    observed.continuePath = true;
  } finally { await context.close(); }
  // 2. An external next is dropped; the decline ends the session on this device.
  const second = await confirmTokenHash(0);
  context = await browser.newContext();
  try {
    const page = await context.newPage();
    const landed = await openLink(page, second, "https://example.com/x");
    observed.secondLink = landed;
    if (landed.path !== "/auth/confirmed" || !landed.relativeLocation || !landed.sameHost) { evidence("confirmedInterstitial", observed); throw new Error(`The second link landed on ${landed.path} (${landed.error})`); }
    await hidden("The external next was not dropped", async () => {
      expect(new URL(page.url()).search).toBe("");
      await expect(page.getByRole("link", { name: "続ける", exact: true })).toHaveAttribute("href", "/onboarding");
    });
    observed.externalNextDropped = true;
    await hidden("The decline did not sign the account out", async () => {
      await page.getByRole("button", { name: "自分のアカウントではありません", exact: true }).click();
      await page.waitForURL(url => url.pathname === "/login");
      await page.goto("/mypage");
      await page.waitForURL(url => url.pathname === "/login");
    });
    observed.declineEndsSession = true;
  } finally { await context.close(); }
  // 3. Without a session the page shows nothing and sends the visitor to /login.
  context = await browser.newContext();
  try {
    const page = await context.newPage();
    await hidden("The interstitial without a session did not go to /login", async () => {
      await page.goto("/auth/confirmed");
      await page.waitForURL(url => url.pathname === "/login");
      expect((await page.content()).includes(email)).toBe(false);
      expect(new URL(page.url()).host).toBe(new URL(test.info().project.use.baseURL!).host);
    });
    observed.noSessionToLogin = true;
    // The proxy's login gate answers an anonymous protected page with a relative Location too (FIX-001).
    await hidden("The proxy login redirect was not a relative /login", async () => {
      const response = await appGet(context.request, "/mypage", { maxRedirects: 0 });
      expect([response.status(), response.headers()["location"]]).toEqual([307, `/login?next=${encodeURIComponent("/mypage")}`]);
    });
    observed.proxyRelativeLogin = true;
  } finally { await context.close(); }
  // 4. The first token, already used (and replaced by the second), must not sign in again.
  context = await browser.newContext();
  try {
    const page = await context.newPage();
    observed.usedToken = await openLink(page, first, "/mypage");
    evidence("confirmedInterstitial", observed);
    expect(observed.usedToken, "the used link goes to /login?error=confirm").toMatchObject({ path: "/login", error: "confirm", relativeLocation: true, sameHost: true });
  } finally { await context.close(); }
});

test("account settings and the deletion confirmation (opened, never confirmed)", async ({ browser }) => {
  const page = await userPage(browser, 0, "/settings/account");
  try {
    await page.goto("/mypage");
    await expect(page.getByRole("heading", { level: 1, name: "マイページ" })).toBeVisible();
    await audit(page, "/mypage", "profile summary");
    await page.goto("/settings/privacy");
    await expect(page.getByRole("heading", { level: 1, name: "公開範囲設定" })).toBeVisible();
    await audit(page, "/settings/privacy", "settings");
    await page.goto("/settings/blocks");
    await expect(page.getByText("ブロック中のユーザーはいません。", { exact: true })).toBeVisible();
    await audit(page, "/settings/blocks", "no blocks, run report listed");
    await page.goto("/settings/account");
    await expect(page.getByRole("heading", { level: 1, name: "アカウント" })).toBeVisible();
    await expect(page.getByText("利用中です。", { exact: true })).toBeVisible();
    await audit(page, "/settings/account", "settings");
    await page.getByRole("button", { name: "退会の手続きへ", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "退会しますか" });
    await expect(dialog.getByRole("button", { name: "退会する", exact: true })).toBeDisabled();
    await audit(page, "/settings/account", "deletion confirmation");
    await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.reload();
    await expect(page.getByText("利用中です。", { exact: true })).toBeVisible();
  } finally { await page.context().close(); }
});

// TEST-011: last, after every step that needs A and B connected. A blocks B from their room, /settings/blocks is
// checked with B's entry and with the unblock dialog open, and A unblocks B there. B's row is found by the run state's
// display name inside hidden(), so it never reaches the reporter or evidence.
test("blocks list with an entry and the unblock dialog (A blocks run user B, then unblocks)", async ({ browser }) => {
  const state = readState();
  const page = await userPage(browser, 0, "/talk");
  let blocked = false;
  try {
    await openRoom(page, state.users[1].name);
    await page.getByRole("button", { name: "ブロック・通報", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "ブロック", exact: true }).click();
    blocked = true;   // set before the confirmation, so a failure still reaches the finally block
    await page.getByRole("dialog").getByRole("button", { name: "ブロックする", exact: true }).click();
    await expect(page.getByRole("heading", { name: "この会話は表示できません" })).toBeVisible();
    await page.goto("/settings/blocks");
    const own = () => page.getByRole("listitem").filter({ hasText: state.users[1].name });
    await hidden("Run user B is not listed once in /settings/blocks", () => expect(own()).toHaveCount(1));
    await audit(page, "/settings/blocks", "one block listed");
    await hidden("The unblock dialog did not open", async () => {
      await own().getByRole("button", { name: "ブロックを解除", exact: true }).click();
      await expect(page.getByRole("dialog").getByRole("button", { name: "ブロックを解除", exact: true })).toBeVisible();
    });
    await audit(page, "/settings/blocks", "unblock dialog");
    await page.getByRole("dialog").getByRole("button", { name: "ブロックを解除", exact: true }).click();
    await expect(page.getByText("ブロック中のユーザーはいません。", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText("ブロック中のユーザーはいません。", { exact: true })).toBeVisible();
    blocked = false;
  } finally {
    if (blocked) {
      await page.goto("/settings/blocks");
      const entry = page.getByRole("listitem").filter({ hasText: state.users[1].name });
      if (await entry.count()) {
        await entry.getByRole("button", { name: "ブロックを解除", exact: true }).click();
        await page.getByRole("dialog").getByRole("button", { name: "ブロックを解除", exact: true }).click();
        await expect(page.getByText("ブロック中のユーザーはいません。", { exact: true })).toBeVisible();
      }
    }
    await page.context().close();
  }
  record(rows.some(r => r.violations.critical + r.violations.serious > 0) ? "fail" : "pass");
});
