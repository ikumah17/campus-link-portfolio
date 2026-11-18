import "server-only";
import { createHash } from "node:crypto";
import { callRpc, type RpcClient } from "@/server/rpc";
import { validId } from "@/server/chat-data";
export const blockKey = (id: string) => createHash("sha256").update(id).digest("hex");
export type LiveBlock = { key: string; name: string | null; createdAt: string };
export type LiveReport = { createdAt: string; status: "open" | "triaged" | "actioned" | "dismissed" };
export async function blockRows(client: RpcClient) {
 const r = await callRpc(client, "list_my_blocks");
 if(r.code!=="ok") return {status:r.code==="unauthenticated"?"unauthenticated" as const:"unavailable" as const};
 if(!Array.isArray(r.data)) return {status:"unavailable" as const};
 const rows: {blocked_id:string; blocked_name_snapshot:string|null; created_at:string}[]=[];
 for(const v of r.data) {
  if(!v || typeof v!=="object") return {status:"unavailable" as const};
  const x=v as Record<string,unknown>;
  if(!validId(x.blocked_id)||x.blocked_id.length!==36||!(x.blocked_name_snapshot===null||typeof x.blocked_name_snapshot==="string")||typeof x.created_at!=="string"||!Number.isFinite(Date.parse(x.created_at))) return {status:"unavailable" as const};
  rows.push({blocked_id:x.blocked_id,blocked_name_snapshot:x.blocked_name_snapshot,created_at:x.created_at});
 }
 return {status:"ok" as const,rows};
}
export async function listBlocks(client:RpcClient) {
 try {const r=await blockRows(client);return r.status==="ok"?{status:"ok" as const,blocks:r.rows.map(v=>({key:blockKey(v.blocked_id),name:v.blocked_name_snapshot,createdAt:v.created_at}))}:r;}catch{return {status:"unavailable" as const};}
}
export async function listReports(client:RpcClient) {
 try {
 const r=await callRpc(client,"my_reports");
 if(r.code!=="ok")return {status:r.code==="unauthenticated"?"unauthenticated" as const:"unavailable" as const};
 if(!Array.isArray(r.data))return {status:"unavailable" as const};
 const reports:LiveReport[]=[];
 for(const v of r.data){
  if(!v||typeof v!=="object")return {status:"unavailable" as const};
  const x=v as Record<string,unknown>;
  if(!validId(x.id)||x.id.length!==36||typeof x.created_at!=="string"||!Number.isFinite(Date.parse(x.created_at))||!["open","triaged","actioned","dismissed"].includes(x.status as string))return {status:"unavailable" as const};
  reports.push({createdAt:x.created_at,status:x.status as LiveReport["status"]});
 }
 return {status:"ok" as const,reports};
 }catch{return {status:"unavailable" as const};}
}
