// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { addTotpFactor, createStaff, createUser } from "./db/fixtures";
import { asUser, fingerprint, freshDb, owner, staff } from "./db/harness";
import type { RpcClient } from "@/server/rpc";
const m = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: () => "supabase" }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: m.create }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { listStaff, staffHandle } from "@/server/admin-staff";
import { grantRole, revokeRole } from "@/server/admin-staff-actions";
let db: PGlite, admin: string;
const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("network"));
function client(me: string): RpcClient {
  return { async rpc(name, args) {
    const casts: Record<string, string> = { p_email: "text", p_role: "public.staff_role", p_user: "uuid" };
    try {
      const rows = await asUser(db, staff(me), `select * from public.${name}(${Object.keys(args).map((key, i) => `${key}=>$${i + 1}::${casts[key]}`).join(",")})`, Object.values(args));
      return { data: name === "admin_list_staff" ? rows : rows[0], error: null };
    } catch (error) { const e = error as { code: string; message: string }; return { data: null, error: { code: e.code, message: e.message } }; }
  } };
}
beforeAll(async () => { db = await freshDb(); admin = await createStaff(db, ["admin"]); m.create.mockResolvedValue(client(admin)); }, 180000);
afterAll(async () => { expect(network).not.toHaveBeenCalled(); await db?.close(); vi.restoreAllMocks(); });
it("retains the last-admin rule through the complete server action path", async () => {
  const result = await listStaff(client(admin));
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw Error("list failed");
  const me = result.rows.find(r => r.isMe)!;
  expect(JSON.stringify(me)).not.toContain(admin);
  const before = await fingerprint(db);
  expect(await revokeRole(me.handle, "admin")).toEqual({ status: "invalid_state" });
  expect(await fingerprint(db)).toBe(before);
});
it("grants, re-reads and revokes without exposing ids or persisting email in audit", async () => {
  const target = await createUser(db), email = `fixture-${target}@example.invalid`;
  await addTotpFactor(db, target);
  expect(await grantRole(email.toUpperCase(), "moderator")).toEqual({ status: "ok" });
  expect(await grantRole(email, "moderator")).toEqual({ status: "invalid_state" });
  const result = await listStaff(client(admin));
  if (result.status !== "ok") throw Error("list failed");
  const row = result.rows.find(r => !r.isMe)!;
  expect(JSON.stringify(result)).not.toContain(target);
  expect(await revokeRole(row.handle, "moderator")).toEqual({ status: "ok" });
  expect(await revokeRole(row.handle, "moderator")).toEqual({ status: "invalid_state" });
  expect(JSON.stringify(await owner(db, "select * from private.audit_log"))).not.toContain(email);
});
it("refuses a target without a verified TOTP factor through the server action path, with no write (SEC-003)", async () => {
  const target = await createUser(db), email = `fixture-${target}@example.invalid`;
  await addTotpFactor(db, target, "unverified");
  const before = await fingerprint(db);
  expect(await grantRole(email, "reviewer")).toEqual({ status: "mfa_required" });
  expect(await fingerprint(db)).toBe(before);
});
it("lists acting through the server path: true for an acting role, false after a newer verified factor (STAFF-001)", async () => {
  const target = await createStaff(db, ["moderator"]);
  const read = async () => {
    const result = await listStaff(client(admin));
    if (result.status !== "ok") throw Error("list failed");
    return result;
  };
  const before = await read(), handles = before.rows.map(r => r.handle);
  expect(before.rows.find(r => r.isMe)).toMatchObject({ roles: ["admin"], acting: [true] });
  expect(before.rows.find(r => r.handle === staffHandle(target))).toMatchObject({ roles: ["moderator"], acting: [true] });
  const factor = await addTotpFactor(db, target);
  await owner(db, "update auth.mfa_factors set created_at = now() + interval '1 minute' where id = $1", [factor]);
  const after = await read();
  expect(after.rows.map(r => r.handle)).toEqual(handles);
  expect(after.rows.find(r => r.handle === staffHandle(target))).toMatchObject({ roles: ["moderator"], acting: [false], isMe: false });
  expect(JSON.stringify(after)).not.toContain(target);
  await owner(db, "update private.staff_roles set revoked_at = now() where user_id = $1", [target]);
});
it("revoking your own admin role works only with another admin; subsequent writes are forbidden", async () => {
  await createStaff(db, ["admin"]);
  const result = await listStaff(client(admin));
  if (result.status !== "ok") throw Error("list failed");
  expect(await revokeRole(result.rows.find(r => r.isMe)!.handle, "admin")).toEqual({ status: "ok" });
  expect(await listStaff(client(admin))).toEqual({ status: "forbidden" });
  expect(await grantRole("missing@example.invalid", "admin")).toEqual({ status: "forbidden" });
});
