// @vitest-environment node
// DB-LIKES-001 (docs/43 §5.4): the web like actions and readers against the real order 34 RPCs in PGlite.
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createMasters, createUser, connect, type Masters } from "./db/fixtures";
import { freshDb, asUser, user, owner } from "./db/harness";
const m=vi.hoisted(()=>({create:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/backend",()=>({backendMode:()=>"supabase"}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabase:m.create}));
vi.mock("next/cache",()=>({revalidatePath:vi.fn()}));
import { likeUser, unlikeUser } from "@/server/like-actions";
import { listLikes, getLikeState } from "@/server/like-data";
import { listProfiles, getProfile } from "@/server/discover-data";
import { listConversations } from "@/server/chat-data";
let db:PGlite, masters:Masters;
const fetchSpy=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("network forbidden"));
beforeAll(async()=>{db=await freshDb();masters=await createMasters(db,"likes")},180000);
afterAll(async()=>{expect(fetchSpy).not.toHaveBeenCalled();await db?.close();vi.restoreAllMocks()});
// PostgREST-shaped client: named arguments, rows as JSON (dates as text), rpc_outcome as one object.
const ROWS=["list_my_likes","get_like_state","discover_profiles","get_profile","list_my_conversations"];
function client(me:string){return {async rpc(name:string,args:Record<string,unknown>){
 const casts:Record<string,string>={p_target:"uuid",p_direction:"text",p_before_at:"timestamptz",p_before_id:"uuid",p_limit:"int",p_min_age:"int",p_max_age:"int",p_genders:"text[]",p_school_ids:"uuid[]",p_after:"uuid"};
 const keys=Object.keys(args), sql=keys.map((k,i)=>`${k} => $${i+1}${casts[k]?`::${casts[k]}`:""}`).join(",");
 try{
  const rows=await asUser<Record<string,unknown>>(db,user(me),`select to_jsonb(r) as j from public.${name}(${sql}) r`,Object.values(args));
  const data=rows.map(r=>r.j);
  return {data:ROWS.includes(name)?data:data[0],error:null};
 }catch(e){const error=e as {code:string;message:string};return {data:null,error:{code:error.code,message:error.message}}}
}}}
function actor(id:string){m.create.mockResolvedValue(client(id))}
async function pair(){return [await createUser(db,{cls:masters.classes[0]}),await createUser(db,{cls:masters.classes[4]})]}
const ids=(r:Awaited<ReturnType<typeof listLikes>>)=>r.status==="ok"?r.likes.map(l=>l.id):r.status;
async function discovers(me:string,target:string){let after:string|undefined;for(;;){const page=await listProfiles(client(me),{genders:[],schoolIds:[],after});if(page.status!=="ok")throw Error("list");if(page.profiles.some(p=>p.id===target))return true;if(!page.nextAfter)return false;after=page.nextAfter}}

it("like, both lists, like back makes one match that the talk list shows; then the likes are gone",async()=>{
 const [a,b]=await pair();
 actor(a);expect(await likeUser(b)).toEqual({status:"ok"});expect(await likeUser(b)).toEqual({status:"ok"});
 expect(ids(await listLikes(client(a),"sent"))).toEqual([b]);expect(ids(await listLikes(client(b),"received"))).toEqual([a]);
 const received=await listLikes(client(b),"received");if(received.status!=="ok")throw Error("received");
 const detail=await getProfile(client(b),a);expect(detail.status).toBe("ok");if(detail.status==="ok")expect(received.likes[0].profile).toEqual(detail.profile);
 expect(await getLikeState(client(a),b)).toEqual({status:"ok",state:{iLiked:true,likedMe:false,conversationId:null}});
 expect(await getLikeState(client(b),a)).toEqual({status:"ok",state:{iLiked:false,likedMe:true,conversationId:null}});
 expect(await discovers(a,b)).toBe(false);expect(await discovers(b,a)).toBe(true);
 actor(b);const matched=await likeUser(a);expect(matched.status).toBe("ok");expect(matched.conversationId).toMatch(/^[0-9a-f-]{36}$/);
 for(const [me,other] of [[a,b],[b,a]]){
  expect(ids(await listLikes(client(me),"sent"))).toEqual([]);expect(ids(await listLikes(client(me),"received"))).toEqual([]);
  expect(await getLikeState(client(me),other)).toEqual({status:"ok",state:{iLiked:false,likedMe:false,conversationId:matched.conversationId}});
  const talk=await listConversations(client(me));expect(talk.status).toBe("ok");if(talk.status==="ok")expect(talk.conversations.map(c=>c.id)).toEqual([matched.conversationId]);
  actor(me);expect(await likeUser(other)).toEqual({status:"already_connected"});
 }
 expect(await owner(db,"select count(*)::int as n from public.connections where user_low=least($1::uuid,$2::uuid) and user_high=greatest($1::uuid,$2::uuid)",[a,b])).toEqual([{n:1}]);
},120000);

it("unlike takes one's own like back and is ok without one",async()=>{
 const [a,b]=await pair();
 actor(a);expect(await likeUser(b)).toEqual({status:"ok"});expect(await unlikeUser(b)).toEqual({status:"ok"});expect(await unlikeUser(b)).toEqual({status:"ok"});
 expect(ids(await listLikes(client(a),"sent"))).toEqual([]);expect(ids(await listLikes(client(b),"received"))).toEqual([]);
 expect(await discovers(a,b)).toBe(true);
});

it.each(["self","bad id","block","hidden","ineligible","connected","missing"])("refusals: %s",async kind=>{
 const a=await createUser(db,{cls:masters.classes[0]}),b=await createUser(db,{cls:masters.classes[4],...(kind==="hidden"?{hidden:{schools:[masters.schools[0]]}}:{}),...(kind==="ineligible"?{ageVerified:false}:{})});
 if(kind==="block")await owner(db,"insert into public.blocks(blocker_id,blocked_id) values($1,$2)",[b,a]);if(kind==="connected")await connect(db,a,b);
 const target=kind==="self"?a:kind==="bad id"?"not-a-uuid":kind==="missing"?"00000000-0000-4000-8000-00000000ffff":b;
 actor(a);expect(await likeUser(target)).toEqual({status:kind==="self"||kind==="bad id"?"validation":kind==="connected"?"already_connected":"not_available"});
 if(!["self","bad id","connected"].includes(kind))expect(await getLikeState(client(a),target)).toEqual({status:"ok",state:null});
});

it("people who become hidden or blocked leave both lists without anything about them",async()=>{
 const me=await createUser(db,{cls:masters.classes[0]});
 const [hider,blocker,kept]=[await createUser(db,{cls:masters.classes[4]}),await createUser(db,{cls:masters.classes[5]}),await createUser(db,{cls:masters.classes[6]})];
 for(const other of [hider,blocker,kept]){actor(other);expect(await likeUser(me)).toEqual({status:"ok"})}
 await owner(db,"insert into public.hidden_affiliations(user_id,school_id) values($1,$2)",[hider,masters.schools[0]]);
 await owner(db,"insert into public.blocks(blocker_id,blocked_id) values($1,$2)",[blocker,me]);
 const r=await listLikes(client(me),"received");expect(ids(r)).toEqual([kept]);
 for(const gone of [hider,blocker])expect(JSON.stringify(r)).not.toContain(gone);
});

it("a deleted caller is refused and the readers answer unavailable",async()=>{
 const [a,b]=await pair();actor(a);expect(await likeUser(b)).toEqual({status:"ok"});
 await owner(db,"update public.profiles set account_status='deleted', deleted_at=now() where user_id=$1",[a]);
 expect(await likeUser(b)).toEqual({status:"unavailable"});expect(await unlikeUser(b)).toEqual({status:"unavailable"});
 expect(await listLikes(client(a),"sent")).toEqual({status:"unavailable"});expect(await getLikeState(client(a),b)).toEqual({status:"unavailable"});
});
