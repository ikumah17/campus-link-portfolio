// @vitest-environment node
import {beforeEach,afterEach,it,expect,vi} from "vitest";
const m=vi.hoisted(()=>({mode:"supabase",create:vi.fn(),rpc:vi.fn()}));
vi.mock("server-only",()=>({}));vi.mock("@/lib/backend",()=>({backendMode:()=>m.mode}));vi.mock("@/lib/supabase/server",()=>({createServerSupabase:m.create}));vi.mock("next/cache",()=>({revalidatePath:vi.fn()}));
import * as actions from "@/server/safety-actions";
const {blockProfile,blockConversation,unblockUser,reportProfile,reportConversation,reportMessage}=actions;
const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const fetchSpy=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("network"));
beforeEach(()=>{vi.clearAllMocks();m.mode="supabase";m.create.mockResolvedValue({rpc:m.rpc});m.rpc.mockResolvedValue({data:{ok:true,code:"ok",ref:"private"},error:null});});
afterEach(()=>expect(fetchSpy).not.toHaveBeenCalled());
it("validates all inputs before client creation",async()=>{
 for(const bad of [null,"bad",id.toUpperCase(),id+"\n"]){expect(await blockProfile(bad)).toEqual({status:"validation"});expect(await blockConversation(bad)).toEqual({status:"validation"});expect(await reportProfile(bad,"spam","")).toEqual({status:"validation"});expect(await reportConversation(bad,"spam","")).toEqual({status:"validation"});expect(await reportMessage(bad,1,"spam","")).toEqual({status:"validation"});}
 for(const key of ["bad","A".repeat(64),"a".repeat(64)+"\n"])expect(await unblockUser(key)).toEqual({status:"validation"});
 for(const fn of [reportProfile,reportConversation]){expect(await fn(id,"unknown","")).toEqual({status:"validation"});expect(await fn(id,"spam","😀".repeat(1001))).toEqual({status:"validation"});expect(await fn(id,"spam",null)).toEqual({status:"validation"});}
 for(const n of [0,-1,1.2,Number.MAX_SAFE_INTEGER+1])expect(await reportMessage(id,n,"spam","")).toEqual({status:"validation"});expect(m.create).not.toHaveBeenCalled();
});
it("normalizes detail and strips private refs",async()=>{expect(await blockProfile(id)).toEqual({status:"ok"});expect(m.rpc).toHaveBeenLastCalledWith("block_user",{p_target:id});expect(await reportProfile(id,"spam","  ")).toEqual({status:"ok"});expect(m.rpc).toHaveBeenLastCalledWith("submit_report",{p_target:id,p_context:"profile",p_reason:"spam",p_detail:null,p_request_id:null,p_message_id:null});expect(await reportProfile(id,"spam","😀".repeat(1000))).toEqual({status:"ok"});});
it("unknown key makes no write and demo makes no client",async()=>{m.rpc.mockResolvedValue({data:[],error:null});expect(await unblockUser("a".repeat(64))).toEqual({status:"ok"});expect(m.rpc).toHaveBeenCalledTimes(1);m.create.mockClear();m.mode="demo";expect(await blockProfile(id)).toEqual({status:"unavailable"});expect(m.create).not.toHaveBeenCalled();});
it("sanitizes forbidden and thrown errors",async()=>{m.rpc.mockResolvedValue({data:null,error:{code:"P0001",message:"forbidden"}});expect(await blockProfile(id)).toEqual({status:"unavailable"});m.create.mockRejectedValue(Error("private"));expect(await blockProfile(id)).toEqual({status:"unavailable"});});
it("offers no request report any more (order 34) and refreshes the likes page after a block",async()=>{expect(Object.keys(actions)).not.toContain("reportRequest");expect(await blockProfile(id)).toEqual({status:"ok"});expect(m.rpc.mock.calls.map(([name])=>name)).not.toContain("list_my_requests");});

it("resolves conversations and sends exact block and report args without counterpart leaks",async()=>{
 const target="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
 const row={conversation_id:id,connection_id:id,counterpart_id:target,counterpart_name:"name",counterpart_photo_id:null,unread:false,last_message_id:null,last_message_body:null,last_message_at:null,last_message_mine:null};
 for(const [index,action] of [()=>blockConversation(id),()=>reportConversation(id,"spam"," hi "),()=>reportMessage(id,3,"spam","")].entries()){
 m.rpc.mockResolvedValueOnce({data:[row],error:null});
 if(index===2)m.rpc.mockResolvedValueOnce({data:[{id:3,sender_id:target,body:"evidence",created_at:"2026-11-07T00:00:00Z"}],error:null});
 const result=await action();expect(result).toEqual({status:"ok"});expect(JSON.stringify(result)).not.toMatch(/blocked_id|counterpart|ref/);expect(JSON.stringify(result)).not.toContain(target);
 }
 expect(m.rpc).toHaveBeenNthCalledWith(2,"block_user",{p_target:target});expect(m.rpc).toHaveBeenNthCalledWith(4,"submit_report",{p_target:target,p_context:"profile",p_reason:"spam",p_detail:"hi",p_request_id:null,p_message_id:null});expect(m.rpc).toHaveBeenLastCalledWith("submit_report",{p_target:target,p_context:"message",p_reason:"spam",p_detail:null,p_request_id:null,p_message_id:3});
 m.rpc.mockResolvedValue({data:[],error:null});expect(await blockConversation(id)).toEqual({status:"not_available"});expect(await reportConversation(id,"spam","")).toEqual({status:"not_available"});
});
