import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRunUsers } from "./lifecycle";
import { projectRef } from "./retention";
import { credentials, environment, evidence, localDir, readState } from "./state";
import { totp } from "./totp";
import { adminPage, login, userPage } from "./ui";

// HOSTED-E2E-006, its own invocation (CAMPUS_E2E_ADMIN_AFFILIATIONS=1). e2e-admin at aal1 is sent to the MFA
// challenge and reads no admin data; at aal2 the dashboard opens each entry. Run user 0 (no staff role) is refused
// at aal1 and, after enrolling its own TOTP, at aal2, where /admin is the not-found page too (ADMIN-005). Until
// HOSTED-007 applies order 19 (my_staff_roles), /admin fails closed for everyone, so the dashboard step skips and
// the non-staff step checks /admin/affiliations only. Through /admin/affiliations e2e-admin creates one run-tagged
// fictional school, department and class, renames the class and reads them back with its own JWT; run user 1's
// onboarding offers them, run user 0's upserts are forbidden, and e2e-admin then disables all three (the screen
// never deletes) so neither run user 1 nor a fresh run user 2 is offered them. No other affiliation row may change.
// Names and the run id stay in a local ledger until the rows are inactive, so a later run can finish an interrupted
// retirement first. Evidence keeps counts, pass/fail and only the run-tagged fictional names; teardown deletes users.
test.describe.configure({ mode: "serial" });

type Level = "school" | "department" | "class";
type Row = { level: Level; id: string; parent_id: string | null; name: string; is_active: boolean; sort_order: number; academic_year: number | null };
type Names = { school: string; department: string; class: string; renamed: string; refused: string };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ledgerPath = resolve(localDir, "affiliations.json");
function names(runId: string): Names {
  if (!/^[a-f0-9]{12}$/.test(runId)) throw new Error("Invalid affiliation run identity");
  return { school: `E2E学校 ${runId}（架空）`, department: `E2E学科 ${runId}（架空）`, class: `E2Eクラス ${runId}（架空）`,
    renamed: `E2Eクラス改 ${runId}（架空）`, refused: `E2E学校 ${runId} 不許可（架空）` };
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
  } catch { throw new Error("Hosted affiliation transport failed (details suppressed)"); }
}
/** An RPC as the token's caller: "rows:<n>", "ok", "forbidden", or a fixed failure label (no provider text). */
async function asToken(jwt: string, name: string, args: Record<string, unknown> = {}) {
  const value = await publicFetch(`/rest/v1/rpc/${name}`, { method: "POST", body: args, jwt });
  const row = value.body as { code?: unknown; message?: unknown } | null;
  if (value.status === 200 && Array.isArray(value.body)) return { answer: `rows:${value.body.length}`, rows: value.body as Record<string, unknown>[] };
  if (value.status === 200) return { answer: "ok", rows: [] };
  if (value.status === 400 && row?.code === "P0001" && row.message === "forbidden") return { answer: "forbidden", rows: [] };
  return { answer: `unexpected:${value.status}`, rows: [] };
}
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
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    if (typeof token !== "string" || claims.aal !== aal || (identity.sub && claims.sub !== identity.sub) ||
      (identity.email && claims.email !== identity.email)) throw new Error();
    return token as string;
  } catch { throw new Error(`Browser session is not the expected ${aal} identity (details suppressed)`); }
}
async function ownToken(index: number): Promise<string> {
  const user = readState().users[index];
  const value = await publicFetch("/auth/v1/token?grant_type=password", { method: "POST", body: { email: user.email, password: user.password } });
  const data = value.body as { access_token?: unknown; user?: { id?: unknown } } | null;
  if (value.status !== 200 || data?.user?.id !== user.id || typeof data.access_token !== "string") throw new Error("Hosted run-user sign-in failed (details suppressed)");
  return data.access_token;
}

/** The whole master through admin_list_affiliations with e2e-admin's own aal2 JWT. Rows stay in memory only. */
async function master(admin: Page): Promise<Row[]> {
  const jwt = await sessionJwt(admin.context(), "aal2", { email: credentials().admin.email });
  const value = await publicFetch("/rest/v1/rpc/admin_list_affiliations", { method: "POST", body: {}, jwt });
  if (value.status !== 200 || !Array.isArray(value.body)) throw new Error(`admin_list_affiliations refused (${value.status})`);
  const rows = value.body as Row[];
  if (rows.some(row => !["school", "department", "class"].includes(row.level) || !uuid.test(row.id) || typeof row.name !== "string" || typeof row.is_active !== "boolean")) {
    throw new Error("admin_list_affiliations returned a malformed row");
  }
  return rows;
}
const tagged = (row: Row, runId: string) => row.name.includes(runId);
/** This run's rows by exact name, level and parent chain. Any other row carrying the run id is an ownership failure. */
function runRows(rows: Row[], runId: string) {
  const n = names(runId);
  const pick = (level: Level, name: string, parent: string | null) => {
    const found = rows.filter(row => row.level === level && row.name === name && row.parent_id === parent);
    if (found.length > 1) throw new Error(`Ambiguous run-tagged ${level}`);
    return found[0] ?? null;
  };
  const school = pick("school", n.school, null);
  const department = school ? pick("department", n.department, school.id) : null;
  const classes = department ? [pick("class", n.class, department.id), pick("class", n.renamed, department.id)].filter((row): row is Row => !!row) : [];
  const owned = [school, department, ...classes].filter((row): row is Row => !!row);
  if (rows.filter(row => tagged(row, runId)).length !== owned.length) throw new Error("Unexpected run-tagged affiliation row");
  return { school, department, classes, owned };
}
const others = (rows: Row[], runId: string) => JSON.stringify(rows.filter(row => !tagged(row, runId)));

type Ledger = { runId: string };
function readLedger(): Ledger | null {
  if (!existsSync(ledgerPath)) return null;
  const value = JSON.parse(readFileSync(ledgerPath, "utf8"));
  if (!/^[a-f0-9]{12}$/.test(value?.runId)) throw new Error("Invalid affiliation ledger");
  return value;
}
/** Disables every still-active row carrying the run id through the screen, class first, and asserts only afterwards:
 *  a failed toggle or an unexpected run-tagged row never leaves the run's other rows selectable. */
async function retire(admin: Page, runId: string) {
  await admin.goto("/admin/affiliations");
  await expect(admin.getByRole("heading", { level: 1, name: "学校・学科・クラス" })).toBeVisible();
  const order: Level[] = ["class", "department", "school"];
  const active = (await master(admin)).filter(row => tagged(row, runId) && row.is_active)
    .sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
  const failed: Level[] = [];
  for (const row of active) {
    try {
      const label = row.level === "class" ? `${row.name}（年度：${row.academic_year ?? "未設定"}）` : row.name;
      const toggle = admin.getByRole("switch", { name: `${label}の有効状態`, exact: true });
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await toggle.click();
      await expect(admin.getByRole("main").getByRole("status")).toHaveText(`${row.name}を無効にしました。`);
      await expect(toggle).toHaveAttribute("aria-checked", "false");
    } catch { failed.push(row.level); }
  }
  const rows = await master(admin);
  if (failed.length) throw new Error(`Could not disable run-tagged ${failed.join(", ")}`);
  if (rows.some(row => tagged(row, runId) && row.is_active)) throw new Error("A run-tagged affiliation row is still active");
  return { disabled: active.length, final: runRows(rows, runId) };
}

/** HOSTED-007 marker: order 19 is on the hosted database when my_staff_roles answers rows to an aal2 JWT. */
const ORDER_19_MISSING = "my_staff_roles is missing on hosted, so /admin fails closed until HOSTED-007 applies order 19";
async function staffRolesDeployed(jwt: string) {
  const value = await publicFetch("/rest/v1/rpc/my_staff_roles", { method: "POST", body: {}, jwt });
  if (value.status === 200 && Array.isArray(value.body)) return true;
  if (value.status === 404 && (value.body as { code?: unknown } | null)?.code === "PGRST202") return false;
  throw new Error(`my_staff_roles probe failed (${value.status})`);
}

/** Step 1 of onboarding with fictional values; returns the school, department and class selects of step 2. */
async function onboardingChoices(page: Page, index: number) {
  await page.goto("/onboarding");
  await page.getByLabel("表示名", { exact: true }).fill(readState().users[index].name);
  await page.getByRole("radio", { name: "その他", exact: true }).check();
  await page.getByLabel("生年月日", { exact: true }).fill("2000-01-02");
  await page.getByLabel("18歳以上です", { exact: true }).check();
  await page.getByRole("button", { name: "次へ", exact: true }).click();
  const school = page.getByLabel("学校", { exact: true });
  await expect(school).toBeVisible();
  return { school, department: page.getByLabel("学科", { exact: true }), class: page.getByLabel("クラス", { exact: true }) };
}
const optionTexts = (select: ReturnType<Page["getByLabel"]>) => select.locator("option").allTextContents();
/** The exact active-row queries onboarding uses (loadAffiliationMaster), with a run user's own JWT: counts only. */
async function selectable(jwt: string, school: Row, department: Row, classRow: Row) {
  const count = async (table: string, id: string) => {
    const value = await publicFetch(`/rest/v1/${table}?select=id&id=eq.${id}&is_active=eq.true`, { method: "GET", jwt });
    if (value.status !== 200 || !Array.isArray(value.body)) throw new Error(`Active ${table} read refused (${value.status})`);
    return value.body.length;
  };
  return { schools: await count("schools", school.id), departments: await count("departments", department.id), classes: await count("classes", classRow.id) };
}

let admin: Page | null = null;
let nonStaff: { jwt: string; context: BrowserContext } | null = null;
let before = "";
const result: Record<string, unknown> = {};
function record(status: "pass" | "fail" | "partial") { evidence("adminAffiliations", { status, ...result }); }
test.afterAll(async () => {
  // Safety net: whatever failed, no row of this run stays selectable. Through the screen, as e2e-admin.
  try {
    const ledger = readLedger();
    if (admin && ledger) {
      const { disabled, final } = await retire(admin, ledger.runId);
      result.afterAllRetired = disabled;
      result.finalRows = final.owned.map(row => ({ level: row.level, name: row.name, active: row.is_active }));
      unlinkSync(ledgerPath);
    }
  } finally {
    if (result.status !== "pass") record("fail");
    await nonStaff?.context.close(); nonStaff = null;
    await admin?.context().close(); admin = null;
  }
});

test("e2e-admin at aal1 is sent to the MFA challenge and reaches no admin data", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const local = credentials();
    await login(page, local.admin, "/admin");
    const paths = ["/admin", "/admin/affiliations", "/admin/verifications", "/admin/reports", "/admin/staff"];
    for (const path of paths) {
      await page.goto(path);
      await page.waitForURL(url => url.pathname === "/admin/mfa" && url.searchParams.get("next") === path);
      await expect(page.getByRole("heading", { level: 1, name: "二段階認証" })).toBeVisible();
      await expect(page.getByLabel("6桁のコード", { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "管理画面" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "学校を追加" })).toHaveCount(0);
    }
    const jwt = await sessionJwt(context, "aal1", { email: local.admin.email });
    const list = (await asToken(jwt, "admin_list_affiliations")).answer;
    expect(list).toBe("forbidden");
    result.adminAal1 = { pathsSentToMfa: paths.length, adminListAffiliations: list };
    record("partial");
  } finally { await context.close(); }
});

test("e2e-admin at aal2 sees the dashboard and each entry opens its page", async ({ browser }) => {
  admin = await adminPage(browser);
  if (!await staffRolesDeployed(await sessionJwt(admin.context(), "aal2", { email: credentials().admin.email }))) {
    result.dashboard = { skipped: ORDER_19_MISSING };
    test.skip(true, ORDER_19_MISSING);
  }
  await expect(admin.getByRole("heading", { level: 1, name: "管理画面" })).toBeVisible();
  const entries = [["学生認証審査", "/admin/verifications"], ["通報", "/admin/reports"], ["学校・学科・クラス", "/admin/affiliations"], ["担当者と役割", "/admin/staff"]] as const;
  for (const [name, path] of entries) {
    await admin.goto("/admin");
    await admin.getByRole("link", { name, exact: true }).click();
    await admin.waitForURL(url => url.pathname === path);
    await expect(admin.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
    await expect(admin.getByRole("alert").filter({ hasText: "現在表示できません" })).toHaveCount(0);
  }
  await admin.getByRole("link", { name: "管理画面へ戻る", exact: true }).click();
  await admin.waitForURL(url => url.pathname === "/admin");
  result.dashboard = { entries: entries.length, opened: entries.length };
  record("partial");
});

test("a run user with no staff role is refused /admin and /admin/affiliations at aal1 and aal2", async ({ browser }) => {
  test.setTimeout(180_000);
  const user = readState().users[0];
  const page = await userPage(browser, 0, "/admin");
  nonStaff = { jwt: "", context: page.context() };
  for (const path of ["/admin", "/admin/affiliations"]) {
    await page.goto(path);
    await page.waitForURL(url => url.pathname === "/admin/mfa" && url.searchParams.get("next") === path);
    await expect(page.getByRole("heading", { level: 1, name: "二段階認証" })).toBeVisible();
    await expect(page.getByRole("button", { name: "学校を追加" })).toHaveCount(0);
  }
  const aal1 = (await asToken(await sessionJwt(page.context(), "aal1", { sub: user.id }), "admin_list_affiliations")).answer;
  expect(aal1).toBe("forbidden");
  // The run user's own TOTP factor, as the screen offers it; the key stays in memory and teardown deletes the user.
  try {
    await page.goto("/admin/mfa?next=%2Fadmin");
    await page.getByRole("button", { name: "認証アプリを設定する", exact: true }).click();
    const secret = (await page.getByLabel("手入力用のキー", { exact: true }).textContent({ timeout: 20_000 }))?.trim();
    if (!secret || !/^[A-Z2-7]+$/.test(secret)) throw new Error();
    await page.getByLabel("6桁のコード", { exact: true }).fill(totp(secret), { timeout: 10_000 });
    await page.getByRole("button", { name: "確認", exact: true }).click();
    await page.waitForURL(url => url.pathname === "/admin");
  } catch { throw new Error("Run-user TOTP enrollment failed (details suppressed)"); }
  nonStaff.jwt = await sessionJwt(page.context(), "aal2", { sub: user.id });
  // Every admin read is refused by the database, and at aal2 both pages are the not-found page (ADMIN-005).
  const aal2 = (await asToken(nonStaff.jwt, "admin_list_affiliations")).answer;
  expect(aal2).toBe("forbidden");
  const deployed = await staffRolesDeployed(nonStaff.jwt);
  const ownRoles = deployed ? (await asToken(nonStaff.jwt, "my_staff_roles")).answer : ORDER_19_MISSING;
  if (deployed) expect(ownRoles).toBe("rows:0");
  const paths = deployed ? ["/admin", "/admin/affiliations"] : ["/admin/affiliations"];
  const statuses: Record<string, number | undefined> = {};
  for (const path of paths) {
    const response = await page.goto(path);
    statuses[path] = response?.status();
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "ページが見つかりません" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "管理画面" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "学校・学科・クラス" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "学校を追加" })).toHaveCount(0);
  }
  result.nonStaffPages = { aal1: "both sent to the MFA screen", aal2: { dashboard: statuses["/admin"] ?? ORDER_19_MISSING, affiliations: statuses["/admin/affiliations"] },
    adminListAffiliations: { aal1, aal2 }, myStaffRoles: ownRoles };
  record("partial");
});

test("e2e-admin creates, renames and reads back a run-tagged school, department and class through the screen", async () => {
  test.setTimeout(240_000);
  if (!admin) throw new Error("The aal2 dashboard step did not open an administrator session");
  // Finish an interrupted earlier run first: its rows are disabled before this run adds any.
  const previous = readLedger();
  if (previous) {
    const { disabled } = await retire(admin, previous.runId);
    unlinkSync(ledgerPath);
    result.previousLedgerRetired = disabled;
  }
  const { runId } = readState();
  const n = names(runId);
  const initial = await master(admin);
  if (initial.some(row => tagged(row, runId))) throw new Error("Run-tagged affiliation rows exist before creation");
  before = others(initial, runId);
  writeFileSync(ledgerPath, JSON.stringify({ runId } satisfies Ledger), { mode: 0o600 });

  await admin.goto("/admin/affiliations");
  await expect(admin.getByRole("heading", { level: 1, name: "学校・学科・クラス" })).toBeVisible();
  const status = admin.getByRole("main").getByRole("status");
  async function save(level: "学校" | "学科" | "クラス", name: string, number: string) {
    const form = admin!.getByRole("form", { name: `${level}の編集` });
    await form.getByLabel("名前", { exact: true }).fill(name);
    await form.getByLabel(level === "クラス" ? "年度（任意）" : "表示順", { exact: true }).fill(number);
    await form.getByRole("button", { name: "保存", exact: true }).click();
    await expect(status).toHaveText(`${level}を保存しました。`);
    await expect(form).toHaveCount(0);
  }
  await admin.getByRole("button", { name: "学校を追加", exact: true }).click();
  await save("学校", n.school, "9999");
  await admin.getByRole("button", { name: `${n.school}を編集`, exact: true }).locator("xpath=..").getByRole("button", { name: "学科を追加", exact: true }).click();
  await save("学科", n.department, "9999");
  await admin.getByRole("button", { name: `${n.department}を編集`, exact: true }).locator("xpath=..").getByRole("button", { name: "クラスを追加", exact: true }).click();
  await save("クラス", n.class, "");
  await admin.getByRole("button", { name: `${n.class}（年度：未設定）を編集`, exact: true }).click();
  await save("クラス", n.renamed, "");
  await expect(admin.getByRole("button", { name: `${n.renamed}（年度：未設定）を編集`, exact: true })).toBeVisible();
  await expect(admin.getByRole("button", { name: `${n.class}（年度：未設定）を編集`, exact: true })).toHaveCount(0);

  const rows = await master(admin);
  const own = runRows(rows, runId);
  expect(own.school).toMatchObject({ parent_id: null, is_active: true, sort_order: 9999, academic_year: null });
  expect(own.department).toMatchObject({ parent_id: own.school!.id, is_active: true, sort_order: 9999, academic_year: null });
  expect(own.classes.map(row => ({ name: row.name, parent: row.parent_id === own.department!.id, active: row.is_active, year: row.academic_year })))
    .toEqual([{ name: n.renamed, parent: true, active: true, year: null }]);
  expect(others(rows, runId)).toBe(before);
  result.created = { school: 1, department: 1, class: 1, classRenamed: 1, readBack: "admin_list_affiliations with e2e-admin's own aal2 JWT",
    runRows: own.owned.length, otherRows: rows.length - own.owned.length, otherRowsUnchanged: true };
  record("partial");
});

test("a fresh run user's onboarding offers the new school, department and renamed class", async ({ browser }) => {
  const { runId } = readState();
  const n = names(runId);
  const own = runRows(await master(admin!), runId);
  const page = await userPage(browser, 1, "/onboarding");
  try {
    const choices = await onboardingChoices(page, 1);
    expect(await optionTexts(choices.school)).toContain(n.school);
    await choices.school.selectOption({ label: n.school });
    expect(await optionTexts(choices.department)).toEqual(["選んでください", n.department]);
    await choices.department.selectOption({ label: n.department });
    expect(await optionTexts(choices.class)).toEqual(["選んでください", n.renamed]);
    const counts = await selectable(await ownToken(1), own.school!, own.department!, own.classes[0]);
    expect(counts).toEqual({ schools: 1, departments: 1, classes: 1 });
    result.onboardingBefore = { schoolOffered: true, departmentOffered: true, renamedClassOffered: true, oldClassNameOffered: false, activeReads: counts };
    record("partial");
  } finally { await page.context().close(); }
});

test("a run user with no staff role cannot call the three upsert RPCs and the master does not change", async () => {
  if (!nonStaff?.jwt) throw new Error("The non-staff step did not record its aal2 session");
  const { runId } = readState();
  const n = names(runId);
  const start = await master(admin!);
  const own = runRows(start, runId);
  const school = own.school!, department = own.department!, classRow = own.classes[0];
  // An update of each run row and an insert under it; every write would leave the row inactive if it were accepted.
  const attempts: [string, Record<string, unknown>][] = [
    ["admin_upsert_school", { p_id: school.id, p_name: `${n.school}改`, p_is_active: false, p_sort_order: 0 }],
    ["admin_upsert_school", { p_id: null, p_name: n.refused, p_is_active: false, p_sort_order: 9999 }],
    ["admin_upsert_department", { p_id: department.id, p_school_id: school.id, p_name: `${n.department}改`, p_is_active: false, p_sort_order: 0 }],
    ["admin_upsert_department", { p_id: null, p_school_id: school.id, p_name: n.refused, p_is_active: false, p_sort_order: 9999 }],
    ["admin_upsert_class", { p_id: classRow.id, p_department_id: department.id, p_name: n.class, p_academic_year: null, p_is_active: false }],
    ["admin_upsert_class", { p_id: null, p_department_id: department.id, p_name: n.refused, p_academic_year: null, p_is_active: false }],
  ];
  const answers: Record<string, string[]> = {};
  for (const [label, jwt] of [["aal1", await ownToken(0)], ["aal2", nonStaff.jwt]] as const) {
    answers[label] = [];
    for (const [name, args] of attempts) answers[label].push((await asToken(jwt, name, args)).answer);
  }
  expect(answers).toEqual({ aal1: Array(6).fill("forbidden"), aal2: Array(6).fill("forbidden") });
  const after = await master(admin!);
  expect(JSON.stringify(after)).toBe(JSON.stringify(start));
  result.nonStaffUpserts = { callsPerAal: 6, forbidden: { aal1: 6, aal2: 6 }, masterUnchanged: true };
  record("partial");
});

test("e2e-admin disables all three rows and no later onboarding offers them", async ({ browser }) => {
  test.setTimeout(240_000);
  const { runId } = readState();
  const n = names(runId);
  const own = runRows(await master(admin!), runId);
  const { disabled, final } = await retire(admin!, runId);
  expect(disabled).toBe(3);
  expect(final.owned.map(row => ({ level: row.level, name: row.name, active: row.is_active }))).toEqual([
    { level: "school", name: n.school, active: false }, { level: "department", name: n.department, active: false },
    { level: "class", name: n.renamed, active: false }]);
  const rows = await master(admin!);
  expect(others(rows, runId)).toBe(before);
  // Inactive rows stay on the admin screen, marked as disabled.
  await expect(admin!.getByText(`${n.school}（無効）`, { exact: true })).toBeVisible();

  await createRunUsers(1);
  const offered: Record<string, boolean> = {};
  for (const index of [1, 2]) {
    const page = await userPage(browser, index, "/onboarding");
    try {
      const choices = await onboardingChoices(page, index);
      const schools = await optionTexts(choices.school);
      expect(schools.length).toBeGreaterThan(1);
      offered[index === 1 ? "earlierUser" : "freshUser"] = schools.some(text => text.includes(runId));
    } finally { await page.context().close(); }
  }
  expect(offered).toEqual({ earlierUser: false, freshUser: false });
  const counts = await selectable(await ownToken(2), own.school!, own.department!, own.classes[0]);
  expect(counts).toEqual({ schools: 0, departments: 0, classes: 0 });
  unlinkSync(ledgerPath);
  result.retired = { disabled, otherRowsUnchanged: true, onboardingOffered: offered, activeReads: counts };
  result.finalRows = final.owned.map(row => ({ level: row.level, name: row.name, active: row.is_active }));
  result.status = "pass";
  record("pass");
});
