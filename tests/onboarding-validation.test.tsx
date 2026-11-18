// @vitest-environment node
import { describe, expect, it } from "vitest";
import { demoAffiliations, demoPhotos } from "@/data/demo-affiliations";
import { adultFrom, anniversary, todayJst, validateAffiliation, validateBio, validateBirthDate, validateDisplayName, validateGender, validatePhotos, validatePurposes } from "@/lib/onboarding-validation";
import { purposeText, sortPurposes, validateModes } from "@/lib/onboarding-rules";

describe("onboarding convenience validation mirrors DB contract", () => {
  it.each([["", false], [" ", false], ["a", true], ["a".repeat(20), true], ["a".repeat(21), false], ["😀".repeat(20), true], ["😀".repeat(21), false]])("display name %s", (name, valid) => expect(validateDisplayName(name)).toBe(valid));
  it.each([["female", true], ["male", true], ["other", true], ["", false], ["unknown", false]])("gender %s", (value, valid) => expect(validateGender(value)).toBe(valid));
  it("uses Tokyo dates independent of local timezone", () => {
    expect(todayJst(new Date("2026-02-28T23:30:00Z"))).toBe("2026-03-01");
    expect(todayJst(new Date("2026-02-28T14:59:59Z"))).toBe("2026-02-28");
    expect(todayJst(new Date("2026-02-28T15:00:00Z"))).toBe("2026-03-01");
  });
  it.each([["2008-02-29", 18, "2026-03-01"], ["2000-02-29", 18, "2018-03-01"], ["2004-02-29", 20, "2024-02-29"], ["1896-02-29", 4, "1900-03-01"], ["1996-02-29", 4, "2000-02-29"]])("anniversary %s + %s", (birth, years, expected) => expect(anniversary(birth, years)).toBe(expected));
  it("accepts exactly eighteen today and rejects the day before", () => {
    expect(adultFrom("2008-02-29")).toBe("2026-03-01");
    expect(validateBirthDate("2008-02-29", new Date("2026-02-28T14:59:59Z"))).toBe(false);
    expect(validateBirthDate("2008-02-29", new Date("2026-02-28T15:00:00Z"))).toBe(true);
    expect(validateBirthDate("2008-03-02", new Date("2026-03-01T00:00:00Z"))).toBe(false);
  });
  it.each(["2025-02-30", "2000-13-01", "2000-00-01", "2000-01-00", "1900-02-29", "1900-01-01", "1899-12-31", "", "2000-2-01", "0000-01-01", "2099-01-01"])("rejects invalid or out-of-range birth %s", (birth) => expect(validateBirthDate(birth, new Date("2026-03-01T00:00:00Z"))).toBe(false));
  it("accepts the earliest allowed date", () => expect(validateBirthDate("1900-01-02", new Date("2026-03-01T00:00:00Z"))).toBe(true));
  it("validates nested affiliation combinations and complete fictional master", () => {
    expect(demoAffiliations).toHaveLength(2);
    expect(demoAffiliations.flatMap((s) => s.departments)).toHaveLength(4);
    expect(demoAffiliations.flatMap((s) => s.departments.flatMap((d) => d.classes))).toHaveLength(8);
    const [a, b] = demoAffiliations;
    expect(validateAffiliation(a.id, a.departments[0].id, a.departments[0].classes[0].id)).toBe(true);
    expect(validateAffiliation(a.id, b.departments[0].id, b.departments[0].classes[0].id)).toBe(false);
    expect(validateAffiliation(a.id, a.departments[0].id, a.departments[1].classes[0].id)).toBe(false);
    expect(validateAffiliation("unknown", "unknown", "unknown")).toBe(false);
  });
  it("accepts 1–3 known unique photos", () => {
    const ids = demoPhotos.map((p) => p.id);
    expect(validatePhotos([])).toBe(false);
    expect(validatePhotos([ids[0]])).toBe(true);
    expect(validatePhotos(ids)).toBe(true);
    expect(validatePhotos([ids[0], ids[0]])).toBe(false);
    expect(validatePhotos(["unknown"])).toBe(false);
    expect(validatePhotos([...ids, "fourth"])).toBe(false);
  });
  it("accepts any known purposes once, none included, and counts bio code points", () => {
    expect(validatePurposes([])).toBe(true);
    expect(validatePurposes(["friends", "partner", "hobby", "study", "talk"])).toBe(true);
    for (const bad of [["romance"], ["friends", "friends"], ["unknown"], ["Friends"], ["toString"]]) expect(validatePurposes(bad)).toBe(false);
    expect(sortPurposes(["talk", "friends"])).toEqual(["friends", "talk"]);
    expect(purposeText(["talk", "friends"])).toBe("友達がほしい・話し相手がほしい");
    // Kept for the iOS app until MOBILE-LIKES-001 (docs/43 R4).
    expect(validateModes([])).toBe(false);
    expect(validateModes(["romance", "friends"])).toBe(true);
    expect(validateModes(["friends"])).toBe(true);
    expect(validateModes(["unknown"])).toBe(false);
    expect(validateModes(["friends", "friends"])).toBe(false);
    expect(validateBio("")).toBe(true);
    expect(validateBio("😀".repeat(500))).toBe(true);
    expect(validateBio("😀".repeat(501))).toBe(false);
  });
});
