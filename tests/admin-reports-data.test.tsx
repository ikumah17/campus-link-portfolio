// @vitest-environment node
import {it,expect,vi,afterAll} from "vitest";
import {createHash} from "node:crypto";
vi.mock("server-only",()=>({}));
import {listReports,getReport} from "@/server/admin-reports";
const fetchSpy=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("network"));
afterAll(()=>{expect(fetchSpy).not.toHaveBeenCalled();vi.restoreAllMocks();});
const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",target="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const row={id,reporter_id:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",target_user_id:target,context:"profile",reason:"spam",status:"open",created_at:"2026-11-07T00:00:00Z",detail:null,evidence_message_body:null,evidence_message_created_at:null,request_id:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",message_id:12345678,evidence_conversation_id:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"};
function client(data:unknown){return {rpc:vi.fn().mockResolvedValue({data,error:null})};}
it("projects stable hashed labels and strips all private references",async()=>{
 const a=await listReports(client([row]),"open"),b=await getReport(client([row]),id);
 expect(a).toMatchObject({status:"ok",reports:[{targetLabel:`対象 #${createHash("sha256").update(target).digest("hex").slice(0,8)}`}]});
 for(const result of [a,b])for(const key of ["reporter_id","target_user_id","request_id","message_id","evidence_conversation_id"] as const){expect(JSON.stringify(result)).not.toContain(String(row[key]));expect(JSON.stringify(result)).not.toContain(`"${key}"`);}
 expect(await listReports(client([{...row,reporter_id:null,target_user_id:null}]),"open")).toMatchObject({reports:[{targetLabel:null}]});
 expect(await getReport(client([{...row,evidence_message_body:"evidence",evidence_message_created_at:row.created_at}]),id)).toMatchObject({report:{evidence:{body:"evidence",createdAt:row.created_at}}});
});
it("strictly rejects malformed list and detail rows",async()=>{
 for(const patch of [{id:"bad"},{reporter_id:undefined},{target_user_id:"bad"},{context:"x"},{reason:"toString"},{status:"x"},{created_at:null}]){
 expect(await listReports(client([{...row,...patch}]),"open")).toEqual({status:"unavailable"});expect(await getReport(client([{...row,...patch}]),id)).toEqual({status:"unavailable"});}
 expect(await listReports(client([{...row,status:"triaged"}]),"open")).toEqual({status:"unavailable"});
 for(const patch of [{detail:1},{evidence_message_body:undefined},{evidence_message_created_at:3}])expect(await getReport(client([{...row,...patch}]),id)).toEqual({status:"unavailable"});
 for(const data of [null,{},[row,row]])expect(await getReport(client(data),id)).toEqual({status:"unavailable"});
 expect(await getReport(client([]),id)).toEqual({status:"ok",report:null});
});
it("maps errors without provider text",async()=>{for(const [error,status] of [[{code:"P0001",message:"forbidden"},"forbidden"],[{code:"PGRST301",message:"secret"},"unauthenticated"],[{message:"secret"},"unavailable"]] as const){const c={rpc:vi.fn().mockResolvedValue({data:null,error})};expect(await listReports(c,"open")).toEqual({status});expect(await getReport(c,id)).toEqual({status});}});
