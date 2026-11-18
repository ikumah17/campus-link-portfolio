import type { AdminReport } from "@/lib/admin-gateway";

export const demoModerator = "demo-moderator";
export function createDemoReports(): AdminReport[] {
  return [
    { id: "admin-report-1", reporterId: "fictional-a", targetId: "fictional-b", context: "message", reason: "harassment", status: "open", detail: "架空の会話についての通報です。", snapshot: "架空のメッセージ：何度も同じ連絡が届きました。" },
    { id: "admin-report-2", reporterId: demoModerator, targetId: "fictional-c", context: "profile", reason: "other", status: "open", detail: "担当者自身が当事者の架空サンプル。", snapshot: null },
    { id: "admin-report-3", reporterId: "fictional-d", targetId: "fictional-e", context: "request", reason: "spam", status: "triaged", detail: "架空の申請について確認中です。", snapshot: null },
  ].map((row) => ({ ...row, createdAt: "2026-10-30T09:00:00+09:00", note: "" })) as AdminReport[];
}
