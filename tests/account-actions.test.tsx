// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ mode: "supabase", create: vi.fn(), rpc: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), redirect: vi.fn((path: string) => { throw Error("redirect:" + path); }) }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: () => m.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: m.create }));
vi.mock("next/cache", () => ({ revalidatePath: m.refresh }));
vi.mock("next/navigation", () => ({ redirect: m.redirect }));
import { deleteAccount, pauseAccount, resumeAccount } from "@/server/account-actions";
import { DELETE_CONFIRMATION } from "@/server/account-rules";
const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("network"));
beforeEach(() => {
  vi.clearAllMocks(); m.mode = "supabase";
  m.create.mockResolvedValue({ rpc: m.rpc, auth: { signOut: m.signOut } });
  m.rpc.mockResolvedValue({ data: { ok: true, code: "ok", ref: null }, error: null });
  m.signOut.mockResolvedValue({ error: null });
});
afterEach(() => expect(network).not.toHaveBeenCalled());

it.each([[pauseAccount, "deactivate_account"], [resumeAccount, "reactivate_account"]] as const)("%o calls only its own RPC with no arguments and revalidates", async (action, name) => {
  expect(await action()).toEqual({ status: "ok" });
  expect(m.rpc).toHaveBeenCalledExactlyOnceWith(name, {});
  expect(m.refresh.mock.calls).toEqual([["/settings/account"], ["/mypage"]]);
  expect(m.signOut).not.toHaveBeenCalled();
});
it.each([
  [{ data: { ok: false, code: "invalid_state" }, error: null }, "invalid_state"],
  [{ data: null, error: { code: "P0001", message: "forbidden" } }, "forbidden"],
  [{ data: null, error: { code: "PGRST301", message: "secret" } }, "unauthenticated"],
  [{ data: null, error: { code: "P0001", message: "validation" } }, "unavailable"],
  [{ data: { ok: false, code: "rate_limited" }, error: null }, "unavailable"],
  [{ data: null, error: { code: "XX000", message: "secret" } }, "unavailable"],
])("maps toggle response %#", async (response, status) => {
  for (const action of [pauseAccount, resumeAccount]) {
    m.rpc.mockResolvedValue(response);
    expect(await action()).toEqual({ status });
  }
  expect(m.refresh).not.toHaveBeenCalled();
});
it("fails closed on throws and in demo", async () => {
  m.create.mockRejectedValue(Error("secret"));
  expect(await pauseAccount()).toEqual({ status: "unavailable" });
  expect(await deleteAccount(DELETE_CONFIRMATION)).toEqual({ status: "unavailable" });
  m.create.mockClear(); m.mode = "demo";
  for (const action of [pauseAccount, resumeAccount, () => deleteAccount(DELETE_CONFIRMATION)]) expect(await action()).toEqual({ status: "unavailable" });
  expect(m.create).not.toHaveBeenCalled();
});
it("never creates a client without the exact confirmation word", async () => {
  for (const value of [undefined, null, "", "退会", " 退会する", "退会する ", "退会する\n", ["退会する"], { value: "退会する" }, 1]) expect(await deleteAccount(value)).toEqual({ status: "invalid" });
  expect(m.create).not.toHaveBeenCalled(); expect(m.rpc).not.toHaveBeenCalled(); expect(m.signOut).not.toHaveBeenCalled();
});
it("deletes with the own session, ends every session, then redirects to the public completion page", async () => {
  await expect(deleteAccount(DELETE_CONFIRMATION)).rejects.toThrow("redirect:/settings/account/deleted");
  expect(m.rpc).toHaveBeenCalledExactlyOnceWith("request_account_deletion", {});
  expect(m.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "global" });
  expect(m.rpc.mock.invocationCallOrder[0]).toBeLessThan(m.signOut.mock.invocationCallOrder[0]);
});
it("still redirects after the deletion when sign-out fails", async () => {
  m.signOut.mockResolvedValue({ error: { status: 500 } });
  await expect(deleteAccount(DELETE_CONFIRMATION)).rejects.toThrow("redirect:/settings/account/deleted");
  m.signOut.mockRejectedValue(Error("network"));
  await expect(deleteAccount(DELETE_CONFIRMATION)).rejects.toThrow("redirect:/settings/account/deleted");
});
it.each([
  [{ data: null, error: { code: "P0001", message: "forbidden" } }, "forbidden"],
  [{ data: { ok: false, code: "invalid_state" }, error: null }, "invalid_state"],
  [{ data: null, error: { code: "PGRST302", message: "secret" } }, "unauthenticated"],
  [{ data: null, error: { code: "XX000", message: "secret" } }, "unavailable"],
])("a refused deletion keeps the session and does not redirect %#", async (response, status) => {
  m.rpc.mockResolvedValue(response);
  expect(await deleteAccount(DELETE_CONFIRMATION)).toEqual({ status });
  expect(m.signOut).not.toHaveBeenCalled(); expect(m.redirect).not.toHaveBeenCalled();
});
