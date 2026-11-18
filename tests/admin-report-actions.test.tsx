// @vitest-environment node
import {it,expect,vi,beforeEach,afterEach} from "vitest";
const m=vi.hoisted(()=>({create:vi.fn(),mode:vi.fn(),rpc:vi.fn(),revalidate:vi.fn()}));
vi.mock("server-only",()=>({}));vi.mock("@/lib/backend",()=>({backendMode:m.mode}));vi.mock("@/lib/supabase/server",()=>({createServerSupabase:m.create}));vi.mock("next/cache",()=>({revalidatePath:m.revalidate}));
import {updateReport,suspendReportTarget,reactivateReportTarget} from "@/server/admin-report-actions";
const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",target="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let network:ReturnType<typeof vi.spyOn>;
beforeEach(()=>{vi.resetAllMocks();network=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("network"));m.mode.mockReturnValue("supabase");m.create.mockResolvedValue({rpc:m.rpc});m.rpc.mockResolvedValue({data:{ok:true,code:"ok",ref:target},error:null});});
afterEach(()=>{expect(network).not.toHaveBeenCalled();vi.restoreAllMocks();});
it("validates before client creation",async()=>{for(const value of [null,"bad",id.toUpperCase(),id+"\n"]){expect(await updateReport(value,"triaged","")).toEqual({status:"invalid"});expect(await suspendReportTarget(value,"spam")).toEqual({status:"invalid"});}for(const s of ["open","unknown",null])expect(await updateReport(id,s,"")).toEqual({status:"invalid"});for(const n of [null,123,"😀".repeat(1001)])expect(await updateReport(id,"triaged",n)).toEqual({status:"invalid"});for(const r of ["unknown","toString",null])expect(await suspendReportTarget(id,r)).toEqual({status:"invalid"});expect(m.create).not.toHaveBeenCalled();});
it("trims and counts code points, sends exact arguments and no ref",async()=>{expect(await updateReport(id,"triaged"," 😀 ")).toEqual({status:"ok"});expect(m.rpc).toHaveBeenLastCalledWith("admin_update_report",{p_id:id,p_status:"triaged",p_note:"😀"});expect(await updateReport(id,"triaged","😀".repeat(1000))).toEqual({status:"ok"});await updateReport(id,"dismissed"," ");expect(m.rpc).toHaveBeenLastCalledWith("admin_update_report",{p_id:id,p_status:"dismissed",p_note:null});expect(m.revalidate).toHaveBeenCalledWith("/admin/reports");});
it("resolves suspension target solely on server",async()=>{m.rpc.mockResolvedValueOnce({data:[{id,reporter_id:null,target_user_id:target,context:"profile",reason:"spam",status:"open",created_at:"date",detail:null,evidence_message_body:null,evidence_message_created_at:null}],error:null});expect(await suspendReportTarget(id,"spam")).toEqual({status:"ok"});expect(m.rpc.mock.calls).toEqual([["admin_get_report",{p_id:id}],["admin_set_account_status",{p_user:target,p_status:"suspended",p_reason:"spam"}]]);});
it("missing target and failures stay status only",async()=>{m.rpc.mockResolvedValueOnce({data:[],error:null});expect(await suspendReportTarget(id,"spam")).toEqual({status:"invalid_state"});for(const code of ["not_available","invalid_state"]){m.rpc.mockResolvedValue({data:{ok:false,code},error:null});expect(await updateReport(id,"triaged","")).toEqual({status:"invalid_state"});}for(const [message,status] of [["forbidden","forbidden"],["validation","invalid"],["secret","unavailable"]]){m.rpc.mockResolvedValue({data:null,error:{code:"P0001",message}});expect(await updateReport(id,"triaged","")).toEqual({status});}m.create.mockRejectedValue(Error("secret"));expect(await suspendReportTarget(id,"spam")).toEqual({status:"unavailable"});});
it("demo makes no client",async()=>{m.mode.mockReturnValue("demo");expect(await updateReport(id,"triaged","")).toEqual({status:"unavailable"});expect(await suspendReportTarget(id,"spam")).toEqual({status:"unavailable"});expect(m.create).not.toHaveBeenCalled();});

const targetRow={id,reporter_id:null,target_user_id:target,context:"profile",reason:"spam",status:"open",created_at:"date",detail:null,evidence_message_body:null,evidence_message_created_at:null};
it("reactivation validates before creating a client and demo stays offline",async()=>{
 for(const value of [null,123,"bad",id.toUpperCase(),id+"\n"])expect(await reactivateReportTarget(value)).toEqual({status:"invalid"});
 expect(m.create).not.toHaveBeenCalled();m.mode.mockReturnValue("demo");expect(await reactivateReportTarget(id)).toEqual({status:"unavailable"});expect(m.create).not.toHaveBeenCalled();
});
it("reactivation resolves its target on the server and returns only status",async()=>{
 m.rpc.mockResolvedValueOnce({data:[targetRow],error:null});
 expect(await reactivateReportTarget(id)).toEqual({status:"ok"});
 expect(m.rpc.mock.calls).toEqual([["admin_get_report",{p_id:id}],["admin_set_account_status",{p_user:target,p_status:"active",p_reason:null}]]);
 expect(m.revalidate).toHaveBeenCalledExactlyOnceWith("/admin/reports");
});
it("reactivation rejects absent reports and targets without a mutation",async()=>{
 for(const rows of [[],[{...targetRow,target_user_id:null}]]){m.rpc.mockResolvedValueOnce({data:rows,error:null});expect(await reactivateReportTarget(id)).toEqual({status:"invalid_state"});}
 expect(m.rpc.mock.calls.every(([name])=>name==="admin_get_report")).toBe(true);expect(m.revalidate).not.toHaveBeenCalled();
});
it.each(["invalid_state","not_available","forbidden","validation","unauthenticated","unknown"])("reactivation maps %s without leaking ids or errors",async code=>{
 m.rpc.mockResolvedValueOnce({data:[targetRow],error:null});
 m.rpc.mockResolvedValueOnce(code==="forbidden"||code==="validation"?{data:null,error:{code:"P0001",message:code}}:code==="unauthenticated"?{data:null,error:{status:401,message:target}}:{data:{ok:false,code,ref:target},error:null});
 expect(await reactivateReportTarget(id)).toEqual({status:code==="not_available"?"invalid_state":code==="validation"?"invalid":code==="unknown"?"unavailable":code});expect(m.revalidate).not.toHaveBeenCalled();
});
it("reactivation handles read refusal and thrown errors without provider text",async()=>{
 m.rpc.mockResolvedValueOnce({data:null,error:{code:"P0001",message:"forbidden"}});expect(await reactivateReportTarget(id)).toEqual({status:"forbidden"});
 m.create.mockRejectedValue(Error(target));expect(await reactivateReportTarget(id)).toEqual({status:"unavailable"});
});
