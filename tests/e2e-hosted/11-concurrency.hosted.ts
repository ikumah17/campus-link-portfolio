import { test, expect } from "@playwright/test";
import { createRunUsers } from "./lifecycle";
import { evidence, readState } from "./state";
import { ORDER_20_MISSING, Session, adminCount, grantWithoutTotp, isAdmin, race, registerConcurrency, staff, summary, type Result } from "./concurrency";

type Submission = { id: string; user_id: string; status: string; reviewer_id: string | null; claimed_at: string | null; version: number };
const school = "00000000-0000-4000-8000-00000000a001";
const department = "00000000-0000-4000-8000-00000000b011";
const classes = ["00000000-0000-4000-8000-00000000c111", "00000000-0000-4000-8000-00000000c112"];
const rounds = 20;

test("NT-19 hosted multi-connection races preserve verification and staff invariants", async () => {
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
  function forbidden(value: Result) { expect(summary(value)).toMatchObject({ status: 400, ok: false, code: "P0001" }); }

  const admin = await Session.signIn("admin", true);
  // The sole-admin boundary must be real. Never revoke an unrelated admin to
  // manufacture it: fail before creating/granting anything if one exists.
  expect(adminCount(await staff(admin)), "prerequisite: e2e-admin is the sole baseline admin").toBe(1);
  expect(isAdmin(await staff(admin), admin.id)).toBe(true);
  const start = readState().users.length;
  await createRunUsers(3);
  const [u, r, yIndex] = [start, start + 1, start + 2];
  // U is in the ledger only for the SEC-003 marker grant below. Persisted BEFORE the first grant.
  registerConcurrency(admin, [u, r, yIndex]);
  const subject = await Session.signIn(u);
  // SEC-003: X and Y enroll and verify their own TOTP here, before any role is granted to them; U never does.
  const reviewer = await Session.signIn(r, true); // also run admin X, later
  const y = await Session.signIn(yIndex, true);
  const users = readState().users;
  for (const [session, index] of [[subject, u], [reviewer, r], [y, yIndex]] as const) {
    success(await session.rpc("start_onboarding", { p_display_name: users[index].name, p_gender: "other", p_birth_date: "2000-01-02", p_adult_declared: true }));
  }
  async function role(index: number, name: "reviewer" | "admin", granted: boolean) {
    const user = readState().users[index];
    const active = (await staff(admin)).some(row => row.user_id === user.id && row.roles.includes(name));
    if (active !== granted) success(await admin.rpc(granted ? "admin_grant_role_by_email" : "admin_revoke_role",
      granted ? { p_email: user.email, p_role: name } : { p_user: user.id, p_role: name }));
    expect((await staff(admin)).some(row => row.user_id === user.id && row.roles.includes(name))).toBe(granted);
  }
  async function submission(id: string): Promise<Submission> {
    const value = await admin.rpc("admin_list_submissions", { p_status: null });
    expect(value.status).toBe(200);
    const rows = value.data as Submission[];
    const matches = rows.filter(row => row.id === id && row.user_id === subject.id);
    expect(matches.length, "read back exactly the run subject's submission").toBe(1);
    return matches[0];
  }
  let affiliationNumber = 0;
  async function freshSubmission() {
    const classId = classes[affiliationNumber++ % classes.length];
    success(await subject.rpc("set_affiliation", { p_school: school, p_department: department, p_class: classId }));
    const submitted = await subject.rpc("submit_verification", { p_kind: "enrollment", p_document_refs: ["synthetic:sample-1"] });
    success(submitted);
    expect(submitted.ref !== null).toBe(true);
    const row = await submission(submitted.ref!);
    expect({ status: row.status, reviewer: row.reviewer_id, version: row.version }).toEqual({ status: "submitted", reviewer: null, version: 0 });
    return { id: submitted.ref!, classId };
  }
  async function claim(id: string) {
    success(await reviewer.rpc("admin_claim_submission", { p_id: id }));
    const value = await reviewer.rpc("admin_get_submission", { p_id: id });
    expect(value.status).toBe(200);
    const rows = value.data as Submission[];
    expect(rows.length).toBe(1);
    expect(rows[0].id === id && rows[0].user_id === subject.id).toBe(true);
    expect(rows[0].version).toBe(1);
    return rows[0].version;
  }
  function decide(id: string, version: number) {
    return reviewer.rpc("admin_decide_submission", { p_id: id, p_approve: true, p_reason: null,
      p_valid_until: new Date(Date.now() + 86_400_000).toISOString(), p_expected_version: version });
  }
  function revokeReviewer() { return admin.rpc("admin_revoke_role", { p_user: reviewer.id, p_role: "reviewer" }); }
  async function account() {
    const value = await subject.rpc("my_account");
    expect(value.status).toBe(200);
    const rows = value.data as { affiliation_status: string; affiliation_confirmed: boolean }[];
    expect(rows.length).toBe(1);
    return { status: rows[0].affiliation_status, confirmed: rows[0].affiliation_confirmed };
  }
  function stateOf(row: Submission) {
    return { status: row.status, assignedToR: row.reviewer_id === reviewer.id,
      reviewerNull: row.reviewer_id === null, claimNull: row.claimed_at === null, version: row.version };
  }
  async function restored() {
    // On transport/assertion failure, try both authenticated admin identities.
    // No server credential is ever used to repair roles.
    try { if (isAdmin(await staff(admin), admin.id)) return; } catch { /* try the survivor */ }
    try {
      if (isAdmin(await staff(reviewer), reviewer.id)) {
        success(await reviewer.rpc("admin_grant_role_by_email", { p_email: "e2e-admin@example.invalid", p_role: "admin" }));
        if (isAdmin(await staff(admin), admin.id)) return;
      }
    } catch { /* keep the ledger and all users for the coordinator */ }
    evidence("nt19Recovery", { status: "failed", note: "e2e-admin admin not restored" });
    throw new Error("e2e-admin admin not restored");
  }

  try {
    scenario = "grant-without-totp";
    const marker = await grantWithoutTotp(admin, u);
    record({ order: marker });
    if (marker === "order_20_missing") test.info().annotations.push({ type: "skip", description: ORDER_20_MISSING });

    await role(r, "reviewer", true);
    scenario = "decision-affiliation";
    for (round = 1; round <= rounds; round++) {
      const fresh = await freshSubmission();
      const version = await claim(fresh.id);
      const changedClass = classes.find(value => value !== fresh.classId)!;
      // Maintain the toggle for the next round after this extra change.
      affiliationNumber++;
      const calls = await race(() => decide(fresh.id, version), () => subject.rpc("set_affiliation",
        { p_school: school, p_department: department, p_class: changedClass }), round % 2 === 0);
      const after = await submission(fresh.id);
      const ownAccount = await account();
      const order = calls.left.ok ? "decision-before-change" : "change-before-decision";
      record({ order, concurrent: calls.concurrent, overlapMs: calls.overlapMs,
        decision: summary(calls.left), change: summary(calls.right), submission: stateOf(after), account: ownAccount });
      expect(calls.concurrent, "different connections had both requests in flight").toBe(true);
      success(calls.right);
      if (calls.left.ok) success(calls.left);
      else expect(summary(calls.left)).toMatchObject({ status: 200, ok: false, code: "invalid_state" });
      expect(stateOf(after)).toEqual({ status: calls.left.ok ? "approved" : "superseded", assignedToR: calls.left.ok,
        reviewerNull: !calls.left.ok, claimNull: !calls.left.ok, version: 2 });
      expect(ownAccount).toEqual({ status: "unconfirmed", confirmed: false });
    }

    for (const operation of ["claim", "decide"] as const) {
      scenario = `revoke-${operation}`;
      for (round = 1; round <= rounds; round++) {
        await role(r, "reviewer", true);
        const fresh = await freshSubmission();
        const version = operation === "decide" ? await claim(fresh.id) : 0;
        const act = () => operation === "claim" ? reviewer.rpc("admin_claim_submission", { p_id: fresh.id }) : decide(fresh.id, version);
        const calls = await race(act, revokeReviewer, round % 2 === 0);
        const after = await submission(fresh.id);
        const hasRole = (await staff(admin)).some(row => row.user_id === reviewer.id && row.roles.includes("reviewer"));
        const ownAccount = await account();
        // A new call started after the revoke response MUST be forbidden. This
        // complements the raced call, whose success implies the earlier order.
        const postRevoke = await act();
        const again = await submission(fresh.id);
        const order = calls.left.ok ? `${operation}-before-revoke` : `revoke-before-${operation}`;
        record({ order, concurrent: calls.concurrent, overlapMs: calls.overlapMs, operation: summary(calls.left), revoke: summary(calls.right),
          postRevoke: summary(postRevoke), submission: stateOf(after), unchangedAfterRefusal: JSON.stringify(stateOf(after)) === JSON.stringify(stateOf(again)),
          reviewerRoleRemoved: !hasRole, account: ownAccount });
        expect(calls.concurrent).toBe(true);
        success(calls.right);
        if (calls.left.ok) success(calls.left); else forbidden(calls.left);
        forbidden(postRevoke);
        expect(hasRole).toBe(false);
        const approved = operation === "decide" && calls.left.ok;
        expect(stateOf(after)).toEqual({ status: approved ? "approved" : "submitted", assignedToR: approved,
          reviewerNull: !approved, claimNull: !approved, version: operation === "decide" || calls.left.ok ? 2 : 0 });
        expect(stateOf(again)).toEqual(stateOf(after));
        expect(ownAccount).toEqual({ status: approved ? "confirmed" : "pending", confirmed: approved });
        // A refused claim leaves a submitted enrollment; changing the class in
        // freshSubmission supersedes it before the next round.
      }
      const orders = new Set(history[scenario].map(row => row.order));
      evidence(`nt19-${scenario}-coverage`, { missingOrders: [`${operation}-before-revoke`, `revoke-before-${operation}`].filter(order => !orders.has(order)) });
    }

    scenario = "sentinel-admins";
    for (round = 1; round <= rounds; round++) {
      await role(r, "admin", true);
      await role(yIndex, "admin", true);
      expect(adminCount(await staff(admin))).toBe(3);
      const calls = await race(() => reviewer.rpc("admin_revoke_role", { p_user: y.id, p_role: "admin" }),
        () => y.rpc("admin_revoke_role", { p_user: reviewer.id, p_role: "admin" }), round % 2 === 0);
      const rows = await staff(admin);
      record({ order: calls.left.ok ? "X-before-Y" : "Y-before-X", concurrent: calls.concurrent, overlapMs: calls.overlapMs,
        xRevokeY: summary(calls.left), yRevokeX: summary(calls.right), activeAdmins: adminCount(rows), protectedAdminActive: isAdmin(rows, admin.id) });
      expect(calls.concurrent).toBe(true);
      expect([calls.left.ok, calls.right.ok].filter(Boolean).length).toBe(1);
      success(calls.left.ok ? calls.left : calls.right);
      forbidden(calls.left.ok ? calls.right : calls.left);
      expect(adminCount(rows)).toBe(2);
      expect(isAdmin(rows, admin.id)).toBe(true);
    }
    await role(r, "admin", false);
    await role(yIndex, "admin", false);
    scenario = "sole-admin";
    round = 1;
    expect(adminCount(await staff(admin))).toBe(1);
    const sole = await admin.rpc("admin_revoke_role", { p_user: admin.id, p_role: "admin" });
    record({ refusal: summary(sole), activeAdmins: adminCount(await staff(admin)), protectedAdminActive: true });
    expect(summary(sole)).toMatchObject({ status: 200, ok: false, code: "invalid_state" });
    expect(isAdmin(await staff(admin), admin.id)).toBe(true);

    // Coordinator clarification msg_7cdd47846078 explicitly authorizes this
    // boundary and in-test restoration; a legitimate X-first order can remove
    // e2e-admin temporarily. Never finish a round/delete X in that state.
    scenario = "two-admins";
    for (round = 1; round <= rounds; round++) {
      await role(r, "admin", true);
      expect(adminCount(await staff(admin))).toBe(2);
      const calls = await race(() => reviewer.rpc("admin_revoke_role", { p_user: admin.id, p_role: "admin" }),
        () => admin.rpc("admin_revoke_role", { p_user: reviewer.id, p_role: "admin" }), round % 2 === 0);
      // A double success is retained as a real finding even if recovery fails.
      if (calls.left.ok && calls.right.ok) {
        record({ xRevokeAdmin: summary(calls.left), adminRevokeX: summary(calls.right), note: "last-admin invariant broken" });
        await restored();
        throw new Error("last-admin invariant broken");
      }
      const survivor = calls.left.ok ? reviewer : admin;
      const rows = await staff(survivor);
      const countBeforeRestore = adminCount(rows);
      // Restore BEFORE assertions that could throw. Finally also attempts it
      // after a transport failure or unexpected refused/read-back response.
      await restored();
      const protectedAdminActive = isAdmin(await staff(admin), admin.id);
      record({ order: calls.left.ok ? "X-before-e2e-admin" : "e2e-admin-before-X", concurrent: calls.concurrent, overlapMs: calls.overlapMs,
        xRevokeAdmin: summary(calls.left), adminRevokeX: summary(calls.right), activeAdminsBeforeRestore: countBeforeRestore,
        protectedAdminRestored: protectedAdminActive });
      expect(calls.concurrent).toBe(true);
      expect([calls.left.ok, calls.right.ok].filter(Boolean).length).toBe(1);
      success(calls.left.ok ? calls.left : calls.right);
      forbidden(calls.left.ok ? calls.right : calls.left);
      expect(countBeforeRestore, "exactly one admin survives the boundary race").toBe(1);
      expect(protectedAdminActive).toBe(true);
      await role(r, "admin", false);
      expect(adminCount(await staff(admin))).toBe(1);
    }
    const final = await staff(admin);
    evidence("nt19", { status: "pass", roundsPerRace: rounds, finalActiveAdmins: adminCount(final), protectedAdminActive: isAdmin(final, admin.id),
      boundary: "two-admin cross-revokes with immediate surviving-session restoration; sole-admin self-revoke refused" });
  } catch (error) {
    evidence("nt19Failure", { scenario, round, status: "failed" });
    throw error;
  } finally {
    await restored();
  }
});
