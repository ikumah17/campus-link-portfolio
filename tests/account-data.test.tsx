// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { loadAccountState } from "@/server/account-data";
const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("network"));
afterEach(() => expect(network).not.toHaveBeenCalled());
const row = { user_id: "private-id", birth_date: "2000-05-05", profile_completed: true, account_status: "active" };
const client = (data: unknown, error: { code: string; message: string } | null = null) => ({ rpc: vi.fn(async () => ({ data, error })) });
it.each(["active", "deactivated", "suspended"])("returns only the %s status", async (accountStatus) => {
  const c = client([{ ...row, account_status: accountStatus }]);
  const result = await loadAccountState(c);
  expect(result).toEqual({ status: "ok", accountStatus });
  expect(JSON.stringify(result)).not.toMatch(/private-id|2000-05-05/);
  expect(c.rpc).toHaveBeenCalledExactlyOnceWith("my_account", {});
});
it("separates onboarding, deletion, authentication and failures", async () => {
  expect(await loadAccountState(client([{ ...row, profile_completed: false, account_status: null }]))).toEqual({ status: "incomplete" });
  expect(await loadAccountState(client([{ ...row, account_status: "deleted" }]))).toEqual({ status: "deleted" });
  // order 18: a deleted account reads only its id and 'deleted', with profile_completed false
  expect(await loadAccountState(client([{ ...row, birth_date: null, profile_completed: false, account_status: "deleted" }]))).toEqual({ status: "deleted" });
  expect(await loadAccountState(client(null, { code: "PGRST301", message: "secret" }))).toEqual({ status: "unauthenticated" });
  expect(await loadAccountState(client(null, { code: "XX000", message: "secret" }))).toEqual({ status: "unavailable" });
  expect(await loadAccountState({ rpc: () => { throw Error("secret"); } })).toEqual({ status: "unavailable" });
  for (const data of [null, [], [null], [row, row], [{ ...row, account_status: "unknown" }], [{ ...row, account_status: null }], [{ ...row, profile_completed: "true" }], row]) expect(await loadAccountState(client(data))).toEqual({ status: "unavailable" });
});
