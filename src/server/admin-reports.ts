import "server-only";
import { createHash } from "node:crypto";
import { contextLabels, reportStatuses, type ReportStatus } from "@/lib/admin-gateway";
import { reportReasons, type ReportContext, type ReportReason } from "@/lib/safety-gateway";
import { callRpc, type RpcClient } from "@/server/rpc";
export type ReportRow = { id: string; targetLabel: string | null; context: ReportContext; reason: ReportReason; status: ReportStatus; createdAt: string };
export type ReportDetail = ReportRow & { detail: string | null; evidence: { body: string; createdAt: string | null } | null };
type Failure = { status: "forbidden" | "unauthenticated" | "unavailable" };
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const text = (v: unknown) => v === null || typeof v === "string";
function valid(v: unknown): v is Record<string, unknown> & { id: string; target_user_id: string | null; context: ReportContext; reason: ReportReason; status: ReportStatus; created_at: string } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return uuid(r.id) && (r.reporter_id === null || uuid(r.reporter_id)) && (r.target_user_id === null || uuid(r.target_user_id)) && typeof r.context === "string" && Object.hasOwn(contextLabels,r.context) && typeof r.reason === "string" && Object.hasOwn(reportReasons,r.reason) && reportStatuses.includes(r.status as ReportStatus) && typeof r.created_at === "string";
}
function row(r: Parameters<typeof valid>[0] & Record<string, unknown>): ReportRow {
  return { id: r.id as string, targetLabel: r.target_user_id === null ? null : `対象 #${createHash("sha256").update(r.target_user_id as string).digest("hex").slice(0,8)}`, context: r.context as ReportContext, reason: r.reason as ReportReason, status: r.status as ReportStatus, createdAt: r.created_at as string };
}
function failure(code: string): Failure { return { status: code === "forbidden" || code === "unauthenticated" ? code : "unavailable" }; }
export async function listReports(client: RpcClient, status: ReportStatus): Promise<{status:"ok"; reports:ReportRow[]} | Failure> {
 const r = await callRpc(client,"admin_list_reports",{p_status:status});
 if(r.code !== "ok") return failure(r.code);
 if(!Array.isArray(r.data) || !r.data.every(v=>valid(v) && v.status===status)) return {status:"unavailable"};
 return {status:"ok",reports:r.data.map(v=>row(v as Record<string,unknown>))};
}
async function read(client: RpcClient,id:string) {
 const r=await callRpc(client,"admin_get_report",{p_id:id});
 if(r.code!=="ok") return failure(r.code);
 if(!Array.isArray(r.data)||r.data.length>1) return {status:"unavailable"} as Failure;
 if(!r.data.length) return {status:"ok" as const,raw:null};
 const v=r.data[0];
 if(!valid(v)||v.id!==id||!text(v.detail)||!text(v.evidence_message_body)||!text(v.evidence_message_created_at)) return {status:"unavailable"} as Failure;
 return {status:"ok" as const,raw:v};
}
export async function getReport(client:RpcClient,id:string):Promise<{status:"ok";report:ReportDetail|null}|Failure> {
 const r=await read(client,id); if(r.status!=="ok") return r;
 const v=r.raw;
 return {status:"ok",report:v?{...row(v),detail:v.detail as string|null,evidence:v.evidence_message_body===null?null:{body:v.evidence_message_body as string,createdAt:v.evidence_message_created_at as string|null}}:null};
}
export async function reportTarget(client:RpcClient,id:string) {
 const r=await read(client,id); return r.status==="ok"?{status:"ok" as const,target:r.raw?.target_user_id??null}:r;
}
// MOD-001 (order 33): what the report points at. Messages and request messages carry their original text for the
// moderator; the bio carries the text shown now (null once hidden); a photo carries only its id and position.
// Order 34 has one bio item; request messages remain for reports made before requests ended.
// Message and request ids stay on the server like the report's own references: actions name the report and the item.
export const contentItems = ["message", "request_message", "bio", "photo"] as const;
export type ContentItem = typeof contentItems[number];
export type ReportContentItem = { item: ContentItem; ref: string | null; position: number | null; body: string | null; hidden: boolean; hiddenAt: string | null };
function contentRow(v: unknown): ReportContentItem | null {
 if(!v||typeof v!=="object"||Array.isArray(v)) return null;
 const r=v as Record<string,unknown>, item=r.item as ContentItem;
 if(!contentItems.includes(item)||!text(r.body)||typeof r.hidden!=="boolean"||!text(r.hidden_at)) return null;
 if(item==="photo"?!uuid(r.ref)||!Number.isSafeInteger(r.photo_position)||r.body!==null||r.hidden:r.photo_position!==null) return null;
 if(item==="message"&&(typeof r.ref!=="string"||!/^[1-9][0-9]{0,18}$/.test(r.ref)||typeof r.body!=="string")) return null;
 if(item==="request_message"&&(!uuid(r.ref)||typeof r.body!=="string")) return null;
 if(item==="bio"&&(r.ref!==null||(r.body===null)!==r.hidden)) return null;
 return {item,ref:item==="photo"?r.ref as string:null,position:r.photo_position as number|null,body:r.body as string|null,hidden:r.hidden,hiddenAt:r.hidden_at as string|null};
}
export async function getReportContent(client:RpcClient,id:string):Promise<{status:"ok";content:ReportContentItem[]}|Failure> {
 const r=await callRpc(client,"admin_get_report_content",{p_id:id});
 if(r.code!=="ok") return failure(r.code);
 if(!Array.isArray(r.data)) return {status:"unavailable"};
 const content=r.data.map(contentRow);
 return content.every(c=>c!==null)?{status:"ok",content:content as ReportContentItem[]}:{status:"unavailable"};
}
