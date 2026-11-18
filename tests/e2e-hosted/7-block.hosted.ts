import { test, expect } from "@playwright/test";
import { readState, evidence } from "./state";
import { userPage, sendMessage, observedRealtime } from "./ui";
import { roomsReady } from "./realtime";

test("block ends the conversation and prevents further sending", async ({ browser }) => {
  const state = readState();
  const a = await userPage(browser, 0, state.conversation!);
  const b = await userPage(browser, 1, state.conversation!);
  try {
    const last = `ブロック前の最後 ${state.runId}`;
    await expect.poll(() => roomsReady([observedRealtime(a), observedRealtime(b)])).toBe(true);
    for (const page of [a, b]) {
      expect(observedRealtime(page).join).toEqual({ role: "authenticated", userMatches: true, roomFilterValid: true });
    }
    // Establish real two-way activity before revocation; a join acknowledgement
    // alone does not prove that the provider is already streaming changes.
    const handshake = `ブロック前の接続確認 ${state.runId}`;
    await sendMessage(a, handshake);
    await expect(b.getByRole("log").getByText(handshake, { exact: true })).toBeVisible();
    const beforeLast = observedRealtime(a).insertCount;
    await sendMessage(b, last);
    await expect.poll(() => observedRealtime(a).insertCount, { message: "A receives B's last pre-block INSERT" }).toBeGreaterThan(beforeLast);
    await expect(a.getByRole("log").getByText(last, { exact: true })).toBeVisible();
    await b.getByRole("button", { name: "ブロック・通報", exact: true }).click();
    await b.getByRole("dialog").getByRole("button", { name: "ブロック", exact: true }).click();
    await b.getByRole("dialog").getByRole("button", { name: "ブロックする", exact: true }).click();
    await expect(b.getByRole("heading", { name: "この会話は表示できません" })).toBeVisible();
    await expect(b.getByRole("button", { name: "送信", exact: true })).toHaveCount(0);
    const afterBlock = observedRealtime(a).insertCount;
    // A's room may close itself when a background fetch answers not_available,
    // which removes the check button; accept either order of events.
    const aUnavailable = a.getByRole("heading", { name: "この会話は表示できません" });
    const aCheck = a.getByRole("button", { name: "新しいメッセージを確認" });
    await expect(aUnavailable.or(aCheck)).toBeVisible();
    let aClosed: "self" | "refresh" = "refresh";
    if (await aCheck.isVisible()) {
      try { await aCheck.click(); } catch (error) { if (!(await aUnavailable.isVisible())) throw error; aClosed = "self"; }
    } else aClosed = "self";
    await expect(aUnavailable).toBeVisible();
    await expect(a.getByRole("button", { name: "送信", exact: true })).toHaveCount(0);
    expect(observedRealtime(a).insertCount).toBe(afterBlock);
    evidence("block", { status: "pass", uiAssertions: "pass", postBlockSend: "app prevents B from sending after block", lastPreBlockInsertObserved: true, aClosed,
      realtime: { a: observedRealtime(a), b: observedRealtime(b) },
      limitation: "No post-block INSERT was attempted because the app removes both composers; server-side post-block event filtering remains unverified." });
  } catch (error) {
    evidence("blockDiagnostic", { realtime: observedRealtime(a), peerRealtime: observedRealtime(b), roomVisible: await a.getByRole("log").count(),
      status: await a.getByRole("status").allTextContents() });
    throw error;
  } finally { await a.context().close(); await b.context().close(); }
});
