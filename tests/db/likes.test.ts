// DB-LIKES-001 order 34 (docs/43 §2, §3, §6.1): likes, the match, the frozen requests and the migration of existing
// data. Every RPC commits on its own; persistent state is checked from a separate owner transaction afterwards.
// PGlite has one connection, so the concurrent match is checked here as both commit orders plus the pair lock held
// inside the call; the real two-connection race is the hosted group (docs/43 §6.4).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, createMasters, createUser, legacyRequest, like, missingId, type Masters } from "./fixtures";
import {
  asUser, claimsOf, deny, fingerprint, freshDb, MIGRATIONS_DIR, migrationFiles, owner, raised, rpc, rpcRows, seedSqlBefore34, user,
} from "./harness";

let db: PGlite;
let m: Masters;

beforeAll(async () => {
  db = await freshDb();
  m = await createMasters(db, "likes");
});

const pair = async () => [await createUser(db, { cls: m.classes[0] }), await createUser(db, { cls: m.classes[4] })];
const likeUser = (from: string, to: string | null) => rpc(db, user(from), "like_user", [to], ["uuid"]);
const unlikeUser = (from: string, to: string | null) => rpc(db, user(from), "unlike_user", [to], ["uuid"]);
const likeRow = async (from: string, to: string) => (await owner<{ at: string }>(db,
  "select created_at::text as at from public.likes where liker_id = $1 and liked_id = $2", [from, to]))[0];
const pairLikes = async (a: string, b: string) => (await owner<{ n: number }>(db, `
  select count(*)::int as n from public.likes
  where (liker_id = $1 and liked_id = $2) or (liker_id = $2 and liked_id = $1)`, [a, b]))[0].n;
const links = async (a: string, b: string) => (await owner<{ n: number; active: number; conv: number }>(db, `
  select count(*)::int as n, count(*) filter (where k.ended_at is null)::int as active, count(c.id)::int as conv
  from public.connections k left join public.conversations c on c.connection_id = k.id
  where k.user_low = least($1::uuid, $2::uuid) and k.user_high = greatest($1::uuid, $2::uuid)`, [a, b]))[0];
const attempts = async (u: string) => (await owner<{ n: number }>(db,
  "select count(*)::int as n from private.rate_limit_events where user_id = $1 and action = 'like'", [u]))[0].n;
const listed = async (viewer: string, direction: string, before: [string, string] | null = null, limit = 50) =>
  (await asUser<{ counterpart_id: string; liked_at: string; name: string }>(db, user(viewer), `
    select counterpart_id::text, liked_at::text, (counterpart).display_name as name
    from public.list_my_likes($1, $2::timestamptz, $3::uuid, $4)`, [direction, before?.[0] ?? null, before?.[1] ?? null, limit]));
const stateOf = (viewer: string, target: string | null) =>
  rpcRows<{ i_liked: boolean; liked_me: boolean; conversation_id: string | null }>(db, user(viewer), "get_like_state", [target], ["uuid"]);
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
const setStatus = (u: string, status: string) =>
  owner(db, "update public.profiles set account_status = $2::public.account_status where user_id = $1", [u, status]);

describe("like_user", () => {
  it("a like is ok with no ref; a second like keeps the one row and its created_at", async () => {
    const [a, b] = await pair();
    expect(await likeUser(a, b)).toEqual({ ok: true, code: "ok", ref: null });
    const first = await likeRow(a, b);
    expect(first).toBeDefined();
    expect(await likeUser(a, b)).toEqual({ ok: true, code: "ok", ref: null });
    expect(await likeRow(a, b)).toEqual(first);
    expect(await pairLikes(a, b)).toBe(1);
    expect(await links(a, b)).toEqual({ n: 0, active: 0, conv: 0 });
    expect(await attempts(a)).toBe(2);
  });

  it("null and self raise validation and write nothing (no attempt recorded)", async () => {
    const [a] = await pair();
    const before = await fingerprint(db);
    expect(await raised(() => likeUser(a, a))).toBe("validation");
    expect(await raised(() => likeUser(a, null))).toBe("validation");
    expect(await raised(() => unlikeUser(a, a))).toBe("validation");
    expect(await raised(() => unlikeUser(a, null))).toBe("validation");
    expect(await fingerprint(db)).toBe(before);
  });

  for (const status of ["deactivated", "suspended", "deleted"]) {
    it(`a ${status} actor gets forbidden from like and unlike, before any write`, async () => {
      const [a, b] = await pair();
      await like(db, a, b);
      await setStatus(a, status);
      const before = await fingerprint(db);
      expect(await raised(() => likeUser(a, b))).toBe("forbidden");
      expect(await raised(() => unlikeUser(a, b))).toBe("forbidden");
      expect(await raised(() => rpc(db, user(a), "list_my_likes", ["sent"]))).toBe(status === "deleted" ? "forbidden" : "");
      expect(await fingerprint(db)).toBe(before);
    });
  }

  it("an account without a profile gets forbidden", async () => {
    const nobody = await createUser(db, { profile: false });
    const [b] = await pair();
    expect(await raised(() => likeUser(nobody, b))).toBe("forbidden");
  });

  it("repeatable read and serializable are refused with forbidden, before any write", async () => {
    const [a, b] = await pair();
    const before = await fingerprint(db);
    for (const isolation of ["repeatable read", "serializable"] as const) {
      expect(await raised(() => asUser(db, user(a), "select * from public.like_user($1)", [b], { isolation }))).toBe("forbidden");
    }
    expect(await fingerprint(db)).toBe(before);
  });

  it("missing, blocked either way, hidden either way and ineligible targets: not_available, no like row, attempt counted", async () => {
    const me = await createUser(db, { cls: m.classes[0] });
    const targets: Record<string, string> = {
      missing: missingId(),
      blockedByMe: await createUser(db, { cls: m.classes[4] }),
      blocksMe: await createUser(db, { cls: m.classes[4] }),
      sameClassDefault: await createUser(db, { cls: m.classes[0] }),
      hiddenByMe: await createUser(db, { cls: m.classes[5] }),
      hidesMe: await createUser(db, { cls: m.classes[6], hidden: { schools: [m.classes[0].schoolId] } }),
      ageRevoked: await createUser(db, { cls: m.classes[4], ageRevoked: true }),
      enrollmentExpired: await createUser(db, { cls: m.classes[4], affiliation: "expired" }),
      noPhoto: await createUser(db, { cls: m.classes[4], photos: 0, removedPhotos: 1 }),
      incomplete: await createUser(db, { cls: m.classes[4], completed: false }),
      deactivated: await createUser(db, { cls: m.classes[4], status: "deactivated" }),
      suspended: await createUser(db, { cls: m.classes[4], status: "suspended" }),
      deleted: await createUser(db, { cls: m.classes[4], status: "deleted" }),
    };
    await owner(db, "insert into public.blocks (blocker_id, blocked_id) values ($1, $2), ($3, $1)", [me, targets.blockedByMe, targets.blocksMe]);
    await owner(db, "insert into public.hidden_affiliations (user_id, class_id) values ($1, $2)", [me, m.classes[5].id]);
    const control = await createUser(db, { cls: m.classes[7] });
    expect((await likeUser(me, control)).ok).toBe(true);
    const before = await attempts(me);
    for (const [label, target] of Object.entries(targets)) {
      expect(await likeUser(me, target), label).toEqual(deny("not_available"));
    }
    expect(await attempts(me) - before).toBe(Object.keys(targets).length);
    const [{ n }] = await owner<{ n: number }>(db, "select count(*)::int as n from public.likes where liker_id = $1", [me]);
    expect(n).toBe(1);   // only the control
  });

  it("an existing like from someone who became invisible never makes a match", async () => {
    const [a, b] = await pair();
    expect((await likeUser(b, a)).ok).toBe(true);
    await owner(db, "insert into public.blocks (blocker_id, blocked_id) values ($1, $2)", [b, a]);
    expect(await likeUser(a, b)).toEqual(deny("not_available"));
    await owner(db, "delete from public.blocks where blocker_id = $1", [b]);
    await owner(db, "update public.affiliations set confirmed_until = now() - interval '1 second' where user_id = $1", [b]);
    expect(await likeUser(a, b)).toEqual(deny("not_available"));
    expect(await links(a, b)).toEqual({ n: 0, active: 0, conv: 0 });
    expect(await likeRow(b, a)).toBeDefined();
    expect(await likeRow(a, b)).toBeUndefined();
  });
});

describe("the match", () => {
  for (const order of ["a first", "b first"] as const) {
    it(`two likes make exactly one connection and conversation, ${order}; the likes go and chat works`, async () => {
      const [x, y] = await pair();
      const [first, second] = order === "a first" ? [x, y] : [y, x];
      expect(await likeUser(first, second)).toEqual({ ok: true, code: "ok", ref: null });
      const matched = await likeUser(second, first);
      expect(matched.ok).toBe(true);
      expect(matched.ref).toMatch(/^[0-9a-f-]{36}$/);
      expect(await links(x, y)).toEqual({ n: 1, active: 1, conv: 1 });
      expect(await pairLikes(x, y)).toBe(0);
      const [k] = await owner<{ origin: string | null; mode: string | null; conversation: string }>(db, `
        select k.origin_request_id as origin, k.mode::text as mode, c.id::text as conversation
        from public.connections k join public.conversations c on c.connection_id = k.id
        where k.user_low = least($1::uuid, $2::uuid) and k.user_high = greatest($1::uuid, $2::uuid)`, [x, y]);
      expect(k).toEqual({ origin: null, mode: null, conversation: matched.ref });
      for (const who of [x, y]) {
        expect((await rpcRows<{ conversation_id: string }>(db, user(who), "list_my_conversations")).map((r) => r.conversation_id))
          .toEqual([matched.ref]);
      }
      expect((await rpc(db, user(first), "send_message", [matched.ref, randomUUID(), "架空のこんにちは"])).ok).toBe(true);
      // after the match: likes are already_connected both ways, unlike changes nothing
      expect(await likeUser(x, y)).toEqual(deny("already_connected"));
      expect(await likeUser(y, x)).toEqual(deny("already_connected"));
      const before = await fingerprint(db, ["private.rate_limit_events"]);
      expect(await unlikeUser(x, y)).toEqual({ ok: true, code: "ok", ref: null });
      expect(await fingerprint(db, ["private.rate_limit_events"])).toBe(before);
      expect(await stateOf(x, y)).toEqual([{ i_liked: false, liked_me: false, conversation_id: matched.ref }]);
    });
  }

  it("the like runs under the pair's exclusive advisory lock, held until commit", async () => {
    const [a, b] = await pair();
    const held = await db.transaction(async (tx) => {
      await tx.query("set local role authenticated");
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claimsOf(user(a)))]);
      const locks = `select count(*)::int as n from pg_locks l
        where l.locktype = 'advisory' and l.mode = 'ExclusiveLock' and l.granted and l.pid = pg_backend_pid()
          and ((l.classid::bigint << 32) | l.objid::bigint)
              = hashtextextended('pair:' || least($1::uuid, $2::uuid)::text || ':' || greatest($1::uuid, $2::uuid)::text, 0)`;
      const before = (await tx.query<{ n: number }>(locks, [a, b])).rows[0].n;
      await tx.query("select * from public.like_user($1)", [b]);
      const after = (await tx.query<{ n: number }>(locks, [a, b])).rows[0].n;
      return { before, after };
    });
    expect(held).toEqual({ before: 0, after: 1 });
  });

  it("one_active_connection_per_pair stays the last guard: a second active connection of a pair cannot commit", async () => {
    const [a, b] = await pair();
    await like(db, b, a);
    expect((await likeUser(a, b)).ok).toBe(true);
    expect(await raised(() => owner(db, `insert into public.connections (user_low, user_high)
      values (least($1::uuid, $2::uuid), greatest($1::uuid, $2::uuid))`, [a, b]))).toMatch(/one_active_connection_per_pair/);
    // both likes written behind the lock's back (owner SQL) still meet the active-connection check, not a second match
    await like(db, a, b);
    await like(db, b, a);
    expect(await likeUser(a, b)).toEqual(deny("already_connected"));
    expect(await links(a, b)).toEqual({ n: 1, active: 1, conv: 1 });
  });

  it("after the connection ends, discovery shows the pair again and two new likes make a new connection", async () => {
    const [a, b] = await pair();
    await like(db, a, b);
    const first = await likeUser(b, a);
    const [{ id }] = await owner<{ id: string }>(db, "select connection_id::text as id from public.conversations where id = $1", [first.ref]);
    expect((await rpc(db, user(a), "end_connection", [id])).ok).toBe(true);
    expect(await rpc(db, user(b), "end_connection", [id])).toEqual(deny("invalid_state"));
    expect(await discovered(a)).toContain(b);
    expect(await likeUser(a, b)).toEqual({ ok: true, code: "ok", ref: null });
    const second = await likeUser(b, a);
    expect(second.ok).toBe(true);
    expect(second.ref).not.toBe(first.ref);
    expect(await links(a, b)).toEqual({ n: 2, active: 1, conv: 2 });
  });
});

describe("unlike_user", () => {
  it("removes only the caller's own like and is ok whether or not a row existed", async () => {
    const [a, b] = await pair();
    await like(db, a, b);
    await like(db, b, a);
    expect(await unlikeUser(a, b)).toEqual({ ok: true, code: "ok", ref: null });
    expect(await likeRow(a, b)).toBeUndefined();
    expect(await likeRow(b, a)).toBeDefined();
    expect(await unlikeUser(a, b)).toEqual({ ok: true, code: "ok", ref: null });
    expect(await unlikeUser(a, missingId())).toEqual({ ok: true, code: "ok", ref: null });
    expect(await attempts(a)).toBe(3);
  });

  it("takes a like back from someone who is no longer visible", async () => {
    const [a, b] = await pair();
    expect((await likeUser(a, b)).ok).toBe(true);
    await owner(db, "insert into public.blocks (blocker_id, blocked_id) values ($1, $2)", [b, a]);
    expect(await unlikeUser(a, b)).toEqual({ ok: true, code: "ok", ref: null });
    expect(await likeRow(a, b)).toBeUndefined();
  });
});

describe("list_my_likes and get_like_state", () => {
  it("sent and received lists, newest first with the id tie-break, keyset pages and the profile card", async () => {
    const me = await createUser(db, { cls: m.classes[0] });
    const others = [];
    for (let i = 0; i < 4; i += 1) others.push(await createUser(db, { cls: m.classes[4 + i] }));
    const same = "2026-11-10 10:00:00+00";
    await like(db, me, others[0], "2026-11-12 10:00:00+00");
    await like(db, me, others[1], same);
    await like(db, me, others[2], same);
    await like(db, others[3], me, "2026-11-11 10:00:00+00");
    await like(db, others[1], me, "2026-11-09 10:00:00+00");
    const tied = [others[1], others[2]].sort().reverse();
    const sent = await listed(me, "sent");
    expect(sent.map((r) => r.counterpart_id)).toEqual([others[0], ...tied]);
    expect(sent.every((r) => r.name.startsWith("架空"))).toBe(true);
    expect((await listed(me, "received")).map((r) => r.counterpart_id)).toEqual([others[3], others[1]]);
    // keyset: two at a time
    const page1 = await listed(me, "sent", null, 2);
    expect(page1.map((r) => r.counterpart_id)).toEqual([others[0], tied[0]]);
    const last = page1[1];
    expect((await listed(me, "sent", [last.liked_at, last.counterpart_id], 2)).map((r) => r.counterpart_id)).toEqual([tied[1]]);
    // the card is the limited profile_view
    const [card] = await asUser<{ card: Record<string, unknown> }>(db, user(me),
      "select to_jsonb(counterpart) as card from public.list_my_likes('received') limit 1");
    expect(Object.keys(card.card).sort()).toEqual(["age", "bio", "class_name", "department_name", "display_name",
      "gender", "hobbies", "photo_ids", "purposes", "school_name", "user_id"]);
  });

  it("validates the direction, the paired keyset arguments and clamps the limit", async () => {
    const me = await createUser(db, { cls: m.classes[0] });
    for (const others of [await createUser(db, { cls: m.classes[4] }), await createUser(db, { cls: m.classes[5] })]) await like(db, me, others);
    for (const args of [["both", null, null], [null, null, null], ["sent", "2026-11-01", null], ["sent", null, missingId()]]) {
      expect(await raised(() => asUser(db, user(me), "select * from public.list_my_likes($1, $2::timestamptz, $3::uuid)", args)), String(args))
        .toBe("validation");
    }
    expect(await listed(me, "sent", null, 0)).toHaveLength(1);
    expect(await listed(me, "sent", null, 1000)).toHaveLength(2);
  });

  it("a match leaves both lists; blocked and hidden people leave them; a deactivated caller sees nothing until reactivation", async () => {
    const me = await createUser(db, { cls: m.classes[0] });
    const [matched, blocked, hidden, kept] = [
      await createUser(db, { cls: m.classes[4] }), await createUser(db, { cls: m.classes[5] }),
      await createUser(db, { cls: m.classes[6] }), await createUser(db, { cls: m.classes[7] })];
    for (const other of [matched, blocked, hidden, kept]) await like(db, other, me);
    await like(db, me, kept);
    expect((await likeUser(me, matched)).ok).toBe(true);
    await owner(db, "insert into public.blocks (blocker_id, blocked_id) values ($1, $2)", [blocked, me]);
    await owner(db, "insert into public.hidden_affiliations (user_id, class_id) values ($1, $2)", [hidden, m.classes[0].id]);
    expect((await listed(me, "received")).map((r) => r.counterpart_id)).toEqual([kept]);
    expect((await listed(me, "sent")).map((r) => r.counterpart_id)).toEqual([kept]);
    expect(await stateOf(me, kept)).toEqual([{ i_liked: true, liked_me: true, conversation_id: null }]);
    expect(await stateOf(me, blocked)).toEqual([]);
    expect(await stateOf(me, hidden)).toEqual([]);
    expect((await rpc(db, user(me), "deactivate_account")).ok).toBe(true);
    expect(await listed(me, "received")).toEqual([]);
    expect(await listed(kept, "sent")).toEqual([]);
    expect(await pairLikes(me, kept)).toBe(2);   // deactivation keeps the likes
    expect((await rpc(db, user(me), "reactivate_account")).ok).toBe(true);
    expect((await listed(me, "received")).map((r) => r.counterpart_id)).toEqual([kept]);
  });

  it("get_like_state: validation for null and self, none / sent / received / matched for a visible person", async () => {
    const [a, b] = await pair();
    expect(await raised(() => stateOf(a, a))).toBe("validation");
    expect(await raised(() => stateOf(a, null))).toBe("validation");
    expect(await stateOf(a, missingId())).toEqual([]);
    expect(await stateOf(a, b)).toEqual([{ i_liked: false, liked_me: false, conversation_id: null }]);
    await likeUser(a, b);
    expect(await stateOf(a, b)).toEqual([{ i_liked: true, liked_me: false, conversation_id: null }]);
    expect(await stateOf(b, a)).toEqual([{ i_liked: false, liked_me: true, conversation_id: null }]);
    const matched = await likeUser(b, a);
    expect(await stateOf(b, a)).toEqual([{ i_liked: false, liked_me: false, conversation_id: matched.ref }]);
  });

  it("discovery excludes people the caller liked, keeps people who liked the caller, and takes no mode", async () => {
    const [a, b] = await pair();
    const c = await createUser(db, { cls: m.classes[5] });
    await likeUser(a, b);
    await likeUser(c, a);
    const ids = await discovered(a);
    expect(ids).not.toContain(b);
    expect(ids).toContain(c);
    expect(await discovered(b)).toContain(a);
    expect(await rpcRows(db, user(a), "get_profile", [b])).toHaveLength(1);
    const [{ old }] = await owner<{ old: string | null }>(db,
      "select to_regprocedure('public.discover_profiles(public.discover_mode,int,int,text[],uuid[],uuid,int)')::text as old");
    expect(old).toBeNull();
  });
});

describe("blocks, deletion and deleted callers", () => {
  it("block_user deletes the pair's likes both ways and ends the match; unblocking restores nothing", async () => {
    const [a, b] = await pair();
    await like(db, a, b);
    await like(db, b, a);
    expect((await rpc(db, user(a), "block_user", [b])).ok).toBe(true);
    expect(await pairLikes(a, b)).toBe(0);
    expect((await rpc(db, user(a), "unblock_user", [b])).ok).toBe(true);
    expect(await pairLikes(a, b)).toBe(0);
    const [c, d] = await pair();
    await like(db, c, d);
    const matched = await likeUser(d, c);
    expect((await rpc(db, user(d), "block_user", [c])).ok).toBe(true);
    const [k] = await owner<{ reason: string }>(db, `select k.ended_reason::text as reason from public.connections k
      join public.conversations v on v.connection_id = k.id where v.id = $1`, [matched.ref]);
    expect(k.reason).toBe("blocked");
  });

  for (const status of ["active", "deactivated", "suspended"]) {
    it(`a ${status} user's deletion deletes the user's likes both ways and ends connections`, async () => {
      const [me, to, from, peer] = [await createUser(db, { cls: m.classes[0] }), await createUser(db, { cls: m.classes[4] }),
        await createUser(db, { cls: m.classes[5] }), await createUser(db, { cls: m.classes[6] })];
      await like(db, me, to);
      await like(db, from, me);
      await like(db, to, from);   // someone else's like stays
      const { connection } = await connect(db, me, peer);
      if (status !== "active") await setStatus(me, status);
      expect((await rpc(db, user(me), "request_account_deletion")).ok).toBe(true);
      const [{ n }] = await owner<{ n: number }>(db, "select count(*)::int as n from public.likes where $1 in (liker_id, liked_id)", [me]);
      expect(n).toBe(0);
      expect(await likeRow(to, from)).toBeDefined();
      const [k] = await owner<{ reason: string }>(db, "select ended_reason::text as reason from public.connections where id = $1", [connection]);
      expect(k.reason).toBe("account_deleted");
    });
  }

  it("a deleted caller is refused by every like RPC, changing nothing", async () => {
    const [a, b] = await pair();
    await like(db, a, b);
    expect((await rpc(db, user(a), "request_account_deletion")).ok).toBe(true);
    const before = await fingerprint(db);
    for (const sql of ["select * from public.like_user($1)", "select * from public.unlike_user($1)",
      "select * from public.get_like_state($1)", "select * from public.list_my_likes('received')"]) {
      expect(await raised(() => asUser(db, user(a), sql, sql.includes("$1") ? [b] : [])), sql).toBe("forbidden");
    }
    expect(await fingerprint(db)).toBe(before);
  });
});

describe("the request history is frozen and the request RPCs are gone", () => {
  it("connection_requests refuses a new pending row and any change of a closed one", async () => {
    const [a, b] = await pair();
    expect(await raised(() => owner(db,
      "insert into public.connection_requests (requester_id, recipient_id, mode) values ($1, $2, 'friends')", [a, b])))
      .toMatch(/connection_requests_frozen/);
    const old = await legacyRequest(db, a, b, { status: "declined", message: "架空の古い申請" });
    for (const change of ["status = 'pending', closed_at = null", "status = 'accepted'", "message = '架空の書換え'"]) {
      expect(await raised(() => owner(db, `update public.connection_requests set ${change} where id = $1`, [old])), change)
        .toMatch(/transition_denied|connection_requests_frozen/);
    }
  });

  it("the request and mode RPCs no longer exist", async () => {
    const rows = await owner<{ f: string; sig: string | null }>(db, `
      select f, to_regprocedure(f)::text as sig from unnest(array[
        'public.send_connection_request(uuid,public.discover_mode,text)', 'public.respond_connection_request(uuid,boolean)',
        'public.cancel_connection_request(uuid)', 'public.list_my_requests()', 'public.set_modes(public.discover_mode[])',
        'public.get_profile(uuid,public.discover_mode)', 'public.update_profile(text,text,text,text,text,text,text[])'
      ]) as f`);
    expect(rows.filter((r) => r.sig !== null)).toEqual([]);
    expect(rows).toHaveLength(7);
    const [{ t }] = await owner<{ t: string | null }>(db, "select to_regclass('public.profile_modes')::text as t");
    expect(t).toBeNull();
  });
});

// --- the migration on existing data (docs/43 §3.2, §6.1 移行) ---

const ORDER_34 = migrationFiles().find((f) => f.endsWith("_likes_single_mode.sql"))!;

async function before34(): Promise<PGlite> {
  const old = await PGlite.create();
  const files = migrationFiles();
  for (const file of [join(MIGRATIONS_DIR, "..", "..", "tests", "db", "shim.sql"), ...files.slice(0, files.indexOf(ORDER_34)).map((f) => join(MIGRATIONS_DIR, f))]) {
    const sql = readFileSync(file, "utf8");
    await old.transaction((tx) => tx.exec(sql));
  }
  const seed = seedSqlBefore34();
  await old.transaction((tx) => tx.exec(seed));
  return old;
}

const apply34 = (target: PGlite) => target.transaction((tx) => tx.exec(readFileSync(join(MIGRATIONS_DIR, ORDER_34), "utf8")));

describe("order 34 on a database with orders 1-33 and existing rows", () => {
  let old: PGlite;
  let w: Record<string, string>;
  let requests: Record<string, string>;
  let conversation: string;
  let counts: { both: number; pendingLive: number; pendingStale: number };

  beforeAll(async () => {
    expect(migrationFiles().indexOf(ORDER_34)).toBe(33);
    old = await before34();
    const om = await createMasters(old, "mig34");
    const mk = (cls: number, legacyBios: { romance?: string | null; friends?: string | null }, legacyModes?: ("romance" | "friends")[]) =>
      createUser(old, { cls: om.classes[cls], legacyBios, legacyModes });
    w = {
      both: await mk(0, { friends: "架空F1", romance: "架空R1" }),
      emptyFriends: await mk(4, { friends: "", romance: "架空R2" }),
      nothing: await mk(5, { friends: null, romance: null }),
      empties: await mk(6, { friends: "", romance: "" }),
      hiddenFriends: await mk(7, { friends: null, romance: "架空R5" }),
      hiddenRomance: await mk(1, { friends: "架空F6", romance: null }),
      romanceOnly: await mk(2, {}, ["romance"]),
      friendsOnly: await mk(4, {}, ["friends"]),
    };
    const staffer = randomUUID();
    const report = randomUUID();
    await owner(old, "insert into public.reports (id, reporter_id, target_user_id, context, reason) values ($1, $2, $3, 'profile', 'spam')",
      [report, w.both, w.hiddenFriends]);
    await owner(old, `insert into private.hidden_bios (user_id, mode, original_text, report_id, hidden_by)
      values ($1, 'friends', '架空の非表示F5', $3, $4), ($2, 'romance', '架空の非表示R6', $3, $4)`, [w.hiddenFriends, w.hiddenRomance, report, staffer]);
    // pending requests: one past its deadline, one live; a closed one stays as it is
    requests = { stale: randomUUID(), live: randomUUID(), closed: randomUUID() };
    await owner(old, `insert into public.connection_requests (id, requester_id, recipient_id, mode, created_at, expires_at)
      values ($1, $2, $3, 'friends', now() - interval '40 days', now() - interval '10 days')`, [requests.stale, w.both, w.emptyFriends]);
    await owner(old, "insert into public.connection_requests (id, requester_id, recipient_id, mode, message) values ($1, $2, $3, 'romance', '架空の申請')",
      [requests.live, w.nothing, w.both]);
    await owner(old, `insert into public.connection_requests (id, requester_id, recipient_id, mode, status, closed_at)
      values ($1, $2, $3, 'friends', 'declined', now() - interval '1 day')`, [requests.closed, w.empties, w.both]);
    // an active connection from an accepted request, with a message
    ({ conversation } = await connect(old, w.hiddenRomance, w.friendsOnly));
    await owner(old, "insert into public.messages (conversation_id, sender_id, client_msg_id, body) values ($1, $2, $3, '架空の前のメッセージ')",
      [conversation, w.hiddenRomance, randomUUID()]);
    // before: the romance-only and friends-only users never saw each other
    const [{ visible }] = await owner<{ visible: boolean }>(old, `select
      private.can_view_profile($1, $2, 'romance') or private.can_view_profile($1, $2, 'friends') as visible`, [w.romanceOnly, w.friendsOnly]);
    expect(visible).toBe(false);
    // the counts the hosted precheck reports (docs/43 §3.3), taken here the same way
    [counts] = await owner<typeof counts>(old, `select
      (select count(*)::int from public.profiles where nullif(bio_friends, '') is not null and nullif(bio_romance, '') is not null) as both,
      (select count(*)::int from public.connection_requests where status = 'pending' and expires_at > now()) as "pendingLive",
      (select count(*)::int from public.connection_requests where status = 'pending' and expires_at <= now()) as "pendingStale"`);
    expect(counts).toEqual({ both: 1 + 2, pendingLive: 1, pendingStale: 1 });   // w.both and the two default-bio users
    await apply34(old);
  });
  afterAll(async () => { await old?.close(); });

  it("bio comes from the friends bio first, then the romance bio; empty strings are empty and a hidden text never returns", async () => {
    const rows = await owner<{ id: string; bio: string | null; purposes: string[] }>(old,
      "select user_id::text as id, bio, purposes from public.profiles where user_id = any ($1::uuid[])", [Object.values(w)]);
    const bio = new Map(rows.map((r) => [r.id, r.bio]));
    expect(Object.fromEntries(Object.entries(w).map(([k, id]) => [k, bio.get(id)]))).toEqual({
      both: "架空F1", emptyFriends: "架空R2", nothing: null, empties: null, hiddenFriends: "架空R5", hiddenRomance: "架空F6",
      romanceOnly: "架空の友達向け紹介", friendsOnly: "架空の友達向け紹介",
    });
    expect(rows.every((r) => Array.isArray(r.purposes) && r.purposes.length === 0)).toBe(true);
    const [{ n }] = await owner<{ n: number }>(old, "select count(*)::int as n from public.profiles where bio like '架空の非表示%'");
    expect(n).toBe(0);
    // the hidden originals stay in private.hidden_bios with their old mode
    expect(await owner(old, "select mode::text, original_text from private.hidden_bios order by original_text")).toEqual([
      { mode: "friends", original_text: "架空の非表示F5" }, { mode: "romance", original_text: "架空の非表示R6" }]);
    // the seed's demo users keep their friends bio
    const [{ demo }] = await owner<{ demo: number }>(old,
      "select count(*)::int as demo from public.profiles where bio = '架空のデモ用プロフィールです。'");
    expect(demo).toBe(4);
  });

  it("pending requests close (expired at expires_at, the live one invalidated) and nothing stays pending", async () => {
    const rows = await owner<{ id: string; status: string; at_deadline: boolean; closed: boolean }>(old, `
      select id::text, status::text, closed_at = expires_at as at_deadline, closed_at is not null as closed
      from public.connection_requests where id = any ($1::uuid[])`, [Object.values(requests)]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(requests.stale)).toMatchObject({ status: "expired", at_deadline: true });
    expect(byId.get(requests.live)).toMatchObject({ status: "invalidated", closed: true });
    expect(byId.get(requests.closed)).toMatchObject({ status: "declined" });
    const [{ pending }] = await owner<{ pending: number }>(old,
      "select count(*)::int as pending from public.connection_requests where status = 'pending'");
    expect(pending).toBe(0);
  });

  it("the old connection keeps its request and mode, and its conversation keeps working", async () => {
    const [k] = await owner<{ origin: boolean; mode: string; ended: boolean }>(old, `
      select k.origin_request_id is not null as origin, k.mode::text as mode, k.ended_at is not null as ended
      from public.connections k join public.conversations c on c.connection_id = k.id where c.id = $1`, [conversation]);
    expect(k).toEqual({ origin: true, mode: "friends", ended: false });
    expect((await rpcRows<{ conversation_id: string }>(old, user(w.friendsOnly), "list_my_conversations")).map((r) => r.conversation_id))
      .toEqual([conversation]);
    expect((await rpc(old, user(w.friendsOnly), "send_message", [conversation, randomUUID(), "架空の返事"])).ok).toBe(true);
    expect(await rpcRows(old, user(w.friendsOnly), "list_messages", [conversation])).toHaveLength(2);
  });

  it("the modes and the four columns are gone, and people in different former modes now see each other (docs/43 R5)", async () => {
    expect(await owner(old, "select to_regclass('public.profile_modes')::text as t")).toEqual([{ t: null }]);
    expect(await owner(old, `select attname from pg_attribute where attrelid = 'public.profiles'::regclass and not attisdropped
      and attname in ('bio_romance', 'bio_friends', 'purpose_romance', 'purpose_friends')`)).toEqual([]);
    expect(await rpcRows(old, user(w.romanceOnly), "get_profile", [w.friendsOnly])).toHaveLength(1);
    expect((await rpc(old, user(w.romanceOnly), "like_user", [w.friendsOnly])).ok).toBe(true);
    expect((await rpc(old, user(w.friendsOnly), "like_user", [w.romanceOnly])).ref).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("stops before any change when a free-text purpose or a completed profile without a mode exists", async () => {
    for (const [label, prepare, message] of [
      ["purpose", "update public.profiles set purpose_friends = '架空の目的' where user_id = $1", /non-empty purpose_romance or purpose_friends/],
      ["no mode", "delete from public.profile_modes where user_id = $1", /completed profile without a mode/],
    ] as const) {
      const target = await before34();
      try {
        const u = await createUser(target, { cls: (await createMasters(target, `g${label}`)).classes[0] });
        expect(u).toBeTruthy();
        await owner(target, prepare, [u]);
        await owner(target, "insert into public.connection_requests (requester_id, recipient_id, mode) select $1, user_id, 'friends' from public.profiles where user_id <> $1 limit 1", [u]);
        const before = await fingerprint(target);
        expect(await raised(() => apply34(target)), label).toMatch(message);
        expect(await fingerprint(target)).toBe(before);
        expect(await owner(target, "select to_regclass('public.profile_modes')::text as t")).toEqual([{ t: "profile_modes" }]);
      } finally { await target.close(); }
    }
  });
});
