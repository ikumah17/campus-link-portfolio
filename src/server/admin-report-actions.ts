"use server";
import "server-only";
import { revalidatePath } from "next/cache";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { reportReasons } from "@/lib/safety-gateway";
import { contentItems, reportTarget } from "@/server/admin-reports";
import { callRpc } from "@/server/rpc";
export type ReportActionResult = {status:"ok"|"invalid"|"invalid_state"|"forbidden"|"unauthenticated"|"unavailable"};
const uuid=(v:unknown):v is string=>typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
function result(code:string):ReportActionResult {
 const status=code==="validation"?"invalid":code==="not_available"?"invalid_state":code;
 if(status==="ok") revalidatePath("/admin/reports");
 return {status:["ok","invalid","invalid_state","forbidden","unauthenticated"].includes(status)?status as ReportActionResult["status"]:"unavailable"};
}
export async function updateReport(id:unknown,status:unknown,note:unknown):Promise<ReportActionResult> {
 if(!uuid(id)||!["triaged","actioned","dismissed"].includes(status as string)||typeof note!=="string"||[...note.trim()].length>1000) return {status:"invalid"};
 if(backendMode()==="demo") return {status:"unavailable"};
 try{return result((await callRpc(await createServerSupabase(),"admin_update_report",{p_id:id,p_status:status,p_note:note.trim()||null})).code);}catch{return {status:"unavailable"};}
}
export async function suspendReportTarget(id:unknown,reason:unknown):Promise<ReportActionResult> {
 if(!uuid(id)||typeof reason!=="string"||!Object.hasOwn(reportReasons,reason)) return {status:"invalid"};
 if(backendMode()==="demo") return {status:"unavailable"};
 try{const client=await createServerSupabase(); const r=await reportTarget(client,id);
 if(r.status!=="ok") return {status:r.status};
 if(!r.target) return {status:"invalid_state"};
 return result((await callRpc(client,"admin_set_account_status",{p_user:r.target,p_status:"suspended",p_reason:reason})).code);
 }catch{return {status:"unavailable"};}
}

export async function reactivateReportTarget(id:unknown):Promise<ReportActionResult> {
 if(!uuid(id)) return {status:"invalid"};
 if(backendMode()==="demo") return {status:"unavailable"};
 try{const client=await createServerSupabase();const r=await reportTarget(client,id);
 if(r.status!=="ok") return {status:r.status};
 if(!r.target) return {status:"invalid_state"};
 return result((await callRpc(client,"admin_set_account_status",{p_user:r.target,p_status:"active",p_reason:null})).code);
 }catch{return {status:"unavailable"};}
}

// MOD-001: hide what the report points at; the database checks the moderator, the report and the item.
export async function hideReportContent(id:unknown,item:unknown,photo:unknown):Promise<ReportActionResult> {
 if(!uuid(id)||!contentItems.includes(item as never)||(item==="photo"?!uuid(photo):photo!==null)) return {status:"invalid"};
 if(backendMode()==="demo") return {status:"unavailable"};
 try{return result((await callRpc(await createServerSupabase(),"admin_hide_reported_content",{p_id:id,p_item:item,p_photo:photo})).code);}catch{return {status:"unavailable"};}
}
export async function unhideReportContent(id:unknown,item:unknown):Promise<ReportActionResult> {
 if(!uuid(id)||!["message","request_message"].includes(item as string)) return {status:"invalid"};
 if(backendMode()==="demo") return {status:"unavailable"};
 try{return result((await callRpc(await createServerSupabase(),"admin_unhide_reported_content",{p_id:id,p_item:item})).code);}catch{return {status:"unavailable"};}
}
