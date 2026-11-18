// ADMIN-006 order 23: admin_list_suspended_accounts lists suspended accounts for admins at aal2 only, never the caller,
// with the time and reason of the latest suspension audit row, and audits the call.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addTotpFactor, createStaff, createUser } from "./fixtures";
import { asRole, asUser, fingerprint, freshDb, migrationFiles, owner, raised, rpc, staff, user } from "./harness";

type Row = { user_id: string; display_name: string | null; suspended_at: string | null; reason: string | null };
const SQL = "select * from public.admin_list_suspended_accounts()";
const SET = ["uuid", "public.account_status", "text"];

let db: PGlite;
const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("network"));
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { expect(network).not.toHaveBeenCalled(); await db?.close(); vi.restoreAllMocks(); });
const list = (sub: string) => asUser<Row>(db, staff(sub), SQL);
const setStatus = async (admin: string, target: string, status: "suspended" | "active", reason: string | null) =>
  expect(await rpc(db, staff(admin), "admin_set_account_status", [target, status, reason], SET)).toMatchObject({ ok: true });
const listAudits = (actor: string) => owner<{ target_type: string; target_id: string | null; detail: unknown }>(db,
  "select target_type, target_id, detail from private.audit_log where action = 'list_suspended_accounts' and actor_id = $1 order by id", [actor]);

describe("admin_list_suspended_accounts", () => {
  it("is order 23", () => {
    expect(migrationFiles()[22]).toBe("20261112120023_suspended_accounts.sql");
  });

  it("lists every suspended account but the caller, with the latest suspension's time and reason, oldest first and unaudited ones last", async () => {
    const admin = await createUser(db, { status: "suspended", displayName: "架空管理者" });
    await addTotpFactor(db, admin);   // the grant-time factor (SEC-013 order 29)
    await owner(db, "insert into private.staff_roles (user_id, role) values ($1, 'admin')", [admin]);
    const other = await createStaff(db, ["admin"]);
    const first = await createUser(db, { displayName: "架空一" });
    const second = await createUser(db, { displayName: "架空二" });
    const noAudit = await createUser(db, { status: "suspended", displayName: "架空三" });
    const active = await createUser(db);
    const deactivated = await createUser(db, { status: "deactivated" });
    await setStatus(other, first, "suspended", "spam");
    await setStatus(other, second, "suspended", "harassment");
    await setStatus(other, first, "active", null);
    await setStatus(other, first, "suspended", "impersonation");   // the latest suspension wins
    const rows = await list(admin);
    const expected = (await owner<{ user_id: string }>(db,
      "select user_id::text from public.profiles where account_status = 'suspended' and user_id <> $1", [admin])).map(r => r.user_id);
    expect(rows.map(r => r.user_id).sort()).toEqual(expected.sort());
    for (const id of [admin, active, deactivated]) expect(rows.map(r => r.user_id)).not.toContain(id);
    const mine = rows.filter(r => [first, second, noAudit].includes(r.user_id));
    expect(mine.map(r => [r.user_id, r.display_name, r.reason])).toEqual([
      [second, "架空二", "harassment"], [first, "架空一", "impersonation"], [noAudit, "架空三", null]]);
    const [{ at }] = await owner<{ at: string }>(db, `select max(created_at) as at from private.audit_log
      where action = 'set_account_status' and target_id = $1 and detail ->> 'to' = 'suspended'`, [first]);
    expect(mine[1].suspended_at).toEqual(at);
    expect(mine[2].suspended_at).toBeNull();
    // Oldest suspension first, then the unaudited ones, each group by user id.
    const dated = rows.filter(r => r.suspended_at !== null), undated = rows.filter(r => r.suspended_at === null);
    expect(rows).toEqual([...dated, ...undated]);
    expect(dated.map(r => new Date(r.suspended_at!).getTime())).toEqual(dated.map(r => new Date(r.suspended_at!).getTime()).sort((a, b) => a - b));
    expect(undated.map(r => r.user_id)).toEqual(undated.map(r => r.user_id).sort());
    // The suspended admin is listed to another admin.
    expect((await list(other)).map(r => r.user_id)).toContain(admin);
  });

  it("returns only the id, the display name, the suspension time and the reason code", async () => {
    const admin = await createStaff(db, ["admin"]);
    const target = await createUser(db);
    await setStatus(admin, target, "suspended", "other");
    const [fn] = await owner<{ result: string }>(db, "select pg_get_function_result('public.admin_list_suspended_accounts()'::regprocedure) as result");
    expect(fn.result).toBe("TABLE(user_id uuid, display_name text, suspended_at timestamp with time zone, reason text)");
    const row = (await list(admin)).find(r => r.user_id === target);
    expect(Object.keys(row!).sort()).toEqual(["display_name", "reason", "suspended_at", "user_id"]);
  });

  it("audits each call with one row that names no account", async () => {
    const admin = await createStaff(db, ["admin"]);
    expect(await listAudits(admin)).toEqual([]);
    await list(admin);
    await list(admin);
    expect(await listAudits(admin)).toEqual([
      { target_type: "profile", target_id: null, detail: {} }, { target_type: "profile", target_id: null, detail: {} }]);
  });

  it("refuses a moderator, a reviewer, a non-staff user, an aal1 admin and a deleted admin, and writes nothing", async () => {
    await createUser(db, { status: "suspended" });   // something to list
    const moderator = await createStaff(db, ["moderator"]);
    const reviewer = await createStaff(db, ["reviewer", "moderator"]);
    const plain = await createUser(db);
    const admin = await createStaff(db, ["admin"]);
    const deleted = await createStaff(db, ["admin"]);
    await owner(db, "insert into public.profiles (user_id, display_name, gender, account_status, deleted_at) values ($1, '架空', 'other', 'deleted', now())", [deleted]);
    const revoked = await createStaff(db, ["admin"]);
    await owner(db, "update private.staff_roles set revoked_at = now() where user_id = $1", [revoked]);
    const before = await fingerprint(db);
    for (const session of [staff(moderator), staff(reviewer), staff(plain), user(plain), user(admin), staff(deleted), staff(revoked)]) {
      expect(await raised(() => asUser(db, session, SQL))).toBe("forbidden");
    }
    expect(await fingerprint(db)).toBe(before);
  });

  it("refuses signed-out and anonymous callers; anon and service_role cannot execute it", async () => {
    const anonymous = await createUser(db, { profile: false, anonymous: true });
    const before = await fingerprint(db);
    expect(await raised(() => asUser(db, {}, SQL))).toBe("forbidden");
    expect(await raised(() => asUser(db, { sub: anonymous, aal: "aal2", isAnonymous: true }, SQL))).toBe("forbidden");
    for (const role of ["anon", "service_role"] as const) {
      expect(await raised(() => asRole(db, role, null, SQL))).toMatch(/permission denied/);
    }
    expect(await fingerprint(db)).toBe(before);
  });

  it("is a volatile security definer with an empty search_path, executable by authenticated only", async () => {
    const [fn] = await owner<{ definer: boolean; volatility: string; config: string[]; args: number; acl: string[] }>(db, `
      select p.prosecdef as definer, p.provolatile::text as volatility, p.proconfig as config, p.pronargs as args,
             array(select a.grantee::regrole::text || ':' || a.privilege_type from aclexplode(p.proacl) a order by 1) as acl
      from pg_proc p where p.oid = 'public.admin_list_suspended_accounts()'::regprocedure`);
    expect(fn).toEqual({ definer: true, volatility: "v", config: ['search_path=""'], args: 0, acl: ["authenticated:EXECUTE", "postgres:EXECUTE"] });
  });

  it("leaves admin_set_account_status unchanged: reactivation by an admin is audited with from and to", async () => {
    const admin = await createStaff(db, ["admin"]);
    const target = await createUser(db);
    await setStatus(admin, target, "suspended", "spam");
    expect((await list(admin)).map(r => r.user_id)).toContain(target);
    await setStatus(admin, target, "active", null);
    expect((await list(admin)).map(r => r.user_id)).not.toContain(target);
    expect(await owner(db, `select detail from private.audit_log where action = 'set_account_status' and target_id = $1 order by id`, [target]))
      .toEqual([{ detail: { from: "active", to: "suspended", reason: "spam" } }, { detail: { from: "suspended", to: "active", reason: null } }]);
  });
});
