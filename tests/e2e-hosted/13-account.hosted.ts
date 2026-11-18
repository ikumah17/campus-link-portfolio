import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import { appGet } from "./request";
import { ownSession } from "./retention";
import { environment, evidence, readState } from "./state";
import { loadedPhoto, photoPng, userPage } from "./ui";

// ACCOUNT-001, its own invocation (CAMPUS_E2E_ACCOUNT=1): run user 0 pauses, resumes and deletes its own account
// through /settings/account; the session ends and a fresh sign-in (ACCOUNT-002) leaves no session and reaches no app page.
// ACCOUNT-003: a token and a browser session taken before the deletion are then refused by the database and the photo
// route; that step skips while hosted lacks migration order 17 (HOSTED-005 applies it). ACCOUNT-004: the same token's
// my_account then reads only its id and 'deleted'; that step skips while hosted lacks order 18 (HOSTED-006 applies it).
// Teardown deletes both run users.
test.describe.configure({ mode: "serial" });

// Run user 0's own access token from the public password grant. Provider bodies and tokens never leave these helpers.
async function ownToken(index: number): Promise<string> {
  const user = readState().users[index];
  const login = await publicFetch("/auth/v1/token?grant_type=password", { method: "POST", body: { email: user.email, password: user.password } });
  const data = login.body as { access_token?: unknown; user?: { id?: unknown } } | null;
  if (login.status !== 200 || data?.user?.id !== user.id || typeof data.access_token !== "string") throw new Error("Hosted own-account sign-in failed (details suppressed)");
  return data.access_token;
}
async function publicFetch(path: string, options: { method: "GET" | "POST"; body?: unknown; jwt?: string }) {
  const env = environment();
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!key) throw new Error("Missing hosted public credential");
  try {
    const response = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}${path}`, {
      method: options.method, signal: AbortSignal.timeout(30_000),
      headers: { apikey: key, ...(options.jwt ? { Authorization: `Bearer ${options.jwt}` } : {}), "Content-Type": "application/json" },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) as unknown };
  } catch { throw new Error("Hosted own-account transport failed (details suppressed)"); }
}
/** An RPC as the token's caller: "rows:<n>", "forbidden", or a fixed failure label (no provider text). */
async function asToken(jwt: string, name: string, args: Record<string, unknown> = {}) {
  const value = await publicFetch(`/rest/v1/rpc/${name}`, { method: "POST", body: args, jwt });
  const row = value.body as { code?: unknown; message?: unknown } | null;
  if (value.status === 200 && Array.isArray(value.body)) return { answer: `rows:${value.body.length}`, rows: value.body as Record<string, unknown>[] };
  if (value.status === 400 && row?.code === "P0001" && row.message === "forbidden") return { answer: "forbidden", rows: [] };
  return { answer: `unexpected:${value.status}`, rows: [] };
}

// Taken in the first test before the deletion, used by the second.
let before: { jwt: string; photoId: string; context: BrowserContext } | null = null;
test.afterAll(async () => { await before?.context.close(); before = null; });

async function onboard(browser: Browser, i: number): Promise<string> {
  const page = await userPage(browser, i, "/onboarding");
  try {
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
    const photoId = (await page.getByAltText("登録した写真 1", { exact: true }).getAttribute("src"))!.replace("/media/photos/", "");
    await page.getByRole("button", { name: "プロフィールを完成", exact: true }).click();
    await expect(page.getByText("プロフィールを作成しました。", { exact: true })).toBeVisible();
    return photoId;
  } finally { await page.context().close(); }
}

test("a run user pauses, resumes and deletes its own account, then cannot use the app", async ({ browser }) => {
  test.setTimeout(300_000);
  const photoId = await onboard(browser, 0);
  const page = await userPage(browser, 0, "/settings/account");
  try {
    await expect(page.getByRole("heading", { level: 1, name: "アカウント" })).toBeVisible();
    await expect(page.getByText("利用中です。", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "休止する", exact: true }).click();
    await expect(page.getByText("休止しました。", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText("休止中です。", { exact: true })).toBeVisible();
    expect(await (await ownSession(0)).accountStatus()).toBe("deactivated");
    await page.goto("/mypage");
    await expect(page.getByText(/アカウントは休止中です。/)).toBeVisible();
    await page.getByRole("link", { name: "再開する", exact: true }).click();
    await page.getByRole("button", { name: "再開する", exact: true }).click();
    await expect(page.getByText("再開しました。", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText("利用中です。", { exact: true })).toBeVisible();
    expect(await (await ownSession(0)).accountStatus()).toBe("active");

    // ACCOUNT-003: a token and a second browser session from before the deletion, as on another device.
    const other = await userPage(browser, 0, "/mypage");
    before = { jwt: await ownToken(0), photoId, context: other.context() };
    expect((await appGet(other.request, `/media/photos/${photoId}`)).status()).toBe(200);
    expect((await asToken(before.jwt, "my_reports")).answer).toBe("rows:0");

    await page.getByRole("button", { name: "退会の手続きへ", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "退会しますか" });
    await expect(dialog.getByRole("button", { name: "退会する", exact: true })).toBeDisabled();
    await dialog.getByRole("textbox").fill("退会する");
    await dialog.getByRole("button", { name: "退会する", exact: true }).click();
    await page.waitForURL(url => url.pathname === "/settings/account/deleted");
    await expect(page.getByRole("heading", { level: 1, name: "退会の手続きが完了しました" })).toBeVisible();
    const status = await (await ownSession(0)).accountStatus();
    expect(status).toBe("deleted");

    // The deletion ended this browser's session: protected pages go to the login form.
    await page.goto("/mypage");
    await page.waitForURL(url => url.pathname === "/login");
    // A fresh sign-in still finds the Auth user (retention removes it later): the action ends that session at once
    // and answers exactly like a wrong password, so the form confirms nothing about the account.
    const run = readState().users[0];
    const answers: string[] = [];
    for (const password of [run.password, `${run.password}-wrong`]) {
      await page.goto("/login?next=%2Fmypage");
      try {
        await page.getByLabel("メールアドレス", { exact: true }).fill(run.email, { timeout: 10_000 });
        await page.getByLabel("パスワード", { exact: true }).fill(password, { timeout: 10_000 });
      } catch { throw new Error("Hosted UI login failed (credential details suppressed)"); }
      await page.getByRole("button", { name: "ログイン", exact: true }).click();
      const alert = page.getByRole("main").getByRole("alert");
      await expect(alert).toHaveText("ログインできませんでした。メールアドレスとパスワード、または確認メールの手続きをご確認ください。");
      expect(new URL(page.url()).pathname).toBe("/login");
      answers.push(await alert.innerText());
    }
    expect(answers[0]).toBe(answers[1]);
    expect((await page.context().cookies()).filter(cookie => /^sb-.*-auth-token/.test(cookie.name))).toEqual([]);
    const refused = ["/mypage", "/verification", "/", "/settings/account", "/search"];
    for (const path of refused) {
      await page.goto(path);
      await page.waitForURL(url => url.pathname === "/login");
    }
    evidence("account", { status: "pass", pauseResume: "deactivated then active (UI and own my_account)", deletion: "request_account_deletion via /settings/account",
      accountStatus: status, sessionEnded: true, reSignIn: "signed out at once; same message as a wrong password; no auth cookie", reSignInRefused: refused });
  } finally { await page.context().close(); }
});

test("a token and a browser session from before the deletion are refused by the database and the photo route (ACCOUNT-003)", async () => {
  if (!before) throw new Error("The deletion step did not record its earlier session");
  const { jwt, photoId, context } = before;
  // Order-17 marker: discover_profiles answered a deleted caller with zero rows before ACCOUNT-003 and refuses it after.
  const marker = (await asToken(jwt, "discover_profiles", {})).answer;
  if (marker !== "forbidden" && marker !== "rows:0") throw new Error(`Unexpected order-17 marker answer ${marker}`);
  test.skip(marker === "rows:0", "Hosted lacks migration order 17 (ACCOUNT-003): HOSTED-005 applies it and reruns this test.");
  const account = await asToken(jwt, "my_account");
  expect(account.rows.map(row => row.account_status)).toEqual(["deleted"]);
  const refused: Record<string, string> = {};
  for (const [name, args] of [["my_reports", {}], ["list_my_likes", { p_direction: "received" }], ["list_my_blocks", {}], ["authorize_photo_delivery", { p_photo_ids: [photoId] }]] as const) {
    refused[name] = (await asToken(jwt, name, args)).answer;
  }
  expect(refused).toEqual({ my_reports: "forbidden", list_my_likes: "forbidden", list_my_blocks: "forbidden", authorize_photo_delivery: "forbidden" });
  const ownRows = await publicFetch("/rest/v1/profiles?select=user_id", { method: "GET", jwt });
  expect([ownRows.status, ownRows.body]).toEqual([200, []]);
  const photo = await appGet(context.request, `/media/photos/${photoId}`);
  expect([photo.status(), photo.headers()["cache-control"]]).toEqual([404, "no-store"]);
  evidence("accountDb", { status: "pass", marker: "discover_profiles refuses a deleted caller (order 17)", myAccount: "deleted",
    refused, ownRowSelect: "profiles: no rows", photoRoute: 404 });
});

test("the pre-deletion token's my_account reads only its id and 'deleted' (ACCOUNT-004)", async () => {
  if (!before) throw new Error("The deletion step did not record its earlier session");
  const { rows } = await asToken(before.jwt, "my_account");
  expect(rows.map(row => row.account_status)).toEqual(["deleted"]);
  // Order-18 marker: before ACCOUNT-004 the deleted caller still read the birth date it entered during onboarding.
  const birth = rows[0].birth_date;
  if (birth !== null && birth !== "2000-01-02") throw new Error("Unexpected order-18 marker answer");
  test.skip(birth === "2000-01-02", "Hosted lacks migration order 18 (ACCOUNT-004): HOSTED-006 applies it and reruns this test.");
  expect(rows).toEqual([{
    user_id: readState().users[0].id, has_profile: true, account_status: "deleted", profile_completed: false, age_verified: false, adult: false,
    affiliation_status: null, affiliation_confirmed: false, has_active_photo: false, eligible: false, birth_date: null,
  }]);
  evidence("accountMyAccount", { status: "pass", marker: "my_account hides the deleted caller's birth date (order 18)",
    myAccount: "own id and 'deleted'; birth_date and affiliation_status null; every flag false" });
});
