import { expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
const m=vi.hoisted(()=>({mode:"supabase",create:vi.fn(),gate:vi.fn(),list:vi.fn(),live:vi.fn()}));
vi.mock("server-only",()=>({}));vi.mock("@/lib/backend",()=>({backendMode:()=>m.mode}));vi.mock("@/lib/supabase/server",()=>({createServerSupabase:m.create}));vi.mock("@/server/profile-gate",()=>({profileGate:m.gate}));vi.mock("@/server/like-data",()=>({listLikes:m.list}));
vi.mock("next/navigation",()=>({redirect:(s:string)=>{throw Error(s)},permanentRedirect:(s:string)=>{throw Error(`permanent ${s}`)},useRouter:()=>({refresh:vi.fn()})}));
vi.mock("@/components/likes",()=>({Likes:()=> <p>demo fixture</p>}));
vi.mock("@/components/likes-live",()=>({LikesLive:(p:Record<string,unknown>)=>{m.live(p);return <h1>live fixture</h1>}}));
import Page from "@/app/likes/page";
import RequestsPage from "@/app/requests/page";
const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const props=(q:Record<string,string|string[]>={})=>({searchParams:Promise.resolve(q)});
const fetchSpy=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("network forbidden"));
afterEach(()=>{expect(fetchSpy).not.toHaveBeenCalled();vi.clearAllMocks();m.mode="supabase"});
it("redirects the old request page to the likes page",()=>{expect(()=>RequestsPage()).toThrow("permanent /likes")});
it("preserves demo without any client, ignoring a mode",async()=>{m.mode="demo";render(await Page(props({mode:"friends"})));expect(screen.getByText("demo fixture")).toBeInTheDocument();expect(m.create).not.toHaveBeenCalled()});
it.each(["incomplete","unauthenticated"])("redirects gate %s",async gate=>{m.gate.mockResolvedValue(gate);await expect(Page(props())).rejects.toThrow(gate==="incomplete"?"/onboarding":"/login?next=%2Flikes");expect(m.list).not.toHaveBeenCalled()});
it.each(["unavailable","throw"])("fails closed at gate %s",async failure=>{m.create.mockResolvedValue({});if(failure==="throw")m.gate.mockRejectedValue(Error("private"));else m.gate.mockResolvedValue(failure);render(await Page(props()));expect(screen.getByRole("alert")).toHaveTextContent("現在表示できません。時間をおいて再度お試しください。")});
it.each(["ok","unauthenticated","unavailable","throw"])("handles list %s",async status=>{m.gate.mockResolvedValue("completed");if(status==="throw")m.list.mockRejectedValue(Error("private"));else m.list.mockResolvedValue({status,likes:[],next:null});if(status==="unauthenticated")await expect(Page(props())).rejects.toThrow("/login");else {render(await Page(props()));expect(screen.getByRole(status==="ok"?"heading":"alert")).toBeInTheDocument()}});
it("continues only the named list from a valid cursor",async()=>{
 m.gate.mockResolvedValue("completed");m.create.mockResolvedValue({});m.list.mockResolvedValue({status:"ok",likes:[],next:null});
 render(await Page(props({tab:"sent",at:"2026-11-17T00:00:00+00:00",id})));
 expect(m.list).toHaveBeenCalledWith({}, "received", undefined);expect(m.list).toHaveBeenCalledWith({}, "sent", {at:"2026-11-17T00:00:00+00:00",id});
 expect(m.live).toHaveBeenLastCalledWith(expect.objectContaining({tab:"sent"}));
 m.list.mockClear();
 for(const q of [{tab:"sent",at:"x",id},{tab:"sent",at:"2026-11-17",id:"bad"},{tab:["sent","sent"],at:"2026-11-17",id},{tab:"other",at:"2026-11-17",id}]){render(await Page(props(q)));}
 for(const call of m.list.mock.calls)expect(call[2]).toBeUndefined();
});
