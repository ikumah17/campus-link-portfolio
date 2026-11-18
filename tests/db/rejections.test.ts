// NT-27 (docs/04_DATABASE.md §5 "エラーと拒否の2分類", §13.2; ARCH-R2-04): every business rejection path of every
// state-changing RPC, each call committed on its own and the persistent state read back from separate owner
// transactions. The deny codes are read from the catalog, so a new rejection path needs a case here.
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { addTotpFactor, connect, createMasters, createStaff, createUser, like, missingId, type Masters } from "./fixtures";
import { asRole, asUser, deny, fingerprint, freshDb, owner, raised, rpc, staff, user, type Outcome, type Session } from "./harness";

let db: PGlite;
let m: Masters;
let reviewer: string;
let reviewer2: string;
let moderator: string;
let admin: string;

beforeAll(async () => {
  db = await freshDb();
  m = await createMasters(db, "nt27");
  reviewer = await createStaff(db, ["reviewer"]);
  reviewer2 = await createStaff(db, ["reviewer"]);
  moderator = await createStaff(db, ["moderator"]);
  admin = await createStaff(db, ["admin"]);   // the only admin of this database
});

type Code = "not_available" | "invalid_state" | "already_connected" | "rate_limited" | "mfa_required";

interface Call {
  fn: string;
  session: Session | "service";
  args: unknown[];
  casts?: string[];
  /** tables the rejection is expected to normalize (checked by `check`) */
  changes?: string[];
  /** rate action the rejected attempt is recorded under */
  attempt?: string;
  /** persistent state after the commit, read from separate owner transactions */
  check?: () => Promise<void>;
}

interface Case { fn: string; code: Code; label: string; prepare: () => Promise<Omit<Call, "fn">> }

const SUBMIT = ["public.verification_kind", "text[]"];
const DECIDE = ["uuid", "boolean", "text", "timestamptz", "int"];
const PRIVACY = ["boolean", "boolean", "boolean", "boolean", "boolean", "uuid[]", "uuid[]", "uuid[]"];
const REPORT = ["uuid", "public.report_context", "public.report_reason", "text", "uuid", "bigint"];
const later = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();

const eligible = (i = 0) => createUser(db, { cls: m.classes[i] });
const photoIds = async (u: string, status = "active") => (await owner<{ id: string }>(db,
  "select id::text from public.profile_photos where user_id = $1 and status = $2 order by position", [u, status])).map((r) => r.id);
const submissionOf = async (u: string, kind: string, status: string) => (await owner<{ id: string; version: number }>(db,
  "select id::text, version from public.verification_submissions where user_id = $1 and kind = $2 and status = $3", [u, kind, status]))[0];
const fillEvents = async (u: string, action: string) => owner(db, `
  insert into private.rate_limit_events (user_id, action)
  select $1, $2 from generate_series(1, (select max_count from private.rate_policy($2)))`, [u, action]);
const likesBetween = async (a: string, b: string) => (await owner<{ n: number }>(db, `
  select count(*)::int as n from public.likes where (liker_id = $1 and liked_id = $2) or (liker_id = $2 and liked_id = $1)`,
[a, b]))[0].n;
const claimed = async (u: string) => {
  const sub = await submissionOf(u, "enrollment", "submitted");
  expect((await rpc(db, staff(reviewer), "admin_claim_submission", [sub.id])).ok).toBe(true);
  return sub.id;
};
const reportOf = async (from: string, to: string) => (await rpc(db, user(from), "submit_report",
  [to, "profile", "spam", null, null, null], REPORT)).ref!;

const CASES: Case[] = [
  // §5.2 onboarding and own data
  { fn: "start_onboarding", code: "invalid_state", label: "already onboarded", prepare: async () => ({
    session: user(await eligible()), args: ["架空", "female", "2000-01-01", true] }) },
  { fn: "update_birth_date", code: "invalid_state", label: "locked by the age approval", prepare: async () => ({
    session: user(await eligible()), args: ["1999-01-01"] }) },
  { fn: "complete_profile", code: "invalid_state", label: "no affiliation or photo yet", prepare: async () => {
    const me = await createUser(db, { profile: false });
    expect((await rpc(db, user(me), "start_onboarding", ["架空", "female", "2000-01-01", true])).ok).toBe(true);
    return { session: user(me), args: [] };
  } },
  { fn: "remove_photo", code: "not_available", label: "another user's photo", prepare: async () => ({
    session: user(await eligible()), args: [(await photoIds(await eligible(4)))[0]] }) },
  { fn: "remove_photo", code: "invalid_state", label: "the last photo of a completed profile", prepare: async () => {
    const me = await eligible();
    return { session: user(me), args: [(await photoIds(me))[0]] };
  } },
  { fn: "remove_photo", code: "invalid_state", label: "an already removed photo", prepare: async () => {
    const me = await createUser(db, { cls: m.classes[0], photos: 2, removedPhotos: 1 });
    return { session: user(me), args: [(await photoIds(me, "removed"))[0]] };
  } },
  { fn: "reorder_photos", code: "invalid_state", label: "not exactly the active photos", prepare: async () => {
    const me = await createUser(db, { cls: m.classes[0], photos: 2 });
    return { session: user(me), args: [[(await photoIds(me))[0], randomUUID()]], casts: ["uuid[]"] };
  } },
  { fn: "submit_verification", code: "invalid_state", label: "an open submission of the same kind", prepare: async () => {
    const me = await createUser(db, { cls: m.classes[0], ageVerified: false });
    expect((await rpc(db, user(me), "submit_verification", ["age", ["synthetic:sample-1"]], SUBMIT)).ok).toBe(true);
    return { session: user(me), args: ["age", ["synthetic:sample-2"]], casts: SUBMIT };
  } },
  { fn: "submit_verification", code: "invalid_state", label: "age already verified", prepare: async () => ({
    session: user(await eligible()), args: ["age", ["synthetic:sample-1"]], casts: SUBMIT }) },
  { fn: "submit_verification", code: "invalid_state", label: "enrollment without an affiliation", prepare: async () => ({
    session: user(await createUser(db, {})), args: ["enrollment", ["synthetic:sample-1"]], casts: SUBMIT }) },
  { fn: "withdraw_verification", code: "not_available", label: "another user's submission", prepare: async () => {
    const other = await createUser(db, { cls: m.classes[4], affiliation: "pending" });
    return { session: user(await eligible()), args: [(await submissionOf(other, "enrollment", "submitted")).id] };
  } },
  { fn: "withdraw_verification", code: "invalid_state", label: "an approved submission", prepare: async () => {
    const me = await eligible();
    return { session: user(me), args: [(await submissionOf(me, "age", "approved")).id] };
  } },
  { fn: "update_privacy_settings", code: "rate_limited", label: "daily limit", prepare: async () => {
    const me = await eligible();
    await fillEvents(me, "privacy");
    return { session: user(me), args: [false, false, false, true, true, [], [], []], casts: PRIVACY };
  } },
  { fn: "reserve_photo_upload", code: "rate_limited", label: "per-window upload limit; the refusal is not recorded (SEC-004)", prepare: async () => {
    const me = await eligible();
    await fillEvents(me, "photo");
    return { session: user(me), args: [] };
  } },
  { fn: "reserve_mfa_attempt", code: "rate_limited", label: "per-window TOTP limit; the refusal is not recorded (SEC-006)", prepare: async () => {
    const me = await eligible();
    await fillEvents(me, "mfa");
    return { session: user(me), args: [] };
  } },
  { fn: "deactivate_account", code: "invalid_state", label: "already deactivated", prepare: async () => ({
    session: user(await createUser(db, { cls: m.classes[0], status: "deactivated" })), args: [] }) },
  { fn: "reactivate_account", code: "invalid_state", label: "already active", prepare: async () => ({
    session: user(await eligible()), args: [] }) },
  { fn: "service_register_photo", code: "invalid_state", label: "all six positions taken", prepare: async () => {
    const me = await createUser(db, { cls: m.classes[0], photos: 6 });
    return { session: "service", args: [me, `${me}/${randomUUID()}.webp`] };
  } },
  { fn: "service_register_photo", code: "invalid_state", label: "the path is already registered", prepare: async () => {
    const me = await createUser(db, { cls: m.classes[0], photos: 2 });
    const [path] = await owner<{ p: string }>(db, "select storage_path as p from public.profile_photos where user_id = $1 limit 1", [me]);
    return { session: "service", args: [me, path.p] };
  } },
  { fn: "service_reserve_signin", code: "rate_limited", label: "per-address sign-in limit; the refusal is not recorded (SEC-006)", prepare: async () => {
    const email = `nt27-${randomUUID()}@example.test`;
    const [{ key }] = await owner<{ key: string }>(db, "select private.signin_rate_key($1)::text as key", [email]);
    await fillEvents(key, "signin");
    return { session: "service", args: [email] };
  } },
  { fn: "service_reserve_signin", code: "rate_limited", label: "per-IP sign-in limit; the refusal records nothing for either key (SEC-008)", prepare: async () => {
    const email = `nt27-${randomUUID()}@example.test`;
    const [{ ip }] = await owner<{ ip: string }>(db, "select private.signin_ip_rate_key('192.0.2.27')::text as ip");
    await fillEvents(ip, "signin_ip");
    return { session: "service", args: [email, "192.0.2.27"] };
  } },
  { fn: "service_reserve_signup", code: "rate_limited", label: "per-address sign-up limit; the refusal is not recorded (SEC-012)", prepare: async () => {
    const email = `nt27-${randomUUID()}@example.test`;
    const [{ key }] = await owner<{ key: string }>(db, "select private.signin_rate_key($1)::text as key", [email]);
    await fillEvents(key, "signup");
    return { session: "service", args: [email, null] };
  } },
  { fn: "service_reserve_signup", code: "rate_limited", label: "per-IP sign-up limit; the refusal records nothing for either key (SEC-012)", prepare: async () => {
    const email = `nt27-${randomUUID()}@example.test`;
    const [{ ip }] = await owner<{ ip: string }>(db, "select private.signin_ip_rate_key('192.0.2.28')::text as ip");
    await fillEvents(ip, "signup_ip");
    return { session: "service", args: [email, "192.0.2.28"] };
  } },

  // §5.3 likes and connections (order 34)
  { fn: "like_user", code: "rate_limited", label: "daily attempt limit", prepare: async () => {
    const me = await eligible();
    await fillEvents(me, "like");
    const target = await eligible(4);
    return { session: user(me), args: [target], attempt: "like",
      check: async () => expect(await likesBetween(me, target)).toBe(0) };
  } },
  { fn: "like_user", code: "not_available", label: "hidden target", prepare: async () => {
    const me = await eligible();
    const target = await createUser(db, { cls: m.classes[5], hidden: { schools: [m.classes[0].schoolId] } });
    await like(db, target, me);   // even the other like does not help
    return { session: user(me), args: [target], attempt: "like",
      check: async () => expect(await likesBetween(me, target)).toBe(1) };
  } },
  { fn: "like_user", code: "already_connected", label: "an active connection", prepare: async () => {
    const [me, target] = [await eligible(), await eligible(4)];
    await connect(db, me, target);
    return { session: user(me), args: [target], attempt: "like" };
  } },
  { fn: "unlike_user", code: "rate_limited", label: "daily attempt limit shared with likes; the like stays", prepare: async () => {
    const [me, target] = [await eligible(), await eligible(4)];
    await like(db, me, target);
    await fillEvents(me, "like");
    return { session: user(me), args: [target], attempt: "like",
      check: async () => expect(await likesBetween(me, target)).toBe(1) };
  } },
  { fn: "end_connection", code: "not_available", label: "not a participant", prepare: async () => {
    const { connection } = await connect(db, await eligible(), await eligible(4));
    return { session: user(await eligible(5)), args: [connection] };
  } },
  { fn: "end_connection", code: "invalid_state", label: "already ended", prepare: async () => {
    const [me, peer] = [await eligible(), await eligible(4)];
    const { connection } = await connect(db, me, peer);
    expect((await rpc(db, user(peer), "end_connection", [connection])).ok).toBe(true);
    return { session: user(me), args: [connection] };
  } },

  // §5.4 chat
  { fn: "send_message", code: "not_available", label: "unknown conversation", prepare: async () => ({
    session: user(await eligible()), args: [randomUUID(), randomUUID(), "架空の本文"] }) },
  { fn: "send_message", code: "not_available", label: "the connection ended by a block", prepare: async () => {
    const [me, peer] = [await eligible(), await eligible(4)];
    const { conversation } = await connect(db, me, peer);
    expect((await rpc(db, user(peer), "block_user", [me])).ok).toBe(true);
    return { session: user(me), args: [conversation, randomUUID(), "架空の本文"] };
  } },
  { fn: "send_message", code: "invalid_state", label: "the client_msg_id belongs to another conversation", prepare: async () => {
    const me = await eligible();
    const one = await connect(db, me, await eligible(4));
    const two = await connect(db, me, await eligible(5));
    const clientId = randomUUID();
    expect((await rpc(db, user(me), "send_message", [one.conversation, clientId, "架空の本文"])).ok).toBe(true);
    return { session: user(me), args: [two.conversation, clientId, "架空の本文"] };
  } },
  { fn: "send_message", code: "rate_limited", label: "per-minute limit", prepare: async () => {
    const me = await eligible();
    const { conversation } = await connect(db, me, await eligible(4));
    await fillEvents(me, "message");
    return { session: user(me), args: [conversation, randomUUID(), "架空の本文"] };
  } },
  { fn: "mark_read", code: "not_available", label: "a message of another conversation", prepare: async () => {
    const me = await eligible();
    const mine = await connect(db, me, await eligible(4));
    const [x, y] = [await eligible(5), await eligible(6)];
    const theirs = await connect(db, x, y);
    const msg = (await rpc(db, user(x), "send_message", [theirs.conversation, randomUUID(), "架空の本文"])).ref!;
    return { session: user(me), args: [mine.conversation, msg], casts: ["uuid", "bigint"] };
  } },

  // §5.5 blocks and reports
  { fn: "block_user", code: "rate_limited", label: "daily limit", prepare: async () => {
    const me = await eligible();
    await fillEvents(me, "block");
    return { session: user(me), args: [await eligible(4)] };
  } },
  { fn: "block_user", code: "rate_limited", label: "total limit", prepare: async () => {
    const me = await eligible();
    await owner(db, `insert into public.blocks (blocker_id, blocked_id)
                     select $1, gen_random_uuid() from generate_series(1, (select private.block_total_limit()))`, [me]);
    return { session: user(me), args: [missingId()] };
  } },
  { fn: "submit_report", code: "rate_limited", label: "daily attempt limit", prepare: async () => {
    const me = await eligible();
    await fillEvents(me, "report");
    return { session: user(me), args: [await eligible(4), "profile", "spam", null, null, null], casts: REPORT, attempt: "report" };
  } },
  { fn: "submit_report", code: "not_available", label: "no relation", prepare: async () => ({
    session: user(await eligible()), args: [missingId(), "profile", "spam", null, null, null], casts: REPORT, attempt: "report" }) },

  // §5.6 management
  { fn: "admin_claim_submission", code: "not_available", label: "unknown id", prepare: async () => ({
    session: staff(reviewer), args: [missingId()] }) },
  { fn: "admin_claim_submission", code: "invalid_state", label: "already claimed by another reviewer", prepare: async () => ({
    session: staff(reviewer2), args: [await claimed(await createUser(db, { cls: m.classes[0], affiliation: "pending" }))] }) },
  { fn: "admin_release_submission", code: "not_available", label: "unknown id", prepare: async () => ({
    session: staff(reviewer), args: [missingId()] }) },
  { fn: "admin_release_submission", code: "invalid_state", label: "claimed by another reviewer", prepare: async () => ({
    session: staff(reviewer2), args: [await claimed(await createUser(db, { cls: m.classes[0], affiliation: "pending" }))] }) },
  { fn: "admin_decide_submission", code: "not_available", label: "unknown id", prepare: async () => ({
    session: staff(reviewer), args: [missingId(), true, null, later(365), 1], casts: DECIDE }) },
  { fn: "admin_decide_submission", code: "invalid_state", label: "version mismatch", prepare: async () => ({
    session: staff(reviewer), args: [await claimed(await createUser(db, { cls: m.classes[0], affiliation: "pending" })), true, null,
      later(365), 0], casts: DECIDE }) },
  { fn: "admin_decide_submission", code: "invalid_state", label: "valid_until in the past", prepare: async () => ({
    session: staff(reviewer), args: [await claimed(await createUser(db, { cls: m.classes[0], affiliation: "pending" })), true, null,
      later(-1), 1], casts: DECIDE }) },
  { fn: "admin_decide_submission", code: "invalid_state", label: "the affiliation is no longer pending (owner-made state)",
    prepare: async () => {
      const u = await createUser(db, { cls: m.classes[0], affiliation: "pending" });
      const id = await claimed(u);
      await owner(db, "update public.affiliations set status = 'unconfirmed', class_id = $2 where user_id = $1", [u, m.classes[1].id]);
      return { session: staff(reviewer), args: [id, true, null, later(365), 1], casts: DECIDE };
    } },
  { fn: "admin_decide_submission", code: "invalid_state", label: "age approval for someone not yet 18", prepare: async () => {
    const [{ birth }] = await owner<{ birth: string }>(db, "select (private.today_jst() - interval '17 years')::date::text as birth");
    const u = await createUser(db, { cls: m.classes[0], ageVerified: false, birthDate: birth });
    expect((await rpc(db, user(u), "submit_verification", ["age", ["synthetic:sample-1"]], SUBMIT)).ok).toBe(true);
    const sub = await submissionOf(u, "age", "submitted");
    expect((await rpc(db, staff(reviewer), "admin_claim_submission", [sub.id])).ok).toBe(true);
    return { session: staff(reviewer), args: [sub.id, true, null, null, 1], casts: DECIDE };
  } },
  { fn: "admin_revoke_verification", code: "invalid_state", label: "nothing approved to revoke", prepare: async () => {
    const subject = await createUser(db, { cls: m.classes[0], affiliation: "pending", ageVerified: false });
    const sub = await submissionOf(subject, "enrollment", "submitted");
    return { session: staff(reviewer), args: [sub.id, "policy"], casts: ["uuid", "text"] };
  } },
  { fn: "admin_set_account_status", code: "not_available", label: "no profile", prepare: async () => ({
    session: staff(admin), args: [missingId(), "suspended", null], casts: ["uuid", "public.account_status", "text"] }) },
  { fn: "admin_set_account_status", code: "invalid_state", label: "active to active", prepare: async () => ({
    session: staff(admin), args: [await eligible(), "active", null], casts: ["uuid", "public.account_status", "text"] }) },
  { fn: "admin_upsert_school", code: "not_available", label: "unknown id", prepare: async () => ({
    session: staff(admin), args: [missingId(), "架空の改名", true, 0], casts: ["uuid", "text", "boolean", "int"] }) },
  { fn: "admin_upsert_school", code: "invalid_state", label: "duplicate name", prepare: async () => {
    const [s] = await owner<{ name: string }>(db, "select name from public.schools where id = $1", [m.schools[0]]);
    return { session: staff(admin), args: [null, s.name, true, 0], casts: ["uuid", "text", "boolean", "int"] };
  } },
  { fn: "admin_upsert_department", code: "not_available", label: "unknown id", prepare: async () => ({
    session: staff(admin), args: [missingId(), m.schools[0], "架空", true, 0], casts: ["uuid", "uuid", "text", "boolean", "int"] }) },
  { fn: "admin_upsert_department", code: "invalid_state", label: "moving to another school", prepare: async () => ({
    session: staff(admin), args: [m.departments[0].id, m.schools[1], "架空の移動", true, 0],
    casts: ["uuid", "uuid", "text", "boolean", "int"] }) },
  { fn: "admin_upsert_class", code: "not_available", label: "unknown id", prepare: async () => ({
    session: staff(admin), args: [missingId(), m.departments[0].id, "架空", null, true],
    casts: ["uuid", "uuid", "text", "smallint", "boolean"] }) },
  { fn: "admin_upsert_class", code: "invalid_state", label: "duplicate (department, name, year)", prepare: async () => {
    const [c] = await owner<{ name: string }>(db, "select name from public.classes where id = $1", [m.classes[0].id]);
    return { session: staff(admin), args: [null, m.classes[0].departmentId, c.name, null, true],
      casts: ["uuid", "uuid", "text", "smallint", "boolean"] };
  } },
  { fn: "admin_update_report", code: "not_available", label: "unknown id", prepare: async () => ({
    session: staff(moderator), args: [missingId(), "triaged", null], casts: ["uuid", "public.report_status", "text"] }) },
  { fn: "admin_update_report", code: "invalid_state", label: "open to actioned", prepare: async () => ({
    session: staff(moderator), args: [await reportOf(await eligible(), await eligible(4)), "actioned", null],
    casts: ["uuid", "public.report_status", "text"] }) },
  // MOD-001 order 33
  { fn: "admin_hide_reported_content", code: "not_available", label: "unknown report", prepare: async () => ({
    session: staff(moderator), args: [missingId(), "message", null], casts: ["uuid", "text", "uuid"] }) },
  { fn: "admin_hide_reported_content", code: "invalid_state", label: "a photo that is already removed", prepare: async () => {
    const target = await createUser(db, { cls: m.classes[4], removedPhotos: 1 });
    const [removed] = await photoIds(target, "removed");
    return { session: staff(moderator), args: [await reportOf(await eligible(), target), "photo", removed], casts: ["uuid", "text", "uuid"] };
  } },
  { fn: "admin_unhide_reported_content", code: "not_available", label: "unknown report", prepare: async () => ({
    session: staff(moderator), args: [missingId(), "message"], casts: ["uuid", "text"] }) },
  { fn: "admin_unhide_reported_content", code: "invalid_state", label: "a message that is not hidden", prepare: async () => {
    const a = await eligible(), b = await eligible(4);
    const { conversation } = await connect(db, a, b);
    const [{ id }] = await owner<{ id: number }>(db, `insert into public.messages (conversation_id, sender_id, client_msg_id, body)
      values ($1, $2, $3, '架空') returning id::int`, [conversation, b, randomUUID()]);
    const report = (await rpc(db, user(a), "submit_report", [b, "message", "spam", null, null, id], REPORT)).ref!;
    return { session: staff(moderator), args: [report, "message"], casts: ["uuid", "text"] };
  } },
  { fn: "admin_grant_role", code: "not_available", label: "unknown user", prepare: async () => ({
    session: staff(admin), args: [missingId(), "reviewer"], casts: ["uuid", "public.staff_role"] }) },
  { fn: "admin_grant_role", code: "invalid_state", label: "already granted", prepare: async () => ({
    session: staff(admin), args: [reviewer, "reviewer"], casts: ["uuid", "public.staff_role"] }) },
  { fn: "admin_grant_role", code: "mfa_required", label: "target without a verified TOTP factor (SEC-003)", prepare: async () => {
    const target = await createStaff(db, [], { totp: false });
    await addTotpFactor(db, target, "unverified");
    return { session: staff(admin), args: [target, "reviewer"], casts: ["uuid", "public.staff_role"] };
  } },
  { fn: "admin_grant_role_by_email", code: "not_available", label: "unknown email, no write or audit", prepare: async () => ({
    session: staff(admin), args: ["unknown-role-target@example.invalid", "reviewer"], casts: ["text", "public.staff_role"] }) },
  { fn: "admin_revoke_role", code: "invalid_state", label: "no such active role", prepare: async () => ({
    session: staff(admin), args: [moderator, "reviewer"], casts: ["uuid", "public.staff_role"] }) },
  { fn: "admin_revoke_role", code: "invalid_state", label: "the last active admin", prepare: async () => ({
    session: staff(admin), args: [admin, "admin"], casts: ["uuid", "public.staff_role"] }) },
];

/** deny codes that only a concurrent transaction can reach; NT-19 (LS) covers them */
const CONCURRENCY_ONLY: Record<string, string> = {
  "request_account_deletion:invalid_state": "status re-check after the pair locks: only a concurrent deletion reaches it",
};

const eventCounts = async () => Object.fromEntries((await owner<{ action: string; n: number }>(db,
  "select action, count(*)::int as n from private.rate_limit_events group by action")).map((r) => [r.action, r.n]));

async function invoke(call: Call): Promise<Outcome> {
  const sql = `select * from public.${call.fn}(${call.args.map((_, i) => `$${i + 1}${call.casts?.[i] ? `::${call.casts[i]}` : ""}`).join(", ")})`;
  const rows = call.session === "service"
    ? await asRole<Outcome>(db, "service_role", null, sql, call.args)
    : await asUser<Outcome>(db, call.session, sql, call.args);
  return rows[0];
}

/** "fn:code" for every private.deny() in the state-changing RPCs, and the RPCs raising anything but forbidden/validation */
async function denyPaths(target: PGlite) {
  const fns = await owner<{ name: string; src: string }>(target, `
    select p.proname as name, p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prorettype = 'public.rpc_outcome'::regtype order by 1`);
  const declared = new Set<string>();
  const badRaises: string[] = [];
  for (const f of fns) {
    for (const [, code] of f.src.matchAll(/private\.deny\('([a-z_]+)'\)/g)) declared.add(`${f.name}:${code}`);
    const coded = [...f.src.matchAll(/raise exception using errcode = 'P0001', message = '([a-z_]+)'/g)].map((x) => x[1]);
    const all = f.src.match(/raise exception/g)?.length ?? 0;
    if (all !== coded.length || coded.some((r) => r !== "forbidden" && r !== "validation")) badRaises.push(f.name);
  }
  return { count: fns.length, declared, badRaises };
}

const uncovered = (declared: Set<string>) => {
  const covered = new Set(CASES.map((c) => `${c.fn}:${c.code}`));
  return [...declared].filter((k) => !covered.has(k) && !(k in CONCURRENCY_ONLY)).sort();
};

describe("NT-27 business rejections commit as rpc_outcome", () => {
  it("the cases cover every deny() code of every state-changing RPC; RPCs raise only forbidden/validation", async () => {
    const { count, declared, badRaises } = await denyPaths(db);
    expect(count).toBe(40);
    expect(badRaises).toEqual([]);
    expect(uncovered(declared)).toEqual([]);
    const covered = new Set(CASES.map((c) => `${c.fn}:${c.code}`));
    expect([...covered].filter((k) => !declared.has(k)).sort()).toEqual([]);   // no invented paths
    expect(Object.keys(CONCURRENCY_ONLY).filter((k) => !declared.has(k))).toEqual([]);
  });

  it("the coverage check is sensitive: a new deny path and a raised business code are reported", async () => {
    const drift = await freshDb();
    await drift.exec(`
      create or replace function public.mark_read(p_conversation uuid, p_message_id bigint) returns public.rpc_outcome
      language plpgsql security definer set search_path = '' as $$
      begin
        if p_message_id < 0 then
          raise exception using errcode = 'P0001', message = 'not_available';
        end if;
        return private.deny('rate_limited');
      end $$;`);
    const { declared, badRaises } = await denyPaths(drift);
    expect(uncovered(declared)).toEqual(["mark_read:rate_limited"]);
    expect(badRaises).toEqual(["mark_read"]);
    await drift.close();
  });

  for (const c of CASES) {
    it(`${c.fn}: ${c.code} (${c.label})`, async () => {
      const call: Call = { fn: c.fn, ...(await c.prepare()) };
      const exclude = ["private.rate_limit_events", ...(call.changes ?? [])];
      const before = await fingerprint(db, exclude);
      const events = await eventCounts();
      const outcome = await invoke(call);   // a raise fails the test: business rejections never raise
      expect(outcome).toEqual(deny(c.code));
      // from here on: separate owner transactions after the commit
      expect(await fingerprint(db, exclude)).toBe(before);
      const after = await eventCounts();
      const recorded = Object.keys(after).flatMap((a) => Array(after[a] - (events[a] ?? 0)).fill(a));
      expect(recorded).toEqual(call.attempt ? [call.attempt] : []);
      await call.check?.();
    });
  }

  it("every state-changing RPC with arguments raises validation on NULL arguments and changes no row", async () => {
    const own = await freshDb();
    const masters = await createMasters(own, "nt27v");
    const me = await createUser(own, { cls: masters.classes[0] });
    const everyRole = await createStaff(own, ["reviewer", "moderator", "admin"]);
    const fns = await owner<{ name: string; args: string[] }>(own, `
      select p.proname as name, array(select format_type(t, null) from unnest(p.proargtypes) with ordinality a(t, o) order by o) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prorettype = 'public.rpc_outcome'::regtype and p.pronargs > 0 order by 1`);
    expect(fns.length).toBe(34);
    const before = await fingerprint(own);
    for (const f of fns) {
      const sql = `select * from public.${f.name}(${f.args.map((t) => `null::${t}`).join(", ")})`;
      const run = f.name.startsWith("service_") ? () => asRole(own, "service_role", null, sql)
        : () => asUser(own, f.name.startsWith("admin_") ? staff(everyRole) : user(me), sql);
      expect(await raised(run), f.name).toBe("validation");
    }
    expect(await fingerprint(own)).toBe(before);
    await own.close();
  });
});
