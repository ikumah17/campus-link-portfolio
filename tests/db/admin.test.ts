// NT-17 management RPCs and NT-18 the append-only audit log (docs/04_DATABASE.md §3.9, §4 require_staff, §5.6,
// §7, §8; ARCH-R2-03, ARCH-R3-FINAL-02). PGlite is one connection: the concurrent orders of NT-19 stay LS gates;
// here the sequential refusal after a committed revocation and the isolation-level refusal are checked.
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { addTotpFactor, createMasters, createStaff, createUser, missingId, type Masters, type StaffRole } from "./fixtures";
import { asRole, asUser, deny, fingerprint, freshDb, owner, raised, rpc, rpcRows, staff, user } from "./harness";

let db: PGlite;
let m: Masters;
let reviewer: string;
let reviewer2: string;
let moderator: string;
let admin: string;

beforeAll(async () => {
  db = await freshDb();
  m = await createMasters(db, "admin");
  reviewer = await createStaff(db, ["reviewer"]);
  reviewer2 = await createStaff(db, ["reviewer"]);
  moderator = await createStaff(db, ["moderator"]);
  admin = await createStaff(db, ["admin"]);
});

const DECIDE = ["uuid", "boolean", "text", "timestamptz", "int"];
const inYear = () => new Date(Date.now() + 365 * 86400_000).toISOString();

/**
 * a student account that also holds a staff role (written under the exclusive staff lock, like the maintenance script),
 * granted after its verified TOTP factor (SEC-013 order 29)
 */
async function grantRole(db: PGlite, u: string, role: StaffRole) {
  await db.transaction(async (tx) => {
    await tx.query("select private.lock_staff_roles(true)");
    await tx.query("insert into auth.mfa_factors (id, user_id, factor_type, status) values (gen_random_uuid(), $1, 'totp', 'verified')", [u]);
    await tx.query("insert into private.staff_roles (user_id, role) values ($1, $2)", [u, role]);
  });
}

const lastAudit = async () => (await owner<{ id: number }>(db, "select coalesce(max(id), 0)::int as id from private.audit_log"))[0].id;
const auditSince = (id: number) => owner<{ action: string; actor: string; target: string | null }>(db,
  "select action, actor_id::text as actor, target_id as target from private.audit_log where id > $1 order by id", [id]);

/** runs one management call and checks that it wrote exactly the given audit rows (none for a rejection) */
async function audited<T>(expected: { action: string; actor: string }[], run: () => Promise<T>): Promise<T> {
  const from = await lastAudit();
  const result = await run();
  expect((await auditSince(from)).map(({ action, actor }) => ({ action, actor }))).toEqual(expected);
  return result;
}

const pendingSubmission = async (u: string) => (await owner<{ id: string }>(db,
  "select id::text from public.verification_submissions where user_id = $1 and kind = 'enrollment' and status = 'submitted'",
  [u]))[0].id;
const submission = async (id: string) => (await owner<{ status: string; version: number; reviewer_id: string | null; claimed: boolean;
  decided: boolean; decision_reason: string | null }>(db, `
  select status::text, version, reviewer_id::text, claimed_at is not null as claimed, decided_at is not null as decided, decision_reason
  from public.verification_submissions where id = $1`, [id]))[0];
const claim = (id: string, who = reviewer) => rpc(db, staff(who), "admin_claim_submission", [id]);
const decide = (id: string, version: number, who = reviewer, approve = true) =>
  rpc(db, staff(who), "admin_decide_submission", [id, approve, approve ? null : "document_unclear", inYear(), version], DECIDE);

describe("NT-17 role checks", () => {
  it("no role, aal1, and the wrong role kind are forbidden before any write; admin implies no other role", async () => {
    const student = await createUser(db, { cls: m.classes[0], affiliation: "pending" });
    const sub = await pendingSubmission(student);
    const calls: [string, () => Promise<unknown>][] = [
      ["student with aal2", () => rpcRows(db, staff(student), "admin_list_submissions", [null], ["public.verification_status"])],
      ["reviewer with aal1", () => rpc(db, user(reviewer), "admin_claim_submission", [sub])],
      ["reviewer on reports", () => rpcRows(db, staff(reviewer), "admin_list_reports", [null], ["public.report_status"])],
      ["reviewer on accounts", () => rpc(db, staff(reviewer), "admin_set_account_status", [student, "suspended", null],
        ["uuid", "public.account_status", "text"])],
      ["moderator on review", () => claim(sub, moderator)],
      ["moderator on roles", () => rpc(db, staff(moderator), "admin_grant_role", [student, "reviewer"], ["uuid", "public.staff_role"])],
      ["admin on review", () => claim(sub, admin)],
      ["admin on reports", () => rpcRows(db, staff(admin), "admin_list_reports", [null], ["public.report_status"])],
    ];
    const before = await fingerprint(db);
    for (const [label, run] of calls) expect(await raised(run), label).toBe("forbidden");
    expect(await fingerprint(db)).toBe(before);
  });
});

describe("NT-17 review operations", () => {
  it("one audit row per successful operation; other reviewers, stale versions, unknown ids and own submissions are rejected", async () => {
    const student = await createUser(db, { cls: m.classes[0], affiliation: "pending", birthDate: "2001-02-03" });
    const sub = await pendingSubmission(student);
    const listed = await audited([{ action: "list_submissions", actor: reviewer }],
      () => rpcRows<Record<string, unknown>>(db, staff(reviewer), "admin_list_submissions", ["submitted"], ["public.verification_status"]));
    expect(listed.map((r) => r.id)).toContain(sub);
    expect(Object.keys(listed[0])).not.toContain("birth_date");

    expect(await audited([{ action: "claim_submission", actor: reviewer }], () => claim(sub))).toEqual({ ok: true, code: "ok", ref: sub });
    expect(await audited([], () => claim(sub, reviewer2))).toEqual(deny("invalid_state"));
    expect(await audited([], () => decide(sub, 1, reviewer2))).toEqual(deny("invalid_state"));
    expect(await audited([], () => decide(sub, 0))).toEqual(deny("invalid_state"));
    expect(await audited([], () => rpc(db, staff(reviewer2), "admin_release_submission", [sub]))).toEqual(deny("invalid_state"));
    expect(await audited([], () => rpcRows(db, staff(reviewer2), "admin_get_submission", [sub]))).toEqual([]);
    expect(await audited([], () => rpcRows(db, staff(reviewer2), "admin_authorize_document_view", [sub]))).toEqual([]);
    expect(await audited([], () => claim(missingId()))).toEqual(deny("not_available"));

    const [detail] = await audited([{ action: "view_submission", actor: reviewer }],
      () => rpcRows<{ birth_date: Date; class_name: string; version: number; document_refs: string[] }>(db, staff(reviewer),
        "admin_get_submission", [sub]));
    expect(detail.birth_date.toISOString().slice(0, 10)).toBe("2001-02-03");
    expect(detail).toMatchObject({ version: 1, document_refs: ["synthetic:sample-1"] });
    expect(detail.class_name).toMatch(/試験クラス/);
    const refs = await audited([{ action: "authorize_document_view", actor: reviewer }],
      () => rpcRows<{ n: number; document_ref: string }>(db, staff(reviewer), "admin_authorize_document_view", [sub]));
    expect(refs).toEqual([{ n: 1, document_ref: "synthetic:sample-1" }]);

    expect(await audited([{ action: "approve_submission", actor: reviewer }], () => decide(sub, 1))).toMatchObject({ ok: true });
    expect(await submission(sub)).toMatchObject({ status: "approved", version: 2, reviewer_id: reviewer });
    const [{ eligible }] = await owner<{ eligible: boolean }>(db, "select private.is_eligible($1) as eligible", [student]);
    expect(eligible).toBe(true);

    // a student who is also a reviewer cannot claim their own submission
    const insider = await createUser(db, { cls: m.classes[4], affiliation: "pending" });
    await grantRole(db, insider, "reviewer");
    const own = await pendingSubmission(insider);
    expect(await audited([], () => claim(own, insider))).toEqual(deny("invalid_state"));
    expect((await submission(own)).status).toBe("submitted");
  });

  it("revocation of an approved verification records the revoker, time and reason; revoking again is invalid_state", async () => {
    const student = await createUser(db, { cls: m.classes[0] });
    const casts = ["uuid", "text"];
    for (const kind of ["enrollment", "age"] as const) {
      const [{ id }] = await owner<{ id: string }>(db,
        "select id::text from public.verification_submissions where user_id = $1 and kind = $2", [student, kind]);
      const outcome = await audited([{ action: "revoke_verification", actor: reviewer }],
        () => rpc(db, staff(reviewer), "admin_revoke_verification", [id, `revoked_${kind}`], casts));
      expect(outcome.ok).toBe(true);
      expect(outcome.ref).toBe(id);
      expect(await submission(outcome.ref!)).toMatchObject({ status: "revoked", reviewer_id: reviewer, decided: true,
        decision_reason: `revoked_${kind}` });
      expect(await audited([], () => rpc(db, staff(reviewer), "admin_revoke_verification", [id, "again"], casts)))
        .toEqual(deny("invalid_state"));
    }
    const [state] = await owner<{ aff: string; age_revoked: boolean; eligible: boolean }>(db, `
      select a.status::text as aff, v.age_revoked_at is not null as age_revoked, private.is_eligible($1) as eligible
      from public.affiliations a join public.account_verifications v on v.user_id = a.user_id where a.user_id = $1`, [student]);
    expect(state).toEqual({ aff: "rejected", age_revoked: true, eligible: false });
  });

  it.each(["enrollment", "age"] as const)("an older approved %s submission cannot revoke the newer confirmation", async (kind) => {
    const student = await createUser(db, { cls: m.classes[0] });
    const [{ id: current, version }] = await owner<{ id: string; version: number }>(db,
      "select id::text, version from public.verification_submissions where user_id = $1 and kind = $2", [student, kind]);
    // Owner preparation: two historical approvals, with only B referenced by the current confirmation.
    const [{ id: old }] = await owner<{ id: string }>(db, `
      insert into public.verification_submissions
        (user_id, kind, status, intake_mode, document_refs, affiliation_snapshot, reviewer_id, decided_at, valid_until, created_at)
      select user_id, kind, status, intake_mode, document_refs, affiliation_snapshot, reviewer_id,
             decided_at - interval '1 year', valid_until, created_at - interval '1 year'
      from public.verification_submissions where id = $1 returning id::text`, [current]);
    const currentConfirmation = () => kind === "age"
      ? owner(db, `select age_submission_id::text as id, age_verified_at is not null as verified,
                          age_revoked_at is not null as revoked from public.account_verifications where user_id = $1`, [student])
      : owner(db, `select confirmed_by_submission::text as id, status::text,
                          confirmed_until is null as cleared from public.affiliations where user_id = $1`, [student]);
    expect(await currentConfirmation()).toEqual(kind === "age"
      ? [{ id: current, verified: true, revoked: false }]
      : [{ id: current, status: "confirmed", cleared: false }]);
    const before = await fingerprint(db);
    expect(await audited([], () => rpc(db, staff(reviewer), "admin_revoke_verification", [old, "document_invalid"], ["uuid", "text"])))
      .toEqual(deny("invalid_state"));
    expect(await fingerprint(db)).toBe(before); // includes both approvals, confirmation, and the entire audit log
    expect((await submission(old)).status).toBe("approved");
    expect((await submission(current)).status).toBe("approved");

    const from = await lastAudit();
    expect(await rpc(db, staff(reviewer), "admin_revoke_verification", [current, "document_invalid"], ["uuid", "text"]))
      .toEqual({ ok: true, code: "ok", ref: current });
    expect(await auditSince(from)).toEqual([{ action: "revoke_verification", actor: reviewer, target: current }]);
    expect(await owner(db, "select target_type, detail from private.audit_log where id > $1", [from]))
      .toEqual([{ target_type: "verification_submission", detail: { kind } }]);
    expect(await submission(current)).toMatchObject({ status: "revoked", version: version + 1, reviewer_id: reviewer,
      decided: true, decision_reason: "document_invalid" });
    expect((await submission(old)).status).toBe("approved");
    expect(await currentConfirmation()).toEqual(kind === "age"
      ? [{ id: current, verified: true, revoked: true }]
      : [{ id: null, status: "rejected", cleared: true }]);
  });

  it("unknown submissions and invalid reasons cause no write, and non-reviewers are forbidden first", async () => {
    const unknown = missingId();
    const before = await fingerprint(db);
    expect(await rpc(db, staff(reviewer), "admin_revoke_verification", [unknown, "document_invalid"], ["uuid", "text"]))
      .toEqual(deny("invalid_state"));
    for (const [id, reason] of [[null, "document_invalid"], [unknown, null], [unknown, ""], [unknown, "INVALID"], [unknown, "x".repeat(65)]]) {
      expect(await raised(() => rpc(db, staff(reviewer), "admin_revoke_verification", [id, reason], ["uuid", "text"]))).toBe("validation");
    }
    for (const who of [moderator, admin]) {
      for (const args of [[unknown, "document_invalid"], [null, null]]) {
        expect(await raised(() => rpc(db, staff(who), "admin_revoke_verification", args, ["uuid", "text"]))).toBe("forbidden");
      }
    }
    expect(await fingerprint(db)).toBe(before);
  });

  it.each(["enrollment", "age"] as const)("submitted and rejected %s submissions cannot be revoked", async (kind) => {
    const student = await createUser(db, { cls: m.classes[0], affiliation: "unconfirmed", ageVerified: false });
    const result = await rpc(db, user(student), "submit_verification", [kind, ["synthetic:sample-1"]], ["public.verification_kind", "text[]"]);
    expect(result.ok).toBe(true);
    const id = result.ref!;
    for (const status of ["submitted", "rejected"]) {
      if (status === "rejected") {
        expect((await claim(id)).ok).toBe(true);
        expect((await decide(id, 1, reviewer, false)).ok).toBe(true);
      }
      const before = await fingerprint(db);
      expect(await rpc(db, staff(reviewer), "admin_revoke_verification", [id, "document_invalid"], ["uuid", "text"]))
        .toEqual(deny("invalid_state"));
      expect(await fingerprint(db)).toBe(before);
      expect((await submission(id)).status).toBe(status);
    }
  });
});

describe("NT-17 reports, accounts, masters and roles", () => {
  const report = (from: string, target: string) => rpc(db, user(from), "submit_report",
    [target, "profile", "spam", "架空の詳細", null, null],
    ["uuid", "public.report_context", "public.report_reason", "text", "uuid", "bigint"]);
  const update = (who: string, id: string, status: string) =>
    rpc(db, staff(who), "admin_update_report", [id, status, "架空のメモ"], ["uuid", "public.report_status", "text"]);

  it("moderators handle reports by the transition table and never one they are a party of", async () => {
    const x = await createUser(db, { cls: m.classes[0] });
    const y = await createUser(db, { cls: m.classes[4] });
    const filed = (await report(x, y)).ref!;
    const other = (await report(y, x)).ref!;
    const list = await audited([{ action: "list_reports", actor: moderator }],
      () => rpcRows<{ id: string }>(db, staff(moderator), "admin_list_reports", ["open"], ["public.report_status"]));
    expect(list.map((r) => r.id)).toEqual(expect.arrayContaining([filed, other]));
    const [got] = await audited([{ action: "view_report", actor: moderator }],
      () => rpcRows<{ detail: string; evidence_message_body: string | null }>(db, staff(moderator), "admin_get_report", [filed]));
    expect(got).toMatchObject({ detail: "架空の詳細", evidence_message_body: null });
    expect(await audited([{ action: "update_report", actor: moderator }], () => update(moderator, filed, "triaged"))).toMatchObject({ ok: true });
    expect(await audited([], () => update(moderator, filed, "open"))).toEqual(deny("invalid_state"));
    expect(await audited([], () => update(moderator, other, "actioned"))).toEqual(deny("invalid_state"));
    expect(await audited([], () => update(moderator, missingId(), "triaged"))).toEqual(deny("not_available"));
    expect(await audited([{ action: "update_report", actor: moderator }], () => update(moderator, filed, "actioned"))).toMatchObject({ ok: true });
    const [{ actions }] = await owner<{ actions: string[] }>(db,
      "select array_agg(action order by id) as actions from private.report_actions where report_id = $1", [filed]);
    expect(actions).toEqual(["triaged", "actioned"]);

    // a student moderator: their own reports (either side) are invisible and untouchable to them
    const party = await createUser(db, { cls: m.classes[5] });
    await grantRole(db, party, "moderator");
    const mine = (await report(party, y)).ref!;
    const aboutMe = (await report(y, party)).ref!;
    const seen = await rpcRows<{ id: string }>(db, staff(party), "admin_list_reports", [null], ["public.report_status"]);
    expect(seen.map((r) => r.id)).toContain(filed);
    expect(seen.map((r) => r.id)).not.toContain(mine);
    expect(seen.map((r) => r.id)).not.toContain(aboutMe);
    for (const id of [mine, aboutMe]) {
      expect(await audited([], () => rpcRows(db, staff(party), "admin_get_report", [id]))).toEqual([]);
      expect(await audited([], () => update(party, id, "triaged"))).toEqual(deny("invalid_state"));
    }
  });

  it("account status: suspended <-> active only, with one audit row each", async () => {
    const casts = ["uuid", "public.account_status", "text"];
    const set = (u: string, status: string) => rpc(db, staff(admin), "admin_set_account_status", [u, status, "policy_violation"], casts);
    const target = await createUser(db, { cls: m.classes[0] });
    expect(await audited([{ action: "set_account_status", actor: admin }], () => set(target, "suspended"))).toMatchObject({ ok: true });
    expect(await audited([], () => set(target, "suspended"))).toEqual(deny("invalid_state"));
    expect(await audited([{ action: "set_account_status", actor: admin }], () => set(target, "active"))).toMatchObject({ ok: true });
    expect(await audited([], () => set(target, "active"))).toEqual(deny("invalid_state"));
    const gone = await createUser(db, { cls: m.classes[0], status: "deleted" });
    expect(await audited([], () => set(gone, "suspended"))).toEqual(deny("invalid_state"));
    expect(await audited([], () => set(missingId(), "suspended"))).toEqual(deny("not_available"));
    expect(await raised(() => set(target, "deactivated"))).toBe("validation");
  });

  it("masters: create, rename, no duplicates, no moves", async () => {
    const school = (id: string | null, name: string) =>
      rpc(db, staff(admin), "admin_upsert_school", [id, name, true, 0], ["uuid", "text", "boolean", "int"]);
    const created = await audited([{ action: "upsert_school", actor: admin }], () => school(null, "管理試験校（架空）"));
    expect(created.ok).toBe(true);
    expect(await audited([], () => school(null, "管理試験校（架空）"))).toEqual(deny("invalid_state"));
    expect(await audited([], () => school(missingId(), "別名（架空）"))).toEqual(deny("not_available"));
    expect((await school(created.ref, "管理試験校改（架空）")).ok).toBe(true);
    const dept = await rpc(db, staff(admin), "admin_upsert_department", [null, created.ref, "管理学科（架空）", true, 0],
      ["uuid", "uuid", "text", "boolean", "int"]);
    expect(dept.ok).toBe(true);
    expect(await rpc(db, staff(admin), "admin_upsert_department", [dept.ref, m.schools[0], "管理学科（架空）", true, 0],
      ["uuid", "uuid", "text", "boolean", "int"])).toEqual(deny("invalid_state"));
    const cls = (id: string | null, department: string) => rpc(db, staff(admin), "admin_upsert_class",
      [id, department, "管理クラス（架空）", null, true], ["uuid", "uuid", "text", "smallint", "boolean"]);
    const c1 = await cls(null, dept.ref!);
    expect(c1.ok).toBe(true);
    expect(await cls(null, dept.ref!)).toEqual(deny("invalid_state"));   // same (department, name, NULL year)
    expect(await cls(c1.ref, m.departments[0].id)).toEqual(deny("invalid_state"));
    const [{ n }] = await owner<{ n: number }>(db, "select count(*)::int as n from public.classes where department_id = $1", [dept.ref]);
    expect(n).toBe(1);
  });

  it("roles: unknown users, duplicates and missing roles are rejected; grants and revocations are audited", async () => {
    const casts = ["uuid", "public.staff_role"];
    const grant = (u: string, role: string) => rpc(db, staff(admin), "admin_grant_role", [u, role], casts);
    const revoke = (u: string, role: string) => rpc(db, staff(admin), "admin_revoke_role", [u, role], casts);
    const someone = await createStaff(db, []);
    await addTotpFactor(db, someone);
    expect(await audited([], () => grant(missingId(), "moderator"))).toEqual(deny("not_available"));
    expect(await audited([{ action: "grant_role", actor: admin }], () => grant(someone, "moderator"))).toMatchObject({ ok: true });
    expect(await audited([], () => grant(someone, "moderator"))).toEqual(deny("invalid_state"));
    expect(await raised(() => rpcRows(db, staff(someone), "admin_list_reports", [null], ["public.report_status"]))).toBe("");
    expect(await audited([{ action: "revoke_role", actor: admin }], () => revoke(someone, "moderator"))).toMatchObject({ ok: true });
    expect(await audited([], () => revoke(someone, "moderator"))).toEqual(deny("invalid_state"));
    expect(await raised(() => rpcRows(db, staff(someone), "admin_list_reports", [null], ["public.report_status"]))).toBe("forbidden");
  });
});

describe("NT-17 reviewer revocation (r3 ARCH-R2-03, r4 ARCH-R3-FINAL-02)", () => {
  it("in-review submissions return to 'submitted'; after the commit every operation of the former reviewer is forbidden", async () => {
    const former = await createStaff(db, ["reviewer"]);
    const u1 = await createUser(db, { cls: m.classes[0], affiliation: "pending" });
    const u2 = await createUser(db, { cls: m.classes[4], affiliation: "pending" });
    const u3 = await createUser(db, { cls: m.classes[5], affiliation: "pending" });
    const [s1, s2, s3] = [await pendingSubmission(u1), await pendingSubmission(u2), await pendingSubmission(u3)];
    expect((await claim(s1, former)).ok).toBe(true);
    expect((await claim(s2, former)).ok).toBe(true);

    const from = await lastAudit();
    expect(await rpc(db, staff(admin), "admin_revoke_role", [former, "reviewer"], ["uuid", "public.staff_role"]))
      .toEqual({ ok: true, code: "ok", ref: former });
    const written = await auditSince(from);
    expect(written.map((r) => r.action).sort()).toEqual(
      ["release_submission_on_role_revocation", "release_submission_on_role_revocation", "revoke_role"]);
    expect(new Set(written.filter((r) => r.action !== "revoke_role").map((r) => r.target))).toEqual(new Set([s1, s2]));
    for (const s of [s1, s2]) {
      expect(await submission(s)).toMatchObject({ status: "submitted", version: 2, reviewer_id: null, claimed: false });
    }

    // r4: each attempt in its own transaction after the revocation committed
    const before = await fingerprint(db);
    const attempts: [string, () => Promise<unknown>][] = [
      ["claim an untouched submission", () => claim(s3, former)],
      ["claim a released submission", () => claim(s1, former)],
      ["release", () => rpc(db, staff(former), "admin_release_submission", [s1])],
      ["decide", () => decide(s1, 2, former)],
      ["get_submission", () => rpcRows(db, staff(former), "admin_get_submission", [s1])],
      ["authorize_document_view", () => rpcRows(db, staff(former), "admin_authorize_document_view", [s1])],
      ["list_submissions", () => rpcRows(db, staff(former), "admin_list_submissions", [null], ["public.verification_status"])],
      ["revoke_verification", () => rpc(db, staff(former), "admin_revoke_verification", [s1, "x"],
        ["uuid", "text"])],
    ];
    for (const [label, run] of attempts) expect(await raised(run), label).toBe("forbidden");
    expect(await fingerprint(db)).toBe(before);   // states, versions, claims and the audit log are unchanged
    const [{ held }] = await owner<{ held: number }>(db,
      "select count(*)::int as held from public.verification_submissions where status = 'in_review' and reviewer_id = $1", [former]);
    expect(held).toBe(0);
    expect((await claim(s1, reviewer2)).ok).toBe(true);   // another reviewer can take it
  });

  it("outside READ COMMITTED the role-dependent RPCs are forbidden before any write", async () => {
    const u = await createUser(db, { cls: m.classes[0], affiliation: "pending" });
    const sub = await pendingSubmission(u);
    const victim = await createStaff(db, ["reviewer"]);
    const before = await fingerprint(db);
    for (const isolation of ["repeatable read", "serializable"] as const) {
      expect(await raised(() => asUser(db, staff(reviewer), "select * from public.admin_claim_submission($1)", [sub], { isolation })),
        isolation).toBe("forbidden");
      expect(await raised(() => asUser(db, staff(admin), "select * from public.admin_revoke_role($1, 'reviewer')", [victim],
        { isolation })), isolation).toBe("forbidden");
      expect(await raised(() => asUser(db, staff(reviewer), "select * from public.admin_list_submissions(null)", [], { isolation })),
        isolation).toBe("forbidden");
    }
    expect(await fingerprint(db)).toBe(before);
    expect((await claim(sub)).ok).toBe(true);   // control: READ COMMITTED
  });

  it("the last active admin cannot be revoked; a revoked admin cannot revoke", async () => {
    const own = await freshDb();
    const first = await createStaff(own, ["admin"]);
    const second = await createStaff(own, []);
    await addTotpFactor(own, second);
    const casts = ["uuid", "public.staff_role"];
    const call = (who: string, fn: string, target: string) => rpc(own, staff(who), fn, [target, "admin"], casts);
    expect(await call(first, "admin_revoke_role", first)).toEqual(deny("invalid_state"));
    expect((await call(first, "admin_grant_role", second)).ok).toBe(true);
    expect((await call(second, "admin_revoke_role", first)).ok).toBe(true);
    expect(await raised(() => call(first, "admin_revoke_role", second))).toBe("forbidden");
    expect(await call(second, "admin_revoke_role", second)).toEqual(deny("invalid_state"));
    const [{ admins }] = await owner<{ admins: number }>(own,
      "select count(*)::int as admins from private.staff_roles where role = 'admin' and revoked_at is null");
    expect(admins).toBe(1);
    await own.close();
  });
});

describe("NT-18 the audit log is append-only", () => {
  it("UPDATE, DELETE and TRUNCATE are rejected on every path, the owner included", async () => {
    const [{ rows }] = await owner<{ rows: number }>(db, "select count(*)::int as rows from private.audit_log");
    expect(rows).toBeGreaterThan(0);
    for (const sql of ["update private.audit_log set action = 'rewritten'", "delete from private.audit_log",
      "truncate private.audit_log", "truncate private.audit_log restart identity cascade"]) {
      expect(await raised(() => owner(db, sql)), `owner: ${sql}`).toBe("audit_log is append-only");
      for (const role of ["authenticated", "service_role"] as const) {
        expect(await raised(() => asRole(db, role, role === "authenticated" ? staff(admin) : null, sql)), `${role}: ${sql}`)
          .toMatch(/permission denied/);
      }
    }
    expect(await raised(() => asUser(db, staff(admin), "select * from private.audit_log"))).toMatch(/permission denied/);
    const [{ after }] = await owner<{ after: number }>(db, "select count(*)::int as after from private.audit_log");
    expect(after).toBe(rows);
  });
});
