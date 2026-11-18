// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m=vi.hoisted(()=>({create:vi.fn(),mode:vi.fn(),rpc:vi.fn(),revalidate:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/backend",()=>({backendMode:m.mode}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabase:m.create}));
vi.mock("next/cache",()=>({revalidatePath:m.revalidate}));
import {saveAffiliation,setAffiliationActive} from "@/server/admin-affiliation-actions";
const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const input={level:"school",id:null,parentId:null,name:" School ",isActive:true,sortOrder:9999,academicYear:null};
let network:ReturnType<typeof vi.spyOn>;
beforeEach(()=>{vi.resetAllMocks();m.mode.mockReturnValue("supabase");m.create.mockResolvedValue({rpc:m.rpc});m.rpc.mockResolvedValue({data:{ok:true,code:"ok",ref:id},error:null});network=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("network"));});
afterEach(()=>{expect(network).not.toHaveBeenCalled();vi.restoreAllMocks();});
it.each([null,{}, {...input,level:"other"},{...input,id:id.toUpperCase()},{...input,parentId:id},{...input,name:" "},{...input,name:"😀".repeat(81)},{...input,sortOrder:10000},{...input,sortOrder:-1},{...input,sortOrder:0.5},{...input,academicYear:2026},{...input,isActive:1},{...input,level:"department",parentId:null},{...input,level:"class",parentId:id,name:"😀".repeat(41)},{...input,level:"class",parentId:id,academicYear:1999},{...input,level:"class",parentId:id,academicYear:2101}])("validates before client creation %#",async value=>{
 expect(await saveAffiliation(value)).toEqual({status:"invalid"});expect(m.create).not.toHaveBeenCalled();
});
it.each(["school","department","class"])("forwards exact %s arguments and code points",async level=>{
 const name="😀".repeat(level==="class"?40:80);
 expect(await saveAffiliation({...input,level,name:` ${name} `,parentId:level==="school"?null:id,academicYear:level==="class"?2000:null})).toEqual({status:"ok"});
 const common={p_id:null,p_name:name,p_is_active:true};
 expect(m.rpc).toHaveBeenCalledExactlyOnceWith(`admin_upsert_${level}`,level==="school"?{...common,p_sort_order:9999}:level==="department"?{...common,p_sort_order:9999,p_school_id:id}:{...common,p_department_id:id,p_academic_year:2000});expect(m.revalidate).toHaveBeenCalledWith("/admin/affiliations");
});
it.each([["invalid_state","duplicate"],["not_available","not_found"]])("maps %s",async(code,status)=>{m.rpc.mockResolvedValue({data:{ok:false,code,ref:null},error:null});expect(await saveAffiliation(input)).toEqual({status});expect(m.revalidate).not.toHaveBeenCalled();});
it.each([["P0001","validation","invalid"],["P0001","forbidden","forbidden"],["PGRST302","private","unauthenticated"],["XX000","private","unavailable"]])("maps errors %s %s",async(code,message,status)=>{m.rpc.mockResolvedValue({data:null,error:{code,message}});expect(await saveAffiliation(input)).toEqual({status});});
it("uses fresh server values for toggles",async()=>{
 m.rpc.mockResolvedValueOnce({data:[{level:"school",id,parent_id:null,name:"Renamed",is_active:true,sort_order:7,academic_year:null}],error:null});
 expect(await setAffiliationActive("school",id,false)).toEqual({status:"ok"});expect(m.rpc).toHaveBeenLastCalledWith("admin_upsert_school",{p_id:id,p_name:"Renamed",p_is_active:false,p_sort_order:7});
});
it("contains demo, thrown errors and missing rows",async()=>{
 m.mode.mockReturnValue("demo");expect(await saveAffiliation(input)).toEqual({status:"unavailable"});expect(await setAffiliationActive("school",id,false)).toEqual({status:"unavailable"});expect(m.create).not.toHaveBeenCalled();
 m.mode.mockReturnValue("supabase");m.create.mockRejectedValueOnce(Error("private"));expect(await saveAffiliation(input)).toEqual({status:"unavailable"});
 m.rpc.mockResolvedValue({data:[],error:null});expect(await setAffiliationActive("school",id,false)).toEqual({status:"not_found"});
});
it("accepts upper year boundary and ignores class sort order",async()=>{
 expect(await saveAffiliation({...input,level:"class",parentId:id,academicYear:2100,sortOrder:null})).toEqual({status:"ok"});
 expect(m.rpc).toHaveBeenCalledWith("admin_upsert_class",{p_id:null,p_name:"School",p_department_id:id,p_academic_year:2100,p_is_active:true});
});
it.each([["other",id,false],["school",id.toUpperCase(),false],["school",id,1]])("validates toggle %#",async(level,id,active)=>{expect(await setAffiliationActive(level,id,active)).toEqual({status:"invalid"});expect(m.create).not.toHaveBeenCalled();});
