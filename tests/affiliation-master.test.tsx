// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadAffiliationMaster } from "@/server/affiliation-master";

vi.mock("server-only", () => ({}));
type Row = Record<string, unknown>;
const data: Record<string, Row[]> = {
  schools: [{ id: "s1", name: "A" }, { id: "s2", name: "B" }],
  departments: [{ id: "d1", name: "A1", school_id: "s1" }, { id: "d2", name: "B1", school_id: "s2" }, { id: "orphan", name: "C1", school_id: "missing" }],
  classes: [{ id: "c1", name: "A1", department_id: "d1" }, { id: "c2", name: "B1", department_id: "d1" }, { id: "c3", name: "C1", department_id: "orphan" }, { id: "c4", name: "D1", department_id: "missing" }],
};
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden")); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
function client(failed?: string, throws = false) {
  const calls: unknown[][] = [];
  const from = vi.fn((table: string) => ({ select: (columns: string) => ({ eq: (column: string, active: boolean) => ({ order: async (order: string) => {
    calls.push([table, columns, column, active, order]);
    if (throws) throw new Error("private DB failure");
    return { data: data[table], error: table === failed ? { message: "private DB failure" } : null };
  } }) }) }));
  return { value: { from } as unknown as Parameters<typeof loadAffiliationMaster>[0], calls };
}
it("nests active rows in query order and drops orphans at both levels", async () => {
  const mock = client();
  expect(await loadAffiliationMaster(mock.value)).toEqual([
    { id: "s1", name: "A", departments: [{ id: "d1", name: "A1", classes: [{ id: "c1", name: "A1" }, { id: "c2", name: "B1" }] }] },
    { id: "s2", name: "B", departments: [{ id: "d2", name: "B1", classes: [] }] },
  ]);
  expect(mock.calls).toEqual([
    ["schools", "id,name", "is_active", true, "name"],
    ["departments", "id,name,school_id", "is_active", true, "name"],
    ["classes", "id,name,department_id", "is_active", true, "name"],
  ]);
});
it.each(["schools", "departments", "classes"])("returns null on %s query failure", async (table) => { expect(await loadAffiliationMaster(client(table).value)).toBeNull(); });
it("returns null on a thrown query failure", async () => { expect(await loadAffiliationMaster(client(undefined, true).value)).toBeNull(); });
