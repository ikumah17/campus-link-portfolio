// SEC-004 order 21 (SECREVIEW-001 M-2): reserve_photo_upload counts photo uploads per user before the image is decoded.
// The limit is read from private.rate_policy('photo'), never hard-coded, like the NT-25 limits.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMasters, createStaff, createUser, type Masters } from "./fixtures";
import { MIGRATIONS_DIR, OUTCOME_OK, asRole, deny, fingerprint, freshDb, migrationFiles, owner, raised, rpc, user, type Session } from "./harness";

let db: PGlite;
let m: Masters;
beforeAll(async () => { db = await freshDb(); m = await createMasters(db, "sec004"); });
afterAll(async () => { await db?.close(); });

const ACTIONS = ["request", "report", "message", "block", "privacy"];
const policy = async (target: PGlite, action: string) => (await owner<{ max_count: number; window_length: string }>(target,
  "select max_count, window_length::text from private.rate_policy($1)", [action]))[0];
const events = async (u: string) => (await owner<{ n: number }>(db,
  "select count(*)::int as n from private.rate_limit_events where user_id = $1 and action = 'photo'", [u]))[0].n;
const reserve = (session: Session) => rpc(db, session, "reserve_photo_upload");
const eligible = () => createUser(db, { cls: m.classes[0] });

describe("SEC-004 order 21", () => {
  it("is order 21", () => {
    expect(migrationFiles()[20]).toBe("20261111120021_photo_rate_limit.sql");
  });

  it("adds the photo action and leaves every earlier action's value exactly as orders 1-20 had it", async () => {
    const all = migrationFiles();
    const earlier = await PGlite.create();
    try {
      for (const file of [join(MIGRATIONS_DIR, "..", "..", "tests", "db", "shim.sql"), ...all.slice(0, 20).map((f) => join(MIGRATIONS_DIR, f))]) {
        await earlier.exec(readFileSync(file, "utf8"));
      }
      for (const action of ACTIONS) expect(await policy(db, action), action).toEqual(await policy(earlier, action));
      expect(await raised(() => policy(earlier, "photo"))).toBe("unknown rate action photo");
    } finally { await earlier.close(); }
    const photo = await policy(db, "photo");
    expect(photo.max_count).toBeGreaterThan(0);
    // shorter than the purge's 7 days, so service_purge_rate_limits never removes an event still in the window
    const [{ inside }] = await owner<{ inside: boolean }>(db, "select $1::interval < interval '7 days' as inside", [photo.window_length]);
    expect(inside).toBe(true);
    expect(await raised(() => policy(db, "unknown"))).toBe("unknown rate action unknown");
  });
});

describe("SEC-004 reserve_photo_upload", () => {
  it("reserves up to the limit, one event each, then answers rate_limited without recording or changing anything", async () => {
    const { max_count: max } = await policy(db, "photo");
    const me = await eligible();
    for (let i = 0; i < max; i += 1) expect(await reserve(user(me))).toEqual({ ...OUTCOME_OK, ref: null });
    expect(await events(me)).toBe(max);
    const before = await fingerprint(db);
    for (let i = 0; i < 3; i += 1) expect(await reserve(user(me))).toEqual(deny("rate_limited"));
    expect(await fingerprint(db)).toBe(before);
    expect(await events(me)).toBe(max);
  });

  it("counts per user: another user is unaffected by a limited one", async () => {
    const { max_count: max } = await policy(db, "photo");
    const [limited, other] = [await eligible(), await eligible()];
    for (let i = 0; i < max; i += 1) expect((await reserve(user(limited))).ok).toBe(true);
    expect(await reserve(user(limited))).toEqual(deny("rate_limited"));
    expect(await reserve(user(other))).toEqual({ ...OUTCOME_OK, ref: null });
    expect(await events(other)).toBe(1);
  });

  it("counts only the photo action: other actions' events do not use it up, and photo events do not use theirs", async () => {
    const { max_count: max } = await policy(db, "photo");
    const me = await eligible();
    await owner(db, `insert into private.rate_limit_events (user_id, action) select $1, 'privacy' from generate_series(1, $2::int)`, [me, max]);
    for (let i = 0; i < max; i += 1) expect((await reserve(user(me))).ok).toBe(true);
    expect(await events(me)).toBe(max);
    const [row] = await owner<{ privacy: number; others: boolean }>(db, `
      select (select count(*)::int from private.rate_limit_events where user_id = $1 and action = 'privacy') as privacy,
             private.rate_ok($1, 'message') and private.rate_ok($1, 'request') as others`, [me]);
    expect(row).toEqual({ privacy: max, others: true });
  });

  it("the window resets: events older than the window no longer count", async () => {
    const { max_count: max, window_length: window } = await policy(db, "photo");
    const me = await eligible();
    for (let i = 0; i < max; i += 1) expect((await reserve(user(me))).ok).toBe(true);
    expect(await reserve(user(me))).toEqual(deny("rate_limited"));
    // exactly at the window edge the events still count; one second past it they do not
    await owner(db, "update private.rate_limit_events set created_at = now() - $2::interval + interval '1 second' where user_id = $1 and action = 'photo'", [me, window]);
    expect(await reserve(user(me))).toEqual(deny("rate_limited"));
    await owner(db, "update private.rate_limit_events set created_at = created_at - interval '2 seconds' where user_id = $1 and action = 'photo'", [me]);
    expect(await reserve(user(me))).toEqual({ ...OUTCOME_OK, ref: null });
    expect(await events(me)).toBe(max + 1);
  });

  it("allows a deactivated account, as photo registration does", async () => {
    const me = await createUser(db, { cls: m.classes[0], status: "deactivated" });
    expect(await reserve(user(me))).toEqual({ ...OUTCOME_OK, ref: null });
    expect(await events(me)).toBe(1);
  });

  it("refuses deleted, suspended, profileless, anonymous, unconfirmed and sessionless callers with forbidden and no write", async () => {
    const deleted = await eligible();
    expect(await rpc(db, user(deleted), "request_account_deletion")).toMatchObject({ ok: true });
    const anonymous = await createUser(db, { profile: false, anonymous: true });
    const callers: [string, Session][] = [
      ["deleted", user(deleted)],
      ["deleted at creation", user(await createUser(db, { status: "deleted" }))],
      ["suspended", user(await createUser(db, { cls: m.classes[0], status: "suspended" }))],
      ["no profile", user(await createUser(db, { profile: false }))],
      ["staff without a profile", { sub: await createStaff(db, ["reviewer", "moderator", "admin"]), aal: "aal2" }],
      ["anonymous", { sub: anonymous, isAnonymous: true }],
      ["anonymous without the claim", { sub: anonymous, omitAnonymousClaim: true }],
      ["unconfirmed email", user(await createUser(db, { cls: m.classes[0], emailConfirmed: false }))],
      ["no sub", { omitSub: true }],
    ];
    const before = await fingerprint(db);
    for (const [label, session] of callers) expect(await raised(() => reserve(session)), label).toBe("forbidden");
    expect(await fingerprint(db)).toBe(before);
  });

  it("is not executable by anon or service_role", async () => {
    const before = await fingerprint(db);
    for (const role of ["anon", "service_role"] as const) {
      expect(await raised(() => asRole(db, role, null, "select * from public.reserve_photo_upload()")), role).toMatch(/permission denied/);
    }
    expect(await fingerprint(db)).toBe(before);
  });
});

describe("SEC-004 retention", () => {
  it("service_purge_rate_limits removes photo events older than 7 days and keeps the recent ones", async () => {
    const own = (await db.clone()) as PGlite;
    try {
      await owner(own, "delete from private.rate_limit_events");
      const me = await createUser(own);
      for (const age of ["8 days", "7 days 1 second", "6 days", "1 minute"]) {
        await owner(own, "insert into private.rate_limit_events (user_id, action, created_at) values ($1, 'photo', now() - $2::interval)", [me, age]);
      }
      expect(await asRole(own, "service_role", null, "select public.service_purge_rate_limits() as n")).toEqual([{ n: 2 }]);
      expect((await owner<{ n: number }>(own, "select count(*)::int as n from private.rate_limit_events where action = 'photo'"))[0].n).toBe(2);
    } finally { await own.close(); }
  });
});
