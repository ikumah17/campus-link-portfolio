import { test, expect, type BrowserContext } from "@playwright/test";
import { projectRef } from "./retention";
import { readState, evidence, environment, credentials } from "./state";
import { userPage, adminPage, discover } from "./ui";

// ADMIN-006: while B is suspended, B is listed in /admin/accounts and is reactivated there instead of from the report.
// Until order 23 (admin_list_suspended_accounts) is on hosted that step skips and B is reactivated from the report,
// as before. The probe is e2e-admin's own aal2 JWT on the same browser session: no extra sign-in.
const ORDER_23_MISSING = "admin_list_suspended_accounts is missing on hosted: the /admin/accounts step skips until order 23 is applied";
async function adminJwt(context: BrowserContext) {
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
    if (typeof token !== "string" || claims.aal !== "aal2" || claims.email !== credentials().admin.email) throw new Error();
    return token as string;
  } catch { throw new Error("Browser session is not e2e-admin at aal2 (details suppressed)"); }
}
/** Order 23 is on hosted when admin_list_suspended_accounts answers rows; a missing function is PGRST202. Anything else fails. */
async function suspendedListDeployed(jwt: string) {
  const env = environment();
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!key) throw new Error("Missing hosted public credential");
  let status: number, body: unknown;
  try {
    const response = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/admin_list_suspended_accounts`, {
      method: "POST", signal: AbortSignal.timeout(30_000), body: "{}",
      headers: { apikey: key, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    });
    status = response.status; body = await response.json().catch(() => null);
  } catch { throw new Error("Hosted suspended-list probe transport failed (details suppressed)"); }
  if (status === 200 && Array.isArray(body)) return true;
  if (status === 404 && (body as { code?: unknown } | null)?.code === "PGRST202") return false;
  throw new Error(`admin_list_suspended_accounts probe failed (${status})`);
}

test("a run-owned report suspends B and suspension can be lifted", async ({ browser }) => {
  const state = readState();
  const a = await userPage(browser, 0, state.profiles![1]);
  const admin = await adminPage(browser);
  try {
    await (await discover(a, state.users[1].name)).click();
    await a.getByRole("button", { name: "通報", exact: true }).click();
    await a.getByRole("dialog").getByLabel("詳細（任意）").fill(`架空の通報 ${state.runId}`);
    await a.getByRole("dialog").getByRole("button", { name: "通報する", exact: true }).click();
    await expect(a.getByRole("dialog").getByRole("status")).toHaveText("通報を受け付けました。");
    // A's own serialized report is not exposed by the app. Find the exact
    // run detail through read-only admin report pages before any mutation.
    await admin.goto("/admin/reports");
    const hrefs = await admin.locator('a[href^="/admin/reports/"]').evaluateAll(links => links.map(link => link.getAttribute("href")!));
    let found = false;
    for (const href of hrefs) {
      await admin.goto(href);
      if (await admin.getByText(`架空の通報 ${state.runId}`, { exact: true }).isVisible()) { found = true; break; }
    }
    expect(found, "exact run-owned report found before suspension").toBe(true);
    const reportUrl = admin.url();
    await admin.getByRole("button", { name: "アカウントを停止", exact: true }).click();
    await admin.getByRole("dialog").getByRole("button", { name: "停止する", exact: true }).click();
    await expect(admin.getByRole("status")).toHaveText("アカウントを停止しました。");
    await discover(a, state.users[1].name, false);
    const deployed = await suspendedListDeployed(await adminJwt(admin.context()));
    let reactivatedFrom: "accounts" | "report" = "report";
    await test.step("ADMIN-006: B is listed in /admin/accounts and reactivated there", async step => {
      step.skip(!deployed, ORDER_23_MISSING);
      await admin.goto("/admin/accounts");
      await expect(admin.getByRole("heading", { level: 1, name: "停止中のアカウント", exact: true })).toBeVisible();
      const row = admin.getByRole("listitem").filter({ has: admin.getByRole("heading", { level: 2, name: state.users[1].name, exact: true }) });
      await expect(row).toHaveCount(1);
      await expect(row.getByText(`ID #${state.users[1].id.slice(0, 8)}`, { exact: true })).toBeVisible();
      await expect(row.getByText("記録なし", { exact: true })).toHaveCount(0);   // the suspension audit row supplies date and reason
      await row.getByRole("button", { name: "停止を解除", exact: true }).click();
      await admin.getByRole("dialog").getByRole("button", { name: "解除する", exact: true }).click();
      await expect(admin.getByRole("main").getByRole("status")).toHaveText("停止を解除しました。");
      await expect(admin.getByRole("heading", { level: 2, name: state.users[1].name, exact: true })).toHaveCount(0);
      reactivatedFrom = "accounts";
    });
    if (reactivatedFrom === "report") {
      await admin.goto(reportUrl);
      await admin.getByRole("button", { name: "停止を解除", exact: true }).click();
      await admin.getByRole("dialog").getByRole("button", { name: "再開する", exact: true }).click();
      await expect(admin.getByRole("status")).toHaveText("アカウントを再開しました。");
    }
    await discover(a, state.users[1].name);
    evidence("moderation", { status: "pass", reactivatedFrom, suspendedList: deployed ? "pass" : { skipped: ORDER_23_MISSING } });
  } finally { await a.context().close(); await admin.context().close(); }
});
