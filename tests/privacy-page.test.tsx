import {render,screen} from "@testing-library/react";
import {afterEach,it,expect,vi,beforeEach} from "vitest";
const m=vi.hoisted(()=>({mode:"supabase",gate:vi.fn(),privacy:vi.fn(),master:vi.fn(),create:vi.fn()}));
vi.mock("server-only",()=>({}));vi.mock("@/lib/backend",()=>({backendMode:()=>m.mode}));vi.mock("@/lib/supabase/server",()=>({createServerSupabase:m.create}));vi.mock("@/server/profile-gate",()=>({profileGate:m.gate}));vi.mock("@/server/privacy-data",()=>({loadMyPrivacy:m.privacy,privacyTargets:()=>[]}));vi.mock("@/server/affiliation-master",()=>({loadAffiliationMaster:m.master}));vi.mock("next/navigation",()=>({redirect:(path:string)=>{throw Error(path)}}));vi.mock("@/components/privacy-settings",()=>({PrivacySettings:()=> <p>demo branch</p>}));vi.mock("@/components/privacy-settings-live",()=>({PrivacySettingsLive:()=> <p>live branch</p>}));
import Page, {generateMetadata} from "@/app/settings/privacy/page";
beforeEach(()=>{vi.clearAllMocks();m.mode="supabase";m.create.mockResolvedValue({});m.gate.mockResolvedValue("completed");m.privacy.mockResolvedValue({status:"ok",settings:{}});m.master.mockResolvedValue([]);});
it("demo makes no client",async()=>{m.mode="demo";render(await Page());expect(screen.getByText("demo branch")).toBeInTheDocument();expect(m.create).not.toHaveBeenCalled();});
it("completed live page",async()=>{render(await Page());expect(screen.getByText("live branch")).toBeInTheDocument();});
it.each([["incomplete","/onboarding"],["unauthenticated","/login"]])("redirects %s",async(gate,path)=>{m.gate.mockResolvedValue(gate);await expect(Page()).rejects.toThrow(path);});
it.each(["unavailable","forbidden"])("gate refuses %s",async gate=>{m.gate.mockResolvedValue(gate);render(await Page());expect(screen.getByRole("alert")).toHaveTextContent("現在表示できません。");});
it("data and master failures",async()=>{m.privacy.mockResolvedValue({status:"unavailable"});render(await Page());expect(screen.getByRole("alert")).toBeInTheDocument();});
it("data authentication redirects",async()=>{m.privacy.mockResolvedValue({status:"unauthenticated"});await expect(Page()).rejects.toThrow("/login?next=");});
const network=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("no network"));afterEach(()=>expect(network).not.toHaveBeenCalled());

it("metadata follows backend",async()=>{expect(await generateMetadata()).toEqual({title:"公開範囲設定 | Campus Link"});m.mode="demo";expect(await generateMetadata()).toEqual({title:"公開範囲設定（デモ）| Campus Link"});});
it("client throw is a fixed alert",async()=>{m.create.mockRejectedValue(Error("secret"));render(await Page());expect(screen.getByRole("alert")).not.toHaveTextContent("secret");});
it("missing master is a fixed alert",async()=>{m.master.mockResolvedValue(null);render(await Page());expect(screen.getByRole("alert")).toBeInTheDocument();});
