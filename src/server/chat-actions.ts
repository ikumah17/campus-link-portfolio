"use server";
import "server-only";
import { revalidatePath } from "next/cache";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { callRpc } from "@/server/rpc";
import { validId, resolveConversations, messagePage, type LiveMessage } from "@/server/chat-data";
import { validateBody } from "@/lib/chat-gateway";
type Status="validation"|"unavailable"|"unauthenticated"|"not_available"|"invalid_state"|"rate_limited";
type Result={status:Status}|{status:"ok";messages:LiveMessage[];hasOlder:boolean};
async function perform(id:string,operation:"latest"|"older"|"send"|"read",value?:number,token?:string,body?:string):Promise<Result|{status:"ok"}>{
 try{
  if(backendMode()==="demo")return {status:"unavailable"};
  const client=await createServerSupabase(), resolved=await resolveConversations(client);
  if(resolved.status!=="ok")return resolved;
  const row=resolved.rows.find(r=>r.conversation.id===id);if(!row)return {status:"not_available"};
  if(operation==="send"||operation==="read"){
   const r=await callRpc(client,operation==="send"?"send_message":"mark_read",operation==="send"?{p_conversation:id,p_client_msg_id:token,p_body:body}:{p_conversation:id,p_message_id:value});
   if(r.code!=="ok")return {status:(["not_available","invalid_state","rate_limited","validation","unauthenticated"].includes(r.code)?r.code:"unavailable") as Status};
   revalidatePath("/talk");if(operation==="read")return {status:"ok"};
  }
  return await messagePage(client,id,row.counterpart,operation==="older"?value!:null);
 }catch{return {status:"unavailable"};}
}
export async function sendChatMessage(id:unknown,token:unknown,body:unknown){
 if(!validId(id)||!validId(token)||typeof body!=="string"||!validateBody(body))return {status:"validation" as const};
 return perform(id,"send",undefined,token,body) as Promise<Result>;
}
export async function olderMessages(id:unknown,before:unknown){if(!validId(id)||!Number.isSafeInteger(before)||(before as number)<=0)return {status:"validation" as const};return perform(id,"older",before as number) as Promise<Result>;}
export async function latestMessages(id:unknown){if(!validId(id))return {status:"validation" as const};return perform(id,"latest") as Promise<Result>;}
export async function markRead(id:unknown,messageId:unknown){if(!validId(id)||!Number.isSafeInteger(messageId)||(messageId as number)<=0)return {status:"validation" as const};const r=await perform(id,"read",messageId as number);return {status:r.status};}
