import "server-only";
import { callRpc, type RpcClient } from "@/server/rpc";
export const PAGE_SIZE = 30;
export const validId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
export type LiveConversation = { id: string; partner: { name: string; photoId: string | null }; latest: { body: string; at: string; mine: boolean } | null; unread: boolean };
// hidden: a moderator took the message out of view (order 33); its stored body is then only the placeholder.
export type LiveMessage = { id: number; mine: boolean; body: string; createdAt: string; hidden: boolean };
type Failure = { status: "unauthenticated" | "unavailable" };
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
export async function resolveConversations(client: RpcClient): Promise<{status:"ok"; rows: {conversation: LiveConversation; counterpart: string}[]} | Failure> {
 const r = await callRpc(client,"list_my_conversations");
 if(r.code!=="ok") return {status:r.code==="unauthenticated"?r.code:"unavailable"};
 if(!Array.isArray(r.data)) return {status:"unavailable"};
 const rows = [];
 for(const value of r.data){
  if(!value || typeof value!=="object") return {status:"unavailable"};
  const v=value as Record<string,unknown>;
  const empty=[v.last_message_id,v.last_message_body,v.last_message_at,v.last_message_mine].every(x=>x===null);
  if(!validId(v.conversation_id)||!validId(v.connection_id)||!validId(v.counterpart_id)||typeof v.counterpart_name!=="string"||!(v.counterpart_photo_id===null||validId(v.counterpart_photo_id))||typeof v.unread!=="boolean"||(!empty&&(!positive(v.last_message_id)||typeof v.last_message_body!=="string"||typeof v.last_message_at!=="string"||typeof v.last_message_mine!=="boolean"))) return {status:"unavailable"};
  rows.push({counterpart:v.counterpart_id,conversation:{id:v.conversation_id,partner:{name:v.counterpart_name,photoId:v.counterpart_photo_id},latest:empty?null:{body:v.last_message_body as string,at:v.last_message_at as string,mine:v.last_message_mine as boolean},unread:v.unread}});
 }
 return {status:"ok",rows};
}
export async function listConversations(client: RpcClient){const r=await resolveConversations(client);return r.status==="ok"?{status:"ok" as const,conversations:r.rows.map(r=>r.conversation)}:r;}
export async function messagePage(client: RpcClient,id:string,counterpart:string,before:number|null){
 const r=await callRpc(client,"list_messages",{p_conversation:id,p_before:before,p_limit:PAGE_SIZE});
 if(r.code!=="ok") return {status:r.code==="unauthenticated"?r.code:"unavailable"} as Failure;
 if(!Array.isArray(r.data)) return {status:"unavailable"} as Failure;
 const messages:LiveMessage[]=[];
 for(const value of r.data){
  if(!value||typeof value!=="object") return {status:"unavailable"} as Failure;
  const v=value as Record<string,unknown>;
  // A database before order 33 has no hidden column; nothing is hidden there.
  if(!positive(v.id)||!validId(v.sender_id)||typeof v.body!=="string"||typeof v.created_at!=="string"||!Number.isFinite(Date.parse(v.created_at))||!(v.hidden===undefined||typeof v.hidden==="boolean")) return {status:"unavailable"} as Failure;
  messages.push({id:v.id,mine:v.sender_id!==counterpart,body:v.body,createdAt:v.created_at,hidden:v.hidden===true});
 }
 return {status:"ok" as const,messages:messages.sort((a,b)=>a.id-b.id),hasOlder:r.data.length===PAGE_SIZE};
}
export async function loadRoom(client:RpcClient,id:string){
 const r=await resolveConversations(client);if(r.status!=="ok")return r;
 const row=r.rows.find(r=>r.conversation.id===id);if(!row)return {status:"ok" as const,room:null};
 const page=await messagePage(client,id,row.counterpart,null);if(page.status!=="ok")return page;
 return {status:"ok" as const,room:{conversation:row.conversation,messages:page.messages,hasOlder:page.hasOlder}};
}
