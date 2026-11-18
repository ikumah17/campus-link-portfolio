import { test, expect } from "@playwright/test";
import { readState, saveState, evidence } from "./state";
import { userPage, openRoom, sendMessage, observedRealtime, likeBack, likeOnProfile } from "./ui";

test("like match, live room delivery and talk list refresh", async ({ browser }) => {
  const state = readState();
  const a = await userPage(browser, 0, state.profiles![1]);
  const b = await userPage(browser, 1, "/likes");
  try {
    // SEC-010: after sign-in no session cookie is readable from JavaScript; the auth cookie is HttpOnly.
    // Only booleans and counts are asserted, so no cookie value reaches the reporter.
    expect(await a.evaluate(() => document.cookie.split(";").some(cookie => cookie.trim().startsWith("sb-"))), "sb- cookie readable from JS").toBe(false);
    const authCookies = (await a.context().cookies()).filter(cookie => /^sb-.+-auth-token(\.\d+)?$/.test(cookie.name));
    expect(authCookies.length, "sb- auth cookie present").toBeGreaterThan(0);
    expect(authCookies.every(cookie => cookie.httpOnly), "sb- auth cookie HttpOnly").toBe(true);
    // HOSTED-E2E-LIKES: A likes B on B's detail page, B likes back from "いいねされた" and the match opens the talk.
    await likeOnProfile(a, state.users[1].name);
    const matched = await likeBack(b, state.users[0].name);
    await openRoom(a, state.users[1].name);
    await openRoom(b, state.users[0].name);
    expect(new URL(a.url()).pathname).toBe(matched);
    expect(new URL(b.url()).pathname).toBe(matched);
    saveState({ ...state, conversation: matched });
    // Observe a real postgres_changes frame, then the screen update. No reload,
    // focus event, manual refresh or polling RPC can satisfy this assertion.
    await expect.poll(() => observedRealtime(b).readyAt).toBeGreaterThan(0);
    const navigation = b.url();
    let navigations = 0;
    b.on("request", request => { if (request.isNavigationRequest() && request.frame() === b.mainFrame()) navigations++; });
    const started = Date.now();
    const message = `架空のメッセージ ${state.runId}`;
    await sendMessage(a, message);
    await expect(b.getByRole("log").getByText(message, { exact: true })).toBeVisible();
    expect(b.url()).toBe(navigation);
    expect(navigations, "open room did not reload").toBe(0);
    expect(observedRealtime(b).insertAt, "hosted Realtime INSERT frame arrived").toBeGreaterThanOrEqual(started);
    const roomDelayMs = Date.now() - started;
    observedRealtime(b).subscribedAt = 0;
    observedRealtime(b).readyAt = 0;
    await b.goto("/talk");
    await expect.poll(() => observedRealtime(b).readyAt).toBeGreaterThan(0);
    const beforeListUpdate = navigations;
    const listStarted = Date.now();
    const latest = `一覧の更新 ${state.runId}`;
    await sendMessage(a, latest);
    await expect(b.getByText(latest, { exact: true })).toBeVisible();
    expect(observedRealtime(b).insertAt).toBeGreaterThanOrEqual(listStarted);
    expect(navigations, "talk list did not reload").toBe(beforeListUpdate);
    evidence("chat", { status: "pass", roomDelayMs, talkListDelayMs: Date.now() - listStarted });
  } finally { await a.context().close(); await b.context().close(); }
});
