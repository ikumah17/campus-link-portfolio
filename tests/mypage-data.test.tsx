// @vitest-environment node
import { it, expect, vi, afterEach } from "vitest";
vi.mock("server-only", () => ({}));
import { loadMyPage } from "@/server/mypage-data";
const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("network"));
afterEach(() => expect(network).not.toHaveBeenCalled());
const row = { account_status: "active", profile_completed: true, age_verified: true, affiliation_status: "confirmed", affiliation_confirmed: true, eligible: true, user_id: "private-id", birth_date: "2000-05-05" };
function client(rows: unknown = [row], names: unknown = [{ display_name: "Alice" }], error: unknown = null) {
  return { rpc: async () => ({ data: rows, error }), from: () => ({ select: () => ({ limit: async () => ({ data: names, error: null }) }) }) } as never;
}
it("returns only the safe projection", async () => {
  const result = await loadMyPage(client());
  expect(result).toEqual({ status: "ok", page: { name: "Alice", accountStatus: "active", ageVerified: true, affiliation: "confirmed", eligible: true } });
  expect(JSON.stringify(result)).not.toMatch(/private-id|2000-05-05|user_id|birth_date/);
});
it.each(["confirmed", "pending", "rejected", "unconfirmed", "expired"])("maps %s", async state => {
  expect(await loadMyPage(client([{ ...row, affiliation_status: state === "expired" ? "confirmed" : state, affiliation_confirmed: state !== "expired" }]))).toMatchObject({ status: "ok", page: { affiliation: state } });
});
it("handles onboarding, authentication and provider failures", async () => {
  expect(await loadMyPage(client([{ ...row, profile_completed: false }]))).toEqual({ status: "incomplete" });
  expect(await loadMyPage(client([{ ...row, account_status: "deactivated", eligible: false }]))).toMatchObject({ status: "ok", page: { accountStatus: "deactivated" } });
  expect(await loadMyPage(client([{ ...row, account_status: "deleted", eligible: false }]))).toEqual({ status: "unavailable" });
  // order 18: a deleted account reads only its id and 'deleted', with every flag false and nulls elsewhere
  expect(await loadMyPage(client([{ user_id: "private-id", account_status: "deleted", profile_completed: false, age_verified: false, affiliation_status: null, affiliation_confirmed: false, eligible: false, birth_date: null }]))).toEqual({ status: "unavailable" });
  expect(await loadMyPage(client(null, [], { code: "PGRST301", message: "secret" }))).toEqual({ status: "unauthenticated" });
  expect(await loadMyPage(client(null, [], { code: "XX000", message: "secret" }))).toEqual({ status: "unavailable" });
  expect(await loadMyPage({ rpc: () => { throw Error("secret"); } } as never)).toEqual({ status: "unavailable" });
});
it("rejects malformed, missing and ambiguous data", async () => {
  for (const rows of [null, [], [null], [row, row], ...Object.keys(row).filter(k => !["user_id", "birth_date"].includes(k)).map(k => [{ ...row, [k]: "wrong" }])]) expect(await loadMyPage(client(rows))).toEqual({ status: "unavailable" });
  for (const names of [null, [], [null], [{ display_name: "A" }, { display_name: "B" }], [{ display_name: "" }], [{ display_name: " " }], [{ display_name: "x".repeat(21) }], [{ display_name: 2 }]]) expect(await loadMyPage(client([row], names))).toEqual({ status: "unavailable" });
});
