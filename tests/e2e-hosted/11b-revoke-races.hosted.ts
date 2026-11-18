import { test, expect } from "@playwright/test";
import { createRunUsers } from "./lifecycle";
import { evidence, readState } from "./state";
import { Session, isAdmin, race, registerConcurrency, staff, summary, type Result } from "./concurrency";

type Submission = { id: string; user_id: string; kind: string; status: string; reviewer_id: string | null; version: number };
const school = "00000000-0000-4000-8000-00000000a001";
const department = "00000000-0000-4000-8000-00000000b011";
const classes = ["00000000-0000-4000-8000-00000000c111", "00000000-0000-4000-8000-00000000c112"];
const rounds = 20;
const reason = "e2e_nt19_revoke";

// HOSTED-E2E-004: admin_revoke_verification(p_submission, p_reason) (migration 13)
// against the other writes on the same subject. Every write here takes
// private.lock_verification_subject, so each round must equal one serial order.
// private.audit_log has no app read path (no RPC, private schema; SQL is not
// authorized). Each successful write bumps the submission version once in the
// same transaction as its audit row, so the version read-back stands in for it.
test("NT-19 hosted verification revoke races preserve one serial order", async () => {
  test.setTimeout(900_000);
  let scenario = "setup";
  let round = 0;
  const history: Record<string, Record<string, unknown>[]> = {};
  function record(value: Record<string, unknown>) {
    (history[scenario] ??= []).push({ round, ...value });
    const orders: Record<string, number> = {};
    for (const row of history[scenario]) if (typeof row.order === "string") orders[row.order] = (orders[row.order] ?? 0) + 1;
    evidence(`nt19-${scenario}`, { rounds: history[scenario].length, orders, results: history[scenario] });
  }
  function success(value: Result) { expect(summary(value)).toMatchObject({ status: 200, ok: true, code: "ok" }); }
  function refused(value: Result) { expect(summary(value)).toMatchObject({ status: 200, ok: false, code: "invalid_state" }); }

  const admin = await Session.signIn("admin", true);
  expect(isAdmin(await staff(admin), admin.id)).toBe(true);
  const start = readState().users.length;
  await createRunUsers(3);
  const [u, r1Index, r2Index] = [start, start + 1, start + 2];
  registerConcurrency(admin, [r1Index, r2Index]); // persisted BEFORE the first grant
  const subject = await Session.signIn(u);
  // SEC-003: R1 and R2 enroll and verify their own TOTP here, before any role is granted to them.
  const r1 = await Session.signIn(r1Index, true);
  const r2 = await Session.signIn(r2Index, true);
  const users = readState().users;
  for (const [session, index] of [[subject, u], [r1, r1Index], [r2, r2Index]] as const) {
    success(await session.rpc("start_onboarding", { p_display_name: users[index].name, p_gender: "other", p_birth_date: "2000-01-02", p_adult_declared: true }));
  }
  async function reviewerRole(index: number, granted: boolean) {
    const user = readState().users[index];
    const active = (await staff(admin)).some(row => row.user_id === user.id && row.roles.includes("reviewer"));
    if (active !== granted) success(await admin.rpc(granted ? "admin_grant_role_by_email" : "admin_revoke_role",
      granted ? { p_email: user.email, p_role: "reviewer" } : { p_user: user.id, p_role: "reviewer" }));
    expect((await staff(admin)).some(row => row.user_id === user.id && row.roles.includes("reviewer"))).toBe(granted);
  }
  function label(id: string | null) { return id === null ? null : id === r1.id ? "R1" : id === r2.id ? "R2" : "other"; }
  async function submission(id: string) {
    const value = await r1.rpc("admin_list_submissions", { p_status: null });
    expect(value.status).toBe(200);
    const matches = (value.data as Submission[]).filter(row => row.id === id && row.user_id === subject.id);
    expect(matches.length, "read back exactly the run subject's submission").toBe(1);
    const row = matches[0];
    expect(row.kind).toBe("enrollment");
    return { status: row.status, reviewer: label(row.reviewer_id), version: row.version };
  }
  async function account() {
    const value = await subject.rpc("my_account");
    expect(value.status).toBe(200);
    const rows = value.data as { affiliation_status: string; affiliation_confirmed: boolean }[];
    expect(rows.length).toBe(1);
    return { status: rows[0].affiliation_status, confirmed: rows[0].affiliation_confirmed };
  }
  let current: string | undefined;
  function changeAffiliation() {
    current = classes.find(value => value !== current)!;
    return subject.rpc("set_affiliation", { p_school: school, p_department: department, p_class: current });
  }
  async function submit() {
    const submitted = await subject.rpc("submit_verification", { p_kind: "enrollment", p_document_refs: ["synthetic:sample-1"] });
    success(submitted);
    expect(submitted.ref !== null).toBe(true);
    expect(await submission(submitted.ref!)).toEqual({ status: "submitted", reviewer: null, version: 0 });
    return submitted.ref!;
  }
  async function claim(id: string) {
    success(await r1.rpc("admin_claim_submission", { p_id: id }));
    expect(await submission(id)).toEqual({ status: "in_review", reviewer: "R1", version: 1 });
  }
  function decide(id: string) {
    return r1.rpc("admin_decide_submission", { p_id: id, p_approve: true, p_reason: null,
      p_valid_until: new Date(Date.now() + 86_400_000).toISOString(), p_expected_version: 1 });
  }
  function revoke(session: Session, id: string) { return session.rpc("admin_revoke_verification", { p_submission: id, p_reason: reason }); }
  // Fresh state every round: a real class change clears any confirmation and
  // supersedes open enrollment submissions left by the previous round.
  async function approved() {
    success(await changeAffiliation());
    expect(await account()).toEqual({ status: "unconfirmed", confirmed: false });
    const id = await submit();
    await claim(id);
    success(await decide(id));
    expect(await submission(id)).toEqual({ status: "approved", reviewer: "R1", version: 2 });
    expect(await account()).toEqual({ status: "confirmed", confirmed: true });
    return id;
  }

  try {
    await reviewerRole(r1Index, true);
    await reviewerRole(r2Index, true);

    // Revoke-first: S1 revoked, affiliation rejected, then the change resets it to
    // unconfirmed. Change-first: confirmed_by_submission is cleared, so the revoke
    // finds no current approval. Either way nothing stands for the new class.
    scenario = "revoke-affiliation";
    for (round = 1; round <= rounds; round++) {
      const s1 = await approved();
      const calls = await race(() => revoke(r1, s1), changeAffiliation, round % 2 === 0);
      const after = await submission(s1);
      const ownAccount = await account();
      // A later revoke of S1 must find no current approval in either order.
      const probe = await revoke(r2, s1);
      const again = await submission(s1);
      record({ order: calls.left.ok ? "revoke-before-change" : "change-before-revoke", concurrent: calls.concurrent, overlapMs: calls.overlapMs,
        revoke: summary(calls.left), change: summary(calls.right), submission: after, account: ownAccount, probeRevoke: summary(probe),
        unchangedAfterProbe: JSON.stringify(after) === JSON.stringify(again) });
      expect(calls.concurrent, "different connections had both requests in flight").toBe(true);
      success(calls.right);
      if (calls.left.ok) { success(calls.left); expect(calls.left.ref).toBe(s1); } else refused(calls.left);
      expect(after).toEqual(calls.left.ok ? { status: "revoked", reviewer: "R1", version: 3 } : { status: "approved", reviewer: "R1", version: 2 });
      expect(ownAccount).toEqual({ status: "unconfirmed", confirmed: false });
      refused(probe);
      expect(again).toEqual(after);
    }

    // The contract accepts a renewal while S1 is current (submit_verification keeps
    // a confirmed, unexpired affiliation confirmed). Revoke-first rejects the
    // affiliation, so approve-S2 is refused. Approve-first moves the confirmation
    // to S2, so revoke-S1 finds S1 no longer current.
    scenario = "revoke-decision";
    for (round = 1; round <= rounds; round++) {
      const s1 = await approved();
      const s2 = await submit();
      expect(await account(), "a renewal keeps S1's confirmation").toEqual({ status: "confirmed", confirmed: true });
      await claim(s2);
      const calls = await race(() => revoke(r2, s1), () => decide(s2), round % 2 === 0);
      const after = { s1: await submission(s1), s2: await submission(s2), account: await account() };
      // Probes through the contract: S1 is never current afterwards, and S2 is
      // current exactly when its approval won. At most one approval is current.
      const probeS1 = await revoke(r2, s1);
      const probeS2 = await revoke(r2, s2);
      const probed = { s1: await submission(s1), s2: await submission(s2), account: await account() };
      record({ order: calls.left.ok ? "revoke-before-approve" : "approve-before-revoke", concurrent: calls.concurrent, overlapMs: calls.overlapMs,
        revoke: summary(calls.left), approve: summary(calls.right), after, probeS1: summary(probeS1), probeS2: summary(probeS2), probed });
      expect(calls.concurrent, "different connections had both requests in flight").toBe(true);
      expect([calls.left.ok, calls.right.ok].filter(Boolean).length, "exactly one of revoke-S1 and approve-S2 succeeds").toBe(1);
      if (calls.left.ok) {
        success(calls.left); refused(calls.right);
        expect(calls.left.ref).toBe(s1);
        expect(after).toEqual({ s1: { status: "revoked", reviewer: "R2", version: 3 }, s2: { status: "in_review", reviewer: "R1", version: 1 },
          account: { status: "rejected", confirmed: false } });
        refused(probeS1); refused(probeS2);
        expect(probed).toEqual(after);
      } else {
        refused(calls.left); success(calls.right);
        expect(after).toEqual({ s1: { status: "approved", reviewer: "R1", version: 2 }, s2: { status: "approved", reviewer: "R1", version: 2 },
          account: { status: "confirmed", confirmed: true } });
        refused(probeS1); success(probeS2);
        expect(probeS2.ref).toBe(s2);
        expect(probed).toEqual({ s1: after.s1, s2: { status: "revoked", reviewer: "R2", version: 3 }, account: { status: "rejected", confirmed: false } });
      }
    }

    // Both revokers lock the subject; the second sees S1 revoked and is refused.
    // The version moves 2 -> 3 exactly once and names the winner.
    scenario = "double-revoke";
    for (round = 1; round <= rounds; round++) {
      const s1 = await approved();
      const calls = await race(() => revoke(r1, s1), () => revoke(r2, s1), round % 2 === 0);
      const after = await submission(s1);
      const ownAccount = await account();
      record({ order: calls.left.ok ? "R1-first" : "R2-first", concurrent: calls.concurrent, overlapMs: calls.overlapMs,
        r1Revoke: summary(calls.left), r2Revoke: summary(calls.right), submission: after, account: ownAccount });
      expect(calls.concurrent, "different connections had both requests in flight").toBe(true);
      expect([calls.left.ok, calls.right.ok].filter(Boolean).length, "exactly one revoke succeeds").toBe(1);
      const [winner, loser] = calls.left.ok ? [calls.left, calls.right] : [calls.right, calls.left];
      success(winner); refused(loser);
      expect(winner.ref).toBe(s1);
      expect(after).toEqual({ status: "revoked", reviewer: calls.left.ok ? "R1" : "R2", version: 3 });
      expect(ownAccount).toEqual({ status: "rejected", confirmed: false });
    }

    await reviewerRole(r1Index, false);
    await reviewerRole(r2Index, false);
    const final = await staff(admin);
    evidence("nt19Revoke", { status: "pass", roundsPerRace: rounds, protectedAdminActive: isAdmin(final, admin.id),
      auditReadPath: "none in app RPCs; one version increment per successful write is asserted instead" });
    expect(isAdmin(final, admin.id)).toBe(true);
  } catch (error) {
    evidence("nt19RevokeFailure", { scenario, round, status: "failed" });
    throw error;
  }
});
