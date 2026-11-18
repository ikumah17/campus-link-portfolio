// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createMasters, createStaff, createUser } from "./db/fixtures";
import { asUser, freshDb, owner, rpc, staff, user, type Session } from "./db/harness";
const m = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: () => "supabase" }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: m.create }));
import { claimSubmission, releaseSubmission, decideSubmission, revokeVerification } from "@/server/admin-verification-actions";
import { getSubmission, listSubmissions } from "@/server/admin-verifications";
let db: PGlite, reviewer: string, reviewer2: string;
let fetchSpy: ReturnType<typeof vi.spyOn>;
// Named arguments exercise the real signatures, independently of property order.
const signatures: Record<string, Record<string, string>> = {
  admin_list_submissions: { p_status: "public.verification_status" }, admin_get_submission: { p_id: "uuid" },
  admin_claim_submission: { p_id: "uuid" }, admin_release_submission: { p_id: "uuid" },
  admin_decide_submission: { p_id: "uuid", p_approve: "boolean", p_reason: "text", p_valid_until: "timestamptz", p_expected_version: "int" },
  admin_revoke_verification: { p_submission: "uuid", p_reason: "text" },
};
function clientFor(session: Session) {
  return { rpc: async (name: string, args: Record<string, unknown>) => {
    const signature = signatures[name]; expect(signature).toBeDefined(); expect(Object.keys(args).sort()).toEqual(Object.keys(signature).sort());
    const keys = Object.keys(signature);
    const sql = `select * from public.${name}(${keys.map((key, i) => `${key} => $${i + 1}::${signature[key]}`).join(", ")})`;
    try {
      const rows = await asUser(db, session, sql, keys.map(key => args[key]));
      // PostgREST serializes SQL date as YYYY-MM-DD; PGlite decodes it to Date.
      const normalized = name === "admin_get_submission" ? rows.map(value => {
        const row = value as Record<string, unknown>;
        return { ...row, birth_date: row.birth_date instanceof Date ? row.birth_date.toISOString().slice(0, 10) : row.birth_date };
      }) : rows;
      return { data: JSON.parse(JSON.stringify(["admin_list_submissions", "admin_get_submission"].includes(name) ? normalized : rows[0])), error: null };
    } catch (error) { const e = error as { code: string; message: string }; return { data: null, error: { code: e.code, message: e.message } }; }
  } };
}
beforeAll(async () => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden")); db = await freshDb();
  reviewer = await createStaff(db, ["reviewer"]); reviewer2 = await createStaff(db, ["reviewer"]);
}, 180_000);
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); });
afterAll(async () => { await db?.close(); vi.restoreAllMocks(); });
it("runs age claim/get/stale decision/release/reclaim/approve/revoke through real RPCs and audits once per read", async () => {
  const subject = await createUser(db, { ageVerified: false });
  const submitted = await rpc(db, user(subject), "submit_verification", ["age", ["synthetic:sample-1"]], ["public.verification_kind", "text[]"]);
  const id = submitted.ref!; const client = clientFor(staff(reviewer)); m.create.mockResolvedValue(client);
  const auditCount = async (action: string) => (await owner<{ n: number }>(db, "select count(*)::int n from private.audit_log where action = $1", [action]))[0].n;
  const before = await auditCount("list_submissions");
  const list = await listSubmissions(client, "submitted", reviewer); expect(list).toMatchObject({ status: "ok", submissions: expect.arrayContaining([expect.objectContaining({ id })]) }); expect(await auditCount("list_submissions")).toBe(before + 1);
  expect(await claimSubmission(id)).toEqual({ status: "ok" });
  const views = await auditCount("view_submission"); const loaded = await getSubmission(client, id); expect(await auditCount("view_submission")).toBe(views + 1);
  if (loaded.status !== "ok" || !loaded.submission) throw new Error("missing assigned detail");
  expect(loaded.submission).toMatchObject({ kind: "age", documentCount: 1, version: 1 }); expect(JSON.stringify(loaded)).not.toContain("synthetic:sample-1");
  expect(await getSubmission(clientFor(staff(reviewer2)), id)).toEqual({ status: "ok", submission: null });
  expect(await decideSubmission({ id, kind: "age", approve: true, expectedVersion: 0 })).toEqual({ status: "invalid_state" });
  expect(await releaseSubmission(id)).toEqual({ status: "ok" }); expect(await getSubmission(client, id)).toEqual({ status: "ok", submission: null });
  expect(await claimSubmission(id)).toEqual({ status: "ok" });
  expect(await decideSubmission({ id, kind: "age", approve: true, expectedVersion: 3 })).toEqual({ status: "ok" });
  expect((await asUser<{ age_verified: boolean }>(db, user(subject), "select * from public.my_account()"))[0].age_verified).toBe(true);
  expect(await revokeVerification({ submissionId: id, reason: "document_invalid" })).toEqual({ status: "ok" });
  expect((await asUser<{ age_verified: boolean }>(db, user(subject), "select * from public.my_account()"))[0].age_verified).toBe(false);
}, 120_000);
it("approves enrollment, confirms my_account affiliation and revokes it", async () => {
  const masters = await createMasters(db, "verify002"); const subject = await createUser(db, { cls: masters.classes[0], affiliation: "pending" });
  const id = (await owner<{ id: string }>(db, "select id from public.verification_submissions where user_id = $1 and kind = 'enrollment'", [subject]))[0].id;
  const client = clientFor(staff(reviewer)); m.create.mockResolvedValue(client);
  expect((await asUser<{ affiliation_confirmed: boolean }>(db, user(subject), "select * from public.my_account()"))[0].affiliation_confirmed).toBe(false);
  expect(await claimSubmission(id)).toEqual({ status: "ok" }); const loaded = await getSubmission(client, id);
  expect(loaded).toMatchObject({ status: "ok", submission: { kind: "enrollment", documentCount: 1 } }); expect(JSON.stringify(loaded)).not.toMatch(/birth_date|2000-05-05/);
  const future = new Date(Date.now() + 366 * 86400_000).toISOString().slice(0, 10);
  expect(await decideSubmission({ id, kind: "enrollment", approve: true, validUntil: future, expectedVersion: 1 })).toEqual({ status: "ok" });
  expect((await asUser<{ affiliation_confirmed: boolean }>(db, user(subject), "select * from public.my_account()"))[0].affiliation_confirmed).toBe(true);
  expect(await revokeVerification({ submissionId: id, reason: "no_longer_enrolled" })).toEqual({ status: "ok" });
  expect((await asUser<{ affiliation_confirmed: boolean }>(db, user(subject), "select * from public.my_account()"))[0].affiliation_confirmed).toBe(false);
}, 120_000);
it("rejects with only an allow-listed reason, and reports unknown id as invalid_state", async () => {
  const subject = await createUser(db, { ageVerified: false }); const submission = await rpc(db, user(subject), "submit_verification", ["age", ["synthetic:sample-1"]], ["public.verification_kind", "text[]"]);
  m.create.mockResolvedValue(clientFor(staff(reviewer))); expect(await claimSubmission(submission.ref)).toEqual({ status: "ok" });
  expect(await decideSubmission({ id: submission.ref, kind: "age", approve: false, reason: "document_mismatch", expectedVersion: 1 })).toEqual({ status: "ok" });
  expect((await owner(db, "select status, decision_reason from public.verification_submissions where id = $1", [submission.ref]))[0]).toEqual({ status: "rejected", decision_reason: "document_mismatch" });
  expect(await claimSubmission("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toEqual({ status: "invalid_state" });
}, 120_000);
it("forbids non-staff and aal1, and refuses a reviewer claiming their own submission", async () => {
  const subject = await createUser(db, { ageVerified: false }); const submission = await rpc(db, user(subject), "submit_verification", ["age", ["synthetic:sample-1"]], ["public.verification_kind", "text[]"]);
  for (const session of [staff(subject), user(reviewer)]) {
    const client = clientFor(session); m.create.mockResolvedValue(client);
    expect(await claimSubmission(submission.ref)).toEqual({ status: "forbidden" }); expect(await listSubmissions(client, "submitted", reviewer)).toEqual({ status: "forbidden" }); expect(await getSubmission(client, submission.ref!)).toEqual({ status: "forbidden" });
  }
  await db.transaction(async tx => { await tx.query("select private.lock_staff_roles(true)"); await tx.query("insert into auth.mfa_factors (id, user_id, factor_type, status) values (gen_random_uuid(), $1, 'totp', 'verified')", [subject]); await tx.query("insert into private.staff_roles (user_id, role) values ($1, 'reviewer')", [subject]); });
  m.create.mockResolvedValue(clientFor(staff(subject))); expect(await claimSubmission(submission.ref)).toEqual({ status: "invalid_state" });
}, 120_000);
