// NT-15 blocks and NT-16 reports (docs/04_DATABASE.md §3.8, §5.5, §6, §13.2; ARCH-R2-02). Every RPC call
// commits on its own and the persistent state is read back from a separate owner transaction.
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { connect, createMasters, createUser, legacyRequest, like, missingId, type Masters } from "./fixtures";
import { asUser, deny, fingerprint, freshDb, owner, raised, rpc, rpcRows, user } from "./harness";

let db: PGlite;
let m: Masters;

beforeAll(async () => {
  db = await freshDb();
  m = await createMasters(db, "safety");
});

const OK = { ok: true, code: "ok", ref: null };
const block = (me: string, target: string) => rpc(db, user(me), "block_user", [target]);
const unblock = (me: string, target: string) => rpc(db, user(me), "unblock_user", [target]);
const blocksOf = (me: string) =>
  rpcRows<{ blocked_id: string; blocked_name_snapshot: string | null; created_at: Date }>(db, user(me), "list_my_blocks");
const firstPhoto = async (u: string) =>
  (await owner<{ id: string }>(db, "select id::text as id from public.profile_photos where user_id = $1 limit 1", [u]))[0].id;
const likesOf = async (u: string) => (await owner<{ n: number }>(db,
  "select count(*)::int as n from public.likes where $1 in (liker_id, liked_id)", [u]))[0].n;

/** every discovery page (50 at a time, keyset by user id) */
async function discovered(viewer: string): Promise<string[]> {
  const ids: string[] = [];
  for (let after: string | null = null; ;) {
    const rows: { user_id: string }[] = await rpcRows<{ user_id: string }>(db, user(viewer), "discover_profiles",
      [null, null, null, null, after, 50], ["int", "int", "text[]", "uuid[]", "uuid", "int"]);
    ids.push(...rows.map((r) => r.user_id));
    if (rows.length < 50) return ids;
    after = rows[rows.length - 1].user_id;
  }
}

/** what `viewer` can learn about `target` through the read and like RPCs */
async function viewOf(viewer: string, target: string, photo: string) {
  return {
    profile: await rpcRows(db, user(viewer), "get_profile", [target]),
    discovered: (await discovered(viewer)).includes(target),
    photos: await rpcRows(db, user(viewer), "authorize_photo_delivery", [[photo]], ["uuid[]"]),
    state: await rpcRows(db, user(viewer), "get_like_state", [target]),
    like: await rpc(db, user(viewer), "like_user", [target]),
  };
}

describe("NT-15 blocking", () => {
  it("both sides stop seeing each other at once and the blocked side cannot tell a block from a missing user", async () => {
    const me = await createUser(db, { cls: m.classes[0] });
    const peer = await createUser(db, { cls: m.classes[4] });
    expect((await rpcRows(db, user(peer), "get_profile", [me]))).toHaveLength(1);   // control
    expect(await block(me, peer)).toEqual(OK);
    const mine = await firstPhoto(me);
    const theirs = await firstPhoto(peer);
    expect(await viewOf(me, peer, theirs)).toEqual({ profile: [], discovered: false, photos: [], state: [], like: deny("not_available") });
    const blocked = await viewOf(peer, me, mine);
    const stranger = await viewOf(peer, missingId(), missingId());
    expect(blocked).toEqual(stranger);
    expect(blocked.like).toEqual(deny("not_available"));
    expect(await blocksOf(peer)).toEqual([]);
    expect(await likesOf(me)).toBe(0);
    expect(await likesOf(peer)).toBe(0);
  });

  it("likes in both directions go, the connection ends and unblocking restores neither", async () => {
    const me = await createUser(db, { cls: m.classes[0] });
    const out = await createUser(db, { cls: m.classes[4] });
    const inc = await createUser(db, { cls: m.classes[5] });
    const both = await createUser(db, { cls: m.classes[6] });
    const friend = await createUser(db, { cls: m.classes[7] });
    const bystander = await createUser(db, { cls: m.classes[3] });
    expect((await rpc(db, user(me), "like_user", [out])).ok).toBe(true);
    expect((await rpc(db, user(inc), "like_user", [me])).ok).toBe(true);
    await like(db, me, both);
    await like(db, both, me);
    await like(db, out, bystander);   // another pair's like stays
    const { connection, conversation } = await connect(db, me, friend);

    for (const target of [out, inc, both, friend]) expect(await block(me, target)).toEqual(OK);
    expect(await likesOf(me)).toBe(0);
    expect(await likesOf(bystander)).toBe(1);
    const [k] = await owner<{ ended_reason: string }>(db, "select ended_reason::text from public.connections where id = $1", [connection]);
    expect(k.ended_reason).toBe("blocked");

    for (const target of [out, inc, both, friend]) expect(await unblock(me, target)).toEqual(OK);
    expect(await likesOf(me)).toBe(0);
    const [after] = await owner<{ ended_reason: string; active: number }>(db, `
      select k.ended_reason::text,
             (select count(*)::int from public.connections x where x.ended_at is null
               and x.user_low = k.user_low and x.user_high = k.user_high) as active
      from public.connections k where k.id = $1`, [connection]);
    expect(after).toEqual({ ended_reason: "blocked", active: 0 });
    expect(await asUser(db, user(friend), "select m.id from public.list_messages($1, null, null) m", [conversation])).toEqual([]);
    expect(await rpcRows(db, user(me), "get_profile", [friend])).toHaveLength(1);   // visible again, not reconnected
    expect(await rpcRows(db, user(me), "get_like_state", [inc])).toEqual([{ i_liked: false, liked_me: false, conversation_id: null }]);
  });

  it("(a)-(e): one row each, the same answers, only (a) keeps its name, and nothing learned later appears", async () => {
    const me = await createUser(db, { cls: m.classes[0], displayName: "架空ブロック主" });
    const targets = {
      a: await createUser(db, { cls: m.classes[4], displayName: "架空見える" }),
      b: await createUser(db, { cls: m.classes[5], displayName: "架空非表示", hidden: { schools: [m.classes[0].schoolId] } }),
      c: await createUser(db, { cls: m.classes[6], displayName: "架空逆向き" }),
      d: await createUser(db, { cls: m.classes[7], displayName: "架空資格なし", status: "suspended" }),
      e: missingId(),
    };
    expect(await block(targets.c, me)).toEqual(OK);   // (c) blocked the caller first
    // control: only (a) is identity-visible right now
    for (const [label, id] of Object.entries(targets)) {
      const [{ visible }] = await owner<{ visible: boolean }>(db, "select private.can_see_identity($1, $2) as visible", [me, id]);
      expect(visible, label).toBe(label === "a");
    }

    const answers = [];
    for (const id of Object.values(targets)) answers.push(await block(me, id));
    expect(answers).toEqual(Array(5).fill(OK));
    const listed = await blocksOf(me);
    expect(new Map(listed.map((r) => [r.blocked_id, r.blocked_name_snapshot]))).toEqual(new Map([
      [targets.a, "架空見える"], [targets.b, null], [targets.c, null], [targets.d, null], [targets.e, null]]));
    expect(Object.keys(listed[0]).sort()).toEqual(["blocked_id", "blocked_name_snapshot", "created_at"]);

    const errors = new Set<string>();
    for (const id of Object.values(targets)) {
      errors.add(await raised(() => asUser(db, user(me), "select * from public.blocks where blocked_id = $1", [id])));
    }
    expect([...errors]).toEqual(["permission denied for table blocks"]);

    // later changes on the targets' side add nothing to the list
    const casts = ["text", "text", "text", "text[]", "text[]"];
    expect((await rpc(db, user(targets.a), "update_profile", ["架空改名", "female", null, [], []], casts)).ok).toBe(true);
    expect((await rpc(db, user(targets.b), "update_privacy_settings", [true, false, false, false, false, [], [], []],
      ["boolean", "boolean", "boolean", "boolean", "boolean", "uuid[]", "uuid[]", "uuid[]"])).ok).toBe(true);
    expect(await unblock(targets.c, me)).toEqual(OK);
    await owner(db, "update public.profiles set account_status = 'active' where user_id = $1", [targets.d]);
    expect(await blocksOf(me)).toEqual(listed);

    const unblocked = [];
    for (const id of Object.values(targets)) unblocked.push(await unblock(me, id));
    expect(unblocked).toEqual(Array(5).fill(OK));
    expect(await blocksOf(me)).toEqual([]);
    expect(await unblock(me, missingId())).toEqual(OK);   // no row: the same answer
    const again = [];
    for (const id of Object.values(targets)) again.push(await block(me, id));
    expect(again).toEqual(Array(5).fill(OK));
    expect((await blocksOf(me)).length).toBe(5);
  });

  it("blocking oneself or without an id is a validation error and writes nothing", async () => {
    const me = await createUser(db, { cls: m.classes[0] });
    const before = await fingerprint(db);
    expect(await raised(() => block(me, me))).toBe("validation");
    expect(await raised(() => rpc(db, user(me), "block_user", [null], ["uuid"]))).toBe("validation");
    expect(await raised(() => unblock(me, me))).toBe("validation");
    expect(await fingerprint(db)).toBe(before);
  });
});

describe("NT-16 reports", () => {
  const report = (me: string, target: string, context: string, request: string | null = null, message: string | null = null,
    detail: string | null = null) =>
    rpc(db, user(me), "submit_report", [target, context, "harassment", detail, request, message],
      ["uuid", "public.report_context", "public.report_reason", "text", "uuid", "bigint"]);
  const attempts = async (u: string) => (await owner<{ n: number }>(db,
    "select count(*)::int as n from private.rate_limit_events where user_id = $1 and action = 'report'", [u]))[0].n;
  const reportsBy = async (u: string) => (await owner<{ n: number }>(db,
    "select count(*)::int as n from public.reports where reporter_id = $1", [u]))[0].n;

  it("unrelated targets, other pairs' messages, own messages: not_available, the attempt still recorded", async () => {
    const me = await createUser(db, { cls: m.classes[0] });
    const peer = await createUser(db, { cls: m.classes[4] });
    const third = await createUser(db, { cls: m.classes[5] });
    const hidden = await createUser(db, { cls: m.classes[6], hidden: { schools: [m.classes[0].schoolId] } });
    const ownConv = await connect(db, me, peer);
    const otherConv = await connect(db, peer, third);
    const mine = (await rpc(db, user(me), "send_message", [ownConv.conversation, randomUUID(), "架空の自分の本文"])).ref!;
    const elsewhere = (await rpc(db, user(peer), "send_message", [otherConv.conversation, randomUUID(), "架空の別会話"])).ref!;
    await like(db, third, hidden);   // another pair's like relates neither of them to me

    const before = await attempts(me);
    const cases: [string, () => ReturnType<typeof report>][] = [
      ["profile of an unrelated hidden user", () => report(me, hidden, "profile")],
      ["profile of a missing user", () => report(me, missingId(), "profile")],
      ["message of another conversation", () => report(me, peer, "message", null, elsewhere)],
      ["own message", () => report(me, peer, "message", null, mine)],
      ["missing message", () => report(me, peer, "message", null, "999999999")],
    ];
    for (const [label, run] of cases) expect(await run(), label).toEqual(deny("not_available"));
    expect(await attempts(me) - before).toBe(cases.length);
    expect(await reportsBy(me)).toBe(0);
  });

  it("message reports keep an evidence snapshot; ended connections, past requests and likes either way count as related", async () => {
    const me = await createUser(db, { cls: m.classes[0] });
    const peer = await createUser(db, { cls: m.classes[4] });
    const { conversation } = await connect(db, me, peer);
    const bad = (await rpc(db, user(peer), "send_message", [conversation, randomUUID(), "架空の問題の本文"])).ref!;
    expect(await block(me, peer)).toEqual(OK);   // the connection ends; the report is still allowed
    const filed = await report(me, peer, "message", null, bad, "架空の詳細");
    expect(filed).toMatchObject({ ok: true, code: "ok" });
    const [evidence] = await owner<{ conversation_id: string; message_body: string; same_time: boolean }>(db, `
      select e.conversation_id::text, e.message_body, e.message_created_at = m.created_at as same_time
      from private.report_evidence e join public.messages m on m.id = $2::bigint
      where e.report_id = $1`, [filed.ref, bad]);
    expect(evidence).toEqual({ conversation_id: conversation, message_body: "架空の問題の本文", same_time: true });

    // a past request (history) and a like in either direction relate a profile report even when the pair is not visible
    const hiddenSchool = { hidden: { schools: [m.classes[0].schoolId] } };
    const other = await createUser(db, { cls: m.classes[5], ...hiddenSchool });
    await legacyRequest(db, other, me, { status: "declined" });
    expect((await report(me, other, "profile")).ok).toBe(true);
    const liker = await createUser(db, { cls: m.classes[5], ...hiddenSchool });
    const liked = await createUser(db, { cls: m.classes[5], ...hiddenSchool });
    await like(db, liker, me);
    await like(db, me, liked);
    expect((await report(me, liker, "profile")).ok).toBe(true);
    expect((await report(me, liked, "profile")).ok).toBe(true);
    const visible = await createUser(db, { cls: m.classes[6] });
    expect((await report(me, visible, "profile")).ok).toBe(true);   // pair_visible
    const [{ evidenceRows }] = await owner<{ evidenceRows: number }>(db, `
      select count(*)::int as "evidenceRows" from private.report_evidence e
      join public.reports r on r.id = e.report_id where r.reporter_id = $1`, [me]);
    expect(evidenceRows).toBe(1);
  });

  it("the reporter sees id/time/status only; the target sees nothing; direct reads are denied", async () => {
    const me = await createUser(db, { cls: m.classes[0] });
    const target = await createUser(db, { cls: m.classes[4] });
    const filed = await report(me, target, "profile");
    expect(filed.ok).toBe(true);
    const mine = await rpcRows<Record<string, unknown>>(db, user(me), "my_reports");
    expect(mine).toHaveLength(1);
    expect(Object.keys(mine[0]).sort()).toEqual(["created_at", "id", "status"]);
    expect(mine[0]).toMatchObject({ id: filed.ref, status: "open" });
    expect(await rpcRows(db, user(target), "my_reports")).toEqual([]);
    for (const who of [me, target]) {
      expect(await raised(() => asUser(db, user(who), "select * from public.reports"))).toMatch(/permission denied/);
      expect(await raised(() => asUser(db, user(who), "select * from private.report_evidence"))).toMatch(/permission denied/);
    }
  });

  it("argument shape errors are validation and write nothing (no attempt recorded)", async () => {
    const me = await createUser(db, { cls: m.classes[0] });
    const target = await createUser(db, { cls: m.classes[4] });
    const before = await fingerprint(db);
    const bad: [string, () => ReturnType<typeof report>][] = [
      ["self", () => report(me, me, "profile")],
      ["profile with a message id", () => report(me, target, "profile", null, "1")],
      ["request without a request id", () => report(me, target, "request")],
      ["request, any request id (no new request reports, order 34)", () => report(me, target, "request", randomUUID())],
      ["message with a request id", () => report(me, target, "message", randomUUID(), "1")],
      ["detail of 1001 characters", () => report(me, target, "profile", null, null, "あ".repeat(1001))],
    ];
    for (const [label, run] of bad) expect(await raised(run), label).toBe("validation");
    expect(await fingerprint(db)).toBe(before);
  });
});
