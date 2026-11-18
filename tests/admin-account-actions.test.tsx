// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ create: vi.fn(), mode: vi.fn(), rpc: vi.fn(), revalidate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: m.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: m.create }));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidate }));
import { reactivateSuspendedAccount } from "@/server/admin-account-actions";
import { listSuspendedAccounts } from "@/server/admin-accounts";
const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const row = { user_id: id, display_name: "架空停止", suspended_at: null, reason: null };
let network: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks(); m.mode.mockReturnValue("supabase"); m.create.mockResolvedValue({ rpc: m.rpc });
  m.rpc.mockResolvedValue({ data: { ok: true, code: "ok", ref: id }, error: null });
  network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("network"));
});
afterEach(() => { expect(network).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
it.each([null, undefined, 1, "", "not-a-uuid", id.toUpperCase(), `${id} `, { id }])("validates the id before creating a client %#", async value => {
  expect(await reactivateSuspendedAccount(value)).toEqual({ status: "invalid" });
  expect(m.create).not.toHaveBeenCalled(); expect(m.revalidate).not.toHaveBeenCalled();
});
it("calls only the unchanged admin_set_account_status with active and no reason, then refreshes the page", async () => {
  expect(await reactivateSuspendedAccount(id)).toEqual({ status: "ok" });
  expect(m.rpc).toHaveBeenCalledExactlyOnceWith("admin_set_account_status", { p_user: id, p_status: "active", p_reason: null });
  expect(m.revalidate).toHaveBeenCalledExactlyOnceWith("/admin/accounts");
});
it.each([
  [{ data: { ok: false, code: "not_available", ref: null }, error: null }, "invalid_state"],
  [{ data: { ok: false, code: "invalid_state", ref: null }, error: null }, "invalid_state"],
  [{ data: null, error: { code: "P0001", message: "forbidden" } }, "forbidden"],
  [{ data: null, error: { code: "P0001", message: "validation" } }, "invalid"],
  [{ data: null, error: { code: "PGRST301", message: "private" }, status: 401 }, "unauthenticated"],
  [{ data: { ok: false, code: "rate_limited", ref: null }, error: null }, "unavailable"],
  [{ data: null, error: { message: "private" } }, "unavailable"],
  [{ data: "unexpected", error: null }, "unavailable"],
])("maps outcome %#", async (answer, status) => {
  m.rpc.mockResolvedValue(answer);
  expect(await reactivateSuspendedAccount(id)).toEqual({ status });
  expect(m.revalidate).not.toHaveBeenCalled();
});
it("contains a thrown client or RPC failure", async () => {
  m.create.mockRejectedValueOnce(Error("private"));
  expect(await reactivateSuspendedAccount(id)).toEqual({ status: "unavailable" });
  m.rpc.mockRejectedValueOnce(Error("private"));
  expect(await reactivateSuspendedAccount(id)).toEqual({ status: "unavailable" });
});
it("is unavailable in the demo without a client", async () => {
  m.mode.mockReturnValue("demo");
  expect(await reactivateSuspendedAccount(id)).toEqual({ status: "unavailable" }); expect(m.create).not.toHaveBeenCalled();
});
it("after a reactivation the account leaves the list (mocked RPC)", async () => {
  let suspended = [row];
  m.rpc.mockImplementation(async (name: string, args: { p_user?: string }) => {
    if (name === "admin_list_suspended_accounts") return { data: suspended, error: null };
    suspended = suspended.filter(r => r.user_id !== args.p_user);
    return { data: { ok: true, code: "ok", ref: args.p_user }, error: null };
  });
  const client = { rpc: m.rpc };
  expect(await listSuspendedAccounts(client)).toEqual({ status: "ok", rows: [{ userId: id, shortId: "#bbbbbbbb", name: "架空停止", suspendedAt: null, reason: null }] });
  expect(await reactivateSuspendedAccount(id)).toEqual({ status: "ok" });
  expect(await listSuspendedAccounts(client)).toEqual({ status: "ok", rows: [] });
});
it.each([
  [{ data: null, error: { code: "P0001", message: "forbidden" } }, "forbidden"],
  [{ data: null, error: { code: "PGRST301", message: "private" }, status: 401 }, "unauthenticated"],
  [{ data: { ok: true, code: "ok", ref: null }, error: null }, "unavailable"],
  [{ data: [{ ...row, display_name: "" }], error: null }, "unavailable"],
  [{ data: [{ ...row, display_name: "あ".repeat(21) }], error: null }, "unavailable"],
  [{ data: [{ ...row, user_id: "x" }], error: null }, "unavailable"],
  [{ data: [{ ...row, suspended_at: "not a date" }], error: null }, "unavailable"],
  [{ data: [{ ...row, email: "a@example.invalid" }], error: null }, "unavailable"],
])("listSuspendedAccounts fails closed %#", async (answer, status) => {
  m.rpc.mockResolvedValue(answer);
  expect(await listSuspendedAccounts({ rpc: m.rpc })).toEqual({ status });
});
