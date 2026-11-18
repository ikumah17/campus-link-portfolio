import type { DataClient } from "../src/account-data";
import { RPC_NAMES } from "../src/rpc";
import {
  loadAccount, loadBlocks, loadPrivacy, pauseAccount, privacyTargets, requestDeletion, resumeAccount, samePrivacySettings, savePrivacy, unblock,
  type PrivacySettings,
} from "../src/settings-data";
import { accountRow, CLASS, DEPT, done, fakeSupabase, masterTables, ok, raised, refusal, SCHOOL, TARGET, type RpcAnswer, type TableAnswer } from "./fake-supabase";

// MOBILE-004: the settings and safety data, ported from the web's privacy, safety and account modules.
const SECOND = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REPORT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const blockRow = (overrides: Record<string, unknown> = {}) => ({ blocked_id: TARGET, blocked_name_snapshot: "架空の相手", created_at: "2026-11-17T03:00:00Z", ...overrides });
const reportRow = (overrides: Record<string, unknown> = {}) => ({ id: REPORT, created_at: "2026-11-16T03:00:00Z", status: "triaged", ...overrides });
const settings = (overrides: Partial<PrivacySettings> = {}): PrivacySettings => ({
  hideSameClass: true, hideSameDepartment: false, hideSameSchool: false, showDepartment: false, showClass: false,
  hiddenSchoolIds: [], hiddenDepartmentIds: [], hiddenClassIds: [], ...overrides,
});
const client = (fake: ReturnType<typeof fakeSupabase>) => fake as unknown as DataClient;
const withAccount = (rpc: (name: string, args: Record<string, unknown>) => RpcAnswer = () => ok([])) =>
  (name: string, args: Record<string, unknown>) => name === "my_account" ? ok([accountRow()]) : rpc(name, args);

describe("the app's RPC names (MOBILE-004)", () => {
  it("adds the user RPCs of privacy, blocks, reports and the account, and still no admin_* or service_*", () => {
    for (const name of ["update_privacy_settings", "list_my_blocks", "unblock_user", "my_reports", "deactivate_account", "reactivate_account", "request_account_deletion"]) {
      expect(RPC_NAMES).toContain(name);
    }
    expect(RPC_NAMES.some((name) => name.startsWith("admin_") || name.startsWith("service_"))).toBe(false);
  });
});

describe("privacy settings", () => {
  const tables = (privacy: TableAnswer, hidden: TableAnswer = { data: [], error: null }) => ({ ...masterTables, privacy_settings: privacy, hidden_affiliations: hidden });

  it("uses the database's defaults when there is no row yet, and labels targets with their parents", async () => {
    const fake = fakeSupabase(withAccount(), tables({ data: [], error: null }));
    expect(await loadPrivacy(client(fake))).toEqual({
      status: "ok", settings: settings(),
      targets: [
        { id: SCHOOL, kind: "school", label: "架空大学" },
        { id: DEPT, kind: "department", label: "架空大学 / 架空学科" },
        { id: CLASS, kind: "class", label: "架空大学 / 架空学科 / Aクラス" },
      ],
    });
  });

  it("reads the own row and the hidden affiliations", async () => {
    const fake = fakeSupabase(withAccount(), tables(
      { data: [{ hide_same_class: false, hide_same_department: true, hide_same_school: false, show_department: true, show_class: false }], error: null },
      { data: [{ school_id: SCHOOL, department_id: null, class_id: null }, { school_id: null, department_id: null, class_id: CLASS }], error: null },
    ));
    const result = await loadPrivacy(client(fake));
    expect(result.status === "ok" && result.settings).toEqual(settings({
      hideSameClass: false, hideSameDepartment: true, showDepartment: true, hiddenSchoolIds: [SCHOOL], hiddenClassIds: [CLASS],
    }));
  });

  it.each([
    ["two rows", { data: [{}, {}], error: null }, { data: [], error: null }],
    ["a non-boolean flag", { data: [{ hide_same_class: "yes", hide_same_department: true, hide_same_school: false, show_department: true, show_class: false }], error: null }, { data: [], error: null }],
    ["a hidden row with two ids", { data: [], error: null }, { data: [{ school_id: SCHOOL, department_id: DEPT, class_id: null }], error: null }],
    ["a malformed id", { data: [], error: null }, { data: [{ school_id: "x", department_id: null, class_id: null }], error: null }],
    ["a read error", { data: null, error: { code: "42501" } }, { data: [], error: null }],
  ])("answers unavailable for %s", async (_name, privacy, hidden) => {
    expect(await loadPrivacy(client(fakeSupabase(withAccount(), tables(privacy as TableAnswer, hidden as TableAnswer))))).toEqual({ status: "unavailable" });
  });

  it("answers unauthenticated for a refused token, and incomplete before the profile is complete", async () => {
    expect(await loadPrivacy(client(fakeSupabase(withAccount(), tables({ data: null, error: { code: "PGRST301" }, status: 401 }))))).toEqual({ status: "unauthenticated" });
    expect(await loadPrivacy(client(fakeSupabase(() => ok([accountRow({ profile_completed: false })]), tables({ data: [], error: null }))))).toEqual({ status: "incomplete" });
    expect(await loadPrivacy(client(fakeSupabase(() => ok([{ user_id: TARGET, account_status: "deleted", profile_completed: false }]), tables({ data: [], error: null }))))).toEqual({ status: "unavailable" });
  });

  it("saves through update_privacy_settings with the web's arguments", async () => {
    const fake = fakeSupabase(() => done());
    expect(await savePrivacy(fake, settings({ hideSameSchool: true, hiddenDepartmentIds: [DEPT] }))).toBe("ok");
    expect(fake.rpc).toHaveBeenCalledWith("update_privacy_settings", {
      p_hide_same_class: true, p_hide_same_department: false, p_hide_same_school: true, p_show_department: false, p_show_class: false,
      p_hidden_school_ids: [], p_hidden_department_ids: [DEPT], p_hidden_class_ids: [],
    });
  });

  it.each([
    ["a missing flag", { ...settings(), showClass: undefined }],
    ["a malformed id", settings({ hiddenSchoolIds: ["x"] })],
    ["a duplicate id", settings({ hiddenSchoolIds: [SCHOOL, SCHOOL] })],
    ["more than 50 targets", settings({ hiddenSchoolIds: Array.from({ length: 51 }, (_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`) })],
  ])("refuses %s before any request", async (_name, input) => {
    const fake = fakeSupabase(() => done());
    expect(await savePrivacy(fake, input)).toBe("invalid");
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it.each([
    [refusal("rate_limited"), "rate_limited"], [raised("validation"), "invalid"], [raised("forbidden"), "forbidden"],
    [{ data: null, error: { code: "PGRST301" }, status: 401 }, "unauthenticated"], [refusal("made_up"), "unavailable"],
  ] as [RpcAnswer, string][])("maps a refusal to %#", async (answer, status) => {
    expect(await savePrivacy(fakeSupabase(() => answer), settings())).toBe(status);
  });

  it("compares settings regardless of the order of ids", () => {
    expect(samePrivacySettings(settings({ hiddenSchoolIds: [SCHOOL, SECOND] }), settings({ hiddenSchoolIds: [SECOND, SCHOOL] }))).toBe(true);
    expect(samePrivacySettings(settings(), settings({ showClass: true }))).toBe(false);
    expect(privacyTargets([])).toEqual([]);
  });
});

describe("blocks and own reports", () => {
  it("lists the blocks and the reports' states", async () => {
    const fake = fakeSupabase(withAccount((name) => name === "list_my_blocks" ? ok([blockRow(), blockRow({ blocked_id: SECOND, blocked_name_snapshot: null })]) : ok([reportRow()])));
    expect(await loadBlocks(fake)).toEqual({
      status: "ok",
      blocks: [{ target: TARGET, name: "架空の相手", createdAt: "2026-11-17T03:00:00Z" }, { target: SECOND, name: null, createdAt: "2026-11-17T03:00:00Z" }],
      reports: [{ createdAt: "2026-11-16T03:00:00Z", status: "triaged" }],
    });
  });

  it.each([
    ["a malformed block id", [blockRow({ blocked_id: "x" })], [reportRow()]],
    ["a bad block date", [blockRow({ created_at: "never" })], [reportRow()]],
    ["an unknown report status", [blockRow()], [reportRow({ status: "lost" })]],
  ])("answers unavailable for %s", async (_name, blocks, reports) => {
    expect(await loadBlocks(fakeSupabase(withAccount((name) => ok(name === "list_my_blocks" ? blocks : reports))))).toEqual({ status: "unavailable" });
  });

  it("answers unauthenticated when a list refuses the token", async () => {
    const refused = { data: null, error: { code: "PGRST301" }, status: 401 };
    expect(await loadBlocks(fakeSupabase(withAccount((name) => name === "my_reports" ? refused : ok([]))))).toEqual({ status: "unauthenticated" });
  });

  it("unblocks only a listed user, after reading the list again", async () => {
    const fake = fakeSupabase((name) => name === "list_my_blocks" ? ok([blockRow()]) : done());
    expect(await unblock(fake, TARGET)).toBe("ok");
    expect(fake.rpc).toHaveBeenLastCalledWith("unblock_user", { p_target: TARGET });

    const gone = fakeSupabase((name) => name === "list_my_blocks" ? ok([]) : done());
    expect(await unblock(gone, TARGET)).toBe("ok");
    expect(gone.rpc.mock.calls.map(([name]) => name)).toEqual(["list_my_blocks"]);
  });

  it("refuses a malformed id and maps refusals", async () => {
    const fake = fakeSupabase(() => done());
    expect(await unblock(fake, "x")).toBe("validation");
    expect(fake.rpc).not.toHaveBeenCalled();
    expect(await unblock(fakeSupabase((name) => name === "list_my_blocks" ? ok([blockRow()]) : refusal("rate_limited")), TARGET)).toBe("rate_limited");
    expect(await unblock(fakeSupabase(() => ok(null as unknown as unknown[])), TARGET)).toBe("unavailable");
  });
});

describe("account", () => {
  it("loads the state from my_account alone, so a paused account reaches it", async () => {
    expect(await loadAccount(fakeSupabase(() => ok([accountRow({ account_status: "deactivated" })])))).toEqual({ status: "ok", accountStatus: "deactivated" });
    expect(await loadAccount(fakeSupabase(() => ok([accountRow({ account_status: "suspended" })])))).toEqual({ status: "ok", accountStatus: "suspended" });
    expect(await loadAccount(fakeSupabase(() => ok([accountRow({ profile_completed: false })])))).toEqual({ status: "incomplete" });
    expect(await loadAccount(fakeSupabase(() => ok([{ user_id: TARGET, account_status: "deleted", profile_completed: false }])))).toEqual({ status: "unavailable" });
    expect(await loadAccount(fakeSupabase(() => ({ data: null, error: { code: "PGRST301" }, status: 401 })))).toEqual({ status: "unauthenticated" });
  });

  it("pauses and resumes through deactivate_account and reactivate_account", async () => {
    const fake = fakeSupabase(() => done());
    expect(await pauseAccount(fake)).toBe("ok");
    expect(await resumeAccount(fake)).toBe("ok");
    expect(fake.rpc.mock.calls.map(([name]) => name)).toEqual(["deactivate_account", "reactivate_account"]);
    expect(await pauseAccount(fakeSupabase(() => refusal("invalid_state")))).toBe("invalid_state");
    expect(await pauseAccount(fakeSupabase(() => refusal("rate_limited")))).toBe("unavailable");
  });

  it("requests the deletion only with the web's confirmation word", async () => {
    const fake = fakeSupabase(() => done());
    for (const word of ["", "退会", " 退会する", "退会する "]) expect(await requestDeletion(fake, word)).toBe("invalid");
    expect(fake.rpc).not.toHaveBeenCalled();
    expect(await requestDeletion(fake, "退会する")).toBe("ok");
    expect(fake.rpc).toHaveBeenCalledWith("request_account_deletion", {});
    expect(await requestDeletion(fakeSupabase(() => raised("forbidden")), "退会する")).toBe("forbidden");
  });
});
