// @vitest-environment node
import {beforeEach,afterEach,it,expect,vi} from "vitest";
const m=vi.hoisted(()=>({mode:vi.fn(),gate:vi.fn(),list:vi.fn()}));
vi.mock("server-only",()=>({}));vi.mock("@/lib/backend",()=>({backendMode:m.mode}));vi.mock("@/server/admin-gate",()=>({requireAdminSession:m.gate}));vi.mock("@/server/admin-affiliations",()=>({listAffiliations:m.list}));vi.mock("@/components/admin-affiliations-live",()=>({AdminAffiliationsLive:()=>null}));vi.mock("next/navigation",()=>({notFound:()=>{throw Error("404");},redirect:(path:string)=>{throw Error(path);}}));
import Page,{dynamic} from "@/app/admin/affiliations/page";
import {AdminAffiliations} from "@/components/admin-affiliations";
import {AdminAffiliationsLive} from "@/components/admin-affiliations-live";
import {AdminUnavailable} from "@/components/admin-live";
let network:ReturnType<typeof vi.spyOn>;
beforeEach(()=>{vi.resetAllMocks();m.mode.mockReturnValue("supabase");m.gate.mockResolvedValue({});network=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("network"));});
afterEach(()=>{expect(network).not.toHaveBeenCalled();vi.restoreAllMocks();});
it("keeps demo and dynamic routing",async()=>{expect(dynamic).toBe("force-dynamic");m.mode.mockReturnValue("demo");expect((await Page()).type).toBe(AdminAffiliations);expect(m.gate).not.toHaveBeenCalled();});
it("contains gate outages",async()=>{m.gate.mockResolvedValue(null);expect((await Page()).type).toBe(AdminUnavailable);expect(m.list).not.toHaveBeenCalled();});
it.each(["forbidden","unauthenticated","unavailable","ok"])("routes list %s",async status=>{m.list.mockResolvedValue({status,rows:[]});if(status==="forbidden")await expect(Page()).rejects.toThrow("404");else if(status==="unauthenticated")await expect(Page()).rejects.toThrow("/login?next=%2Fadmin%2Faffiliations");else expect((await Page()).type).toBe(status==="ok"?AdminAffiliationsLive:AdminUnavailable);expect(m.gate).toHaveBeenCalledWith("/admin/affiliations");});
