// STAFF-001 order 35 (docs/39 P-2): admin_list_staff says, aligned with roles, which listed roles act.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addTotpFactor, createStaff, createUser } from "./fixtures";
import { asRole, asUser, fingerprint, freshDb, migrationFiles, owner, raised, rpcRows, staff } from "./harness";

const ORDER_35 = "20261118120035_staff_acting_column.sql";
type Row = { user_id: string; display_name: string | null; roles: string[]; is_me: boolean; acting: boolean[] };

let db: PGlite, admin: string;
beforeAll(async () => { db = await freshDb(); admin = await createStaff(db, ["admin"]); });
afterAll(async () => { await db?.close(); });

const list = (caller = admin, target = db) => rpcRows<Row>(target, staff(caller), "admin_list_staff");
const rowOf = async (id: string) => (await list()).find(r => r.user_id === id);
/** A verified factor of the user created after every grant of theirs (one minute in the future), as Auth would write it. */
async function newerFactor(id: string) {
  const factor = await addTotpFactor(db, id);
  await owner(db, "update auth.mfa_factors set created_at = now() + interval '1 minute' where id = $1", [factor]);
}

describe("STAFF-001 order 35", () => {
  it("is order 35", () => {
    expect(migrationFiles()[34]).toBe(ORDER_35);
  });

  it("adds only the acting column after the order-14 columns, with the same signature, definer, search_path and grants", async () => {
    const fns = await owner<{ args: string; result: string; definer: boolean; volatility: string; config: string[] }>(db, `
      select pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as result,
             p.prosecdef as definer, p.provolatile::text as volatility, p.proconfig as config
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'admin_list_staff'`);
    expect(fns).toEqual([{
      args: "", definer: true, volatility: "v", config: ['search_path=""'],
      result: "TABLE(user_id uuid, display_name text, roles staff_role[], is_me boolean, acting boolean[])",
    }]);
    const [acl] = await owner<{ anon: boolean; authenticated: boolean; service: boolean; public: boolean }>(db, `
      select has_function_privilege('anon', 'public.admin_list_staff()', 'EXECUTE') as anon,
             has_function_privilege('authenticated', 'public.admin_list_staff()', 'EXECUTE') as authenticated,
             has_function_privilege('service_role', 'public.admin_list_staff()', 'EXECUTE') as service,
             exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                     where p.oid = 'public.admin_list_staff()'::regprocedure and a.grantee = 0) as public`);
    expect(acl).toEqual({ anon: false, authenticated: true, service: false, public: false });
  });
});

describe("STAFF-001 acting", () => {
  it("is true for an acting role and false after a newer verified factor; the row stays listed", async () => {
    const id = await createStaff(db, ["moderator"]);
    expect(await rowOf(id)).toMatchObject({ roles: ["moderator"], acting: [true] });
    await newerFactor(id);
    expect(await rowOf(id)).toMatchObject({ roles: ["moderator"], acting: [false] });
  });

  it("is false for a role without any TOTP factor", async () => {
    const id = await createStaff(db, ["reviewer"], { totp: false });
    expect(await rowOf(id)).toMatchObject({ roles: ["reviewer"], acting: [false] });
  });

  it("is aligned with roles in role order when two roles have different granted_at", async () => {
    const id = await createStaff(db, ["reviewer", "admin"]);
    // a verified factor between the two grants: the reviewer row (granted before it) stops acting, the admin row acts
    await owner(db, `update private.staff_roles set granted_at = now() - interval '2 hours'
      where user_id = $1 and role = 'reviewer' and revoked_at is null`, [id]);
    await owner(db, "update auth.mfa_factors set created_at = now() - interval '3 hours' where user_id = $1", [id]);
    const factor = await addTotpFactor(db, id);
    await owner(db, "update auth.mfa_factors set created_at = now() - interval '1 hour' where id = $1", [factor]);
    expect(await rowOf(id)).toMatchObject({ roles: ["reviewer", "admin"], acting: [false, true] });
    const [effective] = await owner<{ reviewer: boolean; admin: boolean }>(db, `
      select private.staff_role_effective($1, 'reviewer') as reviewer, private.staff_role_effective($1, 'admin') as admin`, [id]);
    expect(effective).toEqual({ reviewer: false, admin: true });
    for (const row of await list()) expect(row.acting).toHaveLength(row.roles.length);
  });

  it("keeps the rows, their order and the other columns; a read writes nothing", async () => {
    const own = await freshDb();
    try {
      const caller = await createStaff(own, ["admin"]);
      const named = await createUser(own, { displayName: "A担当" });
      await own.query("insert into private.staff_roles(user_id, role) values ($1, 'moderator'), ($1, 'admin')", [named]);
      const revoked = await createStaff(own, ["reviewer"]);
      await own.query("update private.staff_roles set revoked_at = now() where user_id = $1", [revoked]);
      const before = await fingerprint(own);
      expect(await list(caller, own)).toEqual([
        { user_id: named, display_name: "A担当", roles: ["moderator", "admin"], is_me: false, acting: [false, false] },
        { user_id: caller, display_name: null, roles: ["admin"], is_me: true, acting: [true] },
      ]);
      expect(await fingerprint(own)).toBe(before);
    } finally { await own.close(); }
  });
});

describe("STAFF-001 caller rules are unchanged", () => {
  it.each(["moderator", "reviewer", "ordinary"])("refuses a %s", async role => {
    const caller = role === "ordinary" ? await createUser(db) : await createStaff(db, [role as "moderator" | "reviewer"]);
    expect(await raised(() => list(caller))).toBe("forbidden");
  });

  it("refuses an admin whose role does not act", async () => {
    const caller = await createStaff(db, ["admin"]);
    await newerFactor(caller);
    expect(await raised(() => list(caller))).toBe("forbidden");
  });

  it("refuses aal1 and a missing session; anon and service_role have no execute", async () => {
    const sql = "select * from public.admin_list_staff()";
    expect(await raised(() => asUser(db, { sub: admin, aal: "aal1" }, sql))).toBe("forbidden");
    expect(await raised(() => asUser(db, {}, sql))).toBe("forbidden");
    for (const role of ["anon", "service_role"] as const) {
      expect(await raised(() => asRole(db, role, null, sql))).toMatch(/permission denied/);
    }
  });
});
