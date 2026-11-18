// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { parseProfile, listProfiles, getProfile, viewerEligible } from "@/server/discover-data";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const row = { user_id: id, display_name: "葵", age: 22, gender: "female", school_name: "大学", department_name: null, class_name: null, bio: null, purposes: [], hobbies: null, photo_ids: [id] };
const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
afterEach(() => expect(fetchSpy).not.toHaveBeenCalled());
const client = (data: unknown, error: { code: string; message: string } | null = null) => ({ rpc: vi.fn(async () => ({ data, error })) });
it("strictly projects fields and normalizes nulls", () => {
  expect(parseProfile({ ...row, birth_date: "secret" })).toEqual({ id, name: "葵", age: 22, gender: "female", school: "大学", department: null, class: null, bio: "", purposes: [], hobbies: [], photoIds: [id] });
  for (const [key, value] of Object.entries(row)) expect(parseProfile({ ...row, [key]: value === null ? undefined : {} })).toBeNull();
  expect(parseProfile({ ...row, photo_ids: [id.toUpperCase()] })).toBeNull();
});
it("reads order 34 purpose codes and refuses unknown, duplicate, malformed or legacy ones", () => {
  const current = row;
  expect(parseProfile({ ...current, purposes: ["friends", "talk"] })).toMatchObject({ id, purposes: ["friends", "talk"] });
  expect(parseProfile({ ...current, purposes: [] })).toMatchObject({ id, purposes: [] });
  const { purposes: _codes, ...legacy } = row;
  expect(parseProfile({ ...legacy, purpose: "自由記述" })).toBeNull();
  for (const purposes of [["romance"], ["friends", "friends"], "friends", null, [null], ["friends", "partner", "hobby", "study", "talk", "talk"]]) {
    expect(parseProfile({ ...current, purposes }), JSON.stringify(purposes)).toBeNull();
  }
});
it("detail asks get_profile with the id only", async () => {
  const c = client([]);
  await getProfile(c, id);
  expect(c.rpc).toHaveBeenCalledWith("get_profile", { p_target: id });
});
it("uses exact arguments and only issues a cursor on full pages", async () => {
  for (const n of [19, 20]) {
    const c = client(Array.from({ length: n }, () => row));
    expect(await listProfiles(c, { genders: [], schoolIds: [] })).toMatchObject({ status: "ok", nextAfter: n === 20 ? id : null });
    // order 34: one list, no mode
    expect(c.rpc).toHaveBeenCalledWith("discover_profiles", { p_min_age: null, p_max_age: null, p_genders: null, p_school_ids: null, p_after: null, p_limit: 20 });
  }
});
it("checks detail cardinality and strips private account fields", async () => {
  expect(await getProfile(client([]), id)).toEqual({ status: "ok", profile: null });
  expect(await getProfile(client([row, row]), id)).toEqual({ status: "unavailable" });
  for (const eligible of [true, false]) expect(await viewerEligible(client([{ eligible, birth_date: "secret" }]))).toBe(eligible);
  expect(JSON.stringify(await getProfile(client([{ ...row, birth_date: "secret" }]), id))).not.toContain("birth_date");
});
it.each([['PGRST301','provider','unauthenticated'], ['P0001','forbidden','unavailable'], ['P0001','validation','unavailable'], ['XX000','provider','unavailable']])("sanitizes %s %s", async (code, message, status) => {
  expect(await getProfile(client(null, { code, message }), id)).toEqual({ status });
});
