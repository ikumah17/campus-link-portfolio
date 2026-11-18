import {render,screen} from "@testing-library/react";
import {afterEach,it,expect,vi,beforeEach} from "vitest";
const m=vi.hoisted(()=>({mode:"supabase",gate:vi.fn(),blocks:vi.fn(),reports:vi.fn(),create:vi.fn()}));
vi.mock("server-only",()=>({}));vi.mock("@/lib/backend",()=>({backendMode:()=>m.mode}));vi.mock("@/lib/supabase/server",()=>({createServerSupabase:m.create}));vi.mock("@/server/profile-gate",()=>({profileGate:m.gate}));vi.mock("@/server/safety-data",()=>({listBlocks:m.blocks,listReports:m.reports}));vi.mock("next/navigation",()=>({redirect:(path:string)=>{throw Error(path)}}));vi.mock("@/components/blocks-settings",()=>({BlocksSettings:()=> <p>demo branch</p>}));vi.mock("@/components/blocks-settings-live",()=>({BlocksSettingsLive:()=> <p>live branch</p>}));
import Page from "@/app/settings/blocks/page";
beforeEach(()=>{vi.clearAllMocks();m.mode="supabase";m.create.mockResolvedValue({});m.gate.mockResolvedValue("completed");m.blocks.mockResolvedValue({status:"ok",blocks:[]});m.reports.mockResolvedValue({status:"ok",reports:[]});});
it("demo makes no client",async()=>{m.mode="demo";render(await Page());expect(screen.getByText("demo branch")).toBeInTheDocument();expect(m.create).not.toHaveBeenCalled();});
it("completed live page",async()=>{render(await Page());expect(screen.getByText("live branch")).toBeInTheDocument();});
it.each([["incomplete","/onboarding"],["unauthenticated","/login"]])("redirects %s",async(gate,path)=>{m.gate.mockResolvedValue(gate);await expect(Page()).rejects.toThrow(path);});
it.each(["unavailable","forbidden"])("gate refuses %s",async gate=>{m.gate.mockResolvedValue(gate);render(await Page());expect(screen.getByRole("alert")).toHaveTextContent("現在表示できません。");});
it("handles throw and data failures",async()=>{m.blocks.mockRejectedValue(Error("private"));render(await Page());expect(screen.getByRole("alert")).not.toHaveTextContent("private");});
it.each(["blocks","reports"])("data unauthenticated %s",async source=>{m[source as "blocks"|"reports"].mockResolvedValue({status:"unauthenticated"});await expect(Page()).rejects.toThrow("/login");});

const network=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("no network"));
afterEach(()=>expect(network).not.toHaveBeenCalled());
