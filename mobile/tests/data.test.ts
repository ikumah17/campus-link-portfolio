import {
  accountGate, listMyPhotos, loadMyPage, loadMyVerification, submitVerification, withdrawVerification, type DataClient,
} from "../src/account-data";
import { birthDateOf, completeOnboarding, invalidStep, loadOnboarding, saveOnboarding } from "../src/onboarding-data";
import { callRpc, RPC_NAMES } from "../src/rpc";
import {
  accountRow, CLASS, DEPT, done, fakeSupabase, masterTables, ok, PHOTO_A, PHOTO_B, raised, refusal, SCHOOL, SUBMISSION,
} from "./fake-supabase";

const client = (fake: ReturnType<typeof fakeSupabase>) => fake as unknown as DataClient;
const input = {
  displayName: "架空の学生", gender: "other", birthDate: "2000-04-01", adultDeclared: true,
  schoolId: SCHOOL, departmentId: DEPT, classId: CLASS, purposes: ["friends", "study"], bio: "よろしく",
};

describe("RPC client", () => {
  it("uses only the app's RPC names, never admin_* or service_*", async () => {
    expect(RPC_NAMES.some((name) => name.startsWith("admin_") || name.startsWith("service_"))).toBe(false);
    const fake = fakeSupabase(() => ok([]));
    await expect(callRpc(fake, "admin_list_reports" as never)).rejects.toThrow("Unknown RPC name");
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it("maps answers like the web's src/server/rpc.ts", async () => {
    const answers = [
      [ok([{ a: 1 }]), { code: "ok", data: [{ a: 1 }] }],
      [done(), { code: "ok", data: { ref: null } }],
      [refusal("invalid_state"), { code: "invalid_state", data: null }],
      [refusal("made_up"), { code: "unavailable", data: null }],
      [raised("validation"), { code: "validation", data: null }],
      [{ data: null, error: { code: "PGRST301" }, status: 401 }, { code: "unauthenticated", data: null }],
      [{ data: null, error: { code: "XX000", message: "secret detail" }, status: 500 }, { code: "unavailable", data: null }],
    ] as const;
    for (const [answer, expected] of answers) expect(await callRpc(fakeSupabase(() => answer), "my_account")).toEqual(expected);
  });
});

describe("account gate", () => {
  it.each([
    [accountRow(), "complete"],
    [accountRow({ profile_completed: false }), "onboarding"],
    [accountRow({ has_profile: false, profile_completed: false, account_status: null }), "onboarding"],
    [accountRow({ account_status: "deleted", profile_completed: false }), "deleted"],
  ])("sends %o to %s", async (row, status) => {
    expect(await accountGate(fakeSupabase(() => ok([row])))).toEqual({ status });
  });

  it("fails closed", async () => {
    expect(await accountGate(fakeSupabase(() => ok([])))).toEqual({ status: "unavailable" });
    expect(await accountGate(fakeSupabase(() => ({ data: null, error: null, status: 401 })))).toEqual({ status: "unauthenticated" });
  });
});

describe("my page", () => {
  it("reads the account and the own display name", async () => {
    const fake = fakeSupabase(() => ok([accountRow({ affiliation_status: "confirmed", affiliation_confirmed: false })]),
      { profiles: { data: [{ display_name: "架空の学生" }], error: null } });
    expect(await loadMyPage(client(fake))).toEqual({ status: "ok", page: {
      name: "架空の学生", accountStatus: "active", ageVerified: false, affiliation: "expired", eligible: false,
    } });
    expect(fake.queries[0]).toEqual({ table: "profiles", calls: [["select", "display_name"], ["limit", 2]] });
  });

  it("sends an unfinished profile to onboarding and hides a deleted account", async () => {
    expect(await loadMyPage(client(fakeSupabase(() => ok([accountRow({ profile_completed: false })]))))).toEqual({ status: "incomplete" });
    expect(await loadMyPage(client(fakeSupabase(() => ok([accountRow({ account_status: "deleted", profile_completed: false })]))))).toEqual({ status: "unavailable" });
  });

  it("lists the active photos in order and refuses malformed rows", async () => {
    const good = fakeSupabase(() => ok([]), { profile_photos: { data: [{ id: PHOTO_A, position: 0 }, { id: PHOTO_B, position: 1 }], error: null } });
    expect(await listMyPhotos(client(good))).toEqual([PHOTO_A, PHOTO_B]);
    expect(good.queries[0].calls).toEqual([["select", "id,position"], ["eq", "status", "active"], ["order", "position"]]);
    const bad = fakeSupabase(() => ok([]), { profile_photos: { data: [{ id: "x", position: 0 }], error: null } });
    expect(await listMyPhotos(client(bad))).toBeNull();
  });
});

describe("verification", () => {
  const submission = { id: SUBMISSION, kind: "age", status: "submitted", created_at: "2026-11-17T00:00:00Z", decided_at: null, decision_reason: null, valid_until: null };

  it("reads the account and the latest submission of each kind", async () => {
    const fake = fakeSupabase(() => ok([accountRow()]), { verification_submissions: { data: [submission], error: null } });
    expect(await loadMyVerification(client(fake))).toEqual({
      status: "ok",
      account: { has_profile: true, age_verified: false, affiliation_status: "unconfirmed", affiliation_confirmed: false },
      age: submission, enrollment: null,
    });
  });

  it("hides a deleted account's history", async () => {
    const fake = fakeSupabase(() => ok([accountRow({ account_status: "deleted" })]), { verification_submissions: { data: [submission], error: null } });
    expect(await loadMyVerification(client(fake))).toEqual({ status: "unavailable" });
    expect(fake.from).not.toHaveBeenCalled();
  });

  it("submits only the synthetic samples", async () => {
    const fake = fakeSupabase(() => done());
    expect(await submitVerification(fake, "age", ["synthetic:sample-1", "synthetic:sample-3"])).toEqual({ status: "ok" });
    expect(fake.rpc).toHaveBeenCalledWith("submit_verification", { p_kind: "age", p_document_refs: ["synthetic:sample-1", "synthetic:sample-3"] });
    for (const refs of [[], ["synthetic:sample-4"], ["file:///real.jpg"], ["synthetic:sample-1", "synthetic:sample-1"]]) {
      expect(await submitVerification(fake, "age", refs)).toEqual({ status: "invalid" });
    }
    expect(await submitVerification(fake, "passport", ["synthetic:sample-1"])).toEqual({ status: "invalid" });
    expect(fake.rpc).toHaveBeenCalledTimes(1);
  });

  it("maps the withdraw answers like the web", async () => {
    expect(await withdrawVerification(fakeSupabase(() => refusal("not_available")), SUBMISSION)).toEqual({ status: "invalid_state" });
    expect(await withdrawVerification(fakeSupabase(() => done()), SUBMISSION)).toEqual({ status: "ok" });
    expect(await withdrawVerification(fakeSupabase(() => done()), "not-a-uuid")).toEqual({ status: "invalid" });
  });
});

describe("onboarding", () => {
  it("joins the birth date fields", () => {
    expect(birthDateOf("2000", "4", "1")).toBe("2000-04-01");
    expect(birthDateOf("200", "4", "1")).toBe("");
    expect(birthDateOf("2000", "", "1")).toBe("");
  });

  it("loads the master and opens a saved profile on its photos", async () => {
    const fake = fakeSupabase(() => ok([accountRow({ profile_completed: false })]),
      { ...masterTables, profile_photos: { data: [{ id: PHOTO_A, position: 0 }], error: null } });
    const started = await loadOnboarding(client(fake), listMyPhotos);
    expect(started).toEqual({ status: "ok", master: [{ id: SCHOOL, name: "架空大学", departments: [{ id: DEPT, name: "架空学科", classes: [{ id: CLASS, name: "Aクラス" }] }] }], initialPhotos: [PHOTO_A] });
    expect(fake.queries.find((q) => q.table === "schools")?.calls).toEqual([["select", "id,name"], ["eq", "is_active", true], ["order", "name"]]);
  });

  it("closes onboarding to a completed or deleted account", async () => {
    expect(await loadOnboarding(client(fakeSupabase(() => ok([accountRow()]), masterTables)), listMyPhotos)).toEqual({ status: "completed" });
    expect(await loadOnboarding(client(fakeSupabase(() => ok([accountRow({ account_status: "deleted", profile_completed: false })]), masterTables)), listMyPhotos))
      .toEqual({ status: "unavailable" });
  });

  it("calls the web's RPCs in the web's order for a new profile", async () => {
    const fake = fakeSupabase((name) => name === "my_account"
      ? ok([accountRow({ has_profile: false, profile_completed: false, account_status: null, birth_date: null })])
      : name === "complete_profile" ? refusal("invalid_state") : done());
    expect(await saveOnboarding(fake, input)).toEqual({ status: "saved_needs_photo" });
    expect(fake.rpc.mock.calls).toEqual([
      ["my_account", {}],
      ["start_onboarding", { p_display_name: "架空の学生", p_gender: "other", p_birth_date: "2000-04-01", p_adult_declared: true }],
      ["set_affiliation", { p_school: SCHOOL, p_department: DEPT, p_class: CLASS }],
      ["update_profile", { p_display_name: "架空の学生", p_gender: "other", p_bio: "よろしく", p_purposes: ["friends", "study"], p_hobbies: [] }],
      ["complete_profile", {}],
    ]);
  });

  it("changes the birth date of a saved profile only when it differs, and reports a locked one", async () => {
    const fake = fakeSupabase((name) => name === "my_account" ? ok([accountRow({ profile_completed: false, birth_date: "1999-01-01" })])
      : name === "update_birth_date" ? refusal("invalid_state") : done());
    expect(await saveOnboarding(fake, input)).toEqual({ status: "birth_locked", step: 0 });
    expect(fake.rpc.mock.calls.map(([name]) => name)).toEqual(["my_account", "update_birth_date"]);
  });

  it("saves no purposes and an empty bio too (both optional, MOBILE-LIKES-001)", async () => {
    const fake = fakeSupabase((name) => name === "my_account" ? ok([accountRow({ profile_completed: false })]) : done());
    expect(await saveOnboarding(fake, { ...input, purposes: [], bio: "" })).toEqual({ status: "completed" });
    expect(fake.rpc).toHaveBeenCalledWith("update_profile", { p_display_name: "架空の学生", p_gender: "other", p_bio: "", p_purposes: [], p_hobbies: [] });
    expect(fake.rpc).not.toHaveBeenCalledWith("set_modes", expect.anything());
  });

  it("refuses invalid input before any RPC, at the web's step", async () => {
    const fake = fakeSupabase(() => done());
    expect(await saveOnboarding(fake, { ...input, birthDate: "2015-01-01" })).toEqual({ status: "invalid", step: 0 });
    expect(await saveOnboarding(fake, { ...input, classId: "x" })).toEqual({ status: "invalid", step: 1 });
    for (const purposes of [["romance"], ["friends", "friends"], ["friends", "partner", "hobby", "study", "talk", "x"], "friends"]) {
      expect(await saveOnboarding(fake, { ...input, purposes })).toEqual({ status: "invalid", step: 3 });
    }
    expect(await saveOnboarding(fake, { ...input, bio: "あ".repeat(501) })).toEqual({ status: "invalid", step: 3 });
    expect(await saveOnboarding(fake, { ...input, bio: undefined })).toEqual({ status: "invalid", step: 3 });
    expect(fake.rpc).not.toHaveBeenCalled();
    expect(invalidStep(input)).toBeUndefined();
  });

  it("maps a database validation refusal to its step", async () => {
    const fake = fakeSupabase((name) => name === "my_account" ? ok([accountRow({ has_profile: false, profile_completed: false })])
      : name === "update_profile" ? raised("validation") : done());
    expect(await saveOnboarding(fake, input)).toEqual({ status: "invalid", step: 3 });
  });

  it("completes the profile or says what is missing", async () => {
    expect(await completeOnboarding(fakeSupabase(() => done()))).toEqual({ status: "completed" });
    const noPhoto = fakeSupabase((name) => name === "complete_profile" ? refusal("invalid_state") : ok([accountRow({ has_active_photo: false })]));
    expect(await completeOnboarding(noPhoto)).toEqual({ status: "needs_photo" });
    const details = fakeSupabase((name) => name === "complete_profile" ? refusal("invalid_state") : ok([accountRow()]));
    expect(await completeOnboarding(details)).toEqual({ status: "needs_details" });
  });
});
