// Demo-only settings, never applied to profile visibility or sent to a server.
import { demoAffiliations } from "@/data/demo-affiliations";

export type PrivacySettings = {
  hideSameClass: boolean;
  hideSameDepartment: boolean;
  hideSameSchool: boolean;
  showDepartment: boolean;
  showClass: boolean;
  hiddenSchoolIds: string[];
  hiddenDepartmentIds: string[];
  hiddenClassIds: string[];
};
export type PrivacyFlag = "hideSameClass" | "hideSameDepartment" | "hideSameSchool" | "showDepartment" | "showClass";
export type HideTargetKind = "school" | "department" | "class";
export type HideTarget = { id: string; kind: HideTargetKind; label: string };
export const PRIVACY_FLAGS: PrivacyFlag[] = ["hideSameClass", "hideSameDepartment", "hideSameSchool", "showDepartment", "showClass"];
export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  hideSameClass: true, hideSameDepartment: false, hideSameSchool: false,
  showDepartment: false, showClass: false,
  hiddenSchoolIds: [], hiddenDepartmentIds: [], hiddenClassIds: [],
};
export const HIDE_TARGET_KIND_LABEL: Record<HideTargetKind, string> = { school: "学校", department: "学科", class: "クラス" };
export const TARGET_FIELDS = { school: "hiddenSchoolIds", department: "hiddenDepartmentIds", class: "hiddenClassIds" } as const;
export const DEMO_HIDE_TARGETS: HideTarget[] = demoAffiliations.flatMap((s) => [
  { id: s.id, kind: "school" as const, label: s.name },
  ...s.departments.flatMap((d) => [
    { id: d.id, kind: "department" as const, label: d.name },
    ...d.classes.map((c) => ({ id: c.id, kind: "class" as const, label: c.name })),
  ]),
]);
export function defaultPrivacySettings(): PrivacySettings {
  return { ...DEFAULT_PRIVACY_SETTINGS, hiddenSchoolIds: [], hiddenDepartmentIds: [], hiddenClassIds: [] };
}
export function samePrivacySettings(a: PrivacySettings, b: PrivacySettings): boolean {
  return PRIVACY_FLAGS.every((flag) => a[flag] === b[flag]) && Object.values(TARGET_FIELDS).every((field) =>
    a[field].length === b[field].length && a[field].every((id) => b[field].includes(id)));
}
