// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { getSubmission, listSubmissions } from "@/server/admin-verifications";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const user = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const list = { id, user_id: user, kind: "age", status: "submitted", reviewer_id: null, claimed_at: null, version: 0, created_at: "2026-11-06T00:00:00+00:00" };
const detail = { id, user_id: user, kind: "age", status: "in_review", version: 1, birth_date: "2000-01-01", school_name: "School", department_name: null, class_name: null, document_refs: ["private/raw/ref"], created_at: list.created_at };
let fetchSpy: ReturnType<typeof vi.spyOn>;
const rpc = vi.fn();
beforeEach(() => { rpc.mockReset(); fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden")); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
const result = (data: unknown, error: unknown = null, status?: number) => rpc.mockResolvedValue({ data, error, status });
it("keeps only listed columns and calls each audited RPC once", async () => {
  result([{ ...list, secret: "not for screen" }]);
  expect(await listSubmissions({ rpc }, "submitted", user)).toEqual({ status: "ok", submissions: [{ id, kind: list.kind, status: list.status, assignedToMe: false, version: 0, created_at: list.created_at }] });
  expect(rpc).toHaveBeenCalledExactlyOnceWith("admin_list_submissions", { p_status: "submitted" });
});
it("handles empty list and zero detail rows", async () => {
  result([]);
  expect(await listSubmissions({ rpc }, "submitted", user)).toEqual({ status: "ok", submissions: [] });
  expect(await getSubmission({ rpc }, id)).toEqual({ status: "ok", submission: null });
});
it("reduces references to count and removes unrelated personal fields", async () => {
  result([detail]);
  const r = await getSubmission({ rpc }, id);
  expect(r).toEqual({ status: "ok", submission: { id, kind: "age", status: "in_review", version: 1, birth_date: "2000-01-01", documentCount: 1, created_at: list.created_at } });
  expect(JSON.stringify(r)).not.toMatch(/private\/raw\/ref|document_refs|School|user_id/);
  expect(rpc).toHaveBeenCalledExactlyOnceWith("admin_get_submission", { p_id: id });
  result([{ ...detail, kind: "enrollment" }]);
  const enrollment = await getSubmission({ rpc }, id);
  expect(JSON.stringify(enrollment)).not.toMatch(/birth_date|2000-01-01|private\/raw\/ref/);
  expect(enrollment).toMatchObject({ status: "ok", submission: { school_name: "School", department_name: null, class_name: null } });
});
it("accepts the database limit of four documents and no more", async () => {
  result([{ ...detail, document_refs: ["a", "b", "c", "d"] }]);
  expect(await getSubmission({ rpc }, id)).toMatchObject({ status: "ok", submission: { documentCount: 4 } });
  result([{ ...detail, document_refs: ["a", "b", "c", "d", "e"] }]);
  expect(await getSubmission({ rpc }, id)).toEqual({ status: "unavailable" });
});
it.each([null, {}, [detail, detail], [null], [{ ...detail, id: user }], [{ ...detail, user_id: "x" }], [{ ...detail, status: "approved" }], [{ ...detail, kind: "x" }], [{ ...detail, version: 1.5 }], [{ ...detail, birth_date: "2026-02-30" }], [{ ...detail, birth_date: "2026-99-01" }], [{ ...detail, school_name: 1 }], [{ ...detail, document_refs: [] }], [{ ...detail, document_refs: [1] }], [{ ...detail, created_at: "bad" }]])("rejects malformed detail %#", async data => {
  result(data); expect(await getSubmission({ rpc }, id)).toEqual({ status: "unavailable" });
});
it.each([null, {}, [null], [{ ...list, id: "bad" }], [{ ...list, user_id: "bad" }], [{ ...list, kind: "x" }], [{ ...list, status: "in_review" }], [{ ...list, reviewer_id: "bad" }], [{ ...list, claimed_at: 2 }], [{ ...list, version: -1 }], [{ ...list, created_at: null }]])("rejects malformed list %#", async data => {
  result(data); expect(await listSubmissions({ rpc }, "submitted", user)).toEqual({ status: "unavailable" });
});
it.each([[{ code: "P0001", message: "forbidden" }, undefined, "forbidden"], [{ code: "PGRST301", message: "private" }, undefined, "unauthenticated"], [null, 401, "unauthenticated"], [{ message: "private" }, undefined, "unavailable"], [{ code: "P0001", message: "validation" }, undefined, "unavailable"]])("maps errors without provider text %#", async (error, status, expected) => {
  result(null, error, status as number | undefined);
  expect(await listSubmissions({ rpc }, "submitted", user)).toEqual({ status: expected });
  expect(await getSubmission({ rpc }, id)).toEqual({ status: expected });
});

it.each([null, user, id])("projects reviewer ownership %s without raw ids", async reviewer => {
  result([{ ...list, reviewer_id: reviewer }]);
  expect(await listSubmissions({ rpc }, "submitted", user)).toEqual({ status: "ok", submissions: [{ id, kind: "age", status: "submitted", assignedToMe: reviewer === user, version: 0, created_at: list.created_at }] });
});
it.each(["", "bad", user.toUpperCase(), `${user}\n`])("refuses malformed caller before RPC %#", async me => {
  expect(await listSubmissions({ rpc }, "submitted", me)).toEqual({ status: "unavailable" });
  expect(rpc).not.toHaveBeenCalled();
});
