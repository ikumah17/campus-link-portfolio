// Convenience checks only; the server remains authoritative. Mirrors
// supabase/migrations/20261027120001_foundation.sql (anniversary/adult_from/today_jst)
// and 20261027120007_visibility.sql (start_onboarding).
// MOBILE-002 (docs/42 §1.1): split from onboarding-validation.ts without imports, so the iOS app shares the same checks.
export const codePointLength = (value: string) => [...value].length;
export const validateDisplayName = (value: string) => value.trim().length > 0 && codePointLength(value) <= 20;
export const validateGender = (value: string) => ["female", "male", "other"].includes(value);
// Kept only for the iOS app until MOBILE-LIKES-001 (docs/43 R4); the web uses validatePurposes.
export const validateModes = (values: string[]) => values.length > 0 && values.every((v) => ["romance", "friends"].includes(v)) && new Set(values).size === values.length;
// The fixed purpose codes in their stored order and their labels (order 34, private.purposes_ok and purposes_sorted).
export const PURPOSE_LABELS = { friends: "友達がほしい", partner: "恋人がほしい", hobby: "趣味仲間がほしい", study: "勉強仲間がほしい", talk: "話し相手がほしい" } as const;
export type Purpose = keyof typeof PURPOSE_LABELS;
export const PURPOSES = Object.keys(PURPOSE_LABELS) as Purpose[];
// Optional: any number of the known codes, each once; none is fine.
export const validatePurposes = (values: string[]): values is Purpose[] => values.length <= PURPOSES.length && values.every((v) => Object.hasOwn(PURPOSE_LABELS, v)) && new Set(values).size === values.length;
export const sortPurposes = (values: Purpose[]) => PURPOSES.filter((p) => values.includes(p));
export const purposeText = (values: Purpose[]) => sortPurposes(values).map((p) => PURPOSE_LABELS[p]).join("・");
export const validateBio = (value: string) => codePointLength(value) <= 500;

const leap = (year: number) => year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
function realDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const days = [31, leap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

export function todayJst(now: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function anniversary(birth: string, years: number) {
  if (!realDate(birth) || !Number.isInteger(years)) return "";
  const year = Number(birth.slice(0, 4)) + years;
  if (year < 1 || year > 9999) return "";
  const md = birth.slice(5) === "02-29" && !leap(year) ? "03-01" : birth.slice(5);
  return `${String(year).padStart(4, "0")}-${md}`;
}
export const adultFrom = (birth: string) => anniversary(birth, 18);
export function validateBirthDate(birth: string, now: Date) {
  return realDate(birth) && birth > "1900-01-01" && !!adultFrom(birth) && adultFrom(birth) <= todayJst(now);
}
