// @vitest-environment node
import {beforeAll,afterAll,it,expect,vi} from "vitest";
import {randomUUID} from "node:crypto";
import type {PGlite} from "@electric-sql/pglite";
import {freshDb,asUser,user,owner} from "./db/harness";
import {createMasters,createUser,connect,legacyRequest,type Masters} from "./db/fixtures";
const m=vi.hoisted(()=>({create:vi.fn()}));
vi.mock("server-only",()=>({}));vi.mock("@/lib/backend",()=>({backendMode:()=>"supabase"}));vi.mock("@/lib/supabase/server",()=>({createServerSupabase:m.create}));vi.mock("next/cache",()=>({revalidatePath:vi.fn()}));
import {loadRoom,listConversations} from "@/server/chat-data";
import {sendChatMessage,markRead,olderMessages} from "@/server/chat-actions";
let db:PGlite,masters:Masters;
const network=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("no network"));
beforeAll(async()=>{db=await freshDb();masters=await createMasters(db,"safety")},180000);
afterAll(async()=>{expect(network).not.toHaveBeenCalled();await db?.close();vi.restoreAllMocks()});
function client(me:string){return {async rpc(name:string,args:Record<string,unknown>){
 const casts:Record<string,string>={p_conversation:"uuid",p_client_msg_id:"uuid",p_body:"text",p_before:"bigint",p_limit:"int",p_min_age:"int",p_max_age:"int",p_message_id:"bigint",p_mode:"public.discover_mode",p_genders:"text[]",p_school_ids:"uuid[]",p_after:"uuid",p_target:"uuid",p_reason:"public.report_reason",p_context:"public.report_context",p_detail:"text",p_request_id:"uuid"};
 const sql=Object.keys(args).map((k,i)=>`${k}=>$${i+1}::${casts[k]??"text"}`).join(",");
 try{const rows=await asUser<Record<string,unknown>>(db,user(me),`select * from public.${name}(${sql})`,Object.values(args));
 const normalized=rows.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,typeof v==="bigint"?Number(v):v instanceof Date?v.toISOString():v])));
 return {data:["list_my_conversations","list_messages","list_my_blocks","my_reports","list_my_requests","get_profile","discover_profiles"].includes(name)?normalized:normalized[0],error:null};
 }catch(e){const v=e as {code:string;message:string};return {data:null,error:{code:v.code,message:v.message}}}
}}}

import {blockConversation,blockProfile,unblockUser,reportProfile,reportMessage} from "@/server/safety-actions";
import {listBlocks,listReports} from "@/server/safety-data";
import {getProfile,listProfiles} from "@/server/discover-data";
it("real authenticated block ends both directions and unblocking never restores connection",async()=>{
 const a=await createUser(db,{cls:masters.classes[0]}),b=await createUser(db,{cls:masters.classes[4]});const {conversation}=await connect(db,a,b);
 m.create.mockResolvedValue(client(a));expect(await blockConversation(conversation)).toEqual({status:"ok"});
 for(const [me,other] of [[a,b],[b,a]]){expect(await listConversations(client(me))).toEqual({status:"ok",conversations:[]});expect(await loadRoom(client(me),conversation)).toEqual({status:"ok",room:null});const list=await listProfiles(client(me),{genders:[],schoolIds:[]});expect(list.status).toBe("ok");if(list.status==="ok")expect(list.profiles.some(p=>p.id===other)).toBe(false);const [photo]=await owner<{id:string}>(db,"select id from public.profile_photos where user_id=$1",[other]);expect(await asUser(db,user(me),"select * from public.authorize_photo_delivery($1::uuid[])",[[photo.id]])).toEqual([]);expect(await getProfile(client(me),other)).toEqual({status:"ok",profile:null});m.create.mockResolvedValue(client(me));expect(await sendChatMessage(conversation,randomUUID(),"no")).toEqual({status:"not_available"});expect(await blockProfile(other)).toEqual({status:"ok"});}
 m.create.mockResolvedValue(client(a));const rows=await listBlocks(client(a));expect(rows.status).toBe("ok");if(rows.status!=="ok")throw Error("blocks");expect(JSON.stringify(rows)).not.toContain(b);expect(await unblockUser(rows.blocks[0].key)).toEqual({status:"ok"});expect(await loadRoom(client(a),conversation)).toEqual({status:"ok",room:null});expect(await blockProfile(randomUUID())).toEqual({status:"ok"});
});
it("real reports accept profile and counterpart message, refuse request reports (order 34), reject own message, strip report ids",async()=>{
 const a=await createUser(db,{cls:masters.classes[0]}),b=await createUser(db,{cls:masters.classes[4]});const {conversation}=await connect(db,a,b);
 const request=await legacyRequest(db,b,a,{status:"accepted"});
 await owner(db,"insert into public.messages(conversation_id,sender_id,client_msg_id,body)values($1,$2,gen_random_uuid(),'evidence'),($1,$3,gen_random_uuid(),'own')",[conversation,b,a]);
 const room=await loadRoom(client(a),conversation);if(room.status!=="ok"||!room.room)throw Error("room");m.create.mockResolvedValue(client(a));expect(await reportProfile(b,"spam","")).toEqual({status:"ok"});expect((await client(a).rpc("submit_report",{p_target:b,p_context:"request",p_reason:"spam",p_detail:null,p_request_id:request,p_message_id:null})).error).toMatchObject({message:"validation"});for(const msg of room.room.messages)expect(await reportMessage(conversation,msg.id,"spam","")).toEqual({status:msg.mine?"not_available":"ok"});const r=await listReports(client(a));expect(r.status).toBe("ok");expect(JSON.stringify(r)).not.toContain('"id"');
});

it("blocks delete the pair's likes and snapshot is only captured for visible identity",async()=>{
 const a=await createUser(db,{cls:masters.classes[0]}),b=await createUser(db,{cls:masters.classes[4]});
 await owner(db,"insert into public.likes(liker_id,liked_id) values($1,$2),($2,$1)",[a,b]);
 m.create.mockResolvedValue(client(a));expect(await blockProfile(b)).toEqual({status:"ok"});expect(await owner(db,"select count(*)::int as n from public.likes where $1 in (liker_id,liked_id)",[a])).toEqual([{n:0}]);
 const visible=await listBlocks(client(a));expect(visible.status).toBe("ok");if(visible.status!=="ok")throw Error("blocks");expect(visible.blocks[0].name).not.toBeNull();
 const hidden=await createUser(db,{cls:masters.classes[4],hidden:{schools:[masters.classes[0].schoolId]}});expect(await blockProfile(hidden)).toEqual({status:"ok"});const rows=await listBlocks(client(a));if(rows.status!=="ok")throw Error("blocks");expect(rows.blocks.some(b=>b.name===null)).toBe(true);
 const c=await createUser(db,{cls:masters.classes[0]});expect(await reportProfile(c,"spam","")).toEqual({status:"not_available"});
});

it("rejects evidence from an ended conversation after the same pair reconnects without writing",async()=>{
 const a=await createUser(db,{cls:masters.classes[0]}),b=await createUser(db,{cls:masters.classes[4]});
 const old=await connect(db,a,b);
 const [message]=await owner<{id:number}>(db,"insert into public.messages(conversation_id,sender_id,client_msg_id,body)values($1,$2,gen_random_uuid(),'old evidence') returning id",[old.conversation,b]);
 await asUser(db,user(a),"select public.end_connection($1::uuid)",[old.connection]);
 const current=await connect(db,a,b);
 m.create.mockResolvedValue(client(a));
 const before=await listReports(client(a));
 expect(await reportMessage(current.conversation,Number(message.id),"spam","")).toEqual({status:"not_available"});
 expect(await listReports(client(a))).toEqual(before);
 expect(await owner(db,"select id from public.reports where reporter_id=$1",[a])).toEqual([]);
});
