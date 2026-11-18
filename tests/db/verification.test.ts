// NT-09 (docs/04_DATABASE.md §3.5, §5.2, §5.6, §7, §8; ARCH-R2-03): affiliation expiry, affiliation change
// from both 'submitted' and 'in_review', stale decisions, resubmission, the withdraw range and renewals.
// Each RPC commits on its own; the persistent state is read from a separate owner transaction.
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { createMasters, createStaff, createUser, type ClassRef, type Masters } from "./fixtures";
import { deny, fingerprint, freshDb, owner, raised, rpc, rpcRows, staff, user } from "./harness";

let db: PGlite;
let m: Masters;
let reviewer: string;

beforeAll(async () => {
  db = await freshDb();
  m = await createMasters(db, "verif");
  reviewer = await createStaff(db, ["reviewer"]);
});

const DECIDE = ["uuid", "boolean", "text", "timestamptz", "int"];
const SUBMIT = ["public.verification_kind", "text[]"];
const days = (n: number) => new Date(Date.now() + n * 86400_000).toISOString();

interface Submission {
  id: string;
  kind: string;
  status: string;
  version: number;
  reviewer_id: string | null;
  claimed: boolean;
  decided: boolean;
  decision_reason: string | null;
  snapshot_class: string | null;
}

const submissions = (u: string, kind?: string) => owner<Submission>(db, `
  select id::text, kind::text, status::text, version, reviewer_id::text, claimed_at is not null as claimed,
         decided_at is not null as decided, decision_reason, affiliation_snapshot ->> 'class_id' as snapshot_class
  from public.verification_submissions where user_id = $1 and ($2::text is null or kind::text = $2)
  order by created_at, id`, [u, kind ?? null]);
const openEnrollment = async (u: string) =>
  (await submissions(u, "enrollment")).find((s) => s.status === "submitted" || s.status === "in_review")!;
const affiliation = async (u: string) => (await owner<{ class_id: string; status: string; until: string | null; by: string | null }>(db,
  "select class_id::text, status::text, confirmed_until::text as until, confirmed_by_submission::text as by from public.affiliations where user_id = $1",
  [u]))[0];
const eligible = async (u: string) =>
  (await owner<{ e: boolean }>(db, "select private.is_eligible($1) as e", [u]))[0].e;
const audits = (target: string) => owner<{ action: string; actor: string; previous: string | null }>(db, `
  select action, actor_id::text as actor, detail ->> 'previous_reviewer' as previous
  from private.audit_log where target_id = $1 order by id`, [target]);

const setAffiliation = (u: string, cls: ClassRef) => rpc(db, user(u), "set_affiliation", [cls.schoolId, cls.departmentId, cls.id]);
const submitEnrollment = (u: string) => rpc(db, user(u), "submit_verification", ["enrollment", ["synthetic:sample-1"]], SUBMIT);
const claim = (id: string, who = reviewer) => rpc(db, staff(who), "admin_claim_submission", [id]);
const decide = (id: string, approve: boolean, version: number, until: string | null = days(365), who = reviewer) =>
  rpc(db, staff(who), "admin_decide_submission", [id, approve, approve ? null : "document_unclear", until, version], DECIDE);

describe("NT-09 affiliation expiry", () => {
  it("a past confirmed_until removes eligibility at once, with no scheduled job", async () => {
    const me = await createUser(db, { cls: m.classes[0] });
    const peer = await createUser(db, { cls: m.classes[4] });
    expect(await rpcRows(db, user(peer), "get_profile", [me])).toHaveLength(1);
    await owner(db, "update public.affiliations set confirmed_until = now() - interval '1 second' where user_id = $1", [me]);
    expect(await eligible(me)).toBe(false);
    expect(await rpcRows(db, user(peer), "get_profile", [me])).toEqual([]);
    const [account] = await rpcRows<{ affiliation_status: string; affiliation_confirmed: boolean; eligible: boolean }>(db,
      user(me), "my_account");
    expect(account).toMatchObject({ affiliation_status: "confirmed", affiliation_confirmed: false, eligible: false });
  });
});

describe("NT-09 affiliation change supersedes open enrollment submissions", () => {
  it("from 'submitted': new unconfirmed affiliation, superseded submission, age untouched, one audit row, resubmission works", async () => {
    const me = await createUser(db, { cls: m.classes[0], affiliation: "pending", ageVerified: false });
    expect((await rpc(db, user(me), "submit_verification", ["age", ["synthetic:sample-2"]], SUBMIT)).ok).toBe(true);
    const [ageBefore] = await submissions(me, "age");
    const old = await openEnrollment(me);
    expect(old).toMatchObject({ status: "submitted", version: 0 });

    expect(await setAffiliation(me, m.classes[3])).toEqual({ ok: true, code: "ok", ref: null });
    expect(await affiliation(me)).toEqual({ class_id: m.classes[3].id, status: "unconfirmed", until: null, by: null });
    const [superseded] = (await submissions(me, "enrollment")).filter((s) => s.id === old.id);
    expect(superseded).toMatchObject({ status: "superseded", version: 1, reviewer_id: null, claimed: false, decided: true,
      decision_reason: "affiliation_changed", snapshot_class: m.classes[0].id });
    expect((await submissions(me, "age"))[0]).toEqual(ageBefore);
    expect(await audits(old.id)).toEqual([{ action: "verification_superseded", actor: me, previous: null }]);

    const again = await submitEnrollment(me);
    expect(again.ok).toBe(true);
    const fresh = await openEnrollment(me);
    expect(fresh).toMatchObject({ id: again.ref, status: "submitted", snapshot_class: m.classes[3].id });
    expect((await affiliation(me)).status).toBe("pending");
  });

  it("from 'in_review': the claim is cleared, the stale decision is invalid_state, the affiliation stays unconfirmed", async () => {
    const me = await createUser(db, { cls: m.classes[0], affiliation: "pending" });
    const old = await openEnrollment(me);
    expect((await claim(old.id)).ok).toBe(true);
    expect((await submissions(me, "enrollment"))[0]).toMatchObject({ status: "in_review", version: 1, reviewer_id: reviewer });

    expect((await setAffiliation(me, m.classes[2])).ok).toBe(true);
    const [after] = await submissions(me, "enrollment");
    expect(after).toMatchObject({ id: old.id, status: "superseded", version: 2, reviewer_id: null, claimed: false,
      decision_reason: "affiliation_changed" });
    expect(await audits(old.id)).toEqual([
      { action: "claim_submission", actor: reviewer, previous: null },
      { action: "verification_superseded", actor: me, previous: reviewer },
    ]);

    const before = await fingerprint(db);
    expect(await decide(old.id, true, 1)).toEqual(deny("invalid_state"));   // the version the reviewer saw
    expect(await decide(old.id, true, 2)).toEqual(deny("invalid_state"));   // even the current version
    expect(await decide(old.id, false, 2)).toEqual(deny("invalid_state"));
    expect(await rpcRows(db, staff(reviewer), "admin_get_submission", [old.id])).toEqual([]);
    expect(await fingerprint(db)).toBe(before);   // no decision, no audit row, no state change
    expect(await affiliation(me)).toMatchObject({ class_id: m.classes[2].id, status: "unconfirmed" });
    expect(await eligible(me)).toBe(false);

    expect((await submitEnrollment(me)).ok).toBe(true);   // not blocked by the open-submission unique index
  });

  it("from 'confirmed': the user becomes unconfirmed and ineligible; the approved submission stays as history", async () => {
    const me = await createUser(db, { cls: m.classes[0] });
    const [approved] = await submissions(me, "enrollment");
    expect(await eligible(me)).toBe(true);
    expect((await setAffiliation(me, m.classes[1])).ok).toBe(true);
    expect(await affiliation(me)).toEqual({ class_id: m.classes[1].id, status: "unconfirmed", until: null, by: null });
    expect(await eligible(me)).toBe(false);
    expect((await submissions(me, "enrollment"))[0]).toEqual(approved);
  });

  it("the same affiliation changes nothing; mismatched or inactive masters are validation and write nothing", async () => {
    const me = await createUser(db, { cls: m.classes[0], affiliation: "pending" });
    const before = await fingerprint(db);
    expect(await setAffiliation(me, m.classes[0])).toEqual({ ok: true, code: "ok", ref: null });
    expect(await fingerprint(db)).toBe(before);
    const wrong = { ...m.classes[1], departmentId: m.classes[2].departmentId };
    expect(await raised(() => setAffiliation(me, wrong))).toBe("validation");
    await owner(db, "update public.classes set is_active = false where id = $1", [m.classes[7].id]);
    try {
      expect(await raised(() => setAffiliation(me, m.classes[7]))).toBe("validation");
    } finally {
      await owner(db, "update public.classes set is_active = true where id = $1", [m.classes[7].id]);
    }
    expect(await fingerprint(db)).toBe(before);
  });
});

describe("NT-09 withdraw range and renewals", () => {
  it("an in_review submission cannot be withdrawn; after release it can, and the affiliation returns to unconfirmed", async () => {
    const me = await createUser(db, { cls: m.classes[0], affiliation: "pending" });
    const sub = await openEnrollment(me);
    expect((await claim(sub.id)).ok).toBe(true);
    const before = await fingerprint(db);
    expect(await rpc(db, user(me), "withdraw_verification", [sub.id])).toEqual(deny("invalid_state"));
    expect(await fingerprint(db)).toBe(before);
    expect((await rpc(db, staff(reviewer), "admin_release_submission", [sub.id])).ok).toBe(true);
    expect((await rpc(db, user(me), "withdraw_verification", [sub.id])).ok).toBe(true);
    expect((await submissions(me, "enrollment"))[0]).toMatchObject({ status: "withdrawn", version: 3, reviewer_id: null });
    expect((await affiliation(me)).status).toBe("unconfirmed");
    const other = await createUser(db, { cls: m.classes[4], affiliation: "pending" });
    expect(await rpc(db, user(me), "withdraw_verification", [(await openEnrollment(other)).id])).toEqual(deny("not_available"));
  });

  it("a renewal inside the validity keeps eligibility while open and after rejection; approval extends the term", async () => {
    const me = await createUser(db, { cls: m.classes[0] });
    const first = await affiliation(me);
    const renewal = await submitEnrollment(me);
    expect(renewal.ok).toBe(true);
    expect(await affiliation(me)).toEqual(first);
    expect(await eligible(me)).toBe(true);
    expect((await claim(renewal.ref!)).ok).toBe(true);
    expect((await decide(renewal.ref!, false, 1)).ok).toBe(true);
    expect(await affiliation(me)).toEqual(first);
    expect(await eligible(me)).toBe(true);

    const second = await submitEnrollment(me);
    expect((await claim(second.ref!)).ok).toBe(true);
    expect(await decide(second.ref!, true, 1, days(-1))).toEqual(deny("invalid_state"));   // valid_until in the past
    expect((await submissions(me, "enrollment")).find((s) => s.id === second.ref)?.status).toBe("in_review");
    const until = days(730);
    expect((await decide(second.ref!, true, 1, until)).ok).toBe(true);
    expect(await affiliation(me)).toMatchObject({ status: "confirmed", by: second.ref });
    const [{ same }] = await owner<{ same: boolean }>(db,
      "select confirmed_until = $2::timestamptz as same from public.affiliations where user_id = $1", [me, until]);
    expect(same).toBe(true);
  });

  it("after expiry a submission makes the affiliation pending (ineligible) until it is approved", async () => {
    const me = await createUser(db, { cls: m.classes[0], affiliation: "expired" });
    expect(await eligible(me)).toBe(false);
    const sub = await submitEnrollment(me);
    expect(sub.ok).toBe(true);
    expect(await affiliation(me)).toMatchObject({ status: "pending", until: null, by: null });
    expect(await eligible(me)).toBe(false);
    expect((await claim(sub.ref!)).ok).toBe(true);
    expect((await decide(sub.ref!, true, 1)).ok).toBe(true);
    expect(await affiliation(me)).toMatchObject({ status: "confirmed", by: sub.ref });
    expect(await eligible(me)).toBe(true);
  });

  it("a rejected first submission rejects the pending affiliation; the next submission is pending again", async () => {
    const me = await createUser(db, { cls: m.classes[0], affiliation: "pending" });
    const sub = await openEnrollment(me);
    expect((await claim(sub.id)).ok).toBe(true);
    expect((await decide(sub.id, false, 1)).ok).toBe(true);
    expect((await affiliation(me)).status).toBe("rejected");
    expect((await submitEnrollment(me)).ok).toBe(true);
    expect((await affiliation(me)).status).toBe("pending");
  });
});
