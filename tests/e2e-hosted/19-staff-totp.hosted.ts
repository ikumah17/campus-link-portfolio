import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { projectRef } from "./retention";
import { credentials, environment, evidence, readState } from "./state";
import { totp } from "./totp";
import { adminPage, userPage } from "./ui";

// TEST-016, its own invocation (CAMPUS_E2E_STAFF_TOTP=1): order 29 (SEC-013) on hosted. A staff role acts only while
// the account has no verified factor created after the grant. Run user A enrolls its own TOTP on /admin/mfa and
// e2e-admin grants it reviewer on /admin/staff; A at aal2 sees the reviewer entry, my_staff_roles lists reviewer and
// admin_list_submissions answers. A then gets a second verified factor through its own Auth session (first the way
// Session.signIn(i, true) does it, at aal1 right after the password grant; if Auth refuses that, with A's own aal2
// session). After signing in again at aal2 with the grant-time factor, the RPC is forbidden, my_staff_roles is empty
// and /admin is the not-found page. e2e-admin revokes and grants reviewer again on the screen and everything acts
// again. Teardown revokes A's role on the screen, and e2e-admin must end with its three roles acting. e2e-admin's
// factor is never enrolled, removed or replaced here. Keys and codes stay in Node memory; evidence keeps answers only.
test.describe.configure({ mode: "serial" });

type Factor = { id: string; secret: string };
type Reply = { status: number; body: unknown };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const granted = "役割を付与しました。";
const revoked = "役割を外しました。";

async function publicFetch(path: string, options: { method: "GET" | "POST"; body?: unknown; jwt?: string }): Promise<Reply> {
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
  } catch { throw new Error("Hosted staff-TOTP transport failed (details suppressed)"); }
}
const field = (value: unknown, name: string) => value !== null && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined;
/** An RPC as the token's caller: "rows:<n>", "forbidden", or a fixed failure label (no provider text). */
async function asToken(jwt: string, name: string, args: Record<string, unknown> = {}) {
  const value = await publicFetch(`/rest/v1/rpc/${name}`, { method: "POST", body: args, jwt });
  if (value.status === 200 && Array.isArray(value.body)) return { answer: `rows:${value.body.length}`, rows: value.body as unknown[] };
  if (value.status === 400 && field(value.body, "code") === "P0001" && field(value.body, "message") === "forbidden") return { answer: "forbidden", rows: [] };
  return { answer: `unexpected:${value.status}`, rows: [] };
}
const ownRoles = async (jwt: string) => {
  const value = await asToken(jwt, "my_staff_roles");
  if (!value.answer.startsWith("rows:")) throw new Error(`my_staff_roles refused (${value.answer})`);
  return value.rows.map(row => String(field(row, "role"))).sort();
};
const claims = (token: string) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
// The browser session's own access token, from the @supabase/ssr cookie (whole or chunked, optionally base64-).
// Its assurance level and identity are checked; the token and cookie never leave this boundary.
async function sessionJwt(context: BrowserContext, aal: "aal1" | "aal2", identity: { sub?: string; email?: string }) {
  const key = `sb-${projectRef}-auth-token`;
  const cookies = await context.cookies();
  try {
    const whole = cookies.find(cookie => cookie.name === key);
    const chunks = cookies.filter(cookie => cookie.name.startsWith(`${key}.`) && /^\d+$/.test(cookie.name.slice(key.length + 1)))
      .sort((a, b) => Number(a.name.slice(key.length + 1)) - Number(b.name.slice(key.length + 1)));
    const raw = whole ? whole.value : chunks.map(cookie => cookie.value).join("");
    const json = raw.startsWith("base64-") ? Buffer.from(raw.slice(7), "base64url").toString("utf8") : decodeURIComponent(raw);
    const token = JSON.parse(json).access_token;
    const values = claims(token);
    if (typeof token !== "string" || values.aal !== aal || (identity.sub && values.sub !== identity.sub) ||
      (identity.email && values.email !== identity.email)) throw new Error();
    return token as string;
  } catch { throw new Error(`Browser session is not the expected ${aal} identity (details suppressed)`); }
}

// A code is used at most once per factor and 30-second window, as adminPage avoids replaying one across sessions.
const usedWindow = new Map<string, number>();
async function code(factor: Factor) {
  if (usedWindow.get(factor.id) === Math.floor(Date.now() / 30_000)) await new Promise(resolve => setTimeout(resolve, 30_000 - Date.now() % 30_000 + 500));
  usedWindow.set(factor.id, Math.floor(Date.now() / 30_000));
  return totp(factor.secret);
}
/** A's own password session (aal1), from Auth with the publishable key, exact identity checked. */
async function passwordJwt() {
  const user = readState().users[0];
  const value = await publicFetch("/auth/v1/token?grant_type=password", { method: "POST", body: { email: user.email, password: user.password } });
  const token = field(value.body, "access_token");
  if (value.status !== 200 || field(field(value.body, "user"), "id") !== user.id || typeof token !== "string") throw new Error("Hosted run-user sign-in failed (details suppressed)");
  return token;
}
/** Challenge and verify one of A's factors with the given session; returns the aal2 token Auth answers. */
async function verify(jwt: string, factor: Factor) {
  const challenge = await publicFetch(`/auth/v1/factors/${factor.id}/challenge`, { method: "POST", body: {}, jwt });
  const challengeId = field(challenge.body, "id");
  if (challenge.status !== 200 || typeof challengeId !== "string" || !uuid.test(challengeId)) throw new Error("TOTP challenge failed (details suppressed)");
  const verified = await publicFetch(`/auth/v1/factors/${factor.id}/verify`, { method: "POST", body: { challenge_id: challengeId, code: await code(factor) }, jwt });
  const token = field(verified.body, "access_token");
  if (verified.status !== 200 || typeof token !== "string") throw new Error("TOTP verification failed (details suppressed)");
  const values = claims(token);
  if (values.aal !== "aal2" || values.sub !== readState().users[0].id) throw new Error("TOTP session identity or assurance mismatch");
  return token;
}
/** A signs in again: a fresh password session, stepped up to aal2 with the given (grant-time) factor. */
const signInAal2 = async (factor: Factor) => verify(await passwordJwt(), factor);
/** Enrolls a TOTP factor with A's own session and verifies it. Returns the refusal status and Auth's error code instead
 *  when Auth refuses the enrollment; the response body never leaves this function. */
async function enroll(jwt: string, name: string): Promise<{ factor: Factor } | { refused: number; code: string | null }> {
  const value = await publicFetch("/auth/v1/factors", { method: "POST", body: { factor_type: "totp", friendly_name: name }, jwt });
  const id = field(value.body, "id"), secret = field(field(value.body, "totp"), "secret");
  if (value.status !== 200) {
    const errorCode = field(value.body, "error_code");
    return { refused: value.status, code: typeof errorCode === "string" && /^[a-z_]{1,40}$/.test(errorCode) ? errorCode : null };
  }
  if (typeof id !== "string" || !uuid.test(id) || typeof secret !== "string" || !/^[A-Z2-7]+$/.test(secret)) throw new Error("Run-user TOTP enrollment failed (details suppressed)");
  const factor = { id, secret };
  await verify(jwt, factor);
  return { factor };
}
/** A's factors as Auth lists them to A, in Auth's order (the order /admin/mfa uses to pick the factor it challenges). */
async function factors(jwt: string) {
  const value = await publicFetch("/auth/v1/user", { method: "GET", jwt });
  const list = field(value.body, "factors");
  if (value.status !== 200 || field(value.body, "id") !== readState().users[0].id || !Array.isArray(list)) throw new Error("Run-user factor read failed (details suppressed)");
  return list.map(row => ({ id: String(field(row, "id")), type: String(field(row, "factor_type")), status: String(field(row, "status")) }));
}

// The staff screen labels each row 「担当 #」 plus the first 8 hex digits of sha256(user id) (src/server/admin-staff.ts).
const labelOf = (id: string) => `担当 #${createHash("sha256").update(id).digest("hex").slice(0, 8)}`;
const rowOf = (admin: Page, id: string) => admin.getByRole("main").getByRole("listitem").filter({ has: admin.getByText(labelOf(id), { exact: true }) });
async function grantReviewer(admin: Page) {
  await admin.goto("/admin/staff");
  await expect(admin.getByRole("heading", { level: 1, name: "担当者と役割" })).toBeVisible();
  await admin.getByLabel("メールアドレス", { exact: true }).fill(readState().users[0].email);
  await admin.getByRole("combobox", { name: /^役割/ }).selectOption("reviewer");
  await admin.getByRole("button", { name: "付与する", exact: true }).click();
  await expect(admin.getByRole("status")).toHaveText(granted);
  await expect(rowOf(admin, readState().users[0].id).getByRole("button", { name: "学生認証審査を外す", exact: true })).toBeVisible();
}
async function revokeReviewer(admin: Page) {
  await admin.goto("/admin/staff");
  const row = rowOf(admin, readState().users[0].id);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "学生認証審査を外す", exact: true }).click();
  await admin.getByRole("dialog").getByRole("button", { name: "外す", exact: true }).click();
  await expect(admin.getByRole("status")).toHaveText(revoked);
  await expect(row).toHaveCount(0);
}
/** A at aal2 in the browser: /admin is the dashboard with only the reviewer entry, or the not-found page. */
async function dashboard(page: Page, acting: boolean) {
  const response = await page.goto("/admin");
  if (acting) {
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "管理画面" })).toBeVisible();
    await expect(page.getByRole("link", { name: "学生認証審査", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "担当者と役割", exact: true })).toHaveCount(0);
  } else {
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "ページが見つかりません" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "管理画面" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "学生認証審査" })).toHaveCount(0);
  }
  return response?.status();
}
/** A's acting state through its own aal2 token: the reviewer RPC's answer and my_staff_roles. */
async function acting(jwt: string) {
  return { adminListSubmissions: (await asToken(jwt, "admin_list_submissions")).answer, myStaffRoles: await ownRoles(jwt) };
}

let admin: Page | null = null;
let first: BrowserContext | null = null;
let second: BrowserContext | null = null;
let grantFactor: Factor | null = null;
let addedFactor: Factor | null = null;
const result: Record<string, unknown> = {};
function record(status: "pass" | "fail" | "partial") { evidence("staffTotpBinding", { status, ...result }); }
test.afterAll(async () => {
  // Safety net: A keeps no role, revoked with e2e-admin's own aal2 session; teardown then deletes A as usual.
  try {
    if (admin) {
      const jwt = await sessionJwt(admin.context(), "aal2", { email: credentials().admin.email });
      const id = readState().users[0].id;
      const listed = await asToken(jwt, "admin_list_staff");
      const row = listed.rows.find(value => field(value, "user_id") === id);
      const roles = row ? field(row, "roles") : [];
      if (Array.isArray(roles) && roles.includes("reviewer")) {
        const value = await asToken(jwt, "admin_revoke_role", { p_user: id, p_role: "reviewer" });
        result.afterAllRevoke = value.answer;
      }
    }
  } finally {
    if (result.status !== "pass") record("fail");
    await first?.close(); first = null;
    await second?.close(); second = null;
    await admin?.context().close(); admin = null;
  }
});

test("run user A enrolls its own TOTP and e2e-admin grants A reviewer on the staff screen", async ({ browser }) => {
  test.setTimeout(180_000);
  const user = readState().users[0];
  const page = await userPage(browser, 0, "/mypage");
  first = page.context();
  // A's own TOTP factor, as the screen offers it; the key stays in memory and teardown deletes the user.
  try {
    await page.goto("/admin/mfa?next=%2Fadmin");
    await page.getByRole("button", { name: "認証アプリを設定する", exact: true }).click();
    const secret = (await page.getByLabel("手入力用のキー", { exact: true }).textContent({ timeout: 20_000 }))?.trim();
    if (!secret || !/^[A-Z2-7]+$/.test(secret)) throw new Error();
    grantFactor = { id: "", secret };
    await page.getByLabel("6桁のコード", { exact: true }).fill(totp(secret), { timeout: 10_000 });
    await page.getByRole("button", { name: "確認", exact: true }).click();
    await page.waitForURL(url => url.pathname === "/admin");
  } catch { throw new Error("Run-user TOTP enrollment failed (details suppressed)"); }
  const jwt = await sessionJwt(first, "aal2", { sub: user.id });
  const listed = await factors(jwt);
  const verified = listed.filter(row => row.status === "verified");
  expect(verified.length).toBe(1);
  expect(verified[0].type).toBe("totp");
  grantFactor.id = verified[0].id;
  usedWindow.set(grantFactor.id, Math.floor(Date.now() / 30_000));
  expect(await acting(jwt)).toEqual({ adminListSubmissions: "forbidden", myStaffRoles: [] });

  admin = await adminPage(browser);
  const adminRoles = await ownRoles(await sessionJwt(admin.context(), "aal2", { email: credentials().admin.email }));
  expect(adminRoles).toEqual(["admin", "moderator", "reviewer"]);
  await grantReviewer(admin);
  result.grant = { factorsBeforeGrant: verified.length, beforeGrant: "forbidden, no roles", granted: true, adminRolesAtStart: adminRoles };
  record("partial");
});

test("A at aal2 acts as reviewer: dashboard entry, my_staff_roles and admin_list_submissions", async () => {
  if (!first || !grantFactor) throw new Error("The grant step did not finish");
  const jwt = await sessionJwt(first, "aal2", { sub: readState().users[0].id });
  const state = await acting(jwt);
  expect(state.adminListSubmissions).toMatch(/^rows:\d+$/);
  expect(state.myStaffRoles).toEqual(["reviewer"]);
  const status = await dashboard(first.pages()[0], true);
  result.afterGrant = { ...state, adminListSubmissions: "rows", dashboard: status };
  record("partial");
});

test("a second verified factor added after the grant stops the role, even after a fresh aal2 sign-in with the grant-time factor", async ({ browser }) => {
  test.setTimeout(240_000);
  if (!first || !grantFactor) throw new Error("The grant step did not finish");
  const user = readState().users[0];
  // Session.signIn(i, true) enrolls a new factor on every call, at aal1 right after the password grant. Try exactly
  // that first; Auth may require aal2 to enroll while a verified factor exists, and then A's own aal2 session adds it.
  const helperWay = await enroll(await passwordJwt(), "TEST-016 second factor (aal1)");
  let path: string;
  if ("factor" in helperWay) { addedFactor = helperWay.factor; path = "aal1 password session (as Session.signIn)"; }
  else {
    result.aal1Enrollment = { refused: helperWay.refused, code: helperWay.code };
    const ownWay = await enroll(await signInAal2(grantFactor), "TEST-016 second factor (aal2)");
    if (!("factor" in ownWay)) throw new Error(`A's own aal2 enrollment refused (${ownWay.refused})`);
    addedFactor = ownWay.factor;
    path = "A's own aal2 session";
  }
  // A signs in again at aal2 with the grant-time factor.
  const jwt = await signInAal2(grantFactor);
  const listed = await factors(jwt);
  const verified = listed.filter(row => row.status === "verified");
  expect(verified.map(row => row.id).sort()).toEqual([grantFactor.id, addedFactor.id].sort());
  const state = await acting(jwt);
  expect(state).toEqual({ adminListSubmissions: "forbidden", myStaffRoles: [] });
  // The browser session that saw the dashboard is still aal2 and now gets the not-found page.
  await sessionJwt(first, "aal2", { sub: user.id });
  const oldBrowser = await dashboard(first.pages()[0], false);
  // A fresh browser sign-in at aal2 through /admin/mfa, with the factor the screen challenges (Auth's first verified TOTP).
  const challenged = listed.find(row => row.type === "totp" && row.status === "verified")!.id === grantFactor.id ? grantFactor : addedFactor;
  const page = await userPage(browser, 0, "/mypage");
  second = page.context();
  try {
    await page.goto("/admin/mfa?next=%2Fadmin");
    await expect(page.getByRole("button", { name: "認証アプリを設定する" })).toHaveCount(0);
    await page.getByLabel("6桁のコード", { exact: true }).fill(await code(challenged), { timeout: 10_000 });
    await page.getByRole("button", { name: "確認", exact: true }).click();
    await page.waitForURL(url => url.pathname === "/admin");
  } catch { throw new Error("Run-user TOTP challenge failed (details suppressed)"); }
  const browserJwt = await sessionJwt(second, "aal2", { sub: user.id });
  expect(await acting(browserJwt)).toEqual({ adminListSubmissions: "forbidden", myStaffRoles: [] });
  const newBrowser = await dashboard(page, false);
  result.afterAddedFactor = { addedThrough: path, verifiedFactors: verified.length, ...state,
    dashboard: { sessionThatSawIt: oldBrowser, freshSignIn: newBrowser, freshSignInFactor: challenged === grantFactor ? "grant-time" : "added" } };
  record("partial");
});

test("e2e-admin revokes and grants reviewer again on the staff screen and A acts again", async () => {
  test.setTimeout(180_000);
  if (!admin || !second || !grantFactor || !addedFactor) throw new Error("The added-factor step did not finish");
  await revokeReviewer(admin);
  await grantReviewer(admin);
  const jwt = await signInAal2(grantFactor);
  const state = await acting(jwt);
  expect(state.adminListSubmissions).toMatch(/^rows:\d+$/);
  expect(state.myStaffRoles).toEqual(["reviewer"]);
  const withAdded = await acting(await signInAal2(addedFactor));
  expect(withAdded.adminListSubmissions).toMatch(/^rows:\d+$/);
  expect(withAdded.myStaffRoles).toEqual(["reviewer"]);
  const status = await dashboard(second.pages()[0], true);
  result.afterRegrant = { grantTimeFactor: { ...state, adminListSubmissions: "rows" },
    addedFactor: { ...withAdded, adminListSubmissions: "rows" }, dashboard: status };
  record("partial");
});

test("teardown revokes A's role on the screen and e2e-admin ends with its three roles acting", async () => {
  if (!admin || !grantFactor) throw new Error("The re-grant step did not finish");
  await revokeReviewer(admin);
  const state = await acting(await signInAal2(grantFactor));
  expect(state).toEqual({ adminListSubmissions: "forbidden", myStaffRoles: [] });
  const adminRoles = await ownRoles(await sessionJwt(admin.context(), "aal2", { email: credentials().admin.email }));
  expect(adminRoles).toEqual(["admin", "moderator", "reviewer"]);
  result.teardown = { ...state, adminRolesAtEnd: adminRoles };
  result.status = "pass";
  record("pass");
});
