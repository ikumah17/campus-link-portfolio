// ACCOUNT-003 (docs/handoffs/ACCOUNT-003-deleted-account-db.md): order 17 makes a deleted account no caller at all.
// The same fictional data runs on migrations 1-16 ("before") and on a clone with order 17 applied ("after"), so every
// probe is compared on identical rows: deleted callers lose everything but my_account, every other caller is unchanged.
// ACCOUNT-004 (docs/handoffs/ACCOUNT-004-my-account-deleted.md): the same world on 1-17 ("before18") and 1-18
// ("after18"): my_account tells a deleted caller only its id and 'deleted', and nothing else changes for anyone.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { READ_RPCS, STATE_CHANGING_RPCS } from "./allowlist";
import { connect, createMasters, createStaff, createUser, type Masters } from "./fixtures";
import { asRole, asUser, claimsOf, fingerprint, MIGRATIONS_DIR, migrationFiles, owner, raised, rpc, staff, user, type Session } from "./harness";

const ORDER_17 = "20261110120017_deleted_account.sql";
const ORDER_18 = "20261111120018_my_account_deleted.sql";
// Public RPCs added after order 18 are not in these worlds; my-staff-roles.test.ts covers order 19,
// photo-rate-limit.test.ts covers order 21, auth-rate-limit.test.ts covers order 22 and suspended-accounts.test.ts
// covers order 23 and hide-reported-content.test.ts covers order 33 for deleted callers.
const LATER_RPCS = ["my_staff_roles", "reserve_photo_upload", "reserve_mfa_attempt", "admin_list_suspended_accounts",
  "admin_get_report_content", "admin_authorize_report_photo", "admin_hide_reported_content", "admin_unhide_reported_content"];
// Order 34 (DB-LIKES-001) dropped the request and mode RPCs and added the like RPCs; likes.test.ts covers its deleted callers.
const ORDER_34_DROPPED = ["list_my_requests", "set_modes", "send_connection_request", "respond_connection_request",
  "cancel_connection_request"];
const ORDER_34_ADDED = ["like_user", "unlike_user", "list_my_likes", "get_like_state"];
const RPCS_TO_18 = [...READ_RPCS, ...STATE_CHANGING_RPCS, ...ORDER_34_DROPPED]
  .filter((name) => !LATER_RPCS.includes(name) && !ORDER_34_ADDED.includes(name)).sort();
const OWN_TABLES = ["profiles", "profile_modes", "profile_photos", "account_verifications", "affiliations", "privacy_settings",
  "hidden_affiliations", "verification_submissions", "conversation_reads", "messages"];

interface Caller { label: string; id: string; session: Session; staff: boolean; conversation?: string; photo?: string }

let before: PGlite, after: PGlite, before18: PGlite, after18: PGlite, m: Masters;
let peer: string, peerPhoto: string;
const callers: Record<"active" | "deactivated" | "suspended" | "deleted" | "staffNoProfile" | "deletedStaff", Caller> = {} as never;
let noProfile: Caller, anonymousId: string;

async function populate(db: PGlite) {
  m = await createMasters(db, "acct3");
  peer = await createUser(db, { cls: m.classes[4] });
  [{ id: peerPhoto }] = await owner<{ id: string }>(db, "select id::text from public.profile_photos where user_id = $1", [peer]);
  for (const [label, status] of [["active", "active"], ["deactivated", "deactivated"], ["suspended", "suspended"], ["deleted", "active"]] as const) {
    const id = await createUser(db, { cls: m.classes[0], status, hidden: { classes: [m.classes[3].id] } });
    const { conversation } = await connect(db, id, peer);
    await owner(db, "insert into public.messages (conversation_id, sender_id, client_msg_id, body) values ($1, $2, $3, '架空')", [conversation, peer, randomUUID()]);
    await owner(db, "insert into public.conversation_reads (conversation_id, user_id, last_read_message_id) values ($1, $2, null)", [conversation, id]);
    await owner(db, "insert into public.blocks (blocker_id, blocked_id, blocked_name_snapshot) values ($1, $2, '架空')", [id, await createUser(db, { cls: m.classes[4] })]);
    await owner(db, "insert into public.reports (reporter_id, target_user_id, context, reason) values ($1, $2, 'profile', 'spam')", [id, peer]);
    await owner(db, "insert into public.connection_requests (requester_id, recipient_id, mode) values ($1, $2, 'romance')", [id, await createUser(db, { cls: m.classes[5] })]);
    const [{ id: photo }] = await owner<{ id: string }>(db, "select id::text from public.profile_photos where user_id = $1", [id]);
    callers[label] = { label, id, session: user(id), staff: false, conversation, photo };
  }
  expect(await rpc(db, callers.deleted.session, "request_account_deletion")).toMatchObject({ ok: true });
  await owner(db, "update public.profiles set deleted_at = now() - interval '40 days' where user_id = $1", [callers.deleted.id]);   // due for retention
  const staffNoProfile = await createStaff(db, ["reviewer", "moderator", "admin"]);
  callers.staffNoProfile = { label: "staffNoProfile", id: staffNoProfile, session: staff(staffNoProfile), staff: true };
  const deletedStaff = await createStaff(db, ["reviewer", "moderator", "admin"]);
  await owner(db, "insert into public.profiles (user_id, display_name, gender, account_status, deleted_at) values ($1, '架空', 'other', 'deleted', now())", [deletedStaff]);
  callers.deletedStaff = { label: "deletedStaff", id: deletedStaff, session: staff(deletedStaff), staff: true };
  await owner(db, "update private.app_settings set value = 'upload' where key = 'verification_intake'");   // the storage self-check answers
}

beforeAll(async () => {
  const all = migrationFiles();
  const files = all.slice(0, all.indexOf(ORDER_18) + 1);   // orders 1-18; later orders are tested on their own
  expect(files.slice(-2)).toEqual([ORDER_17, ORDER_18]);
  before = await PGlite.create();
  for (const file of [join(MIGRATIONS_DIR, "..", "..", "tests", "db", "shim.sql"), ...files.slice(0, -2).map((f) => join(MIGRATIONS_DIR, f))]) {
    await before.exec(readFileSync(file, "utf8"));
  }
  await populate(before);
  // clones load the custom enum array types, so array parameters serialize the same way in both databases
  const base = before;
  before = (await base.clone()) as PGlite;
  after = (await base.clone()) as PGlite;
  await base.close();
  await after.exec(readFileSync(join(MIGRATIONS_DIR, ORDER_17), "utf8"));
  // order 18 runs on its own clones of the order 17 world, taken before any test writes, plus a plain user without
  // a profile and an anonymous user
  const mid = (await after.clone()) as PGlite;
  const plain = await createUser(mid, { profile: false });
  noProfile = { label: "noProfile", id: plain, session: user(plain), staff: false };
  anonymousId = await createUser(mid, { profile: false, anonymous: true });
  before18 = (await mid.clone()) as PGlite;
  after18 = (await mid.clone()) as PGlite;
  await mid.close();
  await after18.exec(readFileSync(join(MIGRATIONS_DIR, ORDER_18), "utf8"));
});
afterAll(async () => { await before?.close(); await after?.close(); await before18?.close(); await after18?.close(); });

/** A result as comparable text: rows, or the raised message. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try { return JSON.stringify(await run()); } catch (error) { return `raised:${(error as Error).message}`; }
}

/** As the caller but with the owner's privileges: private functions authenticated cannot execute. */
function asClaims<T>(db: PGlite, session: Session, sql: string, params: unknown[] = []): Promise<T[]> {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claimsOf(session))]);
    return (await tx.query<T>(sql, params)).rows;
  });
}

/** Every caller-acting read the spec names, by probe label. Probes only read (the storage insert is per database). */
async function probes(db: PGlite, c: Caller): Promise<Record<string, string>> {
  const s = c.session;
  const conversation = c.conversation ?? callers.active.conversation!;
  const result: Record<string, string> = {};
  const read = async (fn: string, args = "") => { result[fn] = await outcome(() => asUser(db, s, `select * from public.${fn}(${args})`)); };
  await read("my_account");
  for (const fn of ["list_my_requests", "list_my_conversations", "list_my_blocks", "my_reports"]) await read(fn);
  await read("list_messages", `'${conversation}'::uuid`);
  await read("discover_profiles", "'friends'");
  await read("get_profile", `'${peer}'::uuid, 'friends'`);
  result.authorize_own_photo = await outcome(() => asUser(db, s, "select * from public.authorize_photo_delivery($1::uuid[])", [[c.photo ?? peerPhoto]]));
  result.authorize_peer_photo = await outcome(() => asUser(db, s, "select * from public.authorize_photo_delivery($1::uuid[])", [[peerPhoto]]));
  for (const fn of ["admin_list_staff", "admin_list_submissions", "admin_list_reports", "admin_list_affiliations"]) await read(fn);
  for (const table of OWN_TABLES) {
    result[`rls:${table}`] = await outcome(async () => (await asUser(db, s, `select 1 from public.${table}`)).length);
  }
  result.rls_document_upload_allowed = await outcome(() => asUser(db, s, "select private.rls_document_upload_allowed($1) as ok", [`${c.id}/probe/1.webp`]));
  result.rls_conversation_member = await outcome(() => asUser(db, s, "select private.rls_conversation_member($1) as ok", [conversation]));
  result.storage_insert = await outcome(() => asUser(db, s, "insert into storage.objects (bucket_id, name) values ('verification-documents', $1)", [`${c.id}/probe/1.webp`]));
  result.require_user = await outcome(() => asClaims(db, s, "select private.require_user() as id"));
  result.require_staff = await outcome(() => asClaims(db, s, "select private.require_staff('admin') as id"));
  return result;
}

describe("ACCOUNT-003 a deleted caller after order 17", () => {
  it("before order 17 the deleted account still read its own data; after it every probe refuses but my_account", async () => {
    const olds: Record<string, Record<string, string>> = {};
    for (const c of [callers.deleted, callers.deletedStaff]) {
      const old = olds[c.label] = await probes(before, c);
      const now = await probes(after, c);
      expect(now.my_account, c.label).toBe(old.my_account);
      expect(JSON.parse(now.my_account), c.label).toMatchObject([{ user_id: c.id, has_profile: true, account_status: "deleted" }]);
      const expected: Record<string, string> = { my_account: old.my_account };
      for (const key of Object.keys(old).filter((k) => k !== "my_account")) {
        expected[key] = key.startsWith("rls:") ? "0"
          : key.startsWith("rls_") ? JSON.stringify([{ ok: false }])
          : key === "storage_insert" ? "raised:new row violates row-level security policy for table \"objects\""
          : "raised:forbidden";
      }
      expect([c.label, now]).toEqual([c.label, expected]);
    }
    // The gap order 17 closes, as the ACCOUNT-002 audit found it.
    const old = olds.deleted;
    expect(JSON.parse(old.authorize_own_photo)).toHaveLength(1);
    for (const key of ["list_my_requests", "list_my_blocks", "my_reports"]) expect(JSON.parse(old[key]), key).not.toEqual([]);
    for (const table of OWN_TABLES.filter((t) => t !== "messages")) expect(Number(old[`rls:${table}`]), table).toBeGreaterThan(0);
    expect(old.rls_document_upload_allowed).toBe(JSON.stringify([{ ok: true }]));
    expect(old.storage_insert).toBe("[]");
    const staffOld = olds.deletedStaff;
    expect(JSON.parse(staffOld.require_staff)).toEqual([{ id: callers.deletedStaff.id }]);
    expect(JSON.parse(staffOld.admin_list_staff)).not.toEqual([]);
  });

  it("every caller-acting RPC in the catalog raises forbidden for a deleted user and a deleted aal2 staff member, changing nothing", async () => {
    const fns = await owner<{ name: string; args: string[] }>(after, `
      select p.proname as name, array(select format_type(t, null) from unnest(p.proargtypes) with ordinality a(t, o) order by o) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'EXECUTE') order by 1`);
    expect(fns.map((f) => f.name).sort()).toEqual(RPCS_TO_18);
    const unchanged = await fingerprint(after);
    for (const c of [callers.deleted, callers.deletedStaff]) {
      for (const f of fns.filter((x) => x.name !== "my_account")) {
        const sql = `select * from public.${f.name}(${f.args.map((t) => `null::${t}`).join(", ")})`;
        expect([c.label, f.name, await raised(() => asUser(after, c.session, sql))]).toEqual([c.label, f.name, "forbidden"]);
      }
      // request_account_deletion refuses a second call cleanly, as before order 17
      expect(await raised(() => rpc(after, c.session, "request_account_deletion"))).toBe("forbidden");
    }
    expect(await fingerprint(after)).toBe(unchanged);
  });
});

describe("ACCOUNT-003 parity: every other caller is unchanged by order 17", () => {
  it("active, deactivated and suspended users and staff without a profile get identical probe results", async () => {
    for (const c of [callers.active, callers.deactivated, callers.suspended, callers.staffNoProfile]) {
      const old = await probes(before, c);
      expect([c.label, await probes(after, c)]).toEqual([c.label, old]);
      if (!c.staff) {
        // messages need an eligible pair, so only the active caller reads them
        for (const table of OWN_TABLES.filter((t) => t !== "messages" || c === callers.active)) {
          expect([c.label, table, Number(old[`rls:${table}`]) > 0]).toEqual([c.label, table, true]);
        }
        expect(old.require_user).toBe(JSON.stringify([{ id: c.id }]));
      }
    }
    const noProfile = await probes(after, callers.staffNoProfile);
    expect(JSON.parse(noProfile.my_account)).toMatchObject([{ user_id: callers.staffNoProfile.id, has_profile: false, account_status: null }]);
    expect(JSON.parse(noProfile.require_staff)).toEqual([{ id: callers.staffNoProfile.id }]);
    expect(JSON.parse(noProfile.admin_list_staff)).not.toEqual([]);
  });

  it("the same writes in the same order give the same outcomes, including today's deactivated allowances", async () => {
    const results: Record<string, string[]> = {};
    for (const [name, db] of [["before", before], ["after", after]] as const) {
      const run: string[] = [];
      const call = async (c: Caller, fn: string, args: unknown[] = [], casts: string[] = []) => {
        const list = args.map((_, i) => `$${i + 1}${casts[i] ? `::${casts[i]}` : ""}`).join(", ");
        run.push(`${c.label}:${fn}:${await outcome(async () => {
          const [row] = await asUser<{ ok: boolean; code: string; ref: string | null }>(db, c.session, `select * from public.${fn}(${list})`, args);
          return { ...row, ref: row.ref === null ? null : "ref" };
        })}`);
      };
      const third = callers.suspended.id;
      for (const c of [callers.active, callers.deactivated, callers.suspended]) {
        await call(c, "update_privacy_settings", [true, false, false, false, false, [], [], []],
          ["boolean", "boolean", "boolean", "boolean", "boolean", "uuid[]", "uuid[]", "uuid[]"]);
        await call(c, "set_modes", [["friends"]], ["public.discover_mode[]"]);
        await call(c, "update_profile", ["架空改", "female", "", "", "", "", []], ["text", "text", "text", "text", "text", "text", "text[]"]);
        await call(c, "block_user", [third], ["uuid"]);
        await call(c, "unblock_user", [third], ["uuid"]);
        await call(c, "submit_report", [peer, "profile", "spam"], ["uuid", "public.report_context", "public.report_reason"]);
        await call(c, "send_connection_request", [peer, "romance"], ["uuid", "public.discover_mode"]);
        await call(c, "deactivate_account");
        await call(c, "reactivate_account");
        await call(c, "deactivate_account");
      }
      await call(callers.staffNoProfile, "admin_upsert_school", [null, "ACCOUNT-003校（架空）", true, 0], ["uuid", "text", "boolean", "int"]);
      await call(callers.staffNoProfile, "request_account_deletion");
      for (const c of [callers.active, callers.deactivated]) await call(c, "request_account_deletion");
      for (const c of [callers.active, callers.deactivated]) await call(c, "request_account_deletion");
      results[name] = run;
    }
    expect(results.after).toEqual(results.before);
    expect(results.before.filter((r) => r.includes(":{\"ok\":true")).length).toBeGreaterThan(10);
    // after deleting themselves through the RPC, the former callers are refused as above
    for (const c of [callers.active, callers.deactivated]) {
      expect(JSON.parse((await probes(after, c)).my_account)).toMatchObject([{ account_status: "deleted" }]);
      expect(await raised(() => asUser(after, c.session, "select * from public.list_my_blocks()"))).toBe("forbidden");
    }
  });

  it("the service-role retention list is identical before and after (the sweep never acts as a caller)", async () => {
    const sql = "select * from public.service_retention_candidates() order by 1, 2, 3, 4";
    const old = await asRole(before, "service_role", null, sql);
    expect(old.length).toBeGreaterThan(0);
    expect(await asRole(after, "service_role", null, sql)).toEqual(old);
  });
});

/** The fixture birth date as PGlite returns it in JSON form. */
const BIRTH = "2000-05-05T00:00:00.000Z";

/** The only my_account row a deleted caller may read after order 18. */
const deletedRow = (id: string) => [{
  user_id: id, has_profile: true, account_status: "deleted", profile_completed: false, age_verified: false, adult: false,
  affiliation_status: null, affiliation_confirmed: false, has_active_photo: false, has_mode: false, eligible: false, birth_date: null,
}];

describe("ACCOUNT-004 my_account for a deleted caller after order 18", () => {
  it("a deleted user and a deleted aal2 staff member read only their id and 'deleted'; every other probe is unchanged", async () => {
    for (const c of [callers.deleted, callers.deletedStaff]) {
      const old = await probes(before18, c);
      const now = await probes(after18, c);
      expect([c.label, JSON.parse(now.my_account)]).toEqual([c.label, deletedRow(c.id)]);
      expect([c.label, now]).toEqual([c.label, { ...old, my_account: now.my_account }]);
    }
    // The leak order 18 closes: before it the deleted user still read its birth date and flags.
    const [old] = JSON.parse((await probes(before18, callers.deleted)).my_account);
    expect(old).toMatchObject({ user_id: callers.deleted.id, account_status: "deleted", birth_date: BIRTH,
      profile_completed: true, adult: true, has_active_photo: true, has_mode: true });
  });

  it("every other caller-acting RPC still raises forbidden for a deleted caller, changing nothing", async () => {
    const fns = await owner<{ name: string; args: string[] }>(after18, `
      select p.proname as name, array(select format_type(t, null) from unnest(p.proargtypes) with ordinality a(t, o) order by o) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'EXECUTE') order by 1`);
    expect(fns.map((f) => f.name).sort()).toEqual(RPCS_TO_18);
    const unchanged = await fingerprint(after18);
    for (const c of [callers.deleted, callers.deletedStaff]) {
      for (const f of fns.filter((x) => x.name !== "my_account")) {
        const sql = `select * from public.${f.name}(${f.args.map((t) => `null::${t}`).join(", ")})`;
        expect([c.label, f.name, await raised(() => asUser(after18, c.session, sql))]).toEqual([c.label, f.name, "forbidden"]);
      }
    }
    expect(await fingerprint(after18)).toBe(unchanged);
  });

  it("parity: no profile, staff without a profile, active, deactivated, suspended and the peer read identical results", async () => {
    const peerCaller: Caller = { label: "peer", id: peer, session: user(peer), staff: false, photo: peerPhoto };
    for (const c of [noProfile, callers.staffNoProfile, callers.active, callers.deactivated, callers.suspended, peerCaller]) {
      const old = await probes(before18, c);
      expect([c.label, await probes(after18, c)]).toEqual([c.label, old]);
      expect([c.label, JSON.parse(old.my_account)]).toMatchObject([c.label, [{ user_id: c.id }]]);
    }
    expect(JSON.parse((await probes(after18, noProfile)).my_account)).toMatchObject([{ has_profile: false, account_status: null, birth_date: null }]);
    expect(JSON.parse((await probes(after18, callers.suspended)).my_account)).toMatchObject([{ account_status: "suspended", birth_date: BIRTH }]);
    expect(JSON.parse((await probes(after18, peerCaller)).my_account)).toMatchObject([{ account_status: "active", eligible: true }]);
  });

  it("a caller who deletes itself reads the full row before and only the deleted row after, on identical writes", async () => {
    const results: Record<string, unknown[]> = {};
    for (const [name, base] of [["before", before18], ["after", after18]] as const) {
      const db = (await base.clone()) as PGlite;
      try {
        const run: unknown[] = [];
        for (const c of [callers.active, callers.deactivated]) {
          run.push(await rpc(db, c.session, "request_account_deletion"));
          run.push(...(await asUser(db, c.session, "select * from public.my_account()")));
        }
        results[name] = run;
      } finally { await db.close(); }
    }
    expect(results.before).toHaveLength(4);
    expect(results.before.filter((r) => (r as { ok?: boolean }).ok === true)).toHaveLength(2);
    expect(results.before[1]).toMatchObject({ account_status: "deleted", birth_date: new Date(BIRTH) });
    expect(results.after).toEqual([results.before[0], deletedRow(callers.active.id)[0], results.before[2], deletedRow(callers.deactivated.id)[0]]);
  });

  it("no session and anonymous JWTs still raise forbidden", async () => {
    const sessions: [string, Session | null][] = [
      ["no session", null],
      ["anonymous (JWT and auth.users)", { sub: anonymousId, isAnonymous: true }],
      ["anonymous claim on a plain user", { sub: noProfile.id, isAnonymous: true }],
      ["anonymous claim on a deleted user", { sub: callers.deleted.id, isAnonymous: true }],
      ["no sub", { omitSub: true }],
    ];
    for (const db of [before18, after18]) {
      for (const [label, session] of sessions) {
        const sql = "select * from public.my_account()";
        const run = () => session ? asUser(db, session, sql) : asRole(db, "anon", null, sql);
        expect([label, await raised(run)]).toEqual([label, session ? "forbidden" : "permission denied for function my_account"]);
      }
      expect(await raised(() => asRole(db, "authenticated", null, "select * from public.my_account()"))).toBe("forbidden");
    }
  });

  it("signature, return columns, security definer, search_path, volatility, owner and ACL are unchanged", async () => {
    const sql = `
      select pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as result, p.prosecdef,
             p.proconfig, p.provolatile, p.proowner::regrole::text as owner, p.proacl::text as acl,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'my_account'`;
    const old = await owner(before18, sql);
    expect(old).toHaveLength(1);
    expect(await owner(after18, sql)).toEqual(old);
    expect(old[0]).toMatchObject({ args: "", prosecdef: true, proconfig: ["search_path=\"\""], anon: false, auth: true });
  });
});
