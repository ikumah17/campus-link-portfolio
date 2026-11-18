import type { ReportContext, ReportReason } from "@/lib/safety-gateway";

export const ADMIN_NOTICE = "デモ：管理画面は架空のデータだけを表示し、実際のアクセス制御・監査・保存はありません。";
export const reportStatuses = ["open", "triaged", "actioned", "dismissed"] as const;
export type ReportStatus = typeof reportStatuses[number];
export const transitions: Record<ReportStatus, readonly ReportStatus[]> = { open: ["triaged", "dismissed"], triaged: ["actioned", "dismissed"], actioned: [], dismissed: [] };
export const statusLabels = { open: "未対応", triaged: "確認中", actioned: "対応済み", dismissed: "見送り" };
export const contextLabels = { profile: "プロフィール", request: "申請（旧機能）", message: "メッセージ" };
export const nameLimits = { school: 80, department: 80, class: 40 };
export type Level = keyof typeof nameLimits;
export type AdminReport = { id: string; reporterId: string; targetId: string; context: ReportContext; reason: ReportReason; createdAt: string; status: ReportStatus; detail: string; snapshot: string | null; note: string };
export type ReportSummary = Pick<AdminReport, "id" | "context" | "reason" | "createdAt" | "status"> & { available: boolean };
export type Affiliation = { id: string; level: Level; parentId: string | null; name: string; isActive: boolean; sortOrder: number; academicYear: number | null };
export type AccountStatus = "active" | "suspended";
export type AdminResult<T> = { code: "ok" | "validation" | "invalid_state" | "not_available"; data: T | null };
export const validTransition = (from: ReportStatus, to: ReportStatus) => transitions[from]?.includes(to) ?? false;
export const validNote = (note: string) => [...note].length <= 1000;
export const validName = (level: Level, name: string) => name.trim().length > 0 && [...name].length <= nameLimits[level];
export const isParty = (report: AdminReport, moderator: string) => report.reporterId === moderator || report.targetId === moderator;
export const validAccountTransition = (from: string, to: string) => (from === "active" && to === "suspended") || (from === "suspended" && to === "active");

// Synchronous demo contract; a hosted adapter must supply real staff authorization.
export interface AdminGateway {
  adminListReports(status: ReportStatus | null): AdminResult<ReportSummary[]>;
  adminGetReport(id: string): AdminResult<AdminReport>;
  adminUpdateReport(id: string, status: ReportStatus, note: string): AdminResult<AdminReport>;
  adminUpsertSchool(id: string | null, name: string, isActive: boolean, sortOrder: number): AdminResult<Affiliation>;
  adminUpsertDepartment(id: string | null, schoolId: string, name: string, isActive: boolean, sortOrder: number): AdminResult<Affiliation>;
  adminUpsertClass(id: string | null, departmentId: string, name: string, academicYear: number | null, isActive: boolean): AdminResult<Affiliation>;
  adminSetAccountStatus(user: string, status: AccountStatus, reason: string | null): AdminResult<AccountStatus>;
}
