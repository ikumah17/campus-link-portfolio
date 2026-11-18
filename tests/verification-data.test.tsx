// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { loadMyVerification } from "@/server/verification-data";
const account = { has_profile: true, age_verified: false, affiliation_status: null, affiliation_confirmed: false, birth_date: "2000-05-05" };
const row = { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", kind: "age", status: "submitted", created_at: "2026-11-06", decided_at: null, decision_reason: null, valid_until: null };
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("forbidden")); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
function client(data: unknown = [row], a: unknown = [account]) {
 const order = vi.fn().mockResolvedValue({ data, error: null }); const select = vi.fn(() => ({ order })); const from = vi.fn(() => ({ select }));
 return { rpc: vi.fn().mockResolvedValue({ data: a, error: null }), from, select, order };
}
it("selects granted columns, newest per kind, and strips private data", async () => {
 const c = client([row, { ...row, id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }, { ...row, kind: "enrollment" }]);
 const r = await loadMyVerification(c); expect(r.status).toBe("ok"); expect(JSON.stringify(r)).not.toContain("birth_date"); expect(JSON.stringify(r)).not.toContain("2000-05-05");
 expect(c.from).toHaveBeenCalledWith("verification_submissions"); expect(c.select).toHaveBeenCalledWith("id,kind,status,created_at,decided_at,decision_reason,valid_until"); expect(c.order).toHaveBeenCalledWith("created_at", { ascending: false });
 if(r.status === "ok") expect(r.age?.id).toBe(row.id);
});
it.each([null, [{}], [{ ...row, status: "bad" }], [{ ...row, id: "bad" }], [{ ...row, valid_until: 2 }]])("fails closed on malformed rows %j", async data => { expect(await loadMyVerification(client(data))).toEqual({ status: "unavailable" }); });
it.each([{ a: [] }, { a: [account, account] }, { a: [{ ...account, age_verified: "yes" }] }])("fails closed on account %j", async ({ a }) => { expect(await loadMyVerification(client([], a))).toEqual({ status: "unavailable" }); });
it("refuses a deleted account before reading its verification history", async () => {
 const c = client([row], [{ ...account, account_status: "deleted" }]);
 expect(await loadMyVerification(c)).toEqual({ status: "unavailable" }); expect(c.from).not.toHaveBeenCalled();
});
it.each(["active", "deactivated", "suspended", null])("keeps the history for a %s account", async (account_status) => {
 expect((await loadMyVerification(client([row], [{ ...account, account_status }]))).status).toBe("ok");
});
it("handles rpc errors and unauthenticated", async () => { const c = client(); c.rpc.mockResolvedValue({ error: { message: "secret" }, data: null }); expect(await loadMyVerification(c)).toEqual({ status: "unavailable" }); c.rpc.mockResolvedValue({ error: null, status: 401 }); expect(await loadMyVerification(c)).toEqual({ status: "unauthenticated" }); });
