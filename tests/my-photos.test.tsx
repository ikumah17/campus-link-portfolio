// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { listMyPhotos } from "@/server/my-photos";
const from = vi.fn(), select = vi.fn(), eq = vi.fn(), order = vi.fn();
const client = { from } as unknown as Pick<SupabaseClient, "from">;
const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks(); fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  from.mockReturnValue({ select }); select.mockReturnValue({ eq }); eq.mockReturnValue({ order });
  order.mockResolvedValue({ data: [{ id, position: 0 }, { id: other, position: 2 }], error: null });
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
it("selects active own rows through RLS, ordered by position, returning only ids", async () => {
  expect(await listMyPhotos(client)).toEqual([id, other]);
  expect(from).toHaveBeenCalledExactlyOnceWith("profile_photos"); expect(select).toHaveBeenCalledExactlyOnceWith("id,position");
  expect(eq).toHaveBeenCalledExactlyOnceWith("status", "active"); expect(order).toHaveBeenCalledExactlyOnceWith("position");
});
it("allows an empty photo list", async () => {
  order.mockResolvedValue({ data: [], error: null }); expect(await listMyPhotos(client)).toEqual([]);
});
it.each([null, {}, [null], [{ id: "bad", position: 0 }], [{ id, position: "0" }], [{ id, position: 6 }]])("fails closed for malformed rows %#", async (data) => {
  order.mockResolvedValue({ data, error: null }); expect(await listMyPhotos(client)).toBeNull();
});
it("returns null for errors and thrown transport failures", async () => {
  order.mockResolvedValue({ data: [], error: { message: "private" } }); expect(await listMyPhotos(client)).toBeNull();
  order.mockRejectedValue(new Error("private")); expect(await listMyPhotos(client)).toBeNull();
});
