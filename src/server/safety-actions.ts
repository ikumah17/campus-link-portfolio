"use server";
import "server-only";
import { revalidatePath } from "next/cache";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { callRpc, type RpcClient } from "@/server/rpc";
import { validId, resolveConversations, messagePage } from "@/server/chat-data";
import { blockRows, blockKey } from "@/server/safety-data";
import { reportReasons } from "@/lib/safety-gateway";
type Status="ok"|"validation"|"not_available"|"rate_limited"|"unauthenticated"|"unavailable";
const uuid=(v:unknown):v is string=>validId(v)&&v.length===36;
const clean=(code:string):{status:Status}=>({status:(["ok","validation","not_available","rate_limited","unauthenticated"].includes(code)?code:"unavailable") as Status});
async function run(action:(client:RpcClient)=>Promise<{status:Status}>,refresh=false){
 try{if(backendMode()!=="supabase")return clean("unavailable");const r=await action(await createServerSupabase());if(refresh&&r.status==="ok")for(const path of ["/","/likes","/talk","/settings/blocks"])revalidatePath(path);return r;}catch{return clean("unavailable");}
}
async function counterpart(client:RpcClient,id:string){const r=await resolveConversations(client);return r.status==="ok"?{status:"ok" as const,target:r.rows.find(v=>v.conversation.id===id)?.counterpart}:r;}
export async function blockProfile(target:unknown){if(!uuid(target))return clean("validation");return run(async c=>clean((await callRpc(c,"block_user",{p_target:target})).code),true);}
export async function blockConversation(id:unknown){if(!uuid(id))return clean("validation");return run(async c=>{const r=await counterpart(c,id);if(r.status!=="ok")return r;if(!r.target)return clean("not_available");return clean((await callRpc(c,"block_user",{p_target:r.target})).code);},true);}
export async function unblockUser(key:unknown){if(typeof key!=="string"||key.length!==64||!/^[0-9a-f]{64}$/.test(key))return clean("validation");return run(async c=>{const r=await blockRows(c);if(r.status!=="ok")return r;const row=r.rows.find(v=>blockKey(v.blocked_id)===key);return row?clean((await callRpc(c,"unblock_user",{p_target:row.blocked_id})).code):clean("ok");},true);}
function validReport(reason:unknown,detail:unknown):detail is string{return typeof reason==="string"&&Object.hasOwn(reportReasons,reason)&&typeof detail==="string"&&[...detail.trim()].length<=1000;}
// A report about a request is no longer taken (order 34: submit_report answers validation); old ones stay for staff.
async function report(kind:"profile"|"conversation"|"message",id:string,reason:unknown,detail:string,messageId?:number){
 return run(async c=>{
 let target=id;
 if(kind==="conversation"||kind==="message"){const r=await counterpart(c,id);if(r.status!=="ok")return r;if(!r.target)return clean("not_available");target=r.target;}
 if(kind==="message"){
 // list_messages scopes the lookup to the accessible conversation. The exclusive
 // upper bound includes the selected id, including MAX_SAFE_INTEGER + 1 (2^53).
 const page=await messagePage(c,id,target,messageId!+1);
 if(page.status!=="ok")return page;
 if(!page.messages.some(message=>message.id===messageId&&!message.mine))return clean("not_available");
 }
 return clean((await callRpc(c,"submit_report",{p_target:target,p_context:kind==="conversation"?"profile":kind,p_reason:reason,p_detail:detail.trim()||null,p_request_id:null,p_message_id:kind==="message"?messageId:null})).code);
 });
}
export async function reportProfile(id:unknown,reason:unknown,detail:unknown){if(!uuid(id)||!validReport(reason,detail))return clean("validation");return report("profile",id,reason,detail);}
export async function reportConversation(id:unknown,reason:unknown,detail:unknown){if(!uuid(id)||!validReport(reason,detail))return clean("validation");return report("conversation",id,reason,detail);}
export async function reportMessage(id:unknown,messageId:unknown,reason:unknown,detail:unknown){if(!uuid(id)||!Number.isSafeInteger(messageId)||(messageId as number)<=0||!validReport(reason,detail))return clean("validation");return report("message",id,reason,detail,messageId as number);}
