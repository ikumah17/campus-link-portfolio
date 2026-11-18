// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ create: vi.fn(), mode: vi.fn(), rpc: vi.fn(), revalidate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: m.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: m.create }));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidate }));
import { grantRole, revokeRole } from "@/server/admin-staff-actions";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email = "staff@example.invalid";
const handle = createHash("sha256").update(id).digest("hex");
const row = { user_id: id, display_name: "Staff", roles: ["admin"], is_me: true, acting: [true] };
const ok = { data: { ok: true, code: "ok", ref: id }, error: null };
let network: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks(); m.mode.mockReturnValue("supabase"); m.create.mockResolvedValue({ rpc: m.rpc });
  m.rpc.mockImplementation(async name => name === "admin_list_staff" ? { data: [row], error: null } : ok);
  network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("network"));
});
afterEach(() => { expect(network).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
it.each([[null, "admin"], [1, "admin"], ["a@", "admin"], ["email", "admin"], ["a@@b", "admin"], ["a".repeat(253) + "@b", "admin"], [email, null], [email, "owner"], [email, "toString"]])("validates grant before client creation %#", async (value, role) => {
  expect(await grantRole(value, role)).toEqual({ status: "invalid" }); expect(m.create).not.toHaveBeenCalled();
});
it.each([[null, "admin"], [id, "admin"], [handle.toUpperCase(), "admin"], ["g".repeat(64), "admin"], [handle, null], [handle, "owner"]])("validates revoke before client creation %#", async (value, role) => {
  expect(await revokeRole(value, role)).toEqual({ status: "invalid" }); expect(m.create).not.toHaveBeenCalled();
});
it.each(["admin", "moderator", "reviewer"])("forwards exact grant arguments for %s and returns only status", async role => {
  expect(await grantRole(` ${email} `, role)).toEqual({ status: "ok" });
  expect(m.rpc).toHaveBeenCalledExactlyOnceWith("admin_grant_role_by_email", { p_email: email, p_role: role });
  expect(m.revalidate).toHaveBeenCalledExactlyOnceWith("/admin/staff");
});
it("accepts the maximum email length", async () => {
  const value = "a".repeat(252) + "@b";
  expect(await grantRole(value, "admin")).toEqual({ status: "ok" });
  expect(m.rpc).toHaveBeenCalledWith("admin_grant_role_by_email", { p_email: value, p_role: "admin" });
});
it("re-reads the target each time and resolves the handle only on the server", async () => {
  expect(await revokeRole(handle, "admin")).toEqual({ status: "ok" });
  expect(m.rpc.mock.calls).toEqual([["admin_list_staff", {}], ["admin_revoke_role", { p_user: id, p_role: "admin" }]]);
  m.rpc.mockResolvedValueOnce({ data: [], error: null });
  expect(await revokeRole(handle, "admin")).toEqual({ status: "invalid_state" });
  expect(m.rpc.mock.calls.filter(([name]) => name === "admin_revoke_role")).toHaveLength(1);
});
it("rejects forged handles without a revoke call", async () => {
  expect(await revokeRole("0".repeat(64), "admin")).toEqual({ status: "invalid_state" });
  expect(m.rpc).toHaveBeenCalledExactlyOnceWith("admin_list_staff", {});
});
it.each(["grant", "revoke"])("maps %s results without ids, handles, email or provider text", async action => {
  const run = () => action === "grant" ? grantRole(email, "admin") : revokeRole(handle, "admin");
  for (const [code, status] of [["not_available", "not_found"], ["invalid_state", "invalid_state"], ["mfa_required", "mfa_required"], ["rate_limited", "unavailable"]]) {
    m.rpc.mockImplementation(async name => name === "admin_list_staff" ? { data: [row], error: null } : { data: { ok: false, code, ref: id }, error: null });
    expect(await run()).toEqual({ status });
  }
  for (const [code, message, status] of [["P0001", "validation", "invalid"], ["P0001", "forbidden", "forbidden"], ["PGRST302", "private", "unauthenticated"], ["XX000", "private", "unavailable"]]) {
    m.rpc.mockImplementation(async name => name === "admin_list_staff" ? { data: [row], error: null } : { data: null, error: { code, message } });
    expect(await run()).toEqual({ status });
  }
  expect(m.revalidate).not.toHaveBeenCalled();
});
it.each([
  [{ data: null, error: { code: "P0001", message: "forbidden" } }, "forbidden"],
  [{ data: null, error: { code: "PGRST301" } }, "unauthenticated"],
  [{ data: [{ ...row, roles: [] }], error: null }, "unavailable"],
  [{ data: [{ ...row, acting: undefined }], error: null }, "unavailable"],
  [{ data: [{ ...row, acting: ["true"] }], error: null }, "unavailable"],
])("fails closed on list failures %#", async (response, status) => {
  m.rpc.mockResolvedValue(response);
  expect(await revokeRole(handle, "admin")).toEqual({ status });
  expect(m.rpc).toHaveBeenCalledExactlyOnceWith("admin_list_staff", {});
});
it("contains demo and thrown failures without network", async () => {
  m.mode.mockReturnValue("demo");
  expect(await grantRole(email, "admin")).toEqual({ status: "unavailable" });
  expect(await revokeRole(handle, "admin")).toEqual({ status: "unavailable" });
  expect(m.create).not.toHaveBeenCalled();
  m.mode.mockReturnValue("supabase"); m.create.mockRejectedValue(Error("private"));
  expect(await grantRole(email, "admin")).toEqual({ status: "unavailable" });
  expect(await revokeRole(handle, "admin")).toEqual({ status: "unavailable" });
});
