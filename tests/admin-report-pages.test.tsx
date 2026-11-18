import {it,expect,vi,beforeEach,afterEach} from "vitest";
const m=vi.hoisted(()=>({mode:vi.fn(),gate:vi.fn(),list:vi.fn(),get:vi.fn(),content:vi.fn()}));
vi.mock("server-only",()=>({}));vi.mock("@/lib/backend",()=>({backendMode:m.mode}));vi.mock("@/server/admin-gate",()=>({requireAdminSession:m.gate}));vi.mock("@/server/admin-reports",()=>({listReports:m.list,getReport:m.get,getReportContent:m.content}));
vi.mock("next/navigation",()=>({redirect:(s:string)=>{throw Error(s);},notFound:()=>{throw Error("NOT_FOUND");}}));
import List,{dynamic} from "@/app/admin/reports/page";
import Detail,{metadata} from "@/app/admin/reports/[id]/page";
const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const detail=(value=id)=>Detail({params:Promise.resolve({id:value})});
let network:ReturnType<typeof vi.spyOn>;
beforeEach(()=>{vi.resetAllMocks();network=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("network"));m.mode.mockReturnValue("supabase");m.gate.mockResolvedValue({});m.list.mockResolvedValue({status:"ok",reports:[]});m.get.mockResolvedValue({status:"ok",report:{id}});m.content.mockResolvedValue({status:"unavailable"});});
afterEach(()=>{expect(network).not.toHaveBeenCalled();vi.restoreAllMocks();});
it("dynamic list filters and fixed metadata without reads",async()=>{expect(dynamic).toBe("force-dynamic");expect(metadata.title).toBe("通報 | Campus Link 管理");for(const status of ["open","triaged","actioned","dismissed","bad",["open"]]){await List({searchParams:Promise.resolve({status})});expect(m.list).toHaveBeenLastCalledWith({},typeof status==="string"&&status!=="bad"?status:"open");}expect(m.get).not.toHaveBeenCalled();});
it("detail rejects bad ids before client",async()=>{for(const value of ["bad",id.toUpperCase(),id+"\n"]){await expect(detail(value)).rejects.toThrow("NOT_FOUND");}expect(m.gate).not.toHaveBeenCalled();});
it("demo list is unchanged and detail unavailable",async()=>{m.mode.mockReturnValue("demo");expect((await List()).type).toBeDefined();await expect(detail()).rejects.toThrow("NOT_FOUND");expect(m.gate).not.toHaveBeenCalled();});
it("pages handle no client, refused, unauthenticated, unavailable and missing",async()=>{for(const [page,rpc,path] of [[()=>List(),m.list,"/admin/reports"],[detail,m.get,`/admin/reports/${id}`]] as const){m.gate.mockResolvedValue(null);expect((await page()).type).toBeDefined();m.gate.mockResolvedValue({});rpc.mockResolvedValue({status:"forbidden"});await expect(page()).rejects.toThrow("NOT_FOUND");rpc.mockResolvedValue({status:"unauthenticated"});await expect(page()).rejects.toThrow(`/login?next=${encodeURIComponent(path)}`);rpc.mockResolvedValue({status:"unavailable"});expect((await page()).type).toBeDefined();}m.get.mockResolvedValue({status:"ok",report:null});await expect(detail()).rejects.toThrow("NOT_FOUND");m.get.mockResolvedValue({status:"ok",report:{id}});expect((await detail()).props.report.id).toBe(id);});
it("detail passes the report content, or null when it cannot be read (before order 33)",async()=>{
 const content=[{item:"message",ref:"1",position:null,body:"架空",hidden:false,hiddenAt:null}];
 m.content.mockResolvedValue({status:"ok",content});const page=await detail();expect(page.props.content).toEqual(content);expect(m.content).toHaveBeenCalledExactlyOnceWith({},id);
 for(const status of ["unavailable","forbidden","unauthenticated"]){m.content.mockResolvedValue({status});expect((await detail()).props.content).toBeNull();}
 m.get.mockResolvedValue({status:"forbidden"});m.content.mockClear();await expect(detail()).rejects.toThrow("NOT_FOUND");expect(m.content).not.toHaveBeenCalled();
});
