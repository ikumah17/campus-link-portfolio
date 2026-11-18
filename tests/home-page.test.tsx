import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "@/app/page";
import { MAIN_CONTENT_ID } from "@/components/skip-link";

const mocks = vi.hoisted(() => ({ mode: vi.fn(), create: vi.fn(), gate: vi.fn(), redirect: vi.fn(), discover: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: mocks.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: mocks.create }));
vi.mock("@/server/profile-gate", () => ({ profileGate: mocks.gate }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/components/discover", () => ({ Discover: mocks.discover }));
const client = { rpc: vi.fn() };
const page = (mode?: string) => Page({ searchParams: Promise.resolve({ mode }) });
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  mocks.mode.mockReturnValue("supabase");
  mocks.create.mockResolvedValue(client);
  mocks.gate.mockResolvedValue("completed");
  mocks.redirect.mockImplementation((path: string) => { throw new Error(`REDIRECT:${path}`); });
  mocks.discover.mockImplementation((props: object) => <div data-testid="discover">{JSON.stringify(props)}</div>);
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

function expectUnavailable() {
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getByRole("alert")).toHaveTextContent("現在ご利用いただけません。時間をおいて再度お試しください。");
  expect(screen.getByRole("main")).toHaveAttribute("id", MAIN_CONTENT_ID);
  expect(screen.getByRole("main")).toHaveAttribute("tabindex", "-1");
  expect(screen.getAllByRole("heading")).toHaveLength(1);
  expect(screen.getByRole("heading", { level: 1, name: "Campus Link" })).toBeInTheDocument();
  expect(screen.queryByTestId("discover")).not.toBeInTheDocument();
  expect(mocks.discover).not.toHaveBeenCalled();
  expect(mocks.redirect).not.toHaveBeenCalled();
  expect(document.body).not.toHaveTextContent("private provider detail");
}

describe("home page profile gate", () => {
  it.each([undefined, "romance", "friends", "invalid"])("keeps demo Discover inert and ignores a mode: %s", async (mode) => {
    mocks.mode.mockReturnValue("demo");
    render(await page(mode));
    expect(screen.getByTestId("discover")).toHaveTextContent("{}");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
  it("renders live Discover for completed eligible Supabase profiles", async () => {
    const data = await import("@/server/discover-data");
    const master = await import("@/server/affiliation-master");
    const eligible = vi.spyOn(data, "viewerEligible").mockResolvedValue(true);
    const schools = vi.spyOn(master, "loadAffiliationMaster").mockResolvedValue([]);
    const list = vi.spyOn(data, "listProfiles").mockResolvedValue({ status: "ok", profiles: [], nextAfter: null });
    const view = await page("friends");
    expect(view.props).toMatchObject({ profiles: [], schools: [], nextAfter: null });
    expect(view.props).not.toHaveProperty("mode");
    render(view);
    expect(screen.queryByTestId("discover")).not.toBeInTheDocument();
    expect(mocks.discover).not.toHaveBeenCalled();
    expect(eligible).toHaveBeenCalledExactlyOnceWith(client);
    expect(schools).toHaveBeenCalledExactlyOnceWith(client);
    expect(list).toHaveBeenCalledExactlyOnceWith(client, { genders: [], schoolIds: [], min: undefined, max: undefined, after: undefined });
    expect(mocks.gate).toHaveBeenCalledExactlyOnceWith(client);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
  it.each([["incomplete", "/onboarding"], ["unauthenticated", "/login"]])("redirects %s outside the catch", async (gate, destination) => {
    mocks.gate.mockResolvedValue(gate);
    await expect(page()).rejects.toThrow(`REDIRECT:${destination}`);
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith(destination);
    expect(mocks.discover).not.toHaveBeenCalled();
  });
  it("renders only the fixed unavailable view for an unavailable gate", async () => {
    mocks.gate.mockResolvedValue("unavailable");
    render(await page());
    expectUnavailable();
  });
  it.each(["create", "gate"] as const)("renders unavailable when %s throws", async (source) => {
    mocks[source].mockRejectedValue(new Error("private provider detail"));
    render(await page());
    expectUnavailable();
    if (source === "create") expect(mocks.gate).not.toHaveBeenCalled();
  });
});
