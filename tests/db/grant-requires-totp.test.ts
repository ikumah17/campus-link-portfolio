// SEC-003 order 20 (SECREVIEW-001 M-3): no staff role for an account without a verified TOTP factor.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addTotpFactor, createStaff, createUser, missingId } from "./fixtures";
import { MIGRATIONS_DIR, asUser, deny, fingerprint, freshDb, migrationFiles, owner, raised, rpc, rpcRows, staff, user } from "./harness";

let db: PGlite, admin: string;
beforeAll(async () => { db = await freshDb(); admin = await createStaff(db, ["admin"]); });
afterAll(async () => { await db?.close(); });

const casts = ["uuid", "public.staff_role"];
const grant = (target: string, role = "reviewer", caller = admin) => rpc(db, staff(caller), "admin_grant_role", [target, role], casts);
const grantByEmail = (email: string, role = "reviewer", caller = admin) =>
  rpc(db, staff(caller), "admin_grant_role_by_email", [email, role], ["text", "public.staff_role"]);
const emailOf = async (id: string) => (await owner<{ email: string }>(db, "select email from auth.users where id = $1", [id]))[0].email;
const activeRoles = async (id: string) => (await owner<{ role: string }>(db,
  "select role::text from private.staff_roles where user_id = $1 and revoked_at is null order by role", [id])).map(r => r.role);
const auditSince = async (from: number) => owner<{ actor_id: string; action: string; target_type: string; target_id: string; detail: unknown }>(db,
  "select actor_id, action, target_type, target_id, detail from private.audit_log where id > $1 order by id", [from]);
const lastAudit = async () => (await owner<{ id: number }>(db, "select coalesce(max(id), 0)::int as id from private.audit_log"))[0].id;

/** Factor states that must not unlock a grant. */
const withoutVerifiedTotp: [string, (target: string) => Promise<unknown>][] = [
  ["no factor", async () => undefined],
  ["only an unverified TOTP factor", target => addTotpFactor(db, target, "unverified")],
  ["only verified non-TOTP factors", target => owner(db, `insert into auth.mfa_factors (id, user_id, factor_type, status)
    values (gen_random_uuid(), $1, 'phone', 'verified'), (gen_random_uuid(), $1, 'webauthn', 'verified')`, [target])],
  ["only another user's verified TOTP factor", async () => addTotpFactor(db, await createUser(db))],
];

describe("SEC-003 admin_grant_role requires the target's verified TOTP factor", () => {
  it.each(withoutVerifiedTotp)("refuses a target with %s: mfa_required, no role and no audit row", async (_, prepare) => {
    const target = await createUser(db);
    await prepare(target);
    const before = await fingerprint(db);
    expect(await grant(target)).toEqual(deny("mfa_required"));
    expect(await fingerprint(db)).toBe(before);
    expect(await activeRoles(target)).toEqual([]);
  });

  it("grants a target with a verified TOTP factor exactly as before: one role, one audit row, ref is the target", async () => {
    const target = await createUser(db);
    await addTotpFactor(db, target, "unverified");
    await addTotpFactor(db, target);
    const from = await lastAudit();
    expect(await grant(target, "moderator")).toEqual({ ok: true, code: "ok", ref: target });
    expect(await auditSince(from)).toEqual([
      { actor_id: admin, action: "grant_role", target_type: "staff_role", target_id: target, detail: { role: "moderator" } }]);
    const [row] = await owner<{ granted_by: string; revoked: boolean }>(db,
      "select granted_by, revoked_at is not null as revoked from private.staff_roles where user_id = $1", [target]);
    expect(row).toEqual({ granted_by: admin, revoked: false });
    const snapshot = await fingerprint(db);
    expect(await grant(target, "moderator")).toEqual(deny("invalid_state"));   // idempotent duplicate, no write
    expect(await fingerprint(db)).toBe(snapshot);
  });

  it("keeps the earlier checks first: authorization, validation, unknown user and duplicate win over mfa_required", async () => {
    const holder = await createStaff(db, ["reviewer"], { totp: false });   // an active role row without any factor
    const target = await createUser(db);
    const moderator = await createStaff(db, ["moderator"]);
    await addTotpFactor(db, moderator);
    const before = await fingerprint(db);
    expect(await raised(() => grant(target, "reviewer", moderator))).toBe("forbidden");
    expect(await raised(() => rpc(db, { sub: admin, aal: "aal1" }, "admin_grant_role", [target, "reviewer"], casts))).toBe("forbidden");
    expect(await raised(() => rpc(db, staff(admin), "admin_grant_role", [null, "reviewer"], casts))).toBe("validation");
    expect(await grant(missingId())).toEqual(deny("not_available"));
    expect(await grant(holder)).toEqual(deny("invalid_state"));
    expect(await grant(holder, "admin")).toEqual(deny("mfa_required"));
    expect(await fingerprint(db)).toBe(before);
  });

  it("a revoked role is not re-granted while the factor is missing, and is once the factor is verified", async () => {
    const target = await createUser(db);
    const factor = await addTotpFactor(db, target, "unverified");
    expect(await grant(target)).toEqual(deny("mfa_required"));
    await owner(db, "update auth.mfa_factors set status = 'verified' where id = $1", [factor]);
    expect((await grant(target)).ok).toBe(true);
    expect((await rpc(db, staff(admin), "admin_revoke_role", [target, "reviewer"], casts)).ok).toBe(true);
    await owner(db, "delete from auth.mfa_factors where id = $1", [factor]);   // the user unenrolled
    const before = await fingerprint(db);
    expect(await grant(target)).toEqual(deny("mfa_required"));
    expect(await fingerprint(db)).toBe(before);
  });
});

describe("SEC-003 admin_grant_role_by_email gives the same refusal", () => {
  it.each(withoutVerifiedTotp)("refuses an email whose account has %s, with no write", async (_, prepare) => {
    const target = await createUser(db);
    await prepare(target);
    const before = await fingerprint(db);
    expect(await grantByEmail(await emailOf(target))).toEqual(deny("mfa_required"));
    expect(await fingerprint(db)).toBe(before);
  });

  it("grants with a verified TOTP factor exactly as before: one audit row, no target in the result", async () => {
    const target = await createUser(db);
    await addTotpFactor(db, target);
    const from = await lastAudit();
    expect(await grantByEmail(` ${(await emailOf(target)).toUpperCase()} `)).toEqual({ ok: true, code: "ok", ref: null });
    expect(await auditSince(from)).toEqual([
      { actor_id: admin, action: "grant_role", target_type: "staff_role", target_id: target, detail: { role: "reviewer" } }]);
    expect(await grantByEmail(await emailOf(target))).toEqual(deny("invalid_state"));
  });

  it("still answers not_available for unknown and unconfirmed emails before any factor check", async () => {
    const unconfirmed = await createUser(db, { emailConfirmed: false });
    await addTotpFactor(db, unconfirmed);
    const before = await fingerprint(db);
    expect(await grantByEmail("missing-sec003@example.invalid")).toEqual(deny("not_available"));
    expect(await grantByEmail(await emailOf(unconfirmed))).toEqual(deny("not_available"));
    expect(await fingerprint(db)).toBe(before);
  });
});

describe("SEC-003 leaves existing roles and revocation alone", () => {
  it("an existing role holder without a factor keeps the row, cannot act at aal1, and can still be revoked", async () => {
    const holder = await createStaff(db, ["moderator"], { totp: false });
    expect(await activeRoles(holder)).toEqual(["moderator"]);
    expect(await raised(() => rpcRows(db, { sub: holder, aal: "aal1" }, "admin_list_reports", [null], ["public.report_status"]))).toBe("forbidden");
    expect(await rpc(db, staff(admin), "admin_revoke_role", [holder, "moderator"], casts)).toEqual({ ok: true, code: "ok", ref: holder });
    expect(await activeRoles(holder)).toEqual([]);
  });

  it("students still cannot call either grant", async () => {
    const student = await createUser(db);
    await addTotpFactor(db, student);
    const email = await emailOf(student);
    for (const session of [user(student), staff(student)]) {
      expect(await raised(() => asUser(db, session, "select * from public.admin_grant_role($1, 'admin')", [student]))).toBe("forbidden");
      expect(await raised(() => asUser(db, session, "select * from public.admin_grant_role_by_email($1, 'admin')", [email]))).toBe("forbidden");
    }
    expect(await activeRoles(student)).toEqual([]);
  });
});

describe("SEC-003 the order-20 body is the order-10 body plus the factor check only", () => {
  const body = (sql: string) => {
    const start = sql.indexOf("function public.admin_grant_role(p_user uuid, p_role public.staff_role)");
    const open = sql.indexOf("$$", start) + 2;
    return sql.slice(open, sql.indexOf("$$", open));
  };
  const file = (order: string) => readFileSync(join(MIGRATIONS_DIR, migrationFiles().find(f => f.endsWith(order))!), "utf8");
  const check = `  if not exists (select 1 from auth.mfa_factors f
                 where f.user_id = p_user and f.factor_type = 'totp' and f.status = 'verified') then
    return private.deny('mfa_required');
  end if;
`;

  it("removing the factor check from the installed function gives the order-10 text byte for byte", async () => {
    const [{ src }] = await owner<{ src: string }>(db,
      "select p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'admin_grant_role'");
    expect(src.replace(/\r\n/g, "\n")).toBe(body(file("_grant_requires_totp.sql")).replace(/\r\n/g, "\n"));
    const installed = src.replace(/\r\n/g, "\n");
    expect(installed.split(check)).toHaveLength(2);
    expect(installed.replace(check, "")).toBe(body(file("_admin.sql")).replace(/\r\n/g, "\n"));
    expect(installed.indexOf(check)).toBeLessThan(installed.indexOf("insert into private.staff_roles"));
  });

  it("admin_grant_role_by_email is unchanged from order 14 and still delegates to admin_grant_role", async () => {
    const [{ src }] = await owner<{ src: string }>(db,
      "select p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'admin_grant_role_by_email'");
    const sql = file("_staff_management.sql");
    const start = sql.indexOf("function public.admin_grant_role_by_email(");
    const open = sql.indexOf("$$", start) + 2;
    expect(src.replace(/\r\n/g, "\n")).toBe(sql.slice(open, sql.indexOf("$$", open)).replace(/\r\n/g, "\n"));
    expect(src).toContain("v_result := public.admin_grant_role(v_users[1], p_role);");
    expect(src).toContain("return private.deny(v_result.code);");
  });
});
