import { test, expect, type BrowserContext } from "@playwright/test";
import { projectRef } from "./retention";
import { readState, evidence, environment } from "./state";
import { userPage, adminPage, openRoom, sendMessage } from "./ui";

// MOD-001 (CAMPUS_E2E_HIDE_CONTENT=1, after the chat group): needs order 33 on hosted (HOSTED-019). A sends B a
// run-owned message, B reports it, e2e-admin hides it from the report and both participants see only the
// placeholder, in the room and through a direct PostgREST read of public.messages with B's own JWT. The hide is then
// undone, so the later groups see the room as before. The report stays as a normal audit row.
const PLACEHOLDER = "この発言は運営により非表示になりました。";
async function sessionJwt(context: BrowserContext, userId: string) {
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
    if (typeof token !== "string" || claims.sub !== userId) throw new Error();
    return token as string;
  } catch { throw new Error("Browser session is not the expected run user (details suppressed)"); }
}
/** The bodies B can read straight from public.messages (the messages_member policy) for the run room. */
async function tableBodies(jwt: string, conversation: string) {
  const env = environment();
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!key) throw new Error("Missing hosted public credential");
  let status: number, body: unknown;
  try {
    const response = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/messages?select=body&conversation_id=eq.${conversation}`, {
      signal: AbortSignal.timeout(30_000), headers: { apikey: key, Authorization: `Bearer ${jwt}` },
    });
    status = response.status; body = await response.json().catch(() => null);
  } catch { throw new Error("Hosted messages read transport failed (details suppressed)"); }
  if (status !== 200 || !Array.isArray(body)) throw new Error(`messages read failed (${status})`);
  return body.map(row => (row as { body?: unknown }).body);
}

test("a run-owned reported message is hidden for both participants and the hide can be undone", async ({ browser }) => {
  const state = readState();
  const room = state.conversation;
  if (!room) throw new Error("The chat group did not record the run room");
  const conversation = room.split("/").at(-1)!;
  const a = await userPage(browser, 0, room);
  const b = await userPage(browser, 1, "/talk");
  const admin = await adminPage(browser);
  try {
    const text = `架空の非表示対象 ${state.runId}`;
    await openRoom(a, state.users[1].name);
    await sendMessage(a, text);
    await openRoom(b, state.users[0].name);
    const item = b.getByRole("log").getByRole("listitem").filter({ hasText: text });
    await expect(item).toHaveCount(1);
    await item.getByRole("button", { name: /^メッセージを通報 / }).click();
    await b.getByRole("dialog").getByLabel("詳細（任意）").fill(`架空のメッセージ通報 ${state.runId}`);
    await b.getByRole("dialog").getByRole("button", { name: "通報する", exact: true }).click();
    await expect(b.getByRole("dialog").getByRole("status")).toHaveText("通報を受け付けました。");

    await admin.goto("/admin/reports");
    const hrefs = await admin.locator('a[href^="/admin/reports/"]').evaluateAll(links => links.map(link => link.getAttribute("href")!));
    let found = false;
    for (const href of hrefs) {
      await admin.goto(href);
      if (await admin.getByText(`架空のメッセージ通報 ${state.runId}`, { exact: true }).isVisible()) { found = true; break; }
    }
    expect(found, "exact run-owned message report found before hiding").toBe(true);
    const content = admin.getByRole("region", { name: "通報された内容" });
    await expect(content.getByText(text, { exact: true })).toBeVisible();
    await expect(content.getByText("表示中", { exact: true })).toBeVisible();
    await admin.getByRole("button", { name: "メッセージの内容を非表示にする", exact: true }).click();
    await admin.getByRole("dialog").getByRole("button", { name: "非表示にする", exact: true }).click();
    await expect(admin.getByRole("status")).toHaveText("内容を非表示にしました。");
    await expect(content.getByText("非表示（運営）", { exact: true })).toBeVisible();

    for (const page of [a, b]) {
      await page.reload();
      const log = page.getByRole("log", { name: "会話履歴" });
      await expect(log.getByText(PLACEHOLDER, { exact: true })).toBeVisible();
      await expect(log.getByText(text, { exact: true })).toHaveCount(0);
    }
    const jwt = await sessionJwt(b.context(), state.users[1].id);
    const hiddenBodies = await tableBodies(jwt, conversation);
    expect(hiddenBodies).toContain(PLACEHOLDER);
    expect(hiddenBodies).not.toContain(text);

    await admin.getByRole("button", { name: "メッセージの表示を戻す", exact: true }).click();
    await admin.getByRole("dialog").getByRole("button", { name: "戻す", exact: true }).click();
    await expect(admin.getByRole("status")).toHaveText("表示を戻しました。");
    await b.reload();
    await expect(b.getByRole("log", { name: "会話履歴" }).getByText(text, { exact: true })).toBeVisible();
    expect(await tableBodies(jwt, conversation)).toContain(text);
    evidence("hideContent", { status: "pass", participantsChecked: 2, tableRead: "placeholder only", undo: "pass" });
  } finally { await a.context().close(); await b.context().close(); await admin.context().close(); }
});
