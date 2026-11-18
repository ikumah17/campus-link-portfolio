export const SAFETY_NOTICE = "デモ：ブロック・通報は架空のもので、どこにも送信・保存されません。";
export const reportReasons = {
  harassment: "嫌がらせ", inappropriate_content: "不適切な内容", spam: "迷惑行為・スパム",
  impersonation: "なりすまし", underage_suspected: "年齢条件への懸念", other: "その他",
} as const;
export type ReportReason = keyof typeof reportReasons;
// Reports about a request are no longer taken (order 34); old ones stay readable for staff only.
export type ReportContext = "profile" | "message";
export type ReportInput = { target: string; context: ReportContext; reason: ReportReason; detail: string; messageId?: number };
export type Block = { blocked_id: string; blocked_name_snapshot: string | null; created_at: number };
export type MyReport = { id: string; created_at: number; status: "open" | "triaged" | "actioned" | "dismissed" };
export type SafetyResult<T> = { code: "ok" | "validation" | "not_available"; data: T };
export function validateReport(input: ReportInput): boolean {
  return Object.hasOwn(reportReasons, input.reason) && ["profile", "message"].includes(input.context)
    && typeof input.detail === "string" && [...input.detail].length <= 1000
    && (input.context !== "message" || (Number.isInteger(input.messageId) && input.messageId! > 0));
}
export interface SafetyGateway {
  // block_user(p_target); deliberately no target-dependent response data.
  blockUser(target: string): Promise<SafetyResult<null>>;
  // unblock_user(p_target)
  unblockUser(target: string): Promise<SafetyResult<null>>;
  // list_my_blocks()
  listMyBlocks(): Promise<SafetyResult<Block[]>>;
  // submit_report(p_target, p_context, p_reason, p_detail, p_request_id, p_message_id); p_request_id is always null here.
  submitReport(input: ReportInput): Promise<SafetyResult<null>>;
  // my_reports(); no target, reason, detail or moderation notes.
  myReports(): Promise<SafetyResult<MyReport[]>>;
}
