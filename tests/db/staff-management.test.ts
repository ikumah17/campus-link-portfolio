// ROLE-001: real local migrations, authorization, private lookup and audit behavior.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { addTotpFactor, createStaff, createUser } from "./fixtures";
import { asRole, asUser, fingerprint, freshDb, owner, rpc, staff } from "./harness";

let db: PGlite, admin: string;
const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("network"));
beforeAll(async () => { db = await freshDb(); admin = await createStaff(db, ["admin"]); });
afterAll(async () => { expect(network).not.toHaveBeenCalled(); await db?.close(); vi.restoreAllMocks(); });
const grant = (email: unknown, role: unknown = "moderator", caller = admin) => rpc(db, staff(caller), "admin_grant_role_by_email", [email, role], ["text", "public.staff_role"]);
async function emailOf(id: string) {
  const [row] = await owner<{ email: string }>(db, "select email from auth.users where id = $1", [id]);
  return row.email;
}
it("lists every active staff once, ordered, with sorted roles and caller identity; reads have no audit", async () => {
  const named = await createUser(db, { displayName: "A担当" });
  await owner(db, "insert into private.staff_roles(user_id,role) values ($1,'admin'),($1,'reviewer'),($1,'moderator')", [named]);
  const revoked = await createStaff(db, ["reviewer"]);
  await owner(db, "update private.staff_roles set revoked_at = now() where user_id=$1", [revoked]);
  const before = await fingerprint(db);
  const rows = await asUser<{ user_id: string; display_name: string | null; roles: string[]; is_me: boolean; acting: boolean[] }>(db, staff(admin), "select * from public.admin_list_staff()");
  // the named account has no TOTP factor, so none of its roles acts (order 35 acting, aligned with roles)
  expect(rows).toEqual([
    { user_id: named, display_name: "A担当", roles: ["reviewer", "moderator", "admin"], is_me: false, acting: [false, false, false] },
    { user_id: admin, display_name: null, roles: ["admin"], is_me: true, acting: [true] },
  ]);
  expect(await fingerprint(db)).toBe(before);
  expect(await rpc(db, staff(admin), "admin_revoke_role", [named, "reviewer"], ["uuid", "public.staff_role"])).toMatchObject({ ok: true });
  const updated = await asUser<{ user_id: string; roles: string[] }>(db, staff(admin), "select * from public.admin_list_staff()");
  expect(updated.find(r => r.user_id === named)?.roles).toEqual(["moderator", "admin"]);
});
it.each(["moderator", "reviewer", "ordinary"])("denies a %s before input validation or any email read", async role => {
  const caller = role === "ordinary" ? await createUser(db) : await createStaff(db, [role as "moderator" | "reviewer"]);
  const before = await fingerprint(db);
  await expect(asUser(db, staff(caller), "select * from public.admin_list_staff()")).rejects.toThrow("forbidden");
  await expect(grant(null, null, caller)).rejects.toThrow("forbidden");
  await expect(grant("missing@example.invalid", "admin", caller)).rejects.toThrow("forbidden");
  expect(await fingerprint(db)).toBe(before);
});
it("rejects aal1 and missing sessions; anon and service have no execute", async () => {
  for (const sql of ["select * from public.admin_list_staff()", "select * from public.admin_grant_role_by_email(null,null)"]) {
    await expect(asUser(db, { sub: admin, aal: "aal1" }, sql)).rejects.toThrow("forbidden");
    await expect(asUser(db, {}, sql)).rejects.toThrow("forbidden");
    for (const role of ["anon", "service_role"] as const) await expect(asRole(db, role, null, sql)).rejects.toThrow(/permission denied/);
  }
});
it("grants exact and case-insensitive emails with exactly one audit per grant and no target in the result", async () => {
  const target = await createUser(db), email = await emailOf(target);
  await addTotpFactor(db, target);
  const before = await owner(db, "select * from private.audit_log order by id");
  for (const [value, role] of [[email, "moderator"], [` ${email.toUpperCase()} `, "reviewer"]]) {
    expect(await grant(value, role)).toEqual({ ok: true, code: "ok", ref: null });
  }
  const after = await owner<{ actor_id: string; action: string; target_type: string; target_id: string; detail: unknown }>(db, "select * from private.audit_log order by id");
  expect(after.slice(before.length).map(({ actor_id, action, target_type, target_id, detail }) => ({ actor_id, action, target_type, target_id, detail }))).toEqual([
    { actor_id: admin, action: "grant_role", target_type: "staff_role", target_id: target, detail: { role: "moderator" } },
    { actor_id: admin, action: "grant_role", target_type: "staff_role", target_id: target, detail: { role: "reviewer" } },
  ]);
  const snapshot = await fingerprint(db);
  expect(await grant(email)).toEqual({ ok: false, code: "invalid_state", ref: null });
  expect(await fingerprint(db)).toBe(snapshot);
});
it("returns the same miss for unknown, unconfirmed, anonymous and ambiguous emails without any write", async () => {
  const unconfirmed = await createUser(db, { emailConfirmed: false }), anonymous = await createUser(db, { anonymous: true });
  const ambiguousA = await createUser(db), ambiguousB = await createUser(db);
  await owner(db, "update auth.users set email=$2 where id=$1", [ambiguousA, "CASE@example.invalid"]);
  await owner(db, "update auth.users set email=$2 where id=$1", [ambiguousB, "case@example.invalid"]);
  const before = await fingerprint(db);
  for (const email of ["missing@example.invalid", await emailOf(unconfirmed), await emailOf(anonymous), "case@example.invalid"]) {
    expect(await grant(email)).toEqual({ ok: false, code: "not_available", ref: null });
  }
  expect(await fingerprint(db)).toBe(before);
});
it("requires auth_account_ok even when the other account predicates match", async () => {
  const isolated = await freshDb();
  try {
    const caller = await createStaff(isolated, ["admin"]), target = await createUser(isolated);
    // Test-only stricter eligibility policy; preserve the caller's own current-session check.
    await isolated.exec(`create or replace function private.auth_account_ok(p_user uuid) returns boolean
      language sql stable security definer set search_path = '' as $$
      select p_user <> '${target}'::uuid and coalesce((select email_confirmed_at is not null and is_anonymous = false from auth.users where id=p_user),false) $$;`);
    const before = await fingerprint(isolated);
    expect(await rpc(isolated, staff(caller), "admin_grant_role_by_email", [`fixture-${target}@example.invalid`, "admin"], ["text", "public.staff_role"]))
      .toEqual({ ok: false, code: "not_available", ref: null });
    expect(await fingerprint(isolated)).toBe(before);
  } finally { await isolated.close(); }
});
it.each([[null, "admin"], ["ab", "admin"], ["abc", "admin"], ["a@@b", "admin"], ["a".repeat(253) + "@b", "admin"], ["a@b", null]])("validates inputs without writes %#", async (email, role) => {
  const before = await fingerprint(db);
  await expect(grant(email, role)).rejects.toThrow("validation");
  expect(await fingerprint(db)).toBe(before);
});
