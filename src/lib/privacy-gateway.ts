import { DEMO_HIDE_TARGETS, PRIVACY_FLAGS, TARGET_FIELDS, defaultPrivacySettings, type HideTarget, type PrivacySettings } from "@/data/demo-privacy";

export type { PrivacySettings } from "@/data/demo-privacy";
export type PrivacyResult = { code: "ok"; data: PrivacySettings } | { code: "validation" | "rate_limited"; data: null };
export interface PrivacyGateway {
  // Read mapping: self-only privacy_settings + hidden_affiliations (§5.2/§7).
  // No dedicated read RPC exists yet; a future adapter must use the authorized self-read.
  getMySettings(): Promise<PrivacyResult>;
  // update_privacy_settings(p_hide_same_class, p_hide_same_department, p_hide_same_school,
  // p_show_department, p_show_class, p_hidden_school_ids, p_hidden_department_ids, p_hidden_class_ids).
  updatePrivacySettings(settings: PrivacySettings): Promise<PrivacyResult>;
}
// Optional master supports testing the 50-id boundary beyond the small demo seed.
export function validatePrivacySettings(input: unknown, master: readonly HideTarget[] = DEMO_HIDE_TARGETS): input is PrivacySettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  if (!PRIVACY_FLAGS.every((flag) => Object.hasOwn(record, flag) && typeof record[flag] === "boolean")) return false;
  let total = 0;
  for (const kind of ["school", "department", "class"] as const) {
    const field = TARGET_FIELDS[kind];
    const ids = record[field];
    if (!Object.hasOwn(record, field) || !Array.isArray(ids) || new Set(ids).size !== ids.length) return false;
    if (![...ids].every((id) => typeof id === "string" && master.some((target) => target.kind === kind && target.id === id))) return false;
    total += ids.length;
  }
  return total <= 50;
}
function copy(settings: PrivacySettings): PrivacySettings {
  return { ...settings, hiddenSchoolIds: [...settings.hiddenSchoolIds], hiddenDepartmentIds: [...settings.hiddenDepartmentIds], hiddenClassIds: [...settings.hiddenClassIds] };
}
export const DEMO_PRIVACY_SAVE_LIMIT = 10;
export function createPrivacyDemo(): PrivacyGateway {
  let settings = defaultPrivacySettings();
  let saves = 0;
  return {
    async getMySettings() { return { code: "ok", data: copy(settings) }; },
    async updatePrivacySettings(input) {
      if (!validatePrivacySettings(input)) return { code: "validation", data: null };
      if (saves >= DEMO_PRIVACY_SAVE_LIMIT) return { code: "rate_limited", data: null };
      settings = copy(input);
      saves += 1;
      return { code: "ok", data: copy(settings) };
    },
  };
}
