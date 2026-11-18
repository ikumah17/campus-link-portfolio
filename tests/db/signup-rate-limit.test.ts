// SEC-012 order 25 (SECREVIEW-001 M-1): service_reserve_signup counts sign-up attempts per typed address key and,
// when the server passes a trusted IP, per client IP key, in one call, before the server calls auth.signUp.
// The limits are read from private.rate_policy, never hard-coded, like the NT-25 limits.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMasters, createUser, type Masters } from "./fixtures";
import { MIGRATIONS_DIR, OUTCOME_OK, asRole, deny, fingerprint, freshDb, migrationFiles, owner, raised, user, type Outcome } from "./harness";

const ORDER_25 = "20261115120025_signup_rate_limit.sql";
let db: PGlite;
let m: Masters;
beforeAll(async () => { db = await freshDb(); m = await createMasters(db, "sec012"); });
afterAll(async () => { await db?.close(); });

const ACTIONS = ["request", "report", "message", "block", "privacy", "photo", "signin", "mfa", "signin_ip"];
const policy = async (target: PGlite, action: string) => (await owner<{ max_count: number; window_length: string }>(target,
  "select max_count, window_length::text from private.rate_policy($1)", [action]))[0];
const addressKey = async (email: string) => (await owner<{ key: string }>(db, "select private.signin_rate_key($1)::text as key", [email]))[0].key;
const ipKey = async (ip: string, target: PGlite = db) => (await owner<{ key: string }>(target, "select private.signin_ip_rate_key($1)::text as key", [ip]))[0].key;
const events = async (key: string, action: string, target: PGlite = db) => (await owner<{ n: number }>(target,
  "select count(*)::int as n from private.rate_limit_events where user_id = $1 and action = $2", [key, action]))[0].n;
const fill = (key: string, action: string) => owner(db, `insert into private.rate_limit_events (user_id, action)
  select $1, $2 from generate_series(1, (select max_count from private.rate_policy($2)))`, [key, action]);
const signup = async (email: unknown, ip: unknown, target: PGlite = db) =>
  (await asRole<Outcome>(target, "service_role", null, "select * from public.service_reserve_signup($1, $2)", [email, ip]))[0];
const signin = async (email: unknown, ip: unknown) =>
  (await asRole<Outcome>(db, "service_role", null, "select * from public.service_reserve_signin($1, $2)", [email, ip]))[0];
const address = () => `sec012-${randomUUID()}@example.test`;
let ipSeq = 0;
// distinct documentation-range addresses per test, so the shared database's counts never collide
const ipv4 = () => { ipSeq += 1; return `203.0.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`; };
const ipv6Prefix = () => { ipSeq += 1; return `2001:db8:5e${ipSeq.toString(16)}:${(ipSeq * 7).toString(16)}`; };
const OK = { ...OUTCOME_OK, ref: null };

describe("SEC-012 order 25", () => {
  it("is order 25", () => {
    expect(migrationFiles()[24]).toBe(ORDER_25);
  });

  it("adds signup (5 per hour) and signup_ip (10 per hour) and leaves every earlier action's value exactly as orders 1-24 had it", async () => {
    const earlier = await PGlite.create();
    try {
      for (const file of [join(MIGRATIONS_DIR, "..", "..", "tests", "db", "shim.sql"), ...migrationFiles().slice(0, 24).map((f) => join(MIGRATIONS_DIR, f))]) {
        await earlier.exec(readFileSync(file, "utf8"));
      }
      for (const action of ACTIONS) expect(await policy(db, action), action).toEqual(await policy(earlier, action));
      for (const action of ["signup", "signup_ip"]) expect(await raised(() => policy(earlier, action))).toBe(`unknown rate action ${action}`);
    } finally { await earlier.close(); }
    expect(await policy(db, "signup")).toEqual({ max_count: 5, window_length: "01:00:00" });
    expect(await policy(db, "signup_ip")).toEqual({ max_count: 10, window_length: "01:00:00" });
    // shorter than the purge's 7 days, so service_purge_rate_limits never removes an event still in the window
    for (const action of ["signup", "signup_ip"]) {
      const [{ inside }] = await owner<{ inside: boolean }>(db, "select $1::interval < interval '7 days' as inside", [(await policy(db, action)).window_length]);
      expect(inside, action).toBe(true);
    }
  });

  it("is additive: no earlier function, key function or the pepper is redefined", async () => {
    const source = readFileSync(join(MIGRATIONS_DIR, ORDER_25), "utf8");
    expect(source).not.toMatch(/app_settings/);
    expect(source).not.toMatch(/\bdrop\b/i);
    expect(source).not.toMatch(/function private\.signin(_ip)?_rate_key/);
    expect(source).not.toMatch(/function public\.service_reserve_signin/);
  });
});

describe("SEC-012 per-address limit", () => {
  it("reserves up to the limit, one event each, then refuses without recording or changing anything", async () => {
    const { max_count: max } = await policy(db, "signup");
    const email = address();
    const key = await addressKey(email);
    for (let i = 0; i < max; i += 1) expect(await signup(email, null)).toEqual(OK);
    expect(await events(key, "signup")).toBe(max);
    const before = await fingerprint(db);
    expect(await signup(email, null)).toEqual(deny("rate_limited"));
    expect(await signup(email, ipv4())).toEqual(deny("rate_limited"));
    expect(await fingerprint(db)).toBe(before);
    expect(await events(key, "signup")).toBe(max);
  });

  it("normalises the address with lower(btrim()) into the same key as sign-in's", async () => {
    const { max_count: max } = await policy(db, "signup");
    const email = address();
    for (let i = 0; i < max; i += 1) expect(await signup(i % 2 ? `  ${email.toUpperCase()} ` : email, null)).toEqual(OK);
    expect(await events(await addressKey(email), "signup")).toBe(max);
    expect(await signup(` ${email.toUpperCase()}`, null)).toEqual(deny("rate_limited"));
  });

  it("an existing account and an unknown address get the same answers", async () => {
    const { max_count: max } = await policy(db, "signup");
    const [{ email: existing }] = await owner<{ email: string }>(db, "select email from auth.users where id = $1", [await createUser(db, { cls: m.classes[0] })]);
    const unknown = address();
    const answers = async (email: string) => {
      const out = [];
      for (let i = 0; i <= max; i += 1) out.push(await signup(email, null));
      return out;
    };
    expect(await answers(existing)).toEqual(await answers(unknown));
  });

  it("an invalid address raises validation and records nothing", async () => {
    const before = await fingerprint(db);
    for (const bad of [null, "", "   ", `${"a".repeat(310)}@example.test`]) {
      expect(await raised(() => signup(bad, null)), String(bad).slice(0, 8)).toBe("validation");
    }
    expect(await raised(() => signup("", "192.0.2.1"))).toBe("validation");
    expect(await raised(() => signup("", "not-an-ip"))).toBe("validation");
    expect(await fingerprint(db)).toBe(before);
  });
});

describe("SEC-012 per-IP limit", () => {
  it("reserves up to the limit across many addresses, then refuses every address from that IP without recording anything", async () => {
    const { max_count: max } = await policy(db, "signup_ip");
    const ip = ipv4();
    const key = await ipKey(ip);
    for (let i = 0; i < max; i += 1) expect(await signup(address(), ip)).toEqual(OK);
    expect(await events(key, "signup_ip")).toBe(max);
    const before = await fingerprint(db);
    const fresh = address();
    expect(await signup(fresh, ip)).toEqual(deny("rate_limited"));
    expect(await fingerprint(db)).toBe(before);
    // the refusal recorded nothing for the address either
    expect(await events(await addressKey(fresh), "signup")).toBe(0);
    // without an IP only the address limit applies
    expect(await signup(fresh, null)).toEqual(OK);
    expect(await events(key, "signup_ip")).toBe(max);
  });

  it("a limited address refuses from a fresh IP and records nothing for the IP", async () => {
    const email = address();
    await fill(await addressKey(email), "signup");
    const ip = ipv4();
    const before = await fingerprint(db);
    expect(await signup(email, ip)).toEqual(deny("rate_limited"));
    expect(await fingerprint(db)).toBe(before);
    expect(await events(await ipKey(ip), "signup_ip")).toBe(0);
    expect(await signup(address(), ip)).toEqual(OK);
    expect(await events(await ipKey(ip), "signup_ip")).toBe(1);
  });

  it("records one event for each key on ok", async () => {
    const [email, ip] = [address(), ipv4()];
    expect(await signup(email, ip)).toEqual(OK);
    expect(await events(await addressKey(email), "signup")).toBe(1);
    expect(await events(await ipKey(ip), "signup_ip")).toBe(1);
  });

  it("IPv6 groups by /64 through the shared key: addresses in one prefix share the limit, another prefix does not", async () => {
    const { max_count: max } = await policy(db, "signup_ip");
    const prefix = ipv6Prefix();
    const hosts = [`${prefix}::1`, `${prefix}:0:0:0:2`, `${prefix}:ffff:ffff:ffff:ffff`, `${prefix.toUpperCase()}::abcd`];
    for (let i = 0; i < max; i += 1) expect(await signup(address(), hosts[i % hosts.length])).toEqual(OK);
    expect(await events(await ipKey(hosts[0]), "signup_ip")).toBe(max);
    for (const host of hosts) expect(await signup(address(), host), host).toEqual(deny("rate_limited"));
    const neighbour = `${prefix.replace(/:([0-9a-f]+)$/, (_, last: string) => `:${(parseInt(last, 16) + 1).toString(16)}`)}::1`;
    expect(await signup(address(), neighbour)).toEqual(OK);
  });

  it("an IPv4-mapped IPv6 address counts as its IPv4 address", async () => {
    const ip = ipv4();
    expect(await signup(address(), `::ffff:${ip}`)).toEqual(OK);
    expect(await events(await ipKey(ip), "signup_ip")).toBe(1);
  });

  it("an invalid IP raises validation and records nothing for either key", async () => {
    const email = address();
    const before = await fingerprint(db);
    for (const bad of ["", "not-an-ip", "192.0.2", "192.0.2.0/24", "2001:db8::/64", "fe80::1%eth0", "1".repeat(65)]) {
      expect(await raised(() => signup(email, bad)), bad.slice(0, 16)).toBe("validation");
    }
    expect(await fingerprint(db)).toBe(before);
    expect(await events(await addressKey(email), "signup")).toBe(0);
  });

  it("the window resets: events older than the window no longer count", async () => {
    const { max_count: max, window_length: window } = await policy(db, "signup_ip");
    const ip = ipv4();
    const key = await ipKey(ip);
    for (let i = 0; i < max; i += 1) expect((await signup(address(), ip)).ok).toBe(true);
    expect(await signup(address(), ip)).toEqual(deny("rate_limited"));
    await owner(db, "update private.rate_limit_events set created_at = now() - $2::interval + interval '1 second' where user_id = $1 and action = 'signup_ip'", [key, window]);
    expect(await signup(address(), ip)).toEqual(deny("rate_limited"));
    await owner(db, "update private.rate_limit_events set created_at = created_at - interval '2 seconds' where user_id = $1 and action = 'signup_ip'", [key]);
    expect(await signup(address(), ip)).toEqual(OK);
  });
});

describe("SEC-012 independence from sign-in", () => {
  it("a full sign-in count for the address and the IP does not limit sign-up, and sign-up records no sign-in event", async () => {
    const [email, ip] = [address(), ipv4()];
    await fill(await addressKey(email), "signin");
    await fill(await ipKey(ip), "signin_ip");
    expect(await signin(email, ip)).toEqual(deny("rate_limited"));
    expect(await signup(email, ip)).toEqual(OK);
    expect(await events(await addressKey(email), "signin")).toBe((await policy(db, "signin")).max_count);
    expect(await events(await ipKey(ip), "signin_ip")).toBe((await policy(db, "signin_ip")).max_count);
  });

  it("a full sign-up count does not limit sign-in, and sign-in records no sign-up event", async () => {
    const [email, ip] = [address(), ipv4()];
    await fill(await addressKey(email), "signup");
    await fill(await ipKey(ip), "signup_ip");
    expect(await signup(email, ip)).toEqual(deny("rate_limited"));
    expect(await signin(email, ip)).toEqual(OK);
    expect(await events(await addressKey(email), "signup")).toBe((await policy(db, "signup")).max_count);
    expect(await events(await ipKey(ip), "signup_ip")).toBe((await policy(db, "signup_ip")).max_count);
  });

  it("stores only the peppered keys: no plain address or IP appears in the events", async () => {
    const [email, ip] = [address(), ipv4()];
    expect(await signup(email, ip)).toEqual(OK);
    const [{ ids }] = await owner<{ ids: string[] }>(db, "select array_agg(user_id::text) as ids from private.rate_limit_events where action in ('signup', 'signup_ip')");
    expect(ids).toEqual(expect.arrayContaining([await addressKey(email), await ipKey(ip)]));
    const [{ n }] = await owner<{ n: number }>(db, "select count(*)::int as n from private.rate_limit_events e where e::text like '%' || $1 || '%' or e::text like '%' || $2 || '%'", [email, ip]);
    expect(n).toBe(0);
  });
});

describe("SEC-012 grants", () => {
  it("is executable by service_role only, in one form", async () => {
    const me = user(await createUser(db, { cls: m.classes[0] }));
    const before = await fingerprint(db);
    for (const sql of ["select * from public.service_reserve_signup('a@example.test', '192.0.2.1')", "select * from public.service_reserve_signup('a@example.test')"]) {
      expect(await raised(() => asRole(db, "anon", null, sql))).toMatch(/permission denied/);
      expect(await raised(() => asRole(db, "authenticated", me, sql))).toMatch(/permission denied/);
    }
    expect(await fingerprint(db)).toBe(before);
    const [{ forms }] = await owner<{ forms: string[] }>(db, `select array_agg(pg_get_function_identity_arguments(p.oid)) as forms
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname = 'service_reserve_signup'`);
    expect(forms).toEqual(["p_email text, p_ip text"]);
    const [{ grantees }] = await owner<{ grantees: string[] }>(db, `select array_agg(distinct r.rolname order by r.rolname) as grantees
      from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid = a.grantee
      where p.proname = 'service_reserve_signup' and a.privilege_type = 'EXECUTE' and r.rolname <> (select pg_get_userbyid(p.proowner))`);
    expect(grantees).toEqual(["service_role"]);
  });

  it("the one-argument call is the address limit alone", async () => {
    const email = address();
    expect((await asRole<Outcome>(db, "service_role", null, "select * from public.service_reserve_signup($1)", [email]))[0]).toEqual(OK);
    expect(await events(await addressKey(email), "signup")).toBe(1);
  });

  it("refuses with forbidden and records nothing when the pepper is missing", async () => {
    const own = (await db.clone()) as PGlite;
    try {
      await owner(own, "delete from private.app_settings where key = 'auth_rate_pepper'");
      const before = await fingerprint(own);
      expect(await raised(() => signup(address(), "192.0.2.1", own))).toBe("forbidden");
      expect(await raised(() => signup(address(), null, own))).toBe("forbidden");
      expect(await fingerprint(own)).toBe(before);
    } finally { await own.close(); }
  });
});

describe("SEC-012 retention", () => {
  it("service_purge_rate_limits removes signup and signup_ip events older than 7 days and keeps the recent ones", async () => {
    const own = (await db.clone()) as PGlite;
    try {
      await owner(own, "delete from private.rate_limit_events");
      const key = await ipKey("192.0.2.98", own);
      for (const action of ["signup", "signup_ip"]) {
        for (const age of ["8 days", "7 days 1 second", "6 days", "1 minute"]) {
          await owner(own, "insert into private.rate_limit_events (user_id, action, created_at) values ($1, $2, now() - $3::interval)", [key, action, age]);
        }
      }
      expect(await asRole(own, "service_role", null, "select public.service_purge_rate_limits() as n")).toEqual([{ n: 4 }]);
      for (const action of ["signup", "signup_ip"]) expect(await events(key, action, own), action).toBe(2);
    } finally { await own.close(); }
  });
});
