// @vitest-environment node
import {beforeAll,afterAll,it,expect,vi} from "vitest";
import {randomUUID} from "node:crypto";
import type {PGlite} from "@electric-sql/pglite";
import {freshDb,asUser,user,owner} from "./db/harness";
import {createMasters,createUser,connect,type Masters} from "./db/fixtures";
const m=vi.hoisted(()=>({create:vi.fn()}));
vi.mock("server-only",()=>({}));vi.mock("@/lib/backend",()=>({backendMode:()=>"supabase"}));vi.mock("@/lib/supabase/server",()=>({createServerSupabase:m.create}));vi.mock("next/cache",()=>({revalidatePath:vi.fn()}));
import {loadRoom,listConversations} from "@/server/chat-data";
import {sendChatMessage,markRead,olderMessages} from "@/server/chat-actions";
let db:PGlite,masters:Masters;
const network=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("no network"));
beforeAll(async()=>{db=await freshDb();masters=await createMasters(db,"chat")},180000);
afterAll(async()=>{expect(network).not.toHaveBeenCalled();await db?.close();vi.restoreAllMocks()});
function client(me:string){return {async rpc(name:string,args:Record<string,unknown>){
 const casts:Record<string,string>={p_conversation:"uuid",p_client_msg_id:"uuid",p_body:"text",p_before:"bigint",p_limit:"int",p_message_id:"bigint"};
 const sql=Object.keys(args).map((k,i)=>`${k}=>$${i+1}::${casts[k]}`).join(",");
 try{const rows=await asUser<Record<string,unknown>>(db,user(me),`select * from public.${name}(${sql})`,Object.values(args));
 const normalized=rows.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,typeof v==="bigint"?Number(v):v instanceof Date?v.toISOString():v])));
 return {data:["list_my_conversations","list_messages"].includes(name)?normalized:normalized[0],error:null};
 }catch(e){const v=e as {code:string;message:string};return {data:null,error:{code:v.code,message:v.message}}}
}}}
async function pair(){const a=await createUser(db,{cls:masters.classes[0]}),b=await createUser(db,{cls:masters.classes[4]});return {a,b,...await connect(db,a,b)}}
it("participants, unread, mark read and idempotent send without identity leaks",async()=>{
 const {a,b,conversation,connection}=await pair();
 for(const me of [a,b])expect(await listConversations(client(me))).toMatchObject({status:"ok",conversations:[{id:conversation}]});
 m.create.mockResolvedValue(client(a));const token=randomUUID();expect((await sendChatMessage(conversation,token,"hello")).status).toBe("ok");expect((await sendChatMessage(conversation,token,"hello")).status).toBe("ok");
 const r=await loadRoom(client(b),conversation);expect(r).toMatchObject({status:"ok",room:{messages:[{mine:false,body:"hello"}],conversation:{unread:true}}});
 const json=JSON.stringify(r);for(const secret of [a,b,connection,"sender_id","counterpart_id","connection_id"])expect(json).not.toContain(secret);
 if(r.status!=="ok"||!r.room)throw Error("room");m.create.mockResolvedValue(client(b));expect(await markRead(conversation,r.room.messages[0].id)).toEqual({status:"ok"});expect(await listConversations(client(b))).toMatchObject({conversations:[{unread:false}]});
 expect(await owner(db,"select id from public.messages where conversation_id=$1",[conversation])).toHaveLength(1);
});
it.each(["third","ended","block-a","block-b","hidden-a","hidden-b","ineligible-a","ineligible-b"])("refuses %s independently",async kind=>{
 const {a,b,conversation,connection}=await pair();let me=a;
 if(kind==="third")me=await createUser(db,{cls:masters.classes[0]});
 if(kind==="ended")await asUser(db,user(a),"select public.end_connection($1)",[connection]);
 if(kind.startsWith("block"))await owner(db,"insert into public.blocks(blocker_id,blocked_id)values($1,$2)",kind.endsWith("a")?[a,b]:[b,a]);
 if(kind.startsWith("hidden"))await owner(db,"insert into public.hidden_affiliations(user_id,school_id)values($1,$2)",kind.endsWith("a")?[a,masters.schools[1]]:[b,masters.schools[0]]);
 if(kind.startsWith("ineligible"))await owner(db,"update public.account_verifications set age_verified_at=null, age_submission_id=null where user_id=$1",[kind.endsWith("a")?a:b]);
 expect(await listConversations(client(me))).toEqual({status:"ok",conversations:[]});expect(await loadRoom(client(me),conversation)).toEqual({status:"ok",room:null});m.create.mockResolvedValue(client(me));expect(await sendChatMessage(conversation,randomUUID(),"no")).toEqual({status:"not_available"});expect(await client(me).rpc("list_messages",{p_conversation:conversation,p_before:null,p_limit:30})).toEqual({data:[],error:null});
});
it("pages 65 messages as 30/30/5 without duplicates",async()=>{const {a,b,conversation}=await pair();await owner(db,"insert into public.messages(conversation_id,sender_id,client_msg_id,body) select $1,$2,gen_random_uuid(),'message' from generate_series(1,65)",[conversation,b]);const first=await loadRoom(client(a),conversation);if(first.status!=="ok"||!first.room)throw Error("room");expect(first.room.messages).toHaveLength(30);expect(first.room.hasOlder).toBe(true);m.create.mockResolvedValue(client(a));const second=await olderMessages(conversation,first.room.messages[0].id);if(second.status!=="ok")throw Error("page");expect(second.messages).toHaveLength(30);const third=await olderMessages(conversation,second.messages[0].id);if(third.status!=="ok")throw Error("page");expect(third.messages).toHaveLength(5);expect(third.hasOlder).toBe(false);expect(new Set([...first.room.messages,...second.messages,...third.messages].map(m=>m.id)).size).toBe(65)});

