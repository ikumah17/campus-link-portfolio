import { expect, type Browser, type Page, type WebSocket } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { createRunUsers } from "./lifecycle";
import { credentials, readState, type User } from "./state";
import { totp } from "./totp";
import { realtimeFlags, realtimeJoinFlags, RoomWireProbe } from "./realtime";
import { appGet } from "./request";

const realtime = new WeakMap<Page, { insertAt: number; insertCount: number; subscribedAt: number; readyAt: number; systemError: boolean; errorCode: string | null; closed: number; join: ReturnType<typeof realtimeJoinFlags> }>();
export function observedRealtime(page: Page) { return realtime.get(page)!; }
const roomWires = new WeakMap<Page, { sockets: { socket: WebSocket; probe: RoomWireProbe }[]; refreshRequests: number; navigations: number; listRefreshes: number }>();
export function observedRoom(page: Page, path: string) {
  const observation = roomWires.get(page)!;
  const id = path.split("/").at(-1)!;
  for (let i = observation.sockets.length - 1; i >= 0; i--) {
    const { socket, probe } = observation.sockets[i];
    const room = probe.snapshot(id);
    if (room) return { ...room, socketOpen: !socket.isClosed(), socketGeneration: i,
      refreshRequests: observation.refreshRequests, navigations: observation.navigations };
  }
  return null;
}
// TEST-007: the newest socket carrying the talk list channel. Room counts are only for the given run rooms.
// listRefreshes (router.refresh RSC fetches of /talk) is secondary evidence; the wire count is authoritative.
export function observedTalkList(page: Page, rooms: { path: string }[]) {
  const observation = roomWires.get(page)!;
  const ids = rooms.map(room => room.path.split("/").at(-1)!);
  for (let i = observation.sockets.length - 1; i >= 0; i--) {
    const { socket, probe } = observation.sockets[i];
    const list = probe.listSnapshot(ids);
    if (list) return { ...list, socketOpen: !socket.isClosed(), socketGeneration: i,
      navigations: observation.navigations, listRefreshes: observation.listRefreshes };
  }
  return null;
}

export async function submissionIds(page: Page) {
  return page.evaluate(() => {
    // Next consumes and clears window.__next_f during hydration. Inline script
    // elements retain the original JSON chunks; parse them without executing JS.
    const chunks: unknown[][] = [];
    for (const script of document.scripts) {
      const match = script.textContent?.match(/self\.__next_f\.push\((\[[\s\S]*\])\)/);
      if (match) { try { chunks.push(JSON.parse(match[1])); } catch { /* unrelated script */ } }
    }
    const wire = chunks.map(chunk => typeof chunk[1] !== "string" ? "" : chunk[0] === 3
      ? new TextDecoder().decode(Uint8Array.from(atob(chunk[1]), character => character.charCodeAt(0))) : chunk[1]).join("");
    const ids: string[] = [];
    function visit(value: unknown) {
      if (!value || typeof value !== "object") return;
      const row = value as Record<string, unknown>;
      if (typeof row.id === "string" && /^[a-f0-9-]{36}$/.test(row.id) &&
        (row.kind === "age" || row.kind === "enrollment") && row.status === "submitted") ids.push(row.id);
      for (const child of Object.values(value)) visit(child);
    }
    for (const line of wire.split("\n")) {
      const json = line.slice(line.indexOf(":") + 1);
      try { visit(JSON.parse(json)); } catch { /* non-JSON Flight record */ }
    }
    return [...new Set(ids)];
  });
}

export async function login(page: Page, user: User, next = "/mypage") {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  // Locator errors include fill values. Replace errors at this boundary so
  // neither credentials nor an MFA enrollment DOM snapshot enter the reporter.
  try {
    await page.getByLabel("メールアドレス", { exact: true }).fill(user.email, { timeout: 10_000 });
    await page.getByLabel("パスワード", { exact: true }).fill(user.password, { timeout: 10_000 });
    await page.getByRole("button", { name: "ログイン", exact: true }).click();
    await page.waitForURL(url => url.pathname !== "/login");
  } catch { throw new Error("Hosted UI login failed (credential details suppressed)"); }
}
export async function adminPage(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const local = credentials();
    await login(page, local.admin, "/admin/mfa");
    await page.getByRole("heading", { name: "二段階認証" }).waitFor();
    let secret = local.adminTotpSecret;
    if (await page.getByRole("button", { name: "認証アプリを設定する" }).isVisible()) {
      await page.getByRole("button", { name: "認証アプリを設定する" }).click();
      secret = (await page.getByLabel("手入力用のキー", { exact: true }).textContent({ timeout: 10_000 }))?.trim();
      if (!secret || !/^[A-Z2-7]+$/.test(secret)) throw new Error("Missing enrollment");
      const stored = JSON.parse(readFileSync(".e2e-hosted.local.json", "utf8"));
      writeFileSync(".e2e-hosted.local.json", JSON.stringify({ ...stored, adminTotpSecret: secret }, null, 2) + "\n", { mode: 0o600 });
    }
    if (!secret) throw new Error("Missing saved enrollment");
    // Avoid replaying the same code in successive independent browser sessions.
    const remaining = 30_000 - Date.now() % 30_000;
    await new Promise(resolve => setTimeout(resolve, remaining + 500));
    await page.getByLabel("6桁のコード").fill(totp(secret), { timeout: 10_000 });
    // TEST-012: verifyTotp sets session cookies, so the action's refresh re-renders /admin/mfa,
    // which redirects (aal2) to /admin as a soft navigation; then the client's location.assign
    // loads /admin as a document. The response and the URL can both be ready while that document
    // is still uncommitted (the old page's load state then answers), so wait for the new
    // document's own load event and prove the old window is gone.
    await page.evaluate(() => { (window as unknown as Record<string, unknown>).__campusMfaDocument = true; });
    const documentResponse = page.waitForResponse(response => response.request().isNavigationRequest() &&
      response.request().frame() === page.mainFrame() && new URL(response.url()).pathname === "/admin", { timeout: 30_000 });
    const documentLoad = page.waitForEvent("load", { timeout: 30_000 });
    await page.getByRole("button", { name: "確認", exact: true }).click();
    await documentResponse;
    await documentLoad;
    if (new URL(page.url()).pathname !== "/admin" ||
      await page.evaluate(() => "__campusMfaDocument" in window)) throw new Error("Admin document not loaded");
    return page;
  } catch {
    await context.close();
    throw new Error("Hosted administrator MFA failed (credential details suppressed)");
  }
}
export async function userPage(browser: Browser, index: number, next = "/mypage") {
  const context = await browser.newContext();
  const page = await context.newPage();
  const user = readState().users[index];
  const observed = { insertAt: 0, insertCount: 0, subscribedAt: 0, readyAt: 0, systemError: false, errorCode: null as string | null, closed: 0, join: null as ReturnType<typeof realtimeJoinFlags> };
  realtime.set(page, observed);
  const wires = { sockets: [] as { socket: WebSocket; probe: RoomWireProbe }[], refreshRequests: 0, navigations: 0, listRefreshes: 0 };
  roomWires.set(page, wires);
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") wires.refreshRequests++;
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) wires.navigations++;
    else if (url.pathname === "/talk" && request.headers()["rsc"] === "1") wires.listRefreshes++;
  });
  page.on("websocket", socket => {
    const probe = new RoomWireProbe();
    wires.sockets.push({ socket, probe });
    socket.on("framesent", frame => {
      probe.observe(String(frame.payload), true);
      const join = realtimeJoinFlags(String(frame.payload), user.id);
      if (join) observed.join = join;
    });
    socket.on("close", () => observed.closed++);
    socket.on("framereceived", frame => {
    probe.observe(String(frame.payload), false);
    const flags = realtimeFlags(String(frame.payload));
    if (flags.insert) { observed.insertAt = Date.now(); observed.insertCount++; }
    if (flags.subscribed) observed.subscribedAt = Date.now();
    if (flags.ready) observed.readyAt = Date.now();
    if (flags.systemError) { observed.systemError = true; observed.errorCode = flags.errorCode; }
  }); });
  try { await login(page, user, next); return page; }
  catch (error) { await context.close(); throw error; }
}
export async function photoPng() {
  return sharp({ create: { width: 32, height: 40, channels: 3, background: { r: 130, g: 140, b: 150 } } }).png().toBuffer();
}
export async function loadedPhoto(page: Page, alt: string) {
  const photo = page.getByAltText(alt, { exact: true });
  await expect(photo).toBeVisible();
  await expect.poll(() => photo.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  const src = await photo.getAttribute("src");
  expect(src).toMatch(/^\/media\/photos\/[a-f0-9-]{36}$/);
  const response = await appGet(page.request, src!);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toMatch(/^image\//);
}
export async function discover(page: Page, name: string, visible = true) {
  await page.goto("/");
  const link = page.getByRole("link", { name: `${name}のプロフィールを見る`, exact: true });
  if (visible) await expect(link).toBeVisible();
  else await expect(link).toHaveCount(0);
  return link;
}
export async function openRoom(page: Page, partner: string) {
  await page.goto("/talk");
  await page.getByRole("link").filter({ has: page.getByRole("heading", { name: partner, exact: true }) }).click();
  await expect(page.getByRole("log", { name: "会話履歴" })).toBeVisible();
}
export async function sendMessage(page: Page, text: string) {
  await page.getByLabel("メッセージ", { exact: true }).fill(text);
  await page.getByRole("button", { name: "送信", exact: true }).click();
  await expect(page.getByRole("log").getByText(text, { exact: true })).toBeVisible();
}
// HOSTED-E2E-LIKES (docs/43 §4.1, §4.3): the like on a detail page, and the likes page's two lists.
export async function likeOnProfile(page: Page, name: string) {
  await page.getByRole("button", { name: `${name}にいいね`, exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("いいねしました。");
  await expect(page.getByText("いいね済み", { exact: true })).toBeVisible();
}
export async function likesTab(page: Page, tab: "いいねされた" | "いいねした") {
  await page.goto("/likes");
  await page.getByRole("tab", { name: tab, exact: true }).click();
  await expect(page.getByRole("tab", { name: tab, exact: true })).toHaveAttribute("aria-selected", "true");
  return page.getByRole("tabpanel").getByRole("listitem");
}
// B likes back from "いいねされた": the match text, then "トークを開く" names the new conversation. Returns its path.
export async function likeBack(page: Page, name: string) {
  const row = (await likesTab(page, "いいねされた")).filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: `${name}にいいねを返す`, exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("マッチしました。トークで話せます。");
  const talk = page.getByRole("link", { name: "トークを開く", exact: true });
  await expect(talk).toHaveAttribute("href", /^\/talk\/[a-f0-9-]{36}$/);
  return (await talk.getAttribute("href"))!;
}
// Fresh participants use the same app onboarding/synthetic-review/acceptance
// paths as groups 1/2/4 (NT-21 and the likes group). No privileged shortcut creates their eligibility.
export async function eligibleUsers(browser: Browser, classes: readonly (1 | 2)[]) {
  const start = readState().users.length;
  const count = classes.length;
  await createRunUsers(count);
  const indices = Array.from({ length: count }, (_, i) => start + i);
  const ids: string[] = [];
  for (const index of indices) {
    const page = await userPage(browser, index, "/onboarding");
    try {
      await page.getByLabel("表示名", { exact: true }).fill(readState().users[index].name);
      await page.getByRole("radio", { name: "その他", exact: true }).check();
      await page.getByLabel("生年月日", { exact: true }).fill("2000-01-02");
      await page.getByLabel("18歳以上です", { exact: true }).check();
      await page.getByRole("button", { name: "次へ", exact: true }).click();
      await page.getByLabel("学校", { exact: true }).selectOption("00000000-0000-4000-8000-00000000a001");
      await page.getByLabel("学科", { exact: true }).selectOption("00000000-0000-4000-8000-00000000b011");
      await page.getByLabel("クラス", { exact: true }).selectOption(`00000000-0000-4000-8000-00000000c11${classes[index - start]}`);
      await page.getByRole("button", { name: "次へ", exact: true }).click();
      await page.getByRole("button", { name: "次へ", exact: true }).click();
      await page.getByRole("checkbox", { name: "友達がほしい", exact: true }).check();
      await page.getByRole("button", { name: "確認へ", exact: true }).click();
      await page.getByRole("button", { name: "プロフィールを保存", exact: true }).click();
      await page.getByLabel("写真を追加", { exact: true }).setInputFiles({ name: "fictional.png", mimeType: "image/png", buffer: await photoPng() });
      await loadedPhoto(page, "登録した写真 1");
      await page.getByRole("button", { name: "プロフィールを完成", exact: true }).click();
      await expect(page.getByText("プロフィールを作成しました。", { exact: true })).toBeVisible();
      await page.goto("/verification");
      for (const title of ["年齢確認", "在学確認"]) {
        const section = page.getByRole("region", { name: title, exact: true });
        await section.getByRole("button", { name: "架空のサンプル資料1", exact: true }).click();
        await section.getByRole("button", { name: "提出", exact: true }).click();
        await expect(section.getByText("提出済み", { exact: true })).toBeVisible();
      }
      await page.reload();
      const ownIds = await submissionIds(page);
      expect(ownIds).toHaveLength(2);
      ids.push(...ownIds);
    } finally { await page.context().close(); }
  }
  const admin = await adminPage(browser);
  try {
    for (const id of ids) {
      await admin.goto("/admin/verifications");
      const index = (await submissionIds(admin)).indexOf(id);
      expect(index, "claim only this run's submitted ID").toBeGreaterThanOrEqual(0);
      await admin.getByRole("region", { name: "提出一覧" }).getByRole("listitem").nth(index).getByRole("button", { name: "担当する" }).click();
      await expect(admin).toHaveURL(new RegExp(`/admin/verifications/${id}$`));
      await admin.getByRole("button", { name: "承認", exact: true }).click();
      await expect(admin.getByRole("status")).toHaveText("審査結果を保存しました。");
    }
  } finally { await admin.context().close(); }
  return indices;
}
