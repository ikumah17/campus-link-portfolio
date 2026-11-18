// @vitest-environment node
import {afterEach,it,expect,vi} from "vitest";
import {createHash} from "node:crypto";
vi.mock("server-only",()=>({}));
import {listBlocks,listReports} from "@/server/safety-data";
const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",at="2026-11-07T00:00:00Z";
it("only returns hashed keys, snapshot and safe report fields",async()=>{const c={rpc:vi.fn().mockResolvedValue({data:[{blocked_id:id,blocked_name_snapshot:null,created_at:at}],error:null})};const r=await listBlocks(c);expect(r).toEqual({status:"ok",blocks:[{key:createHash("sha256").update(id).digest("hex"),name:null,createdAt:at}]});expect(JSON.stringify(r)).not.toContain(id);c.rpc.mockResolvedValue({data:[{id,created_at:at,status:"open"}],error:null});expect(await listReports(c)).toEqual({status:"ok",reports:[{createdAt:at,status:"open"}]});});
it("rejects malformed rows",async()=>{for(const row of [null,{}, {blocked_id:id,blocked_name_snapshot:2,created_at:at}])expect(await listBlocks({rpc:async()=>({data:[row],error:null})})).toEqual({status:"unavailable"});expect(await listReports({rpc:async()=>({data:[{id,created_at:at,status:"secret"}],error:null})})).toEqual({status:"unavailable"});});

const network=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("no network"));
afterEach(()=>expect(network).not.toHaveBeenCalled());
