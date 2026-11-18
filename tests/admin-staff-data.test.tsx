// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { listStaff } from "@/server/admin-staff";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const handle = createHash("sha256").update(id).digest("hex");
const row = { user_id: id, display_name: "担当者", roles: ["admin", "reviewer"], is_me: true, acting: [true, false] };
const rpc = vi.fn();
let network: ReturnType<typeof vi.spyOn>;
beforeEach(() => { vi.resetAllMocks(); network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("network")); });
afterEach(() => { expect(network).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
it("projects only safe fields, exact hashes and Unicode names", async () => {
  rpc.mockResolvedValue({ data: [{ ...row, display_name: "😀".repeat(20), email: "private@example.invalid", granted_by: id }], error: null });
  const result = await listStaff({ rpc });
  expect(result).toEqual({ status: "ok", rows: [{ handle, label: `担当 #${handle.slice(0, 8)}`, name: "😀".repeat(20), roles: row.roles, acting: [true, false], isMe: true }] });
  expect(JSON.stringify(result)).not.toContain(id);
  expect(JSON.stringify(result)).not.toContain("private");
  expect(rpc).toHaveBeenCalledExactlyOnceWith("admin_list_staff", {});
});
it("accepts null names and an empty list", async () => {
  rpc.mockResolvedValueOnce({ data: [{ ...row, display_name: null }], error: null }).mockResolvedValueOnce({ data: [], error: null });
  expect(await listStaff({ rpc })).toMatchObject({ status: "ok", rows: [{ name: null }] });
  expect(await listStaff({ rpc })).toEqual({ status: "ok", rows: [] });
});
it.each([
  null, {}, { ...row, user_id: "bad" }, { ...row, user_id: id.toUpperCase() },
  { ...row, display_name: "" }, { ...row, display_name: "😀".repeat(21) }, { ...row, display_name: 2 },
  { ...row, roles: [] }, { ...row, roles: ["admin", "admin"] }, { ...row, roles: ["owner"] },
  { ...row, roles: Array(1) }, { ...row, roles: "admin" }, { ...row, is_me: 1 }, { ...row, is_me: undefined },
  // order 35 acting: aligned 1:1 with roles, booleans only
  { ...row, acting: undefined }, { ...row, acting: null }, { ...row, acting: true }, { ...row, acting: [true] },
  { ...row, acting: [true, false, true] }, { ...row, acting: [true, "false"] }, { ...row, acting: [true, null] },
  { ...row, acting: [1, 0] }, { ...row, acting: Array(2) }, { ...row, acting: {} },
])("rejects malformed rows %#", async value => {
  rpc.mockResolvedValue({ data: [value], error: null });
  expect(await listStaff({ rpc })).toEqual({ status: "unavailable" });
});
it("rejects duplicate people, multiple callers and sparse rows", async () => {
  for (const data of [[row, row], [row, { ...row, user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }], Array(1), { ok: true, code: "ok", ref: null }]) {
    rpc.mockResolvedValue({ data, error: null });
    expect(await listStaff({ rpc })).toEqual({ status: "unavailable" });
  }
});
it.each([["P0001", "forbidden", "forbidden"], ["PGRST301", "private", "unauthenticated"], ["XX000", "private", "unavailable"]])("contains provider errors %s", async (code, message, status) => {
  rpc.mockResolvedValue({ data: null, error: { code, message } });
  expect(await listStaff({ rpc })).toEqual({ status });
});
it("contains thrown failures", async () => {
  rpc.mockRejectedValue(Error("private"));
  expect(await listStaff({ rpc })).toEqual({ status: "unavailable" });
});
