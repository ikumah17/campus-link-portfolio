// @vitest-environment node
import {beforeAll,afterAll,it,expect,vi} from "vitest";
import type {PGlite} from "@electric-sql/pglite";
import {freshDb,asUser,asRole,staff,owner} from "./db/harness";
import {createUser,createStaff} from "./db/fixtures";
import type {RpcClient} from "@/server/rpc";
const m=vi.hoisted(()=>({create:vi.fn()}));
vi.mock("server-only",()=>({}));vi.mock("@/lib/backend",()=>({backendMode:()=>"supabase"}));vi.mock("@/lib/supabase/server",()=>({createServerSupabase:m.create}));vi.mock("next/cache",()=>({revalidatePath:vi.fn()}));
import {listAffiliations} from "@/server/admin-affiliations";
import {saveAffiliation,setAffiliationActive} from "@/server/admin-affiliation-actions";
import {loadAffiliationMaster} from "@/server/affiliation-master";
let db:PGlite,admin:string,admin2:string,plain:string,moderator:string,reviewer:string;
const network=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("network"));
function client(me:string):RpcClient{return {async rpc(name,args){
 const casts:Record<string,string>={p_id:"uuid",p_school_id:"uuid",p_department_id:"uuid",p_name:"text",p_is_active:"boolean",p_sort_order:"int",p_academic_year:"smallint"};
 try{const rows=await asUser(db,staff(me),`select * from public.${name}(${Object.keys(args).map((k,i)=>`${k}=>$${i+1}::${casts[k]}`).join(",")})`,Object.values(args));return {data:name==="admin_list_affiliations"?rows:rows[0],error:null};}catch(e){const v=e as {code:string;message:string};return {data:null,error:{code:v.code,message:v.message}};}
}};}
// The query-builder adapter issues real RLS-protected SELECTs for the unchanged loader.
function masterClient(me:string){
 const adapter = {from(table:string){return {select(){return {eq(){return {async order(){
  try{return {data:await asUser(db,{sub:me},`select * from public.${table} where is_active = true order by name`),error:null};}
  catch{return {data:null,error:{}};}
 } };} };} };} };
 return adapter as unknown as Parameters<typeof loadAffiliationMaster>[0];
}
beforeAll(async()=>{db=await freshDb();admin=await createStaff(db,["admin"]);admin2=await createStaff(db,["admin"]);plain=await createUser(db);moderator=await createStaff(db,["moderator"]);reviewer=await createStaff(db,["reviewer"]);},180000);
afterAll(async()=>{expect(network).not.toHaveBeenCalled();await db?.close();vi.restoreAllMocks();});
it("creates hierarchy, renames, toggles with fresh values, preserves RLS and detects duplicates",async()=>{
 m.create.mockResolvedValue(client(admin));
 const base={id:null,name:"Local school",level:"school",parentId:null,isActive:true,sortOrder:9,academicYear:null};
 expect(await saveAffiliation(base)).toEqual({status:"ok"});
 async function find(name:string){const r=await listAffiliations(client(admin));if(r.status!=="ok")throw Error(r.status);return r.rows.find(r=>r.name===name)!;}
 const school=await find(base.name);
 expect(await saveAffiliation({...base,level:"department",name:"Local dept",parentId:school.id})).toEqual({status:"ok"});const dept=await find("Local dept");
 expect(await saveAffiliation({...base,level:"class",name:"Local class",parentId:dept.id,academicYear:2026})).toEqual({status:"ok"});const cls=await find("Local class");
 for(const row of [school,dept,cls])expect(await saveAffiliation({...row,id:null})).toEqual({status:"duplicate"});
 expect(await saveAffiliation({...cls,name:"New class"})).toEqual({status:"ok"});
 m.create.mockResolvedValue(client(admin2));expect(await setAffiliationActive("class",cls.id,false)).toEqual({status:"ok"});
 expect(await find("New class")).toMatchObject({id:cls.id,isActive:false,academicYear:2026,parentId:dept.id});
 const master=await loadAffiliationMaster(masterClient(plain));expect(master?.find(s=>s.id===school.id)?.departments.find(d=>d.id===dept.id)?.classes).toEqual([]);
 expect(await setAffiliationActive("class",cls.id,true)).toEqual({status:"ok"});
 const active=await loadAffiliationMaster(masterClient(plain));expect(active?.find(s=>s.id===school.id)?.departments.find(d=>d.id===dept.id)?.classes).toEqual([{id:cls.id,name:"New class"}]);
 expect(await setAffiliationActive("school",school.id,false)).toEqual({status:"ok"});expect(await find("Local dept")).toMatchObject({isActive:true});
 for(const me of [plain,moderator,reviewer]){
  expect(await listAffiliations(client(me))).toEqual({status:"forbidden"});m.create.mockResolvedValue(client(me));
  for(const row of [school,dept,cls]){expect(await saveAffiliation(row)).toEqual({status:"forbidden"});expect(await setAffiliationActive(row.level,row.id,false)).toEqual({status:"forbidden"});}
 }
},120000);
it("lists all rows in documented order and shape without an audit write; anon and service cannot execute",async()=>{
 const before=await owner(db,"select * from private.audit_log order by id");
 const result=await listAffiliations(client(admin));expect(result.status).toBe("ok");
 const expected=await owner(db,`select * from (select 'school' as level,id,null::uuid as "parentId",name,is_active as "isActive",sort_order as "sortOrder",null::smallint as "academicYear" from public.schools union all select 'department',id,school_id,name,is_active,sort_order,null::smallint from public.departments union all select 'class',id,department_id,name,is_active,0,academic_year from public.classes) all_rows order by case level when 'school' then 1 when 'department' then 2 else 3 end, "sortOrder", name, "academicYear" nulls first, id`);
 const rank:Record<string,number>={school:0,department:1,class:2};
 if(result.status==="ok"){
  expect(result.rows).toEqual(expected);
  const sql=await owner(db,`select * from public.admin_list_affiliations()` ).catch(()=>null);
  expect(sql).toBeNull(); // owner without session is not authorized either
  expect(result.rows.map(r=>rank[r.level])).toEqual(result.rows.map(r=>rank[r.level]).sort());
  for(const level of ["school","department","class"]){const rows=result.rows.filter(r=>r.level===level);expect(rows.map(r=>r.sortOrder)).toEqual(rows.map(r=>r.sortOrder).sort((a,b)=>a-b));}
 }
 expect(await owner(db,"select * from private.audit_log order by id")).toEqual(before);
 for(const role of ["anon","service_role"] as const)await expect(asRole(db,role,null,"select * from public.admin_list_affiliations()")).rejects.toThrow(/permission denied/);
},120000);
