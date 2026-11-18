import { test, expect } from "@playwright/test";
import { Session, race, summary, type Result } from "./concurrency";
import { evidence, readState } from "./state";
import { discover, eligibleUsers, likeOnProfile, likesTab, openRoom, userPage } from "./ui";

// HOSTED-E2E-LIKES (docs/43 §6.4), a default group: two fresh run users C and D, made eligible through the app as in
// NT-21 (different classes, so the default same-class hide keeps them visible). C likes D on D's detail page and takes
// it back from "いいねした"; both lists are read on each side and get_like_state is read with each user's own JWT. Then
// C and D call like_user at the same time on separate TCP connections (concurrency.ts): exactly one match, one
// conversation, both likes gone. Each opens the same room from the talk list. D blocks C in the room, which ends the
// match: the room closes for both, the pair is no longer visible and a new like is not_available. Teardown deletes C and D.
test.describe.configure({ mode: "serial" });

type LikeRow = { i_liked: boolean; liked_me: boolean; conversation_id: string | null };
let pair: [number, number] | null = null;
let conversation: string | null = null;
const record: Record<string, unknown> = {};

function rows(value: Result): unknown[] {
  expect(value.status).toBe(200);
  expect(Array.isArray(value.data)).toBe(true);
  return value.data as unknown[];
}
async function likeState(session: Session, target: string) {
  return rows(await session.rpc("get_like_state", { p_target: target })) as LikeRow[];
}
async function likeCounts(session: Session) {
  const counts: Record<string, number> = {};
  for (const direction of ["sent", "received"]) counts[direction] = rows(await session.rpc("list_my_likes", { p_direction: direction })).length;
  return counts;
}

test("like and unlike on the detail page and the likes page's two lists", async ({ browser }) => {
  test.setTimeout(420_000);
  const [c, d] = await eligibleUsers(browser, [1, 2]);
  pair = [c, d];
  const users = readState().users;
  const [cs, ds] = [await Session.signIn(c), await Session.signIn(d)];
  const cp = await userPage(browser, c), dp = await userPage(browser, d);
  try {
    await (await discover(cp, users[d].name)).click();
    await expect(cp.getByRole("heading", { level: 1 })).toContainText(users[d].name);
    await likeOnProfile(cp, users[d].name);
    expect(await likeState(cs, users[d].id)).toEqual([{ i_liked: true, liked_me: false, conversation_id: null }]);
    expect(await likeState(ds, users[c].id)).toEqual([{ i_liked: false, liked_me: true, conversation_id: null }]);
    expect(await likeCounts(cs)).toEqual({ sent: 1, received: 0 });
    expect(await likeCounts(ds)).toEqual({ sent: 0, received: 1 });

    // The two lists on each side.
    await expect((await likesTab(cp, "いいねした")).filter({ hasText: users[d].name })).toHaveCount(1);
    await expect((await likesTab(cp, "いいねされた")).filter({ hasText: users[d].name })).toHaveCount(0);
    await expect(cp.getByText("まだいいねはありません。", { exact: true })).toBeVisible();
    await expect((await likesTab(dp, "いいねされた")).filter({ hasText: users[c].name })).toHaveCount(1);
    await expect((await likesTab(dp, "いいねした")).filter({ hasText: users[c].name })).toHaveCount(0);
    await expect(dp.getByText("まだいいねしていません。", { exact: true })).toBeVisible();
    // D sees on C's detail page that C liked D.
    await (await discover(dp, users[c].name)).click();
    await expect(dp.getByRole("heading", { level: 1 })).toContainText(users[c].name);
    await expect(dp.getByText("あなたにいいねしています", { exact: true })).toBeVisible();
    await expect(dp.getByRole("button", { name: `${users[c].name}にいいねを返す`, exact: true })).toBeVisible();

    // C takes the like back from "いいねした"; it leaves both lists.
    const sent = (await likesTab(cp, "いいねした")).filter({ hasText: users[d].name });
    await sent.getByRole("button", { name: `${users[d].name}へのいいねを取り消す`, exact: true }).click();
    await expect(cp.getByRole("status")).toHaveText("いいねを取り消しました。");
    await expect(sent).toHaveCount(0);
    expect(await likeState(cs, users[d].id)).toEqual([{ i_liked: false, liked_me: false, conversation_id: null }]);
    expect(await likeState(ds, users[c].id)).toEqual([{ i_liked: false, liked_me: false, conversation_id: null }]);
    expect(await likeCounts(cs)).toEqual({ sent: 0, received: 0 });
    expect(await likeCounts(ds)).toEqual({ sent: 0, received: 0 });
    await likesTab(cp, "いいねした");
    await expect(cp.getByText("まだいいねしていません。", { exact: true })).toBeVisible();
    await likesTab(dp, "いいねされた");
    await expect(dp.getByText("まだいいねはありません。", { exact: true })).toBeVisible();
    // Not liked any more, so D is listed for C again.
    await discover(cp, users[d].name);
    record.likeUnlike = "pass";
    evidence("likes", { status: "running", ...record });
  } finally { await cp.context().close(); await dp.context().close(); }
});

test("both liking at once makes exactly one match, and both open its talk", async ({ browser }) => {
  if (!pair) throw new Error("The like step did not record its pair");
  const [c, d] = pair;
  const users = readState().users;
  const [cs, ds] = [await Session.signIn(c), await Session.signIn(d)];
  const calls = await race(() => cs.rpc("like_user", { p_target: users[d].id }), () => ds.rpc("like_user", { p_target: users[c].id }));
  expect(calls.concurrent, "different connections had both likes in flight").toBe(true);
  for (const value of [calls.left, calls.right]) expect(summary(value)).toMatchObject({ status: 200, ok: true, code: "ok" });
  // One answer is ok(null) (only a like), the other ok(the new conversation id).
  const refs = [calls.left.ref, calls.right.ref];
  expect(refs.filter(ref => ref !== null)).toHaveLength(1);
  conversation = refs.find(ref => ref !== null)!;
  expect(await likeState(cs, users[d].id)).toEqual([{ i_liked: false, liked_me: false, conversation_id: conversation }]);
  expect(await likeState(ds, users[c].id)).toEqual([{ i_liked: false, liked_me: false, conversation_id: conversation }]);
  expect(await likeCounts(cs)).toEqual({ sent: 0, received: 0 });
  expect(await likeCounts(ds)).toEqual({ sent: 0, received: 0 });
  // A later like of the matched pair changes nothing.
  expect(summary(await cs.rpc("like_user", { p_target: users[d].id }))).toMatchObject({ status: 200, ok: false, code: "already_connected" });
  expect(await likeState(cs, users[d].id)).toEqual([{ i_liked: false, liked_me: false, conversation_id: conversation }]);

  const cp = await userPage(browser, c), dp = await userPage(browser, d);
  try {
    for (const [page, partner] of [[cp, users[d].name], [dp, users[c].name]] as const) {
      await page.goto("/talk");
      await expect(page.getByRole("link").filter({ has: page.getByRole("heading", { name: partner, exact: true }) })).toHaveCount(1);
      await openRoom(page, partner);
      expect(new URL(page.url()).pathname).toBe(`/talk/${conversation}`);
    }
  } finally { await cp.context().close(); await dp.context().close(); }
  record.race = { concurrent: calls.concurrent, overlapMs: calls.overlapMs, matchedBy: calls.left.ref ? "C" : "D", left: summary(calls.left), right: summary(calls.right) };
  evidence("likes", { status: "running", ...record });
});

test("a block in the room ends the match", async ({ browser }) => {
  if (!pair || !conversation) throw new Error("The race step did not record its match");
  const [c, d] = pair;
  const users = readState().users;
  const cp = await userPage(browser, c, `/talk/${conversation}`), dp = await userPage(browser, d, `/talk/${conversation}`);
  try {
    await expect(dp.getByRole("log", { name: "会話履歴" })).toBeVisible();
    await dp.getByRole("button", { name: "ブロック・通報", exact: true }).click();
    await dp.getByRole("dialog").getByRole("button", { name: "ブロック", exact: true }).click();
    await dp.getByRole("dialog").getByRole("button", { name: "ブロックする", exact: true }).click();
    await expect(dp.getByRole("heading", { name: "この会話は表示できません" })).toBeVisible();
    await expect(dp.getByRole("button", { name: "送信", exact: true })).toHaveCount(0);
    await cp.reload();
    await expect(cp.getByRole("heading", { name: "この会話は表示できません" })).toBeVisible();
    await expect(cp.getByRole("button", { name: "送信", exact: true })).toHaveCount(0);
    // C has no other connection, so its talk list is empty again.
    await cp.goto("/talk");
    await expect(cp.getByText("つながりはまだありません。", { exact: true })).toBeVisible();
    await likesTab(cp, "いいねされた");
    await expect(cp.getByText("まだいいねはありません。", { exact: true })).toBeVisible();
  } finally { await cp.context().close(); await dp.context().close(); }
  const [cs, ds] = [await Session.signIn(c), await Session.signIn(d)];
  // The pair is no longer visible: no like state either way, and a new like is the indistinguishable refusal.
  expect(await likeState(cs, users[d].id)).toEqual([]);
  expect(await likeState(ds, users[c].id)).toEqual([]);
  expect(summary(await cs.rpc("like_user", { p_target: users[d].id }))).toMatchObject({ status: 200, ok: false, code: "not_available" });
  expect(await likeCounts(cs)).toEqual({ sent: 0, received: 0 });
  expect(await likeCounts(ds)).toEqual({ sent: 0, received: 0 });
  record.block = "pass";
  evidence("likes", { status: "pass", ...record });
});
