import { test, expect, type Browser, type Page } from "@playwright/test";
import { clearRunEmailConfirmation, insertRunMessage } from "./lifecycle";
import { evidence, readState, saveState, type RunRoom } from "./state";
import { roomsReady, talkListTopic } from "./realtime";
import { adminPage, discover, eligibleUsers, likeBack, likeOnProfile, observedRealtime, observedRoom, observedTalkList, openRoom, sendMessage, userPage } from "./ui";

const windowMs = 35_000;
test.setTimeout(360_000);

async function acceptRoom(browser: Browser, requester: number, recipient: number): Promise<RunRoom> {
  const state = readState();
  const a = await userPage(browser, requester);
  const b = await userPage(browser, recipient, "/likes");
  try {
    await (await discover(a, state.users[recipient].name)).click();
    await expect(a).toHaveURL(/\/profiles\/[a-f0-9-]{36}(?:\?|$)/);
    await expect(a.getByRole("heading", { level: 1 })).toContainText(state.users[recipient].name);
    await likeOnProfile(a, state.users[recipient].name);
    const matched = await likeBack(b, state.users[requester].name);
    await openRoom(a, state.users[recipient].name);
    await openRoom(b, state.users[requester].name);
    expect(new URL(b.url()).pathname).toBe(new URL(a.url()).pathname);
    expect(new URL(a.url()).pathname).toBe(matched);
    const room: RunRoom = { path: new URL(a.url()).pathname, participants: [requester, recipient] };
    expect(room.path).not.toBe(state.conversation);
    const latest = readState();
    expect(latest.revocationRooms?.some(value => value.path === room.path) ?? false).toBe(false);
    saveState({ ...latest, revocationRooms: [...latest.revocationRooms ?? [], room] });
    return room;
  } finally { await a.context().close(); await b.context().close(); }
}

async function livePair(a: Page, b: Page, room: RunRoom) {
  await expect.poll(() => roomsReady([observedRealtime(a), observedRealtime(b)])).toBe(true);
  for (const page of [a, b]) {
    expect(observedRealtime(page).join).toEqual({ role: "authenticated", userMatches: true, roomFilterValid: true });
    await expect.poll(() => observedRoom(page, room.path)?.state).toBe("joined");
    expect(observedRoom(page, room.path)?.ready).toBe(true);
  }
  const beforeA = observedRoom(a, room.path)!.insertCount;
  const beforeB = observedRoom(b, room.path)!.insertCount;
  for (const [sender, receiver, label] of [[a, b, "A"], [b, a, "B"]] as const) {
    const text = `NT-21 preflight ${label} ${readState().runId}`;
    await sendMessage(sender, text);
    await expect(receiver.getByRole("log").getByText(text, { exact: true })).toBeVisible();
  }
  // Drain both own and peer frames before taking the revocation baseline.
  await expect.poll(() => observedRoom(a, room.path)!.insertCount).toBe(beforeA + 2);
  await expect.poll(() => observedRoom(b, room.path)!.insertCount).toBe(beforeB + 2);
}

function sameChannel(page: Page, room: RunRoom, before: NonNullable<ReturnType<typeof observedRoom>>) {
  const after = observedRoom(page, room.path)!;
  expect(after.state, "existing channel is still joined").toBe("joined");
  expect(after.ready).toBe(true);
  expect(after.socketOpen, "original WebSocket remains open").toBe(true);
  expect(after.socketGeneration, "no replacement socket").toBe(before.socketGeneration);
  expect(after.joins, "no rejoin").toBe(before.joins);
  expect(after.leaves, "no channel removal").toBe(before.leaves);
  expect(after.navigations, "subscriber's page never reloads").toBe(before.navigations);
}

// TEST-007: the talk list subscription (one unfiltered channel on /talk) observed on the wire, per run room.
type TalkList = NonNullable<ReturnType<typeof observedTalkList>>;
function listCount(list: TalkList, room: RunRoom) { return list.rooms[room.path.split("/").at(-1)!].count; }

async function joinedTalkList(page: Page, rooms: RunRoom[]) {
  await expect.poll(() => observedTalkList(page, rooms)?.state).toBe("joined");
  await expect.poll(() => observedTalkList(page, rooms)?.ready).toBe(true);
  expect(observedRealtime(page).systemError, "talk list joins without a Realtime error").toBe(false);
  expect(observedRealtime(page).join).toMatchObject({ role: "authenticated", userMatches: true });
  return observedTalkList(page, rooms)!;
}

// Both rooms' preflight messages (one per direction) reach the talk list before revocation.
async function drainedTalkList(page: Page, rooms: RunRoom[], joined: TalkList) {
  await expect.poll(() => rooms.map(room => listCount(observedTalkList(page, rooms)!, room)))
    .toEqual(rooms.map(room => listCount(joined, room) + 2));
  return observedTalkList(page, rooms)!;
}

function sameTalkList(page: Page, rooms: RunRoom[], before: TalkList) {
  const after = observedTalkList(page, rooms)!;
  expect(after.state, "talk list channel is still joined").toBe("joined");
  expect(after.ready).toBe(true);
  expect(after.socketOpen, "original talk list WebSocket remains open").toBe(true);
  expect(after.socketGeneration, "no replacement talk list socket").toBe(before.socketGeneration);
  expect(after.joins, "no talk list rejoin").toBe(before.joins);
  expect(after.leaves, "no talk list channel removal").toBe(before.leaves);
  expect(after.navigations, "talk list page never reloads").toBe(before.navigations);
}

function talkListResult(page: Page, rooms: RunRoom[], [revoked, control]: RunRoom[], before: TalkList, heartbeatBefore: number) {
  sameTalkList(page, rooms, before);
  const after = observedTalkList(page, rooms)!;
  expect(after.heartbeatReplies, "talk list socket answers a heartbeat within the observation window").toBeGreaterThan(heartbeatBefore);
  expect(listCount(after, revoked), "NT-21 talk list delivery leak").toBe(listCount(before, revoked));
  expect(listCount(after, control), "control INSERT reaches the same talk list socket").toBe(listCount(before, control) + 1);
  expect(after.insertCount, "exactly the control INSERT on the talk list topic").toBe(before.insertCount + 1);
  expect(after.otherInserts).toBe(before.otherInserts);
}

function talkListEvidence(record: Record<string, unknown>, page: Page, rooms: RunRoom[], revoked: RunRoom, started: number | null) {
  if (started !== null) record.observedWindowMs = Date.now() - started;
  const after = observedTalkList(page, rooms);
  record.after = after;
  const before = record.before as TalkList | undefined;
  if (before && after && listCount(after, revoked) > listCount(before, revoked)) record.finding = "NT-21 talk list delivery leak";
}

function inserted(result: Awaited<ReturnType<typeof insertRunMessage>>, label: string) {
  const prerequisite = result.status === 403 || result.code === "42501"
    ? "; missing temporary coordinator grant: INSERT on public.messages and USAGE on public.messages_id_seq to service_role (campus-link-dev only)"
    : "";
  expect(result, `${label} must really succeed${prerequisite}`).toMatchObject({ status: 201, ok: true });
}

async function suspendRunUser(browser: Browser, reporter: Page) {
  const marker = `NT-21 suspension ${readState().runId}`;
  await reporter.getByRole("button", { name: "ブロック・通報", exact: true }).click();
  await reporter.getByRole("dialog").getByRole("button", { name: "通報", exact: true }).click();
  await reporter.getByRole("dialog").getByLabel("詳細（任意）").fill(marker);
  await reporter.getByRole("dialog").getByRole("button", { name: "通報する", exact: true }).click();
  await expect(reporter.getByRole("dialog").getByRole("status")).toHaveText("通報を受け付けました。");
  await reporter.getByRole("dialog").getByRole("button", { name: "閉じる", exact: true }).click();
  const admin = await adminPage(browser);
  try {
    await admin.goto("/admin/reports");
    const hrefs = await admin.locator('a[href^="/admin/reports/"]').evaluateAll(links => links.map(link => link.getAttribute("href")!));
    let found = false;
    for (const href of hrefs) {
      await admin.goto(href);
      if (await admin.getByText(marker, { exact: true }).isVisible()) { found = true; break; }
    }
    expect(found, "only the exact run-owned report may be actioned").toBe(true);
    await admin.getByRole("button", { name: "アカウントを停止", exact: true }).click();
    await admin.getByRole("dialog").getByRole("button", { name: "停止する", exact: true }).click();
    await expect(admin.getByRole("status")).toHaveText("アカウントを停止しました。");
  } finally { await admin.context().close(); }
}

test("NT-21 block suppresses server INSERT on an existing joined channel, with an unblocked control", async ({ browser }) => {
  const [ai, bi, ci] = await eligibleUsers(browser, [1, 2, 2]);
  const room = await acceptRoom(browser, ai, bi);
  // A uses class 1; B and C use class 2, keeping both pairs discoverable.
  const controlRoom = await acceptRoom(browser, ai, ci);
  const a = await userPage(browser, ai, room.path);
  const b = await userPage(browser, bi, room.path);
  const controlA = await userPage(browser, ai, controlRoom.path);
  const c = await userPage(browser, ci, controlRoom.path);
  const listA = await userPage(browser, ai, "/talk");
  const listRooms = [room, controlRoom];
  const listRecord: Record<string, unknown> = { runId: readState().runId, status: "failed", topic: talkListTopic, windowMs, observedWindowMs: 0,
    subscriber: "A on /talk, joined before the preflight", revoked: "A-B room, B blocks A", control: "A-C room on the same talk list socket", controlDelayMs: null };
  const record: Record<string, unknown> = { runId: readState().runId, status: "failed", windowMs, observedWindowMs: 0,
    ineligibility: "block", control: "same A, separate unblocked A-C conversation and page", controlDelayMs: null };
  let observationStarted: number | null = null;
  try {
    const listJoined = await joinedTalkList(listA, listRooms);
    await livePair(a, b, room);
    await livePair(controlA, c, controlRoom);
    const listBefore = await drainedTalkList(listA, listRooms, listJoined);
    listRecord.joined = listJoined;
    listRecord.before = listBefore;
    const before = observedRoom(a, room.path)!;
    const controlBefore = observedRoom(controlA, controlRoom.path)!;
    record.before = before;
    record.controlBefore = controlBefore;
    await b.getByRole("button", { name: "ブロック・通報", exact: true }).click();
    await b.getByRole("dialog").getByRole("button", { name: "ブロック", exact: true }).click();
    await b.getByRole("dialog").getByRole("button", { name: "ブロックする", exact: true }).click();
    await expect(b.getByRole("heading", { name: "この会話は表示できません" })).toBeVisible();
    sameChannel(a, room, before);
    sameTalkList(listA, listRooms, listBefore);
    record.insert = await insertRunMessage(room, bi);
    const controlStarted = Date.now();
    record.controlInsert = await insertRunMessage(controlRoom, ci);
    inserted(record.insert as Awaited<ReturnType<typeof insertRunMessage>>, "post-block server INSERT");
    inserted(record.controlInsert as Awaited<ReturnType<typeof insertRunMessage>>, "control server INSERT");
    const started = Date.now();
    observationStarted = started;
    const heartbeatBefore = observedRoom(a, room.path)!.heartbeatReplies;
    const listHeartbeatBefore = observedTalkList(listA, listRooms)!.heartbeatReplies;
    while (Date.now() - started < windowMs) {
      sameChannel(a, room, before);
      sameTalkList(listA, listRooms, listBefore);
      const list = observedTalkList(listA, listRooms)!;
      if (listCount(list, controlRoom) > listCount(listBefore, controlRoom) && listRecord.controlDelayMs === null)
        listRecord.controlDelayMs = list.rooms[controlRoom.path.split("/").at(-1)!].at - controlStarted;
      const count = observedRoom(controlA, controlRoom.path)!.insertCount;
      if (count > controlBefore.insertCount && record.controlDelayMs === null) record.controlDelayMs = observedRoom(controlA, controlRoom.path)!.insertAt - controlStarted;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    record.observedWindowMs = Date.now() - started;
    sameChannel(a, room, before);
    sameChannel(controlA, controlRoom, controlBefore);
    expect(observedRoom(a, room.path)!.heartbeatReplies, "original socket answers a heartbeat within the observation window").toBeGreaterThan(heartbeatBefore);
    const leaked = observedRoom(a, room.path)!.insertCount !== before.insertCount;
    if (leaked) record.finding = "NT-21 delivery leak";
    expect(observedRoom(a, room.path)!.insertCount, "NT-21 delivery leak").toBe(before.insertCount);
    expect(observedRoom(controlA, controlRoom.path)!.insertCount, "unblocked control receives the server INSERT").toBe(controlBefore.insertCount + 1);
    expect(record.controlDelayMs).not.toBeNull();
    record.status = "pass";
    talkListResult(listA, listRooms, [room, controlRoom], listBefore, listHeartbeatBefore);
    expect(listRecord.controlDelayMs).not.toBeNull();
    listRecord.status = "pass";
  } finally {
    talkListEvidence(listRecord, listA, listRooms, room, observationStarted);
    evidence("talkListRevocationBlock", listRecord);
    if (observationStarted !== null) record.observedWindowMs = Date.now() - observationStarted;
    record.after = observedRoom(a, room.path);
    record.controlAfter = observedRoom(controlA, controlRoom.path);
    if (record.before && observedRoom(a, room.path)!.insertCount > (record.before as { insertCount: number }).insertCount) record.finding = "NT-21 delivery leak";
    evidence("realtimeRevocationBlock", record);
    for (const page of [a, b, controlA, c, listA]) await page.context().close();
  }
});

test("NT-21 ineligibility suppresses server INSERT for both A and B, with an eligible B-D control", async ({ browser }) => {
  const [ai, bi, di] = await eligibleUsers(browser, [1, 2, 1]);
  const room = await acceptRoom(browser, ai, bi);
  const controlRoom = await acceptRoom(browser, bi, di);
  const a = await userPage(browser, ai, room.path);
  const b = await userPage(browser, bi, room.path);
  const controlB = await userPage(browser, bi, controlRoom.path);
  const d = await userPage(browser, di, controlRoom.path);
  const listB = await userPage(browser, bi, "/talk");
  const listRooms = [room, controlRoom];
  const listRecord: Record<string, unknown> = { runId: readState().runId, status: "failed", topic: talkListTopic, windowMs, observedWindowMs: 0,
    subscriber: "B on /talk, joined before the preflight", revoked: "A-B room, A made ineligible", control: "B-D room on the same talk list socket", controlDelayMs: null };
  const record: Record<string, unknown> = { runId: readState().runId, status: "failed", windowMs, observedWindowMs: 0,
    ineligibility: null, control: "same B, separate eligible B-D conversation and page", controlDelayMs: null };
  let observationStarted: number | null = null;
  try {
    const listJoined = await joinedTalkList(listB, listRooms);
    await livePair(a, b, room);
    await livePair(controlB, d, controlRoom);
    const listBefore = await drainedTalkList(listB, listRooms, listJoined);
    listRecord.joined = listJoined;
    listRecord.before = listBefore;
    const before = observedRoom(a, room.path)!;
    const peerBefore = observedRoom(b, room.path)!;
    const controlBefore = observedRoom(controlB, controlRoom.path)!;
    record.before = before;
    record.peerBefore = peerBefore;
    record.controlBefore = controlBefore;
    const unconfirm = await clearRunEmailConfirmation(ai);
    record.emailUnconfirm = unconfirm;
    if (unconfirm.cleared) record.ineligibility = "email confirmation cleared (Auth Admin GET verified)";
    else {
      // Auth Admin can accept email_confirm:false without actually clearing it.
      // Suspending A makes pair_visible false for both A and B. Keep both
      // A-B channels joined and use B's separate eligible B-D room as control.
      await suspendRunUser(browser, b);
      record.ineligibility = "account suspended through exact run-owned report (Auth API did not clear confirmation)";
    }
    listRecord.ineligibility = record.ineligibility;
    sameChannel(a, room, before);
    sameChannel(b, room, peerBefore);
    sameTalkList(listB, listRooms, listBefore);
    record.insert = await insertRunMessage(room, bi);
    const controlStarted = Date.now();
    record.controlInsert = await insertRunMessage(controlRoom, di);
    inserted(record.insert as Awaited<ReturnType<typeof insertRunMessage>>, "post-ineligibility server INSERT");
    inserted(record.controlInsert as Awaited<ReturnType<typeof insertRunMessage>>, "control server INSERT");
    const started = Date.now();
    observationStarted = started;
    const heartbeatBefore = observedRoom(a, room.path)!.heartbeatReplies;
    const peerHeartbeatBefore = observedRoom(b, room.path)!.heartbeatReplies;
    const listHeartbeatBefore = observedTalkList(listB, listRooms)!.heartbeatReplies;
    while (Date.now() - started < windowMs) {
      sameChannel(a, room, before);
      sameChannel(b, room, peerBefore);
      sameTalkList(listB, listRooms, listBefore);
      const list = observedTalkList(listB, listRooms)!;
      if (listCount(list, controlRoom) > listCount(listBefore, controlRoom) && listRecord.controlDelayMs === null)
        listRecord.controlDelayMs = list.rooms[controlRoom.path.split("/").at(-1)!].at - controlStarted;
      if (observedRoom(controlB, controlRoom.path)!.insertCount > controlBefore.insertCount && record.controlDelayMs === null) record.controlDelayMs = observedRoom(controlB, controlRoom.path)!.insertAt - controlStarted;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    record.observedWindowMs = Date.now() - started;
    sameChannel(a, room, before);
    sameChannel(b, room, peerBefore);
    sameChannel(controlB, controlRoom, controlBefore);
    expect(observedRoom(a, room.path)!.heartbeatReplies, "original socket answers a heartbeat within the observation window").toBeGreaterThan(heartbeatBefore);
    expect(observedRoom(b, room.path)!.heartbeatReplies, "B's original socket also answers a heartbeat").toBeGreaterThan(peerHeartbeatBefore);
    const leaked = observedRoom(a, room.path)!.insertCount !== before.insertCount || observedRoom(b, room.path)!.insertCount !== peerBefore.insertCount;
    if (leaked) record.finding = "NT-21 delivery leak";
    expect(observedRoom(a, room.path)!.insertCount, "NT-21 delivery leak to A").toBe(before.insertCount);
    expect(observedRoom(b, room.path)!.insertCount, "NT-21 delivery leak to B on the ineligible A-B pair").toBe(peerBefore.insertCount);
    expect(observedRoom(controlB, controlRoom.path)!.insertCount, "eligible B-D control receives the server INSERT").toBe(controlBefore.insertCount + 1);
    expect(record.controlDelayMs).not.toBeNull();
    record.status = "pass";
    talkListResult(listB, listRooms, [room, controlRoom], listBefore, listHeartbeatBefore);
    expect(listRecord.controlDelayMs).not.toBeNull();
    listRecord.status = "pass";
  } finally {
    talkListEvidence(listRecord, listB, listRooms, room, observationStarted);
    evidence("talkListRevocationIneligible", listRecord);
    if (observationStarted !== null) record.observedWindowMs = Date.now() - observationStarted;
    record.after = observedRoom(a, room.path);
    record.peerAfter = observedRoom(b, room.path);
    record.controlAfter = observedRoom(controlB, controlRoom.path);
    if (record.before && record.peerBefore) {
      const aReceivedNone = observedRoom(a, room.path)!.insertCount === (record.before as { insertCount: number }).insertCount;
      const bReceivedNone = observedRoom(b, room.path)!.insertCount === (record.peerBefore as { insertCount: number }).insertCount;
      record.noDelivery = { a: aReceivedNone, b: bReceivedNone };
      if (!aReceivedNone || !bReceivedNone) record.finding = "NT-21 delivery leak";
    }
    record.clientRefreshedToken = (observedRoom(a, room.path)?.refreshRequests ?? 0) > Number((record.before as { refreshRequests?: number } | undefined)?.refreshRequests ?? 0);
    record.clientUpdatedChannelToken = (observedRoom(a, room.path)?.tokenUpdates ?? 0) > Number((record.before as { tokenUpdates?: number } | undefined)?.tokenUpdates ?? 0);
    evidence("realtimeRevocationIneligible", record);
    for (const page of [a, b, controlB, d, listB]) await page.context().close();
  }
});
