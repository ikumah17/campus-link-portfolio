import { describe, expect, it } from "vitest";
import { createAdminDemo } from "@/lib/admin-demo";
import { reportStatuses, validTransition, validName, validNote, validAccountTransition } from "@/lib/admin-gateway";
import { demoAffiliations } from "@/data/demo-affiliations";

describe("admin demo contract", () => {
  for (const from of reportStatuses) for (const to of reportStatuses) {
    it(`transition ${from} -> ${to}`, () => {
      const allowed = ["open>triaged", "open>dismissed", "triaged>actioned", "triaged>dismissed"].includes(`${from}>${to}`);
      expect(validTransition(from, to)).toBe(allowed);
      const { gateway } = createAdminDemo();
      if (from === "triaged") gateway.adminUpdateReport("admin-report-1", "triaged", "");
      if (from === "actioned") { gateway.adminUpdateReport("admin-report-1", "triaged", ""); gateway.adminUpdateReport("admin-report-1", "actioned", ""); }
      if (from === "dismissed") gateway.adminUpdateReport("admin-report-1", "dismissed", "");
      expect(gateway.adminUpdateReport("admin-report-1", to, "").code).toBe(allowed ? "ok" : "invalid_state");
    });
  }
  for (const size of [0, 1000, 1001]) it(`note length ${size}`, () => {
    const { gateway } = createAdminDemo(); const note = "あ".repeat(size);
    expect(validNote(note)).toBe(size <= 1000);
    expect(gateway.adminUpdateReport("admin-report-1", "triaged", note).code).toBe(size <= 1000 ? "ok" : "validation");
  });
  for (const [level, limit] of [["school", 80], ["department", 80], ["class", 40]] as const) {
    for (const name of ["", "   ", "a", "a".repeat(limit), "a".repeat(limit + 1), "😀".repeat(limit)]) it(`${level} name length ${[...name].length}`, () => {
      const { gateway } = createAdminDemo(); const expected = !!name.trim() && [...name].length <= limit;
      expect(validName(level, name)).toBe(expected);
      const result = level === "school" ? gateway.adminUpsertSchool(null, name, true, 0) : level === "department" ? gateway.adminUpsertDepartment(null, demoAffiliations[0].id, name, true, 0) : gateway.adminUpsertClass(null, demoAffiliations[0].departments[0].id, name, 2026, true);
      expect(result.code).toBe(expected ? "ok" : "validation");
    });
  }
  it("denies reporter and target parties without evidence or mutation", () => {
    for (const moderator of ["demo-moderator", "fictional-c"]) {
      const { gateway } = createAdminDemo(moderator);
      expect(gateway.adminGetReport("admin-report-2")).toEqual({ code: "not_available", data: null });
      expect(gateway.adminUpdateReport("admin-report-2", "dismissed", "").code).toBe("not_available");
      const list = gateway.adminListReports("open").data!;
      expect(list.find((r) => r.id === "admin-report-2")?.available).toBe(false);
      expect(list[0]).not.toHaveProperty("detail"); expect(list[0]).not.toHaveProperty("snapshot");
    }
  });
  it("requires parents, prevents moving, duplicate names and unknown updates", () => {
    const { gateway } = createAdminDemo(); const school = demoAffiliations[0]; const dept = school.departments[0];
    expect(gateway.adminUpsertDepartment(null, "missing", "x", true, 0).code).toBe("validation");
    expect(gateway.adminUpsertClass(null, school.id, "x", null, true).code).toBe("validation");
    expect(gateway.adminUpsertDepartment(dept.id, demoAffiliations[1].id, "x", true, 0).code).toBe("invalid_state");
    expect(gateway.adminUpsertClass(dept.classes[0].id, school.departments[1].id, "x", null, true).code).toBe("invalid_state");
    expect(gateway.adminUpsertSchool(null, school.name, true, 0).code).toBe("invalid_state");
    expect(gateway.adminUpsertSchool("missing", "x", true, 0).code).toBe("not_available");
    expect(gateway.adminGetReport("missing").code).toBe("not_available");
  });
  it("retains inactive rows and children, stores sort/year and returns copies", () => {
    const demo = createAdminDemo(); const before = demo.affiliations(); const school = before[0];
    expect(demo.gateway.adminUpsertSchool(school.id, "変更（架空）", false, -2).code).toBe("ok");
    expect(demo.affiliations()).toHaveLength(before.length);
    expect(demo.affiliations()[0]).toMatchObject({ name: "変更（架空）", isActive: false, sortOrder: -2 });
    expect(demo.affiliations().filter((r) => r.parentId === school.id).every((r) => r.isActive)).toBe(true);
    const cls = demo.gateway.adminUpsertClass(null, demoAffiliations[0].departments[0].id, "新クラス", 2027, true);
    expect(cls.data?.academicYear).toBe(2027); cls.data!.name = "mutated";
    expect(demo.affiliations().at(-1)?.name).toBe("新クラス");
    const report = demo.gateway.adminGetReport("admin-report-1"); report.data!.detail = "mutated";
    expect(demo.gateway.adminGetReport("admin-report-1").data?.detail).not.toBe("mutated");
    expect(createAdminDemo().affiliations()[0].isActive).toBe(true);
  });
  it("rejects fractional and out-of-range sort/year", () => {
    const { gateway } = createAdminDemo();
    for (const n of [NaN, Infinity, 0.5, 2147483648]) expect(gateway.adminUpsertSchool(null, "x", true, n).code).toBe("validation");
    for (const n of [NaN, Infinity, 0.5, 32768]) expect(gateway.adminUpsertClass(null, demoAffiliations[0].departments[0].id, "x", n, true).code).toBe("validation");
  });
  it("allows only active/suspended account changes and validates reasons", () => {
    const { gateway } = createAdminDemo();
    for (const from of ["active", "suspended", "deactivated", "pending"]) for (const to of ["active", "suspended", "deactivated", "pending"]) expect(validAccountTransition(from, to)).toBe((from === "active" && to === "suspended") || (from === "suspended" && to === "active"));
    expect(gateway.adminSetAccountStatus("fictional-a", "active", null).code).toBe("invalid_state");
    expect(gateway.adminSetAccountStatus("fictional-a", "suspended", "demo_reason").code).toBe("ok");
    expect(gateway.adminSetAccountStatus("fictional-a", "active", null).code).toBe("ok");
    expect(gateway.adminSetAccountStatus("fictional-a", "suspended", "bad reason").code).toBe("validation");
    expect(gateway.adminSetAccountStatus("missing", "suspended", null).code).toBe("not_available");
  });
});
