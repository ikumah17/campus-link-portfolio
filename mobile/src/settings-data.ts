import type { SupabaseClient } from "@supabase/supabase-js";
import type { DataClient, Failure } from "./account-data";
import { gate, type Gated } from "./discover-data";
import { DELETE_CONFIRMATION } from "./messages";
import { loadAffiliationMaster, type Affiliation } from "./onboarding-data";
import { callRpc, isUuid, type RpcClient } from "./rpc";

// MOBILE-004 (docs/42 §2 #10–#14): ports of the web's src/server/privacy-data.ts, privacy-actions.ts, safety-data.ts,
// safety-actions.ts (unblock), account-data.ts and account-actions.ts, called with the user's own JWT. The RPCs and
// own-row RLS decide; only fixed status codes leave these functions, never provider text. A blocked user's id is kept
// only to unblock and never reaches the screen or a log.

// --- Privacy (src/server/privacy-data.ts, src/server/privacy-actions.ts) ---
export type PrivacySettings = {
  hideSameClass: boolean; hideSameDepartment: boolean; hideSameSchool: boolean; showDepartment: boolean; showClass: boolean;
  hiddenSchoolIds: string[]; hiddenDepartmentIds: string[]; hiddenClassIds: string[];
};
export type PrivacyFlag = "hideSameClass" | "hideSameDepartment" | "hideSameSchool" | "showDepartment" | "showClass";
export type HideTargetKind = "school" | "department" | "class";
export type HideTarget = { id: string; kind: HideTargetKind; label: string };
export const PRIVACY_FLAGS: PrivacyFlag[] = ["hideSameClass", "hideSameDepartment", "hideSameSchool", "showDepartment", "showClass"];
export const TARGET_FIELDS = { school: "hiddenSchoolIds", department: "hiddenDepartmentIds", class: "hiddenClassIds" } as const;
export const MAX_HIDDEN_TARGETS = 50;

export function samePrivacySettings(a: PrivacySettings, b: PrivacySettings): boolean {
  return PRIVACY_FLAGS.every((flag) => a[flag] === b[flag]) && Object.values(TARGET_FIELDS).every((field) =>
    a[field].length === b[field].length && a[field].every((id) => b[field].includes(id)));
}

// Child labels name their parents: the same department or class name can exist in several branches.
export function privacyTargets(master: Affiliation[]): HideTarget[] {
  return master.flatMap((s) => [{ id: s.id, kind: "school" as const, label: s.name }, ...s.departments.flatMap((d) => [
    { id: d.id, kind: "department" as const, label: `${s.name} / ${d.name}` },
    ...d.classes.map((c) => ({ id: c.id, kind: "class" as const, label: `${s.name} / ${d.name} / ${c.name}` })),
  ])]);
}

const refused = (r: { status?: number; error?: { code?: string } | null }) => r.status === 401 || ["PGRST301", "PGRST302"].includes(r.error?.code ?? "");

async function loadMyPrivacy(client: Pick<SupabaseClient, "from">): Promise<{ status: "ok"; settings: PrivacySettings } | Failure> {
  const results = await Promise.all([
    client.from("privacy_settings").select("hide_same_class,hide_same_department,hide_same_school,show_department,show_class").limit(2),
    client.from("hidden_affiliations").select("school_id,department_id,class_id"),
  ]);
  if (results.some(refused)) return { status: "unauthenticated" };
  if (results.some((r) => r.error || !Array.isArray(r.data))) return { status: "unavailable" };
  const rows = results[0].data as Record<string, unknown>[];
  if (rows.length > 1) return { status: "unavailable" };
  const row = rows[0];
  if (rows.length && (!row || typeof row !== "object" || ["hide_same_class", "hide_same_department", "hide_same_school", "show_department", "show_class"].some((k) => typeof row[k] !== "boolean"))) return { status: "unavailable" };
  // No row yet: the database's defaults (the same class hidden), as on the web (docs/42 §2 #12).
  const settings: PrivacySettings = {
    hideSameClass: (row?.hide_same_class as boolean | undefined) ?? true, hideSameDepartment: (row?.hide_same_department as boolean | undefined) ?? false,
    hideSameSchool: (row?.hide_same_school as boolean | undefined) ?? false, showDepartment: (row?.show_department as boolean | undefined) ?? false,
    showClass: (row?.show_class as boolean | undefined) ?? false, hiddenSchoolIds: [], hiddenDepartmentIds: [], hiddenClassIds: [],
  };
  const fields = ["school_id", "department_id", "class_id"] as const;
  const lists = ["hiddenSchoolIds", "hiddenDepartmentIds", "hiddenClassIds"] as const;
  for (const hidden of results[1].data as Record<string, unknown>[]) {
    if (!hidden || typeof hidden !== "object" || fields.some((k) => hidden[k] !== null && !isUuid(hidden[k])) || fields.filter((k) => hidden[k] !== null).length !== 1) return { status: "unavailable" };
    fields.forEach((k, i) => { if (hidden[k] !== null) settings[lists[i]].push(hidden[k] as string); });
  }
  return { status: "ok", settings };
}

export type PrivacyPage = { status: "ok"; settings: PrivacySettings; targets: HideTarget[] };
// src/app/settings/privacy/page.tsx: the gate, then the own settings and the affiliation master.
export function loadPrivacy(client: DataClient): Promise<Gated<PrivacyPage>> {
  return gate<PrivacyPage>(client, async () => {
    const [privacy, master] = await Promise.all([loadMyPrivacy(client), loadAffiliationMaster(client)]);
    if (privacy.status !== "ok") return privacy;
    return master ? { status: "ok", settings: privacy.settings, targets: privacyTargets(master) } : { status: "unavailable" };
  });
}

export type PrivacySaveStatus = "ok" | "invalid" | "rate_limited" | "unauthenticated" | "forbidden" | "unavailable";
export async function savePrivacy(client: RpcClient, input: unknown): Promise<PrivacySaveStatus> {
  try {
    if (!input || typeof input !== "object") return "invalid";
    const r = input as Record<string, unknown>;
    const arrays = Object.values(TARGET_FIELDS);
    if (PRIVACY_FLAGS.some((k) => typeof r[k] !== "boolean") ||
      arrays.some((k) => !Array.isArray(r[k]) || (r[k] as unknown[]).some((id) => !isUuid(id)) || new Set(r[k] as unknown[]).size !== (r[k] as unknown[]).length)) return "invalid";
    if (arrays.reduce((n, k) => n + (r[k] as string[]).length, 0) > MAX_HIDDEN_TARGETS) return "invalid";
    const result = await callRpc(client, "update_privacy_settings", {
      p_hide_same_class: r.hideSameClass, p_hide_same_department: r.hideSameDepartment, p_hide_same_school: r.hideSameSchool,
      p_show_department: r.showDepartment, p_show_class: r.showClass,
      p_hidden_school_ids: r.hiddenSchoolIds, p_hidden_department_ids: r.hiddenDepartmentIds, p_hidden_class_ids: r.hiddenClassIds,
    });
    return result.code === "validation" ? "invalid" : ["ok", "rate_limited", "unauthenticated", "forbidden"].includes(result.code) ? result.code as PrivacySaveStatus : "unavailable";
  } catch {
    return "unavailable";
  }
}

// --- Blocks and own reports (src/server/safety-data.ts, safety-actions.ts unblockUser) ---
export type BlockRow = { target: string; name: string | null; createdAt: string };
export type ReportRow = { createdAt: string; status: "open" | "triaged" | "actioned" | "dismissed" };
const validTime = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

async function blockRows(client: RpcClient): Promise<{ status: "ok"; rows: BlockRow[] } | Failure> {
  const r = await callRpc(client, "list_my_blocks");
  if (r.code !== "ok") return { status: r.code === "unauthenticated" ? "unauthenticated" : "unavailable" };
  if (!Array.isArray(r.data)) return { status: "unavailable" };
  const rows: BlockRow[] = [];
  for (const v of r.data) {
    if (!v || typeof v !== "object") return { status: "unavailable" };
    const x = v as Record<string, unknown>;
    if (!isUuid(x.blocked_id) || !(x.blocked_name_snapshot === null || typeof x.blocked_name_snapshot === "string") || !validTime(x.created_at)) return { status: "unavailable" };
    rows.push({ target: x.blocked_id, name: x.blocked_name_snapshot, createdAt: x.created_at });
  }
  return { status: "ok", rows };
}

async function reportRows(client: RpcClient): Promise<{ status: "ok"; reports: ReportRow[] } | Failure> {
  const r = await callRpc(client, "my_reports");
  if (r.code !== "ok") return { status: r.code === "unauthenticated" ? "unauthenticated" : "unavailable" };
  if (!Array.isArray(r.data)) return { status: "unavailable" };
  const reports: ReportRow[] = [];
  for (const v of r.data) {
    if (!v || typeof v !== "object") return { status: "unavailable" };
    const x = v as Record<string, unknown>;
    if (!isUuid(x.id) || !validTime(x.created_at) || !["open", "triaged", "actioned", "dismissed"].includes(x.status as string)) return { status: "unavailable" };
    reports.push({ createdAt: x.created_at, status: x.status as ReportRow["status"] });
  }
  return { status: "ok", reports };
}

export type BlocksPage = { status: "ok"; blocks: BlockRow[]; reports: ReportRow[] };
// src/app/settings/blocks/page.tsx: the gate, then the block list and the own reports' states.
export function loadBlocks(client: RpcClient): Promise<Gated<BlocksPage>> {
  return gate<BlocksPage>(client, async () => {
    const blocks = await blockRows(client);
    if (blocks.status !== "ok") return blocks;
    const reports = await reportRows(client);
    return reports.status === "ok" ? { status: "ok", blocks: blocks.rows, reports: reports.reports } : reports;
  });
}

export type UnblockStatus = "ok" | "validation" | "not_available" | "rate_limited" | "unauthenticated" | "unavailable";
const cleanSafety = (code: string): UnblockStatus => (["ok", "validation", "not_available", "rate_limited", "unauthenticated"].includes(code) ? code : "unavailable") as UnblockStatus;

// The web re-reads the block list and unblocks only a listed user; one no longer listed is already unblocked ("ok").
export async function unblock(client: RpcClient, target: unknown): Promise<UnblockStatus> {
  if (!isUuid(target)) return "validation";
  try {
    const r = await blockRows(client);
    if (r.status !== "ok") return r.status;
    if (!r.rows.some((row) => row.target === target)) return "ok";
    return cleanSafety((await callRpc(client, "unblock_user", { p_target: target })).code);
  } catch {
    return "unavailable";
  }
}

// --- Account (src/server/account-data.ts, src/server/account-actions.ts) ---
export type AccountState = "active" | "deactivated" | "suspended";
export type AccountActionStatus = "ok" | "invalid" | "invalid_state" | "forbidden" | "unauthenticated" | "unavailable";
export type AccountPage = { status: "ok"; accountStatus: AccountState };

// my_account alone gates this screen: a paused account still completed its profile and must reach it to resume.
export async function loadAccount(client: RpcClient): Promise<Gated<AccountPage>> {
  try {
    const result = await callRpc(client, "my_account");
    if (result.code === "unauthenticated") return { status: "unauthenticated" };
    if (result.code !== "ok" || !Array.isArray(result.data) || result.data.length !== 1) return { status: "unavailable" };
    const row = result.data[0] as Record<string, unknown> | null;
    if (!row || typeof row !== "object" || typeof row.profile_completed !== "boolean") return { status: "unavailable" };
    // Since order 18 a deleted account reads only its id and 'deleted'; no screen serves it.
    if (row.account_status === "deleted") return { status: "unavailable" };
    if (!row.profile_completed) return { status: "incomplete" };
    if (row.account_status === "active" || row.account_status === "deactivated" || row.account_status === "suspended") return { status: "ok", accountStatus: row.account_status };
  } catch {
    // Never forward account values or provider errors to the screen.
  }
  return { status: "unavailable" };
}

const known: AccountActionStatus[] = ["ok", "invalid_state", "forbidden", "unauthenticated"];
const cleanAccount = (code: string): AccountActionStatus => (known as string[]).includes(code) ? code as AccountActionStatus : "unavailable";

async function toggle(client: RpcClient, name: "deactivate_account" | "reactivate_account"): Promise<AccountActionStatus> {
  try { return cleanAccount((await callRpc(client, name)).code); } catch { return "unavailable"; }
}
export const pauseAccount = (client: RpcClient) => toggle(client, "deactivate_account");
export const resumeAccount = (client: RpcClient) => toggle(client, "reactivate_account");

/**
 * request_account_deletion with the web's confirmation word. The caller then ends every session (docs/42 §2 #13);
 * the retention job removes the Auth user later.
 */
export async function requestDeletion(client: RpcClient, confirmation: unknown): Promise<AccountActionStatus> {
  if (confirmation !== DELETE_CONFIRMATION) return "invalid";
  try { return cleanAccount((await callRpc(client, "request_account_deletion")).code); } catch { return "unavailable"; }
}

