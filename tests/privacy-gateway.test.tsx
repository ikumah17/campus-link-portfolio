import { describe, expect, it } from "vitest";
import { createPrivacyDemo, DEMO_PRIVACY_SAVE_LIMIT, validatePrivacySettings } from "@/lib/privacy-gateway";
import { DEMO_HIDE_TARGETS, PRIVACY_FLAGS, TARGET_FIELDS, defaultPrivacySettings } from "@/data/demo-privacy";

describe("privacy gateway", () => {
  it("keeps the safe defaults and rejects malformed settings atomically", async () => {
    const gateway = createPrivacyDemo();
    expect(await gateway.getMySettings()).toEqual({ code: "ok", data: defaultPrivacySettings() });
    for (const input of [null, [], {}, "bad", { ...defaultPrivacySettings(), hiddenSchoolIds: ["unknown"] }]) {
      expect(validatePrivacySettings(input)).toBe(false);
    }
    expect(await gateway.updatePrivacySettings({ ...defaultPrivacySettings(), hiddenSchoolIds: ["unknown"] })).toEqual({ code: "validation", data: null });
    expect(await gateway.getMySettings()).toEqual({ code: "ok", data: defaultPrivacySettings() });
  });
  for (const flag of PRIVACY_FLAGS) it(`validates ${flag} as a boolean`, () => {
    for (const value of [true, false]) expect(validatePrivacySettings({ ...defaultPrivacySettings(), [flag]: value })).toBe(true);
    for (const value of [null, undefined, 1, "true"]) expect(validatePrivacySettings({ ...defaultPrivacySettings(), [flag]: value })).toBe(false);
  });
  for (const kind of ["school", "department", "class"] as const) it(`validates ${kind} ids and rejects duplicates and wrong kinds`, () => {
    const field = TARGET_FIELDS[kind];
    const id = DEMO_HIDE_TARGETS.find((t) => t.kind === kind)!.id;
    const wrong = DEMO_HIDE_TARGETS.find((t) => t.kind !== kind)!.id;
    expect(validatePrivacySettings({ ...defaultPrivacySettings(), [field]: [id] })).toBe(true);
    for (const ids of [[wrong], [id, id], ["unknown"], [null], Array(1), id]) expect(validatePrivacySettings({ ...defaultPrivacySettings(), [field]: ids })).toBe(false);
  });
  it("accepts 50 total ids and rejects 51 across kinds", () => {
    const master = Array.from({ length: 51 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, kind: i < 25 ? "school" as const : "department" as const, label: "fixture" }));
    const settings = { ...defaultPrivacySettings(), hiddenSchoolIds: master.slice(0, 25).map((t) => t.id), hiddenDepartmentIds: master.slice(25, 50).map((t) => t.id) };
    expect(validatePrivacySettings(settings, master)).toBe(true);
    settings.hiddenDepartmentIds.push(master[50].id);
    expect(validatePrivacySettings(settings, master)).toBe(false);
  });
  it("replaces whole sets, isolates returned/input arrays and rate limits without mutation", async () => {
    const gateway = createPrivacyDemo();
    const settings = { ...defaultPrivacySettings(), hiddenSchoolIds: [DEMO_HIDE_TARGETS[0].id] };
    await gateway.updatePrivacySettings(settings);
    settings.hiddenSchoolIds.push("bad");
    const read = await gateway.getMySettings();
    if (read.code !== "ok") throw new Error("read failed");
    expect(read.data.hiddenSchoolIds).toEqual([DEMO_HIDE_TARGETS[0].id]);
    read.data.hiddenSchoolIds.push("bad");
    for (let n = 1; n < DEMO_PRIVACY_SAVE_LIMIT; n++) expect((await gateway.updatePrivacySettings(defaultPrivacySettings())).code).toBe("ok");
    expect(await gateway.updatePrivacySettings({ ...defaultPrivacySettings(), showClass: true })).toEqual({ code: "rate_limited", data: null });
    expect(await gateway.getMySettings()).toEqual({ code: "ok", data: defaultPrivacySettings() });
    expect(await createPrivacyDemo().getMySettings()).toEqual({ code: "ok", data: defaultPrivacySettings() });
  });
});
