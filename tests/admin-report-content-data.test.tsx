// @vitest-environment node
// MOD-001: the report content projection and the hide/undo actions (order 33).
import {it,expect,vi,beforeEach,afterEach} from "vitest";
const m=vi.hoisted(()=>({create:vi.fn(),mode:vi.fn(),rpc:vi.fn(),revalidate:vi.fn()}));
vi.mock("server-only",()=>({}));vi.mock("@/lib/backend",()=>({backendMode:m.mode}));vi.mock("@/lib/supabase/server",()=>({createServerSupabase:m.create}));vi.mock("next/cache",()=>({revalidatePath:m.revalidate}));
import {getReportContent} from "@/server/admin-reports";
import {hideReportContent,unhideReportContent} from "@/server/admin-report-actions";
const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",photo="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",request="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const rows={
 message:{item:"message",ref:"12345",photo_position:null,body:"架空の発言",hidden:true,hidden_at:"2026-11-17T00:00:00Z"},
 request:{item:"request_message",ref:request,photo_position:null,body:"架空の申請",hidden:false,hidden_at:null},
 bio:{item:"bio",ref:null,photo_position:null,body:"架空の紹介",hidden:false,hidden_at:null},
 hiddenBio:{item:"bio",ref:null,photo_position:null,body:null,hidden:true,hidden_at:"2026-11-17T00:00:00Z"},
 photo:{item:"photo",ref:photo,photo_position:1,body:null,hidden:false,hidden_at:null},
};
const client=(data:unknown,error:object|null=null)=>({rpc:vi.fn().mockResolvedValue({data,error})});
let network:ReturnType<typeof vi.spyOn>;
beforeEach(()=>{vi.resetAllMocks();network=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("network"));m.mode.mockReturnValue("supabase");m.create.mockResolvedValue({rpc:m.rpc});m.rpc.mockResolvedValue({data:{ok:true,code:"ok",ref:id},error:null});});
afterEach(()=>{expect(network).not.toHaveBeenCalled();vi.restoreAllMocks();});

it("projects every item, keeps photo ids only and strips message and request ids",async()=>{
 const c=client(Object.values(rows));const r=await getReportContent(c,id);
 expect(c.rpc).toHaveBeenCalledExactlyOnceWith("admin_get_report_content",{p_id:id});
 expect(r).toEqual({status:"ok",content:[
  {item:"message",ref:null,position:null,body:"架空の発言",hidden:true,hiddenAt:"2026-11-17T00:00:00Z"},
  {item:"request_message",ref:null,position:null,body:"架空の申請",hidden:false,hiddenAt:null},
  {item:"bio",ref:null,position:null,body:"架空の紹介",hidden:false,hiddenAt:null},
  {item:"bio",ref:null,position:null,body:null,hidden:true,hiddenAt:"2026-11-17T00:00:00Z"},
  {item:"photo",ref:photo,position:1,body:null,hidden:false,hiddenAt:null}]});
 expect(JSON.stringify(r)).not.toContain("12345");expect(JSON.stringify(r)).not.toContain(request);
});
it("fails the whole content on any malformed row and maps refusals",async()=>{
 for(const bad of [null,{},{...rows.message,item:"profile"},{...rows.message,ref:"0"},{...rows.message,ref:photo},{...rows.message,body:null},{...rows.request,ref:"1"},{...rows.bio,ref:photo},{...rows.bio,hidden:true},{...rows.hiddenBio,hidden:false},{...rows.photo,ref:"1"},{...rows.photo,photo_position:null},{...rows.photo,body:"x"},{...rows.photo,hidden:true},{...rows.message,photo_position:0},{...rows.message,hidden:"yes"},{...rows.bio,item:"bio_friends"},{...rows.bio,item:"bio_romance"}])
  expect([bad,await getReportContent(client([rows.photo,bad]),id)]).toEqual([bad,{status:"unavailable"}]);
 expect(await getReportContent(client({}),id)).toEqual({status:"unavailable"});
 expect(await getReportContent(client(null,{code:"P0001",message:"forbidden"}),id)).toEqual({status:"forbidden"});
 // before order 33 the function is missing (PGRST202): only unavailable
 expect(await getReportContent(client(null,{code:"PGRST202",message:"missing"}),id)).toEqual({status:"unavailable"});
});
it("actions validate before creating a client and send exact arguments",async()=>{
 for(const [rid,item,p] of [[null,"message",null],["bad","message",null],[id,"bogus",null],[id,"toString",null],[id,"photo",null],[id,"photo","bad"],[id,"message",photo],[id,"bio",photo],[id,"bio_friends",null],[id,"bio_romance",null],[id,"message",undefined]])expect(await hideReportContent(rid,item,p)).toEqual({status:"invalid"});
 for(const [rid,item] of [[null,"message"],[id,"photo"],[id,"bio"],[id,null]])expect(await unhideReportContent(rid,item)).toEqual({status:"invalid"});
 expect(m.create).not.toHaveBeenCalled();
 expect(await hideReportContent(id,"photo",photo)).toEqual({status:"ok"});expect(m.rpc).toHaveBeenLastCalledWith("admin_hide_reported_content",{p_id:id,p_item:"photo",p_photo:photo});
 for(const item of ["message","request_message","bio"]){expect(await hideReportContent(id,item,null)).toEqual({status:"ok"});expect(m.rpc).toHaveBeenLastCalledWith("admin_hide_reported_content",{p_id:id,p_item:item,p_photo:null});}
 for(const item of ["message","request_message"]){expect(await unhideReportContent(id,item)).toEqual({status:"ok"});expect(m.rpc).toHaveBeenLastCalledWith("admin_unhide_reported_content",{p_id:id,p_item:item});}
 expect(m.revalidate).toHaveBeenCalledWith("/admin/reports");
});
it("actions map refusals, failures and demo to status only",async()=>{
 for(const [data,error,status] of [[{ok:false,code:"not_available"},null,"invalid_state"],[{ok:false,code:"invalid_state"},null,"invalid_state"],[null,{code:"P0001",message:"forbidden"},"forbidden"],[null,{code:"P0001",message:"validation"},"invalid"],[null,{message:"secret"},"unavailable"]] as const){
  m.rpc.mockResolvedValue({data,error});expect(await hideReportContent(id,"message",null)).toEqual({status});expect(await unhideReportContent(id,"message")).toEqual({status});
 }
 m.create.mockRejectedValue(Error("secret"));expect(await hideReportContent(id,"message",null)).toEqual({status:"unavailable"});expect(await unhideReportContent(id,"message")).toEqual({status:"unavailable"});
 m.create.mockReset();m.mode.mockReturnValue("demo");expect(await hideReportContent(id,"message",null)).toEqual({status:"unavailable"});expect(await unhideReportContent(id,"message")).toEqual({status:"unavailable"});expect(m.create).not.toHaveBeenCalled();
});
