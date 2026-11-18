// NT-25 rate limits before and after each limit (docs/04_DATABASE.md §5.3-§5.5, §8 "レート制限"). The P4 values are
// provisional and read from private.rate_policy / private.block_total_limit, never hard-coded here.
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { connect, createMasters, createUser, missingId, type Masters } from "./fixtures";
import { deny, fingerprint, freshDb, owner, rpc, user } from "./harness";

let db: PGlite;
let m: Masters;

beforeAll(async () => {
  db = await freshDb();
  m = await createMasters(db, "limits");
});

const limit = async (action: string) => (await owner<{ max_count: number }>(db,
  "select max_count from private.rate_policy($1)", [action]))[0].max_count;
const events = async (u: string, action: string) => (await owner<{ n: number }>(db,
  "select count(*)::int as n from private.rate_limit_events where user_id = $1 and action = $2", [u, action]))[0].n;
/** moves the user's events of one action out of the window (owner preparation, like expires_at in the past) */
const ageEvents = (u: string, action: string, by: string) => owner(db,
  `update private.rate_limit_events set created_at = created_at - $3::interval where user_id = $1 and action = $2`, [u, action, by]);
const RATE_LIMITED = deny("rate_limited");
const PRIVACY = ["boolean", "boolean", "boolean", "boolean", "boolean", "uuid[]", "uuid[]", "uuid[]"];
const REPORT = ["uuid", "public.report_context", "public.report_reason", "text", "uuid", "bigint"];

describe("NT-25 rate limits", () => {
  it("likes and unlikes share one counter of every attempt, rejected ones included; the limit answers the same for any target", async () => {
    const max = await limit("like");
    expect(max).toBe(100);
    const [{ window }] = await owner<{ window: string }>(db, "select window_length::text as window from private.rate_policy('like')");
    expect(window).toBe("1 day");
    const me = await createUser(db, { cls: m.classes[0] });
    const targets = [await createUser(db, { cls: m.classes[4] }), await createUser(db, { cls: m.classes[5] })];
    for (let i = 0; i < max - 3; i += 1) {
      expect(await rpc(db, user(me), "like_user", [missingId()])).toEqual(deny("not_available"));
    }
    expect((await rpc(db, user(me), "like_user", [targets[0]])).ok).toBe(true);
    expect((await rpc(db, user(me), "unlike_user", [targets[0]])).ok).toBe(true);
    expect((await rpc(db, user(me), "like_user", [targets[0]])).ok).toBe(true);   // the max-th attempt
    expect(await events(me, "like")).toBe(max);
    const before = await fingerprint(db, ["private.rate_limit_events"]);
    for (const [fn, target] of [["like_user", targets[1]], ["like_user", missingId()], ["unlike_user", targets[0]]] as const) {
      expect(await rpc(db, user(me), fn, [target])).toEqual(RATE_LIMITED);
    }
    expect(await events(me, "like")).toBe(max + 3);   // rate-limited attempts are recorded too
    expect(await fingerprint(db, ["private.rate_limit_events"])).toBe(before);   // the like stays, no new one
    const [{ liked }] = await owner<{ liked: number }>(db, "select count(*)::int as liked from public.likes where liker_id = $1", [me]);
    expect(liked).toBe(1);
    expect(await events(me, "request")).toBe(0);
    await ageEvents(me, "like", "25 hours");
    expect((await rpc(db, user(me), "like_user", [targets[1]])).ok).toBe(true);
  });

  it("messages: the limit stops new rows; a resend of an existing client_msg_id still returns its row", async () => {
    const max = await limit("message");
    const me = await createUser(db, { cls: m.classes[0] });
    const peer = await createUser(db, { cls: m.classes[4] });
    const { conversation } = await connect(db, me, peer);
    const firstId = randomUUID();
    const first = await rpc(db, user(me), "send_message", [conversation, firstId, "架空の本文0"]);
    for (let i = 1; i < max; i += 1) {
      expect((await rpc(db, user(me), "send_message", [conversation, randomUUID(), `架空の本文${i}`])).ok).toBe(true);
    }
    const before = await fingerprint(db);
    expect(await rpc(db, user(me), "send_message", [conversation, randomUUID(), "架空の超過"])).toEqual(RATE_LIMITED);
    expect(await fingerprint(db)).toBe(before);
    expect(await rpc(db, user(me), "send_message", [conversation, firstId, "架空の再送"])).toEqual(first);
    expect((await rpc(db, user(peer), "send_message", [conversation, randomUUID(), "架空の相手"])).ok).toBe(true);   // per user
    await ageEvents(me, "message", "2 minutes");
    expect((await rpc(db, user(me), "send_message", [conversation, randomUUID(), "架空の窓の後"])).ok).toBe(true);
  });

  it("reports count every attempt; the limit answers the same for related and unrelated targets", async () => {
    const max = await limit("report");
    const me = await createUser(db, { cls: m.classes[0] });
    const related = await createUser(db, { cls: m.classes[4] });
    const report = (target: string) =>
      rpc(db, user(me), "submit_report", [target, "profile", "spam", null, null, null], REPORT);
    for (let i = 0; i < max - 1; i += 1) expect(await report(missingId())).toEqual(deny("not_available"));
    expect((await report(related)).ok).toBe(true);
    for (const target of [related, missingId()]) expect(await report(target)).toEqual(RATE_LIMITED);
    expect(await events(me, "report")).toBe(max + 2);
    const [{ reports }] = await owner<{ reports: number }>(db, "select count(*)::int as reports from public.reports where reporter_id = $1", [me]);
    expect(reports).toBe(1);
  });

  it("blocks: the daily limit and the total limit answer the same for every kind of target", async () => {
    const max = await limit("block");
    const me = await createUser(db, { cls: m.classes[0] });
    const visible = await createUser(db, { cls: m.classes[4] });
    for (let i = 0; i < max; i += 1) {
      expect(await rpc(db, user(me), "block_user", [missingId()])).toEqual({ ok: true, code: "ok", ref: null });
    }
    const before = await fingerprint(db);
    for (const target of [visible, missingId()]) expect(await rpc(db, user(me), "block_user", [target])).toEqual(RATE_LIMITED);
    expect(await fingerprint(db)).toBe(before);
    const [{ visibleNow }] = await owner<{ visibleNow: boolean }>(db, `select private.pair_visible($1, $2) as "visibleNow"`, [me, visible]);
    expect(visibleNow).toBe(true);   // the rate-limited block did not happen

    const [{ total }] = await owner<{ total: number }>(db, "select private.block_total_limit() as total");
    const hoarder = await createUser(db, { cls: m.classes[5] });
    await owner(db, `insert into public.blocks (blocker_id, blocked_id)
                     select $1, gen_random_uuid() from generate_series(1, $2)`, [hoarder, total]);
    for (const target of [visible, missingId()]) expect(await rpc(db, user(hoarder), "block_user", [target])).toEqual(RATE_LIMITED);
    const [one] = await owner<{ blocked_id: string }>(db, "select blocked_id::text from public.blocks where blocker_id = $1 limit 1", [hoarder]);
    expect((await rpc(db, user(hoarder), "unblock_user", [one.blocked_id])).ok).toBe(true);
    expect((await rpc(db, user(hoarder), "block_user", [visible])).ok).toBe(true);   // total - 1 < total
  });

  it("privacy settings: the limit leaves the settings unchanged", async () => {
    const max = await limit("privacy");
    const me = await createUser(db, { cls: m.classes[0] });
    const flip = (on: boolean) => rpc(db, user(me), "update_privacy_settings", [true, on, false, false, false, [], [], []], PRIVACY);
    for (let i = 0; i < max; i += 1) expect((await flip(i % 2 === 0)).ok).toBe(true);
    const before = await fingerprint(db);
    expect(await flip(true)).toEqual(RATE_LIMITED);
    expect(await fingerprint(db)).toBe(before);
    await ageEvents(me, "privacy", "25 hours");
    expect((await flip(true)).ok).toBe(true);
  });
});
