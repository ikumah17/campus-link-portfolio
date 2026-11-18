// SEC-013 order 29 (SECREVIEW-002 N-3): a staff role acts only while the account still has the TOTP factor it was granted with.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addTotpFactor, createStaff, createUser, type StaffRole } from "./fixtures";
import { MIGRATIONS_DIR, asRole, asUser, fingerprint, freshDb, migrationFiles, owner, raised, rpc, rpcRows, staff, user } from "./harness";

const ORDER_29 = "20261116120029_staff_totp_binding.sql";
const ROLES: StaffRole[] = ["reviewer", "moderator", "admin"];
const casts = ["uuid", "public.staff_role"];

let db: PGlite, admin: string;
beforeAll(async () => { db = await freshDb(); admin = await createStaff(db, ["admin"]); });
afterAll(async () => { await db?.close(); });

/** One RPC per role that runs private.require_staff(role) and nothing else first. */
const probe = (db: PGlite, sub: string, role: StaffRole, aal: "aal1" | "aal2" = "aal2") => {
  const session = { sub, aal };
  if (role === "reviewer") return rpcRows(db, session, "admin_list_submissions", [null], ["public.verification_status"]);
  if (role === "moderator") return rpcRows(db, session, "admin_list_reports", [null], ["public.report_status"]);
  return rpcRows(db, session, "admin_list_staff");
};
const listed = async (sub: string) =>
  (await asUser<{ role: string }>(db, staff(sub), "select * from public.my_staff_roles()")).map(r => r.role);
const grant = (target: string, role: StaffRole, caller = admin) => rpc(db, staff(caller), "admin_grant_role", [target, role], casts);
const revoke = (target: string, role: StaffRole, caller = admin) => rpc(db, staff(caller), "admin_revoke_role", [target, role], casts);

/** A factor of the user created `ago` before now (an interval), written by owner SQL like Auth would. */
async function addFactor(id: string, ago: string, type = "totp", status = "verified"): Promise<string> {
  const [{ factor }] = await owner<{ factor: string }>(db, `insert into auth.mfa_factors (id, user_id, factor_type, status, created_at)
    values (gen_random_uuid(), $1, $2::auth.factor_type, $3::auth.factor_status, now() - $4::interval) returning id as factor`,
  [id, type, status, ago]);
  return factor;
}

/**
 * An account granted `role` through admin_grant_role after a verified TOTP factor made two hours ago. The grant is then
 * moved one hour back, so a factor "added after the grant" (30 minutes ago) sits between it and now, and a later
 * re-grant at now() is after that factor, without relying on the clock moving between statements.
 */
async function bound(role: StaffRole): Promise<{ id: string; factor: string }> {
  const id = await createStaff(db, [], { totp: false });
  const factor = await addFactor(id, "2 hours");
  expect((await grant(id, role)).ok).toBe(true);
  await owner(db, `update private.staff_roles set granted_at = now() - interval '1 hour'
    where user_id = $1 and role = $2 and revoked_at is null`, [id, role]);
  return { id, factor };
}

const AFTER = "30 minutes";
const changes: [string, (id: string, factor: string) => Promise<unknown>][] = [
  ["the grant-time factor is deleted", (_, factor) => owner(db, "delete from auth.mfa_factors where id = $1", [factor])],
  ["the grant-time factor is deleted and a new verified TOTP is enrolled", async (id, factor) => {
    await owner(db, "delete from auth.mfa_factors where id = $1", [factor]);
    await addFactor(id, AFTER);
  }],
  ["a second verified TOTP factor is added after the grant, the original kept", id => addFactor(id, AFTER)],
  ["a verified phone factor is added after the grant, the original kept", id => addFactor(id, AFTER, "phone")],
  ["a verified webauthn factor is added after the grant, the original kept", id => addFactor(id, AFTER, "webauthn")],
  ["the grant-time factor is present but unverified", (_, factor) =>
    owner(db, "update auth.mfa_factors set status = 'unverified' where id = $1", [factor])],
];

describe("SEC-013 order 29", () => {
  it("is order 29", () => {
    expect(migrationFiles()[28]).toBe(ORDER_29);
    expect(migrationFiles().length).toBeGreaterThanOrEqual(29);   // order 30 (SEC-014) follows
  });
});

describe("SEC-013 a role acts with the factor it was granted with", () => {
  it.each(ROLES)("a %s role granted after a verified TOTP acts at aal2 and is listed", async (role) => {
    const { id } = await bound(role);
    expect(await raised(() => probe(db, id, role))).toBe("");
    expect(await listed(id)).toEqual([role]);
  });

  it("a factor created exactly at granted_at counts as the grant-time factor", async () => {
    const id = await createStaff(db, [], { totp: false });
    await addTotpFactor(db, id);
    expect((await grant(id, "moderator")).ok).toBe(true);
    await owner(db, `update auth.mfa_factors f set created_at = r.granted_at from private.staff_roles r
      where f.user_id = $1 and r.user_id = $1 and r.revoked_at is null`, [id]);
    expect(await raised(() => probe(db, id, "moderator"))).toBe("");
  });

  it("an unverified factor added after the grant, and another user's new factor, change nothing", async () => {
    const { id } = await bound("reviewer");
    await addFactor(id, AFTER, "totp", "unverified");
    await addFactor(id, AFTER, "phone", "unverified");
    await addFactor(await createUser(db), AFTER);
    expect(await raised(() => probe(db, id, "reviewer"))).toBe("");
    expect(await listed(id)).toEqual(["reviewer"]);
  });

  for (const [label, change] of changes) {
    it.each(ROLES)(`${label}: the %s role is forbidden, unlisted and nothing is written`, async (role) => {
      const { id, factor } = await bound(role);
      await change(id, factor);
      const before = await fingerprint(db);
      expect(await raised(() => probe(db, id, role))).toBe("forbidden");
      expect(await listed(id)).toEqual([]);
      expect(await fingerprint(db)).toBe(before);
      const [{ active }] = await owner<{ active: number }>(db,
        "select count(*)::int as active from private.staff_roles where user_id = $1 and revoked_at is null", [id]);
      expect(active).toBe(1);   // the row stays; only its effect stops
    });
  }

  it("each row is judged by its own granted_at: a role granted after the new factor acts, the older one does not", async () => {
    const { id } = await bound("reviewer");
    await addFactor(id, AFTER);
    expect((await grant(id, "moderator")).ok).toBe(true);
    expect(await raised(() => probe(db, id, "reviewer"))).toBe("forbidden");
    expect(await raised(() => probe(db, id, "moderator"))).toBe("");
    expect(await listed(id)).toEqual(["moderator"]);
  });

  it("after the factor is replaced, revoke and re-grant restore the role with the new factor", async () => {
    const { id, factor } = await bound("reviewer");
    await owner(db, "delete from auth.mfa_factors where id = $1", [factor]);
    await addFactor(id, AFTER);
    expect(await raised(() => probe(db, id, "reviewer"))).toBe("forbidden");
    expect(await grant(id, "reviewer")).toEqual({ ok: false, code: "invalid_state", ref: null });   // the row is still active
    expect(await revoke(id, "reviewer")).toEqual({ ok: true, code: "ok", ref: id });   // revoking needs no effective target role
    expect(await grant(id, "reviewer")).toEqual({ ok: true, code: "ok", ref: id });
    expect(await raised(() => probe(db, id, "reviewer"))).toBe("");
    expect(await listed(id)).toEqual(["reviewer"]);
  });

  it.each(ROLES)("an effective %s role is still refused at aal1, and listed there", async (role) => {
    const { id } = await bound(role);
    expect(await raised(() => probe(db, id, role, "aal1"))).toBe("forbidden");
    expect((await asUser<{ role: string }>(db, user(id), "select * from public.my_staff_roles()")).map(r => r.role)).toEqual([role]);
  });

  it.each(ROLES)("a revoked %s role with its grant-time factor intact is refused and unlisted", async (role) => {
    const { id } = await bound(role);
    if (role === "admin") await createStaff(db, ["admin"]);   // keep another admin so the revoke is allowed
    expect((await revoke(id, role)).ok).toBe(true);
    expect(await raised(() => probe(db, id, role))).toBe("forbidden");
    expect(await listed(id)).toEqual([]);
  });

  it("a role row without any factor (granted before order 20) is refused at aal2", async () => {
    const id = await createStaff(db, ["moderator"], { totp: false });
    expect(await raised(() => probe(db, id, "moderator"))).toBe("forbidden");
    expect(await listed(id)).toEqual([]);
  });
});

describe("SEC-013 the last admin gets no bypass", () => {
  it("when the only admin's role stops acting, every admin RPC refuses and the row stays", async () => {
    const own = await freshDb();
    const only = await createStaff(own, ["admin"]);
    const target = await createStaff(own, [], { totp: false });
    await addTotpFactor(own, target);
    expect(await raised(() => probe(own, only, "admin"))).toBe("");
    await own.query("delete from auth.mfa_factors where user_id = $1", [only]);
    await addTotpFactor(own, only);   // re-enrolled; still after the grant
    await own.query(`update auth.mfa_factors set created_at = now() + interval '1 minute' where user_id = $1`, [only]);
    const before = await fingerprint(own);
    expect(await raised(() => probe(own, only, "admin"))).toBe("forbidden");
    for (const fn of ["admin_grant_role", "admin_revoke_role"]) {
      expect(await raised(() => rpc(own, staff(only), fn, [target, "admin"], casts))).toBe("forbidden");
    }
    expect(await raised(() => rpc(own, staff(only), "admin_revoke_role", [only, "admin"], casts))).toBe("forbidden");
    expect(await fingerprint(own)).toBe(before);
    expect(await owner<{ user_id: string }>(own,
      "select user_id::text from private.staff_roles where role = 'admin' and revoked_at is null")).toEqual([{ user_id: only }]);
    await own.close();
  });
});

describe("SEC-013 surface", () => {
  const fn = async (signature: string) => (await owner<{ definer: boolean; volatility: string; config: string[]; acl: string[] }>(db, `
    select p.prosecdef as definer, p.provolatile::text as volatility, p.proconfig as config,
           array(select a.grantee::regrole::text || ':' || a.privilege_type from aclexplode(p.proacl) a order by 1) as acl
    from pg_proc p where p.oid = $1::regprocedure`, [signature]))[0];

  it("the helper is a stable security definer with an empty search_path that no API role can execute", async () => {
    expect(await fn("private.staff_role_effective(uuid, public.staff_role)"))
      .toEqual({ definer: true, volatility: "s", config: ['search_path=""'], acl: ["postgres:EXECUTE"] });
    const sql = "select private.staff_role_effective($1, 'admin')";
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      expect(await raised(() => asRole(db, role, role === "authenticated" ? staff(admin) : null, sql, [admin]))).toMatch(/permission denied/);
    }
  });

  it("require_staff and my_staff_roles keep their volatility and grants", async () => {
    expect(await fn("private.require_staff(public.staff_role, boolean)"))
      .toEqual({ definer: true, volatility: "v", config: ['search_path=""'], acl: ["postgres:EXECUTE"] });
    expect(await fn("public.my_staff_roles()"))
      .toEqual({ definer: true, volatility: "s", config: ['search_path=""'], acl: ["authenticated:EXECUTE", "postgres:EXECUTE"] });
  });

  const installed = async (schema: string, name: string) => (await owner<{ src: string }>(db,
    `select p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = $1 and p.proname = $2`,
    [schema, name]))[0].src.replace(/\r\n/g, "\n");
  const body = (order: string, head: string) => {
    const sql = readFileSync(join(MIGRATIONS_DIR, migrationFiles().find(f => f.endsWith(order))!), "utf8").replace(/\r\n/g, "\n");
    const open = sql.indexOf("$$", sql.indexOf(head)) + 2;
    return sql.slice(open, sql.indexOf("$$", open));
  };

  it("require_staff is the order-5 body with only the role-row test replaced (lock, aal2, error and return unchanged)", async () => {
    const src = await installed("private", "require_staff");
    expect(src).toBe(body(ORDER_29, "function private.require_staff("));
    const old = `not exists (select 1 from private.staff_roles r
                    where r.user_id = v_uid and r.role = p_role and r.revoked_at is null)`;
    expect(body("_staff_audit.sql", "function private.require_staff(").split(old)).toHaveLength(2);
    expect(body("_staff_audit.sql", "function private.require_staff(").replace(old, "not private.staff_role_effective(v_uid, p_role)")).toBe(src);
  });

  it("my_staff_roles is the order-19 body with only the effective-role condition added", async () => {
    const src = await installed("public", "my_staff_roles");
    const old = "where r.user_id = v_me and r.revoked_at is null\n";
    expect(body("_my_staff_roles.sql", "function public.my_staff_roles(").replace(old,
      "where r.user_id = v_me and r.revoked_at is null and private.staff_role_effective(v_me, r.role)\n")).toBe(src);
  });
});
