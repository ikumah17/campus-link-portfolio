// SEC-006 order 22 (SECREVIEW-001 M-1): service_reserve_signin counts sign-in attempts per typed address and
// reserve_mfa_attempt counts TOTP codes per user, before the server calls Auth.
// The limits are read from private.rate_policy, never hard-coded, like the NT-25 limits.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMasters, createStaff, createUser, type Masters } from "./fixtures";
import { MIGRATIONS_DIR, OUTCOME_OK, asRole, deny, fingerprint, freshDb, migrationFiles, owner, raised, rpc, staff, user, type Outcome, type Session } from "./harness";

const ORDER_22 = "20261111120022_auth_rate_limit.sql";
let db: PGlite;
let m: Masters;
beforeAll(async () => { db = await freshDb(); m = await createMasters(db, "sec006"); });
afterAll(async () => { await db?.close(); });

const ACTIONS = ["request", "report", "message", "block", "privacy", "photo"];
const policy = async (target: PGlite, action: string) => (await owner<{ max_count: number; window_length: string }>(target,
  "select max_count, window_length::text from private.rate_policy($1)", [action]))[0];
const pepper = async (target: PGlite) => (await owner<{ value: string }>(target,
  "select value from private.app_settings where key = 'auth_rate_pepper'"))[0]?.value;
const keyOf = async (email: string) => (await owner<{ key: string }>(db, "select private.signin_rate_key($1)::text as key", [email]))[0].key;
const events = async (target: PGlite, key: string, action: string) => (await owner<{ n: number }>(target,
  "select count(*)::int as n from private.rate_limit_events where user_id = $1 and action = $2", [key, action]))[0].n;
const signin = async (email: unknown, target: PGlite = db) =>
  (await asRole<Outcome>(target, "service_role", null, "select * from public.service_reserve_signin($1)", [email]))[0];
const mfa = (session: Session) => rpc(db, session, "reserve_mfa_attempt");
const address = () => `sec006-${randomUUID()}@example.test`;
const OK = { ...OUTCOME_OK, ref: null };

describe("SEC-006 order 22", () => {
  it("is order 22", () => {
    expect(migrationFiles()[21]).toBe(ORDER_22);
  });

  it("adds signin (per address) and mfa (per user) and leaves every earlier action's value exactly as orders 1-21 had it", async () => {
    const earlier = await PGlite.create();
    try {
      for (const file of [join(MIGRATIONS_DIR, "..", "..", "tests", "db", "shim.sql"), ...migrationFiles().slice(0, 21).map((f) => join(MIGRATIONS_DIR, f))]) {
        await earlier.exec(readFileSync(file, "utf8"));
      }
      for (const action of ACTIONS) expect(await policy(db, action), action).toEqual(await policy(earlier, action));
      for (const action of ["signin", "mfa"]) expect(await raised(() => policy(earlier, action))).toBe(`unknown rate action ${action}`);
      expect(await pepper(earlier)).toBeUndefined();
    } finally { await earlier.close(); }
    expect(await policy(db, "signin")).toEqual({ max_count: 10, window_length: "00:15:00" });
    expect(await policy(db, "mfa")).toEqual({ max_count: 10, window_length: "00:10:00" });
    // shorter than the purge's 7 days, so service_purge_rate_limits never removes an event still in the window
    for (const action of ["signin", "mfa"]) {
      const [{ inside }] = await owner<{ inside: boolean }>(db, "select $1::interval < interval '7 days' as inside", [(await policy(db, action)).window_length]);
      expect(inside, action).toBe(true);
    }
  });

  it("stores a 32-byte hex pepper once; running the insert again keeps it", async () => {
    const value = await pepper(db);
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    const insert = readFileSync(join(MIGRATIONS_DIR, ORDER_22), "utf8").match(/insert into private\.app_settings[\s\S]*?;/)?.[0];
    expect(insert).toContain("on conflict (key) do nothing");
    const own = (await db.clone()) as PGlite;
    try {
      await own.exec(insert!);
      expect(await pepper(own)).toBe(value);
      expect((await owner<{ n: number }>(own, "select count(*)::int as n from private.app_settings where key = 'auth_rate_pepper'"))[0].n).toBe(1);
    } finally { await own.close(); }
  });

  it("no API role can read the pepper or the key function", async () => {
    const session: Record<string, Session | null> = { anon: null, authenticated: user(await createUser(db, { cls: m.classes[0] })), service_role: null };
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      expect(await raised(() => asRole(db, role, session[role], "select value from private.app_settings")), role).toMatch(/permission denied/);
      expect(await raised(() => asRole(db, role, session[role], "select private.signin_rate_key('a@example.test')")), role).toMatch(/permission denied/);
    }
  });
});

describe("SEC-006 service_reserve_signin", () => {
  it("reserves up to the limit, one event each, then answers rate_limited without recording or changing anything", async () => {
    const { max_count: max } = await policy(db, "signin");
    const email = address();
    const key = await keyOf(email);
    for (let i = 0; i < max; i += 1) expect(await signin(email)).toEqual(OK);
    expect(await events(db, key, "signin")).toBe(max);
    const before = await fingerprint(db);
    for (let i = 0; i < 3; i += 1) expect(await signin(email)).toEqual(deny("rate_limited"));
    expect(await fingerprint(db)).toBe(before);
    expect(await events(db, key, "signin")).toBe(max);
  });

  it("one key per address: other case and surrounding spaces share it; different addresses are independent", async () => {
    const { max_count: max } = await policy(db, "signin");
    const email = address();
    const spellings = [email, email.toUpperCase(), `  ${email}`, `${email}  `, ` ${email.replace("sec006", "SEC006")} `];
    for (let i = 0; i < max; i += 1) expect(await signin(spellings[i % spellings.length])).toEqual(OK);
    for (const spelling of spellings) expect(await signin(spelling), spelling).toEqual(deny("rate_limited"));
    expect(await events(db, await keyOf(email), "signin")).toBe(max);
    const other = address();
    expect(await signin(other)).toEqual(OK);
    expect(await events(db, await keyOf(other), "signin")).toBe(1);
  });

  it("the window resets: events older than the window no longer count", async () => {
    const { max_count: max, window_length: window } = await policy(db, "signin");
    const email = address();
    const key = await keyOf(email);
    for (let i = 0; i < max; i += 1) expect((await signin(email)).ok).toBe(true);
    expect(await signin(email)).toEqual(deny("rate_limited"));
    // exactly at the window edge the events still count; one second past it they do not
    await owner(db, "update private.rate_limit_events set created_at = now() - $2::interval + interval '1 second' where user_id = $1 and action = 'signin'", [key, window]);
    expect(await signin(email)).toEqual(deny("rate_limited"));
    await owner(db, "update private.rate_limit_events set created_at = created_at - interval '2 seconds' where user_id = $1 and action = 'signin'", [key]);
    expect(await signin(email)).toEqual(OK);
    expect(await events(db, key, "signin")).toBe(max + 1);
  });

  it("the key is the peppered sha256 of the normalised address and never a plain email hash", async () => {
    const email = address();
    expect(await signin(` ${email.toUpperCase()} `)).toEqual(OK);
    const key = await keyOf(email);
    const hex = (input: string) => createHash("sha256").update(input, "utf8").digest("hex").slice(0, 32);
    const asUuid = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    expect(key).toBe(asUuid(hex(`${await pepper(db)}${email}`)));
    const [row] = await owner<{ ids: string[] }>(db, "select array_agg(user_id::text) as ids from private.rate_limit_events where action = 'signin'");
    expect(row.ids).toContain(key);
    for (const plain of [hex(email), createHash("md5").update(email).digest("hex")]) expect(row.ids).not.toContain(asUuid(plain));
  });

  it("an empty, blank, missing or over-long address raises validation and records nothing; 320 characters is accepted", async () => {
    const before = await fingerprint(db);
    for (const bad of ["", "   ", null, `${"a".repeat(309)}@example.test`]) {
      expect(await raised(() => signin(bad)), String(bad).slice(0, 10)).toBe("validation");
    }
    expect(await fingerprint(db)).toBe(before);
    const longest = `${"b".repeat(320 - "@example.test".length - 36)}${randomUUID()}@example.test`;
    expect(longest).toHaveLength(320);
    expect(await signin(` ${longest} `)).toEqual(OK);
  });

  it("refuses with forbidden and records nothing when the pepper is missing", async () => {
    const own = (await db.clone()) as PGlite;
    try {
      await owner(own, "delete from private.app_settings where key = 'auth_rate_pepper'");
      const before = await fingerprint(own);
      expect(await raised(() => signin(address(), own))).toBe("forbidden");
      expect(await fingerprint(own)).toBe(before);
    } finally { await own.close(); }
  });

  it("is executable by service_role only", async () => {
    const me = user(await createUser(db, { cls: m.classes[0] }));
    const before = await fingerprint(db);
    expect(await raised(() => asRole(db, "anon", null, "select * from public.service_reserve_signin('a@example.test')"))).toMatch(/permission denied/);
    expect(await raised(() => asRole(db, "authenticated", me, "select * from public.service_reserve_signin('a@example.test')"))).toMatch(/permission denied/);
    expect(await fingerprint(db)).toBe(before);
  });
});

describe("SEC-006 reserve_mfa_attempt", () => {
  it("reserves up to the limit, one event each, then answers rate_limited without recording or changing anything", async () => {
    const { max_count: max } = await policy(db, "mfa");
    const me = await createUser(db, { cls: m.classes[0] });
    for (let i = 0; i < max; i += 1) expect(await mfa(user(me))).toEqual(OK);
    expect(await events(db, me, "mfa")).toBe(max);
    const before = await fingerprint(db);
    for (let i = 0; i < 3; i += 1) expect(await mfa(user(me))).toEqual(deny("rate_limited"));
    expect(await fingerprint(db)).toBe(before);
    expect(await events(db, me, "mfa")).toBe(max);
  });

  it("counts per user and per action: another user, and the same user's other limits, are unaffected", async () => {
    const { max_count: max } = await policy(db, "mfa");
    const [limited, other] = [await createUser(db, { cls: m.classes[0] }), await createUser(db, { cls: m.classes[0] })];
    for (let i = 0; i < max; i += 1) expect((await mfa(user(limited))).ok).toBe(true);
    expect(await mfa(user(limited))).toEqual(deny("rate_limited"));
    expect(await mfa(user(other))).toEqual(OK);
    const [row] = await owner<{ ok: boolean }>(db, "select private.rate_ok($1, 'photo') and private.rate_ok($1, 'message') as ok", [limited]);
    expect(row.ok).toBe(true);
  });

  it("the window resets: events older than the window no longer count", async () => {
    const { max_count: max, window_length: window } = await policy(db, "mfa");
    const me = await createUser(db, { cls: m.classes[0] });
    for (let i = 0; i < max; i += 1) expect((await mfa(user(me))).ok).toBe(true);
    expect(await mfa(user(me))).toEqual(deny("rate_limited"));
    await owner(db, "update private.rate_limit_events set created_at = now() - $2::interval - interval '1 second' where user_id = $1 and action = 'mfa'", [me, window]);
    expect(await mfa(user(me))).toEqual(OK);
  });

  it("allows aal1 and aal2 sessions, profileless staff and accounts without a profile", async () => {
    const callers: [string, Session][] = [
      ["aal1", user(await createUser(db, { cls: m.classes[0] }))],
      ["aal2", staff(await createUser(db, { cls: m.classes[0] }))],
      ["profileless staff at aal1", user(await createStaff(db, ["reviewer", "moderator", "admin"]))],
      ["profileless staff at aal2", staff(await createStaff(db, ["admin"]))],
      ["no profile", user(await createUser(db, { profile: false }))],
    ];
    for (const [label, session] of callers) {
      expect(await mfa(session), label).toEqual(OK);
      expect(await events(db, session.sub!, "mfa"), label).toBe(1);
    }
  });

  it("refuses the callers require_user refuses with forbidden and no write", async () => {
    const deleted = await createUser(db, { cls: m.classes[0] });
    expect(await rpc(db, user(deleted), "request_account_deletion")).toMatchObject({ ok: true });
    const anonymous = await createUser(db, { profile: false, anonymous: true });
    const callers: [string, Session][] = [
      ["deleted", user(deleted)],
      ["deleted at creation", user(await createUser(db, { status: "deleted" }))],
      ["anonymous", { sub: anonymous, isAnonymous: true }],
      ["anonymous without the claim", { sub: anonymous, omitAnonymousClaim: true }],
      ["unconfirmed email", user(await createUser(db, { cls: m.classes[0], emailConfirmed: false }))],
      ["no such user", user(randomUUID())],
      ["no sub", { omitSub: true }],
    ];
    const before = await fingerprint(db);
    for (const [label, session] of callers) expect(await raised(() => mfa(session)), label).toBe("forbidden");
    expect(await fingerprint(db)).toBe(before);
  });

  it("is executable by authenticated only", async () => {
    const before = await fingerprint(db);
    for (const role of ["anon", "service_role"] as const) {
      expect(await raised(() => asRole(db, role, null, "select * from public.reserve_mfa_attempt()")), role).toMatch(/permission denied/);
    }
    expect(await fingerprint(db)).toBe(before);
  });
});

describe("SEC-006 retention", () => {
  it("service_purge_rate_limits removes signin and mfa events older than 7 days and keeps the recent ones", async () => {
    const own = (await db.clone()) as PGlite;
    try {
      await owner(own, "delete from private.rate_limit_events");
      const me = await createUser(own);
      const [{ key }] = await owner<{ key: string }>(own, "select private.signin_rate_key($1)::text as key", [address()]);
      for (const [id, action] of [[key, "signin"], [me, "mfa"]]) {
        for (const age of ["8 days", "7 days 1 second", "6 days", "1 minute"]) {
          await owner(own, "insert into private.rate_limit_events (user_id, action, created_at) values ($1, $2, now() - $3::interval)", [id, action, age]);
        }
      }
      expect(await asRole(own, "service_role", null, "select public.service_purge_rate_limits() as n")).toEqual([{ n: 4 }]);
      for (const [id, action] of [[key, "signin"], [me, "mfa"]]) expect(await events(own, id, action), action).toBe(2);
    } finally { await own.close(); }
  });
});
