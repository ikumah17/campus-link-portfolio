// SEC-008 order 24 (SECREVIEW-001 M-1): service_reserve_signin also counts sign-in attempts per client IP key when
// the server passes a trusted IP, in the same call as the per-address limit.
// The limits are read from private.rate_policy, never hard-coded, like the NT-25 limits.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMasters, createUser, type Masters } from "./fixtures";
import { MIGRATIONS_DIR, OUTCOME_OK, asRole, deny, fingerprint, freshDb, migrationFiles, owner, raised, user, type Outcome, type Session } from "./harness";

const ORDER_24 = "20261115120024_signin_ip_limit.sql";
let db: PGlite;
let m: Masters;
beforeAll(async () => { db = await freshDb(); m = await createMasters(db, "sec008"); });
afterAll(async () => { await db?.close(); });

const ACTIONS = ["request", "report", "message", "block", "privacy", "photo", "signin", "mfa"];
const policy = async (target: PGlite, action: string) => (await owner<{ max_count: number; window_length: string }>(target,
  "select max_count, window_length::text from private.rate_policy($1)", [action]))[0];
const pepper = async () => (await owner<{ value: string }>(db, "select value from private.app_settings where key = 'auth_rate_pepper'"))[0].value;
const addressKey = async (email: string) => (await owner<{ key: string }>(db, "select private.signin_rate_key($1)::text as key", [email]))[0].key;
const ipKey = async (ip: string, target: PGlite = db) => (await owner<{ key: string }>(target, "select private.signin_ip_rate_key($1)::text as key", [ip]))[0].key;
const events = async (key: string, action: string, target: PGlite = db) => (await owner<{ n: number }>(target,
  "select count(*)::int as n from private.rate_limit_events where user_id = $1 and action = $2", [key, action]))[0].n;
const signin = async (email: unknown, ip: unknown, target: PGlite = db) =>
  (await asRole<Outcome>(target, "service_role", null, "select * from public.service_reserve_signin($1, $2)", [email, ip]))[0];
const address = () => `sec008-${randomUUID()}@example.test`;
let ipSeq = 0;
// distinct documentation-range addresses per test, so the shared database's counts never collide
const ipv4 = () => { ipSeq += 1; return `198.51.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`; };
const ipv6Prefix = () => { ipSeq += 1; return `2001:db8:${ipSeq.toString(16)}:${(ipSeq * 7).toString(16)}`; };
const OK = { ...OUTCOME_OK, ref: null };

describe("SEC-008 order 24", () => {
  it("is order 24", () => {
    expect(migrationFiles()[23]).toBe(ORDER_24);
  });

  it("adds signin_ip (30 per 15 minutes) and leaves every earlier action's value exactly as orders 1-23 had it", async () => {
    const earlier = await PGlite.create();
    try {
      for (const file of [join(MIGRATIONS_DIR, "..", "..", "tests", "db", "shim.sql"), ...migrationFiles().slice(0, 23).map((f) => join(MIGRATIONS_DIR, f))]) {
        await earlier.exec(readFileSync(file, "utf8"));
      }
      for (const action of ACTIONS) expect(await policy(db, action), action).toEqual(await policy(earlier, action));
      expect(await raised(() => policy(earlier, "signin_ip"))).toBe("unknown rate action signin_ip");
    } finally { await earlier.close(); }
    expect(await policy(db, "signin_ip")).toEqual({ max_count: 30, window_length: "00:15:00" });
    const [{ inside }] = await owner<{ inside: boolean }>(db, "select $1::interval < interval '7 days' as inside", [(await policy(db, "signin_ip")).window_length]);
    expect(inside).toBe(true);
  });

  it("does not change the pepper", async () => {
    const source = readFileSync(join(MIGRATIONS_DIR, ORDER_24), "utf8");
    expect(source).not.toMatch(/app_settings/);
  });

  it("no API role can execute the IP key function", async () => {
    const session: Record<string, Session | null> = { anon: null, authenticated: user(await createUser(db, { cls: m.classes[0] })), service_role: null };
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      expect(await raised(() => asRole(db, role, session[role], "select private.signin_ip_rate_key('192.0.2.1')")), role).toMatch(/permission denied/);
    }
  });
});

describe("SEC-008 per-IP limit", () => {
  it("reserves up to the limit across many addresses, then refuses every address from that IP without recording anything", async () => {
    const { max_count: max } = await policy(db, "signin_ip");
    const ip = ipv4();
    const key = await ipKey(ip);
    const addresses = Array.from({ length: max }, address);
    for (const email of addresses) expect(await signin(email, ip)).toEqual(OK);
    expect(await events(key, "signin_ip")).toBe(max);
    const before = await fingerprint(db);
    const fresh = address();
    for (const email of [fresh, address(), addresses[0]]) expect(await signin(email, ip)).toEqual(deny("rate_limited"));
    expect(await fingerprint(db)).toBe(before);
    // the refusal recorded nothing for the address either
    expect(await events(await addressKey(fresh), "signin")).toBe(0);
    expect(await events(key, "signin_ip")).toBe(max);
  });

  it("is independent of the address limit: a limited address refuses from any IP and records nothing for the IP", async () => {
    const { max_count: max } = await policy(db, "signin");
    const email = address();
    for (let i = 0; i < max; i += 1) expect(await signin(email, ipv4())).toEqual(OK);
    const ip = ipv4();
    const before = await fingerprint(db);
    expect(await signin(email, ip)).toEqual(deny("rate_limited"));
    expect(await fingerprint(db)).toBe(before);
    expect(await events(await ipKey(ip), "signin_ip")).toBe(0);
    // the same IP still serves another address
    expect(await signin(address(), ip)).toEqual(OK);
    expect(await events(await ipKey(ip), "signin_ip")).toBe(1);
  });

  it("records one event for each key on ok", async () => {
    const [email, ip] = [address(), ipv4()];
    expect(await signin(email, ip)).toEqual(OK);
    expect(await events(await addressKey(email), "signin")).toBe(1);
    expect(await events(await ipKey(ip), "signin_ip")).toBe(1);
  });

  it("without an IP only the address limit applies, also for an IP-limited client", async () => {
    const ip = ipv4();
    const key = await ipKey(ip);
    await owner(db, `insert into private.rate_limit_events (user_id, action)
      select $1, 'signin_ip' from generate_series(1, (select max_count from private.rate_policy('signin_ip')))`, [key]);
    expect(await signin(address(), ip)).toEqual(deny("rate_limited"));
    const email = address();
    expect(await signin(email, null)).toEqual(OK);
    expect(await events(await addressKey(email), "signin")).toBe(1);
    const [{ n }] = await owner<{ n: number }>(db, "select count(*)::int as n from private.rate_limit_events where action = 'signin_ip' and user_id = $1", [key]);
    expect(n).toBe((await policy(db, "signin_ip")).max_count);
  });

  it("the one-argument call still works and is the address limit alone", async () => {
    const email = address();
    expect((await asRole<Outcome>(db, "service_role", null, "select * from public.service_reserve_signin($1)", [email]))[0]).toEqual(OK);
    expect(await events(await addressKey(email), "signin")).toBe(1);
  });

  it("IPv6 groups by /64: addresses in one prefix share a key, another prefix does not", async () => {
    const { max_count: max } = await policy(db, "signin_ip");
    const prefix = ipv6Prefix();
    const hosts = [`${prefix}::1`, `${prefix}:0:0:0:2`, `${prefix}:ffff:ffff:ffff:ffff`, `${prefix.toUpperCase()}::abcd`, `${prefix}:1:2:3:4`];
    const keys = new Set(await Promise.all(hosts.map((h) => ipKey(h))));
    expect(keys.size).toBe(1);
    for (let i = 0; i < max; i += 1) expect(await signin(address(), hosts[i % hosts.length])).toEqual(OK);
    for (const host of hosts) expect(await signin(address(), host), host).toEqual(deny("rate_limited"));
    const neighbour = `${prefix.replace(/:([0-9a-f]+)$/, (_, last: string) => `:${(parseInt(last, 16) + 1).toString(16)}`)}::1`;
    expect(await ipKey(neighbour)).not.toBe([...keys][0]);
    expect(await signin(address(), neighbour)).toEqual(OK);
  });

  it("IPv4 keys are per host, and an IPv4-mapped IPv6 address counts as its IPv4 address", async () => {
    expect(await ipKey("192.0.2.10")).not.toBe(await ipKey("192.0.2.11"));
    expect(await ipKey("::ffff:192.0.2.10")).toBe(await ipKey("192.0.2.10"));
    expect(await ipKey("::FFFF:c000:020a")).toBe(await ipKey("192.0.2.10"));
    // mapped addresses never share one /64 key
    expect(await ipKey("::ffff:192.0.2.11")).not.toBe(await ipKey("::ffff:192.0.2.10"));
  });

  it("the key is the peppered sha256 of 'ip:' and the normalised IP, never a plain hash", async () => {
    const hex = (input: string) => createHash("sha256").update(input, "utf8").digest("hex").slice(0, 32);
    const asUuid = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    const secret = await pepper();
    expect(await ipKey("192.0.2.77")).toBe(asUuid(hex(`${secret}ip:192.0.2.77`)));
    expect(await ipKey("2001:db8:aa:bb:1:2:3:4")).toBe(asUuid(hex(`${secret}ip:2001:db8:aa:bb::/64`)));
    const ip = ipv4();
    expect(await signin(address(), ip)).toEqual(OK);
    const [row] = await owner<{ ids: string[] }>(db, "select array_agg(user_id::text) as ids from private.rate_limit_events where action = 'signin_ip'");
    expect(row.ids).toContain(await ipKey(ip));
    for (const plain of [hex(ip), hex(`ip:${ip}`), createHash("md5").update(ip).digest("hex")]) expect(row.ids).not.toContain(asUuid(plain));
  });

  it("an invalid IP raises validation and records nothing for either key", async () => {
    const email = address();
    const before = await fingerprint(db);
    for (const bad of ["", "not-an-ip", "192.0.2", "192.0.2.256", "192.0.2.0/24", "2001:db8::/64", "192.0.2.1:443", "fe80::1%eth0", "1".repeat(65)]) {
      expect(await raised(() => signin(email, bad)), bad.slice(0, 16)).toBe("validation");
    }
    expect(await fingerprint(db)).toBe(before);
    expect(await events(await addressKey(email), "signin")).toBe(0);
  });

  it("an invalid address raises validation before the IP is looked at", async () => {
    const before = await fingerprint(db);
    expect(await raised(() => signin("", "192.0.2.1"))).toBe("validation");
    expect(await raised(() => signin("", "not-an-ip"))).toBe("validation");
    expect(await fingerprint(db)).toBe(before);
  });

  it("refuses with forbidden and records nothing when the pepper is missing", async () => {
    const own = (await db.clone()) as PGlite;
    try {
      await owner(own, "delete from private.app_settings where key = 'auth_rate_pepper'");
      const before = await fingerprint(own);
      expect(await raised(() => signin(address(), "192.0.2.1", own))).toBe("forbidden");
      expect(await raised(() => owner(own, "select private.signin_ip_rate_key('192.0.2.1')"))).toBe("forbidden");
      expect(await fingerprint(own)).toBe(before);
    } finally { await own.close(); }
  });

  it("the window resets: events older than the window no longer count", async () => {
    const { max_count: max, window_length: window } = await policy(db, "signin_ip");
    const ip = ipv4();
    const key = await ipKey(ip);
    for (let i = 0; i < max; i += 1) expect((await signin(address(), ip)).ok).toBe(true);
    expect(await signin(address(), ip)).toEqual(deny("rate_limited"));
    await owner(db, "update private.rate_limit_events set created_at = now() - $2::interval + interval '1 second' where user_id = $1 and action = 'signin_ip'", [key, window]);
    expect(await signin(address(), ip)).toEqual(deny("rate_limited"));
    await owner(db, "update private.rate_limit_events set created_at = created_at - interval '2 seconds' where user_id = $1 and action = 'signin_ip'", [key]);
    expect(await signin(address(), ip)).toEqual(OK);
  });

  it("is executable by service_role only, in its one remaining form", async () => {
    const me = user(await createUser(db, { cls: m.classes[0] }));
    const before = await fingerprint(db);
    for (const sql of ["select * from public.service_reserve_signin('a@example.test', '192.0.2.1')", "select * from public.service_reserve_signin('a@example.test')"]) {
      expect(await raised(() => asRole(db, "anon", null, sql))).toMatch(/permission denied/);
      expect(await raised(() => asRole(db, "authenticated", me, sql))).toMatch(/permission denied/);
    }
    expect(await fingerprint(db)).toBe(before);
    const [{ forms }] = await owner<{ forms: string[] }>(db, `select array_agg(pg_get_function_identity_arguments(p.oid)) as forms
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'service_reserve_signin'`);
    expect(forms).toEqual(["p_email text, p_ip text"]);
  });
});

describe("SEC-008 retention", () => {
  it("service_purge_rate_limits removes signin_ip events older than 7 days and keeps the recent ones", async () => {
    const own = (await db.clone()) as PGlite;
    try {
      await owner(own, "delete from private.rate_limit_events");
      const key = await ipKey("192.0.2.99", own);
      for (const age of ["8 days", "7 days 1 second", "6 days", "1 minute"]) {
        await owner(own, "insert into private.rate_limit_events (user_id, action, created_at) values ($1, 'signin_ip', now() - $2::interval)", [key, age]);
      }
      expect(await asRole(own, "service_role", null, "select public.service_purge_rate_limits() as n")).toEqual([{ n: 2 }]);
      expect(await events(key, "signin_ip", own)).toBe(2);
    } finally { await own.close(); }
  });
});
