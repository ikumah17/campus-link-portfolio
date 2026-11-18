import { demoAffiliations, demoPhotos } from "@/data/demo-affiliations";

// Convenience checks only; the server remains authoritative. The checks without demo data live in
// onboarding-rules.ts (MOBILE-002), shared with the iOS app.
export { adultFrom, anniversary, codePointLength, todayJst, validateBio, validateBirthDate, validateDisplayName, validateGender, validatePurposes, PURPOSES, PURPOSE_LABELS, purposeText, type Purpose } from "@/lib/onboarding-rules";

export const validatePhotos = (values: string[]) => values.length >= 1 && values.length <= 3 && new Set(values).size === values.length && values.every((v) => demoPhotos.some((p) => p.id === v));
export const validateAffiliation = (school: string, dept: string, cls: string) =>
  !!demoAffiliations.find((s) => s.id === school)?.departments.find((d) => d.id === dept)?.classes.find((c) => c.id === cls);
