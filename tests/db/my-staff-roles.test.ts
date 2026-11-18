// ADMIN-005 order 19: my_staff_roles names only the caller's own active roles, reads nothing else and writes nothing.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addTotpFactor, createStaff, createUser } from "./fixtures";
import { asRole, asUser, fingerprint, freshDb, migrationFiles, owner, raised, rpc, staff, user } from "./harness";

let db: PGlite;
const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("network"));
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { expect(network).not.toHaveBeenCalled(); await db?.close(); vi.restoreAllMocks(); });
const roles = async (sub: string, aal: "aal1" | "aal2" = "aal2") =>
  (await asUser<{ role: string }>(db, { sub, aal }, "select * from public.my_staff_roles()")).map((r) => r.role);
/** roles granted right after a new verified TOTP factor, so they act (SEC-013 order 29) */
const grantRoles = async (id: string, list: string[]) => {
  await addTotpFactor(db, id);
  await owner(db, "insert into private.staff_roles (user_id, role) select $1, unnest($2::public.staff_role[])", [id, list]);
};

describe("my_staff_roles", () => {
  it("is order 19", () => {
    expect(migrationFiles()[18]).toBe("20261111120019_my_staff_roles.sql");
  });

  it.each(["active", "deactivated", "suspended"] as const)("returns a %s staff member's own active roles, ordered, at aal1 and aal2", async (status) => {
    const me = await createUser(db, { status });
    const other = await createStaff(db, ["moderator"]);
    await grantRoles(me, ["admin", "reviewer"]);
    const before = await fingerprint(db);
    expect(await roles(me)).toEqual(["reviewer", "admin"]);
    expect(await roles(me, "aal1")).toEqual(["reviewer", "admin"]);
    expect(await roles(other)).toEqual(["moderator"]);
    expect(await fingerprint(db)).toBe(before);
  });

  it("returns the roles of staff without a profile and leaves out revoked roles", async () => {
    const me = await createStaff(db, ["reviewer", "moderator", "admin"]);
    await owner(db, "update private.staff_roles set revoked_at = now() where user_id = $1 and role = 'moderator'", [me]);
    expect(await roles(me)).toEqual(["reviewer", "admin"]);
    await owner(db, "update private.staff_roles set revoked_at = now() where user_id = $1", [me]);
    await grantRoles(me, ["moderator"]);
    expect(await roles(me)).toEqual(["moderator"]);
  });

  it.each([["an ordinary user", { profile: true }], ["a user without a profile", { profile: false }]] as const)("returns no rows for %s", async (_label, spec) => {
    const me = await createUser(db, spec);
    expect(await roles(me)).toEqual([]);
    expect(await roles(me, "aal1")).toEqual([]);
  });

  it("refuses a deleted account, staff roles included, and changes nothing", async () => {
    const deleted = await createUser(db);
    await grantRoles(deleted, ["reviewer"]);
    expect(await roles(deleted)).toEqual(["reviewer"]);
    expect(await rpc(db, user(deleted), "request_account_deletion")).toMatchObject({ ok: true });
    const deletedStaff = await createStaff(db, ["reviewer", "moderator", "admin"]);
    await owner(db, "insert into public.profiles (user_id, display_name, gender, account_status, deleted_at) values ($1, '架空', 'other', 'deleted', now())", [deletedStaff]);
    const before = await fingerprint(db);
    for (const id of [deleted, deletedStaff]) {
      for (const aal of ["aal1", "aal2"] as const) expect(await raised(() => roles(id, aal))).toBe("forbidden");
    }
    expect(await fingerprint(db)).toBe(before);
  });

  it("refuses signed-out, anonymous and unconfirmed callers; anon and service_role cannot execute it", async () => {
    const anonymous = await createUser(db, { profile: false, anonymous: true });
    const unconfirmed = await createUser(db, { emailConfirmed: false });
    await grantRoles(unconfirmed, ["admin"]);
    const sql = "select * from public.my_staff_roles()";
    expect(await raised(() => asUser(db, {}, sql))).toBe("forbidden");
    expect(await raised(() => asUser(db, staff(anonymous), sql))).toBe("forbidden");
    expect(await raised(() => asUser(db, { sub: anonymous, aal: "aal2", isAnonymous: true }, sql))).toBe("forbidden");
    expect(await raised(() => asUser(db, user(unconfirmed), sql))).toBe("forbidden");
    for (const role of ["anon", "service_role"] as const) {
      expect(await raised(() => asRole(db, role, null, sql))).toMatch(/permission denied/);
    }
  });

  it("is a stable security definer with an empty search_path, executable by authenticated only", async () => {
    const [fn] = await owner<{ definer: boolean; volatility: string; config: string[]; args: number; acl: string[] }>(db, `
      select p.prosecdef as definer, p.provolatile::text as volatility, p.proconfig as config, p.pronargs as args,
             array(select a.grantee::regrole::text || ':' || a.privilege_type from aclexplode(p.proacl) a order by 1) as acl
      from pg_proc p where p.oid = 'public.my_staff_roles()'::regprocedure`);
    expect(fn).toEqual({ definer: true, volatility: "s", config: ['search_path=""'], args: 0, acl: ["authenticated:EXECUTE", "postgres:EXECUTE"] });
  });
});
