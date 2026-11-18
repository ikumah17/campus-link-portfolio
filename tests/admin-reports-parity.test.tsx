// @vitest-environment node
import {beforeAll,afterAll,it,expect,vi} from "vitest";
import type {PGlite} from "@electric-sql/pglite";
import {freshDb,asUser,staff,owner} from "./db/harness";
import {createUser,createStaff,createMasters} from "./db/fixtures";
const m=vi.hoisted(()=>({create:vi.fn()}));
vi.mock("server-only",()=>({}));vi.mock("@/lib/backend",()=>({backendMode:()=>"supabase"}));vi.mock("@/lib/supabase/server",()=>({createServerSupabase:m.create}));vi.mock("next/cache",()=>({revalidatePath:vi.fn()}));
import {listReports,getReport} from "@/server/admin-reports";
import {updateReport,suspendReportTarget,reactivateReportTarget} from "@/server/admin-report-actions";
import {listProfiles} from "@/server/discover-data";
let db:PGlite,a:string,b:string,mod:string,admin:string,party:string,id:string;
const network=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("network"));
function client(me:string){return {async rpc(name:string,args:Record<string,unknown>){
 const casts:Record<string,string>={p_id:"uuid",p_user:"uuid",p_status:name==="admin_set_account_status"?"public.account_status":"public.report_status",p_note:"text",p_reason:"text",p_mode:"public.discover_mode",p_genders:"text[]",p_school_ids:"uuid[]",p_min_age:"int",p_max_age:"int",p_limit:"int",p_after:"uuid"};
 try{const rows=await asUser<Record<string,unknown>>(db,staff(me),`select * from public.${name}(${Object.keys(args).map((k,i)=>`${k}=>$${i+1}::${casts[k]}`).join(",")})`,Object.values(args));const normalized=rows.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,v instanceof Date?v.toISOString():v])));return {data:["admin_get_report","admin_list_reports","discover_profiles"].includes(name)?normalized:normalized[0],error:null};}catch(e){const v=e as {code:string;message:string};return {data:null,error:{code:v.code,message:v.message}};}
}};}
async function report(reporter=a,target=b){const [r]=await owner<{id:string}>(db,"insert into public.reports(reporter_id,target_user_id,context,reason)values($1,$2,'profile','spam')returning id",[reporter,target]);return r.id;}
beforeAll(async()=>{db=await freshDb();const masters=await createMasters(db,"admin-reports");a=await createUser(db,{cls:masters.classes[0]});b=await createUser(db,{cls:masters.classes[4]});mod=await createStaff(db,["moderator"]);admin=await createStaff(db,["admin","moderator"]);party=await createStaff(db,["moderator","admin"]);await owner(db,"insert into public.profiles(user_id,display_name,gender)values($1,'Staff','other')",[party]);id=await report();},180000);
afterAll(async()=>{expect(network).not.toHaveBeenCalled();await db?.close();vi.restoreAllMocks();});
it("audits each view and list and enforces transitions",async()=>{
 expect(await listReports(client(mod),"open")).toMatchObject({status:"ok",reports:[{id}]});
 for(let i=0;i<2;i++)expect(await getReport(client(mod),id)).toMatchObject({status:"ok",report:{id}});
 expect(await owner(db,"select action from private.audit_log where actor_id=$1 order by created_at",[mod])).toEqual([{action:"list_reports"},{action:"view_report"},{action:"view_report"}]);
 m.create.mockResolvedValue(client(mod));expect(await updateReport(id,"triaged","")).toEqual({status:"ok"});expect(await updateReport(id,"triaged","")).toEqual({status:"invalid_state"});expect(await updateReport(id,"actioned","")).toEqual({status:"ok"});expect(await updateReport(id,"dismissed","")).toEqual({status:"invalid_state"});const second=await report();expect(await updateReport(second,"dismissed","")).toEqual({status:"ok"});expect(await updateReport(second,"actioned","")).toEqual({status:"invalid_state"});
});
it("excludes both parties for list, detail, update and suspension",async()=>{
 for(const [r,t] of [[party,b],[a,party]]){const rid=await report(r,t);const list=await listReports(client(party),"open");expect(list.status).toBe("ok");if(list.status==="ok")expect(list.reports.some(r=>r.id===rid)).toBe(false);expect(await getReport(client(party),rid)).toEqual({status:"ok",report:null});m.create.mockResolvedValue(client(party));expect(await updateReport(rid,"triaged","")).toEqual({status:"invalid_state"});expect(await suspendReportTarget(rid,"spam")).toEqual({status:"invalid_state"});}
});
it("plain users are refused, moderator cannot suspend, admin hides target from Discover",async()=>{
 expect(await listReports(client(a),"open")).toEqual({status:"forbidden"});expect(await getReport(client(a),id)).toEqual({status:"forbidden"});m.create.mockResolvedValue(client(a));expect(await updateReport(id,"triaged","")).toEqual({status:"forbidden"});expect(await suspendReportTarget(id,"spam")).toEqual({status:"forbidden"});
 m.create.mockResolvedValue(client(mod));expect(await suspendReportTarget(id,"spam")).toEqual({status:"forbidden"});
 const filters={genders:[],schoolIds:[]};const before=await listProfiles(client(a),filters);expect(before.status).toBe("ok");if(before.status==="ok")expect(before.profiles.some(p=>p.id===b)).toBe(true);
 m.create.mockResolvedValue(client(admin));expect(await suspendReportTarget(id,"spam")).toEqual({status:"ok"});expect(await suspendReportTarget(id,"spam")).toEqual({status:"invalid_state"});const after=await listProfiles(client(a),filters);expect(after.status).toBe("ok");if(after.status==="ok")expect(after.profiles.some(p=>p.id===b)).toBe(false);
});

it("database rejects every unsupported transition including triaged to open",async()=>{
 for(const from of ["open","triaged","actioned","dismissed"])for(const to of ["open","triaged","actioned","dismissed"]){
  const rid=await report();
  if(from==="triaged"||from==="actioned")await client(mod).rpc("admin_update_report",{p_id:rid,p_status:"triaged",p_note:null});
  if(from==="actioned"||from==="dismissed")await client(mod).rpc("admin_update_report",{p_id:rid,p_status:from,p_note:null});
  const r=await client(mod).rpc("admin_update_report",{p_id:rid,p_status:to,p_note:null});
  const allowed=["open>triaged","open>dismissed","triaged>actioned","triaged>dismissed"].includes(`${from}>${to}`);
  expect(r.error).toBeNull();expect(r.data).toMatchObject({code:allowed?"ok":"invalid_state"});
 }
});

it("admin reactivates a suspended report target and restores Discover visibility",async()=>{
 m.create.mockResolvedValue(client(admin));
 // Existing suspension coverage leaves b suspended; restore it before proving a full cycle.
 expect(await reactivateReportTarget(id)).toEqual({status:"ok"});
 expect(await reactivateReportTarget(id)).toEqual({status:"invalid_state"});
 expect(await suspendReportTarget(id,"spam")).toEqual({status:"ok"});
 expect(await reactivateReportTarget(id)).toEqual({status:"ok"});
 const visible=await listProfiles(client(a),{genders:[],schoolIds:[]});expect(visible.status).toBe("ok");if(visible.status==="ok")expect(visible.profiles.some(p=>p.id===b)).toBe(true);
});
it("non-admin moderator and both report parties cannot reactivate",async()=>{
 m.create.mockResolvedValue(client(admin));expect(await suspendReportTarget(id,"spam")).toEqual({status:"ok"});
 m.create.mockResolvedValue(client(mod));expect(await reactivateReportTarget(id)).toEqual({status:"forbidden"});
 for(const [r,t] of [[party,b],[a,party]]){const rid=await report(r,t);m.create.mockResolvedValue(client(party));expect(await reactivateReportTarget(rid)).toEqual({status:"invalid_state"});}
 m.create.mockResolvedValue(client(admin));expect(await reactivateReportTarget(id)).toEqual({status:"ok"});
});
