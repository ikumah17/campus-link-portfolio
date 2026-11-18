// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { listAffiliations } from "@/server/admin-affiliations";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const row = { level: "school", id, parent_id: null, name: "School", is_active: false, sort_order: 0, academic_year: null };
const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("network"));
afterEach(() => expect(network).not.toHaveBeenCalled());
it("maps all levels and inactive rows", async () => {
 const department = { ...row, id: id.replaceAll("a", "b"), level: "department", parent_id: id };
 const cls = { ...row, id: id.replaceAll("a", "c"), level: "class", parent_id: department.id, academic_year: 2026 };
 const rpc = vi.fn().mockResolvedValue({ data: [row, department, cls], error: null });
 expect(await listAffiliations({ rpc })).toEqual({ status: "ok", rows: [row, department, cls].map(r => ({ id:r.id,level:r.level,parentId:r.parent_id,name:r.name,isActive:r.is_active,sortOrder:r.sort_order,academicYear:r.academic_year })) });
 expect(rpc).toHaveBeenCalledExactlyOnceWith("admin_list_affiliations", {});
});
it.each([null, {}, [{...row,level:"other"}], [{...row,id:"bad"}], [{...row,parent_id:id}], [{...row,academic_year:2000}], [{...row,is_active:1}], [{...row,sort_order:0.5}], [{...row,name:null}], [{...row,level:"department",parent_id:id}], [{...row,level:"class",parent_id:null}], [row,row]])("rejects malformed rows %#", async data => {
 expect(await listAffiliations({rpc:vi.fn().mockResolvedValue({data,error:null})})).toEqual({status:"unavailable"});
});
it.each([["P0001","forbidden","forbidden"],["PGRST301","private","unauthenticated"],["XX000","private","unavailable"]])("maps errors %s",async(code,message,status)=>{
 expect(await listAffiliations({rpc:vi.fn().mockResolvedValue({data:null,error:{code,message}})})).toEqual({status});
});
