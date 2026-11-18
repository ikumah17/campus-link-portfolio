// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeOnboarding, refreshOnboardingPhotos, saveOnboarding, type OnboardingInput } from "@/server/onboarding-actions";
import { demoAffiliations } from "@/data/demo-affiliations";

const mocks = vi.hoisted(() => ({ mode: vi.fn(), create: vi.fn(), rpc: vi.fn(), photos: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: mocks.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: mocks.create }));
vi.mock("@/server/my-photos", () => ({ listMyPhotos: mocks.photos }));
const school = demoAffiliations[0];
const input: OnboardingInput = { displayName: "架空", gender: "female", birthDate: "2000-02-29", adultDeclared: true, schoolId: school.id, departmentId: school.departments[0].id, classId: school.departments[0].classes[0].id, purposes: ["talk", "friends"], bio: "架空の自己紹介" };
const privateMessage = "private DB details 2000-02-29";
const ok = { data: { ok: true, code: "ok", ref: null }, error: null };
const account = (has_profile = false, birth_date: string | null = null, profile_completed = false) => ({ data: [{ has_profile, birth_date, profile_completed }], error: null });
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  mocks.mode.mockReturnValue("supabase");
  mocks.create.mockResolvedValue({ rpc: mocks.rpc });
  mocks.rpc.mockResolvedValue(ok).mockResolvedValueOnce(account());
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
const names = () => mocks.rpc.mock.calls.map(([name]) => name);
describe("refresh saved onboarding photos", () => {
  it("returns only canonical own ids using the session client with no caller parameters", async () => {
    const ids = ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"];
    mocks.photos.mockResolvedValue(ids);
    expect(await refreshOnboardingPhotos()).toEqual(ids);
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.photos).toHaveBeenCalledExactlyOnceWith(await mocks.create.mock.results[0].value);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("returns null for a failed read or client without disclosing provider errors", async () => {
    mocks.photos.mockResolvedValueOnce(null);
    expect(await refreshOnboardingPhotos()).toBeNull();
    mocks.photos.mockRejectedValueOnce(new Error(privateMessage));
    expect(await refreshOnboardingPhotos()).toBeNull();
    mocks.create.mockRejectedValueOnce(new Error(privateMessage));
    expect(await refreshOnboardingPhotos()).toBeNull();
  });
  it("keeps demo mode inert without creating a client", async () => {
    mocks.mode.mockReturnValue("demo");
    expect(await refreshOnboardingPhotos()).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.photos).not.toHaveBeenCalled();
  });
});
describe("complete saved onboarding", () => {
  it("completes using only the user's session client and no caller parameters", async () => {
    mocks.rpc.mockReset().mockResolvedValue(ok);
    expect(await completeOnboarding()).toEqual({ status: "completed" });
    expect(mocks.rpc.mock.calls).toEqual([["complete_profile", {}]]);
  });
  it.each([
    [false, "needs_photo"], [true, "needs_details"], [undefined, "needs_details"], [null, "needs_details"], [0, "needs_details"], ["false", "needs_details"],
  ])("interprets has_active_photo=%s exactly", async (has_active_photo, status) => {
    mocks.rpc.mockReset().mockResolvedValueOnce({ data: { ok: false, code: "invalid_state" }, error: null }).mockResolvedValueOnce({ data: [{ has_active_photo }], error: null });
    expect(await completeOnboarding()).toEqual({ status });
    expect(mocks.rpc.mock.calls).toEqual([["complete_profile", {}], ["my_account", {}]]);
  });
  it.each(["validation", "forbidden", "unauthenticated", "unavailable", "not_available", "rate_limited"])("maps complete_profile %s safely", async (code) => {
    const error = code === "validation" || code === "forbidden" ? { code: "P0001", message: code } : code === "unauthenticated" ? { status: 401, message: privateMessage } : { message: privateMessage };
    mocks.rpc.mockReset().mockResolvedValue({ data: null, error });
    const result = await completeOnboarding();
    expect(result).toEqual({ status: code === "unauthenticated" ? "unauthenticated" : "unavailable" }); safe(result);
    expect(names()).toEqual(["complete_profile"]);
  });
  it.each([
    { data: [], error: null }, { data: [null], error: null }, { data: [{}, {}], error: null },
    { data: null, error: { message: privateMessage } },
    { data: null, error: { status: 401, message: privateMessage } },
  ])("fails safely if the follow-up account read fails %#", async (accountResult) => {
    mocks.rpc.mockReset().mockResolvedValueOnce({ data: { ok: false, code: "invalid_state" }, error: null }).mockResolvedValueOnce(accountResult);
    const result = await completeOnboarding();
    expect(result).toEqual({ status: accountResult.error && "status" in accountResult.error ? "unauthenticated" : "unavailable" }); safe(result);
  });
  it("catches client/transport errors and keeps demo mode inert", async () => {
    mocks.create.mockRejectedValue(new Error(privateMessage)); expect(await completeOnboarding()).toEqual({ status: "unavailable" });
    mocks.create.mockClear(); vi.clearAllMocks(); mocks.mode.mockReturnValue("demo");
    expect(await completeOnboarding()).toEqual({ status: "unavailable" }); expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
function safe(result: unknown) {
  expect(JSON.stringify(result)).not.toContain(privateMessage);
  expect(JSON.stringify(result)).not.toContain(input.birthDate);
  expect(JSON.stringify(result)).not.toContain(input.displayName);
}

describe("onboarding RPC sequence", () => {
  it("uses exact SQL arguments under the session, including all required profile fields", async () => {
    expect(await saveOnboarding(input)).toEqual({ status: "completed" });
    expect(mocks.rpc.mock.calls).toEqual([
      ["my_account", {}],
      ["start_onboarding", { p_display_name: "架空", p_gender: "female", p_birth_date: "2000-02-29", p_adult_declared: true }],
      ["set_affiliation", { p_school: input.schoolId, p_department: input.departmentId, p_class: input.classId }],
      ["update_profile", { p_display_name: "架空", p_gender: "female", p_bio: "架空の自己紹介", p_purposes: ["talk", "friends"], p_hobbies: [] }],
      ["complete_profile", {}],
    ]);
  });
  it.each([false, true])("resumes an incomplete profile, birth changed: %s", async (changed) => {
    mocks.rpc.mockReset().mockResolvedValue(ok).mockResolvedValueOnce(account(true, changed ? "2000-01-01" : input.birthDate));
    expect(await saveOnboarding(input)).toEqual({ status: "completed" });
    expect(names()).toEqual(["my_account", ...(changed ? ["update_birth_date"] : []), "set_affiliation", "update_profile", "complete_profile"]);
    if (changed) expect(mocks.rpc).toHaveBeenNthCalledWith(2, "update_birth_date", { p_birth_date: input.birthDate });
  });
  it("returns completed before any write", async () => {
    mocks.rpc.mockReset().mockResolvedValueOnce(account(true, input.birthDate, true));
    expect(await saveOnboarding(input)).toEqual({ status: "completed" });
    expect(names()).toEqual(["my_account"]);
  });
  it("answers a deleted account as before order 18 (completed) before any write, from the all-false row too", async () => {
    const deleted17 = { has_profile: true, birth_date: input.birthDate, profile_completed: true, account_status: "deleted" };
    const deleted18 = { has_profile: true, birth_date: null, profile_completed: false, account_status: "deleted", adult: false, eligible: false, has_active_photo: false };
    for (const row of [deleted17, deleted18]) {
      mocks.rpc.mockReset().mockResolvedValueOnce({ data: [row], error: null });
      expect(await saveOnboarding(input)).toEqual({ status: "completed" });
      expect(names()).toEqual(["my_account"]);
    }
  });
  it("maps a locked birth date and stops", async () => {
    mocks.rpc.mockReset().mockResolvedValueOnce(account(true, "2000-01-01")).mockResolvedValueOnce({ data: { ok: false, code: "invalid_state", message: privateMessage }, error: null });
    const result = await saveOnboarding(input);
    expect(result).toEqual({ status: "birth_locked", step: 0 }); safe(result);
    expect(names()).toEqual(["my_account", "update_birth_date"]);
  });
  it("saves pending photos without claiming completion", async () => {
    mocks.rpc.mockImplementation(async (name: string) => name === "my_account" ? account() : name === "complete_profile" ? { data: { ok: false, code: "invalid_state" }, error: null } : ok);
    expect(await saveOnboarding(input)).toEqual({ status: "saved_needs_photo" });
  });
  it.each([[], [null], [{}], [{ has_profile: "false", profile_completed: false }]].map((data) => ({ data })))("rejects a missing or malformed account %#", async ({ data }) => {
    mocks.rpc.mockReset().mockResolvedValueOnce({ data, error: null });
    expect(await saveOnboarding(input)).toEqual({ status: "unavailable", step: 0 });
    expect(names()).toEqual(["my_account"]);
  });
  it("preserves the bio, allows no purposes and counts Unicode code points", async () => {
    expect(await saveOnboarding({ ...input, displayName: "😀".repeat(20), purposes: [], bio: "😀".repeat(500) })).toEqual({ status: "completed" });
    expect(mocks.rpc.mock.calls[3]).toEqual(["update_profile", expect.objectContaining({ p_bio: "😀".repeat(500), p_purposes: [] })]);
    expect(names()).not.toContain("set_modes");
  });
  it("retries partial saves using the profile created by the prior attempt", async () => {
    let hasProfile = false;
    let affiliationFailed = false;
    mocks.rpc.mockReset().mockImplementation(async (name: string) => {
      if (name === "my_account") return account(hasProfile, hasProfile ? input.birthDate : null);
      if (name === "start_onboarding") hasProfile = true;
      if (name === "set_affiliation" && !affiliationFailed) {
        affiliationFailed = true;
        return { data: null, error: { message: privateMessage } };
      }
      return ok;
    });
    expect(await saveOnboarding(input)).toEqual({ status: "unavailable", step: 1 });
    expect(names()).toEqual(["my_account", "start_onboarding", "set_affiliation"]);
    expect(await saveOnboarding(input)).toEqual({ status: "completed" });
    expect(names()).toEqual(["my_account", "start_onboarding", "set_affiliation", "my_account", "set_affiliation", "update_profile", "complete_profile"]);
  });
});

describe("every RPC failure stops at its UI step", () => {
  const stages = [["my_account", 0], ["start_onboarding", 0], ["update_birth_date", 0], ["set_affiliation", 1], ["update_profile", 3], ["complete_profile", 2]] as const;
  const codes = ["validation", "unauthenticated", "unavailable", "forbidden", "not_available", "invalid_state", "already_pending", "already_connected", "rate_limited"] as const;
  for (const [stage, step] of stages) {
    it.each(codes)(`${stage} maps %s and returns no private data`, async (code) => {
      mocks.rpc.mockReset().mockImplementation(async (name: string) => {
        if (name === stage) {
          if (code === "validation" || code === "forbidden") return { data: null, error: { code: "P0001", message: code } };
          if (code === "unauthenticated") return { data: null, error: { status: 401, message: privateMessage } };
          if (code === "unavailable") return { data: null, error: { message: privateMessage } };
          return { data: { ok: false, code, message: privateMessage }, error: null };
        }
        return name === "my_account" ? account(stage === "update_birth_date", "2000-01-01") : ok;
      });
      const result = await saveOnboarding(input);
      const status = code === "validation" ? "invalid" : code === "unauthenticated" ? "unauthenticated" : code === "invalid_state" && stage === "complete_profile" ? "saved_needs_photo" : code === "invalid_state" && stage === "update_birth_date" ? "birth_locked" : "unavailable";
      expect(result).toEqual(status === "saved_needs_photo" ? { status } : { status, step });
      expect(names().at(-1)).toBe(stage); safe(result);
    });
  }
  it("catches a thrown transport failure without logging or leaking", async () => {
    const log = vi.spyOn(console, "error");
    mocks.rpc.mockReset().mockRejectedValue(new Error(privateMessage));
    const result = await saveOnboarding(input);
    expect(result).toEqual({ status: "unavailable", step: 0 }); safe(result);
    mocks.create.mockRejectedValue(new Error(privateMessage));
    safe(await saveOnboarding(input)); expect(log).not.toHaveBeenCalled();
  });
});

describe("validate the entire payload before creating a client", () => {
  it.each([
    [null, 0], [undefined, 0], [{}, 0],
    [{ ...input, schoolId: "bad" }, 1], [{ ...input, schoolId: input.schoolId.toUpperCase() }, 1],
    [{ ...input, schoolId: `${input.schoolId}\n` }, 1],
    [{ ...input, departmentId: 1 }, 1], [{ ...input, classId: "bad" }, 1],
    [{ ...input, purposes: ["romance"] }, 3], [{ ...input, purposes: ["friends", "friends"] }, 3], [{ ...input, purposes: null }, 3], [{ ...input, purposes: Array(1) }, 3], [{ ...input, purposes: [1] }, 3], [{ ...input, purposes: "friends" }, 3],
    [{ ...input, displayName: "x".repeat(21) }, 0], [{ ...input, displayName: " " }, 0], [{ ...input, gender: "x" }, 0],
    [{ ...input, birthDate: "2020-01-01" }, 0], [{ ...input, birthDate: "2000-02-30" }, 0], [{ ...input, adultDeclared: false }, 0], [{ ...input, adultDeclared: "true" }, 0],
    [{ ...input, bio: "x".repeat(501) }, 3], [{ ...input, bio: 1 }, 3], [{ ...input, bio: null }, 3],
  ])("rejects malformed input %#", async (value, step) => {
    const result = await saveOnboarding(value);
    expect(result).toEqual({ status: "invalid", step }); safe(result);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("is inert in demo mode, even for invalid input", async () => {
    mocks.mode.mockReturnValue("demo");
    expect(await saveOnboarding(input)).toEqual({ status: "unavailable" });
    expect(await saveOnboarding(null)).toEqual({ status: "unavailable" });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
