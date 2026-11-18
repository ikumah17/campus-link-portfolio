// @vitest-environment node
import {it,expect,vi,afterEach} from "vitest";
vi.mock("server-only",()=>({}));
import {listConversations,loadRoom} from "@/server/chat-data";
const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",connection="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const row={conversation_id:id,connection_id:connection,counterpart_id:other,counterpart_name:"Partner",counterpart_photo_id:null,last_message_id:null,last_message_body:null,last_message_at:null,last_message_mine:null,unread:false};
const fetchSpy=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("network"));afterEach(()=>expect(fetchSpy).not.toHaveBeenCalled());
it.each(Object.keys(row))("rejects malformed conversation column %s",async key=>{const rpc=vi.fn().mockResolvedValue({data:[{...row,[key]:undefined}],error:null});expect(await listConversations({rpc})).toEqual({status:"unavailable"})});
it("checks last message atomically and strips private ids",async()=>{const rpc=vi.fn().mockResolvedValue({data:[row],error:null});const r=await listConversations({rpc});for(const s of [other,connection,"counterpart_id","connection_id"])expect(JSON.stringify(r)).not.toContain(s);rpc.mockResolvedValue({data:[{...row,last_message_body:"partial"}],error:null});expect(await listConversations({rpc})).toEqual({status:"unavailable"});});
it.each([{}, {id:0}, {sender_id:"bad"},{body:null},{created_at:"bad"}])("rejects malformed message %j",async patch=>{const rpc=vi.fn().mockResolvedValueOnce({data:[row],error:null}).mockResolvedValue({data:[{id:1,sender_id:other,body:"hi",created_at:"2026-01-01T00:00:00Z",...patch}],error:null});const r=await loadRoom({rpc},id);expect(r.status).toBe(Object.keys(patch).length?"unavailable":"ok");if(r.status==="ok")expect(JSON.stringify(r)).not.toContain(other);});
it.each([29,30])("boundary %s and oldest-first mapping",async n=>{const rpc=vi.fn().mockResolvedValueOnce({data:[row],error:null}).mockResolvedValue({data:Array.from({length:n},(_,i)=>({id:n-i,sender_id:other,body:"hi",created_at:"2026-01-01T00:00:00Z"})),error:null});const r=await loadRoom({rpc},id);expect(r).toMatchObject({status:"ok",room:{hasOlder:n===30,messages:expect.arrayContaining([expect.objectContaining({id:1,mine:false})])}});});
it("sanitizes provider failure",async()=>{expect(await listConversations({rpc:async()=>({data:null,error:{message:"secret"}})})).toEqual({status:"unavailable"});});

it("MOD-001: passes the hidden flag, treats a missing one (before order 33) as visible and rejects a malformed one",async()=>{
 const page=(patch:object)=>({rpc:vi.fn().mockResolvedValueOnce({data:[row],error:null}).mockResolvedValue({data:[{id:1,sender_id:other,body:"hi",created_at:"2026-01-01T00:00:00Z",...patch}],error:null})});
 expect(await loadRoom(page({hidden:true}),id)).toMatchObject({status:"ok",room:{messages:[{id:1,hidden:true}]}});
 expect(await loadRoom(page({hidden:false}),id)).toMatchObject({status:"ok",room:{messages:[{id:1,hidden:false}]}});
 expect(await loadRoom(page({}),id)).toMatchObject({status:"ok",room:{messages:[{id:1,hidden:false}]}});
 for(const hidden of [null,"true",1])expect(await loadRoom(page({hidden}),id)).toEqual({status:"unavailable"});
});
