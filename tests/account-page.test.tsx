import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ mode: "supabase", create: vi.fn(), load: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: () => m.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: m.create }));
vi.mock("@/server/account-data", () => ({ loadAccountState: m.load }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw Error(path); } }));
vi.mock("@/components/account-settings-live", () => ({ AccountSettingsLive: ({ accountStatus }: { accountStatus: string }) => <p>live {accountStatus}</p> }));
import Page, { generateMetadata } from "@/app/settings/account/page";
import DeletedPage, { metadata } from "@/app/settings/account/deleted/page";
const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("network"));
beforeEach(() => { m.mode = "supabase"; m.create.mockResolvedValue({}); m.load.mockResolvedValue({ status: "ok", accountStatus: "active" }); });
afterEach(() => { cleanup(); expect(network).not.toHaveBeenCalled(); vi.clearAllMocks(); });
it("demo renders the in-memory screen without a client", async () => {
  m.mode = "demo"; render(await Page());
  expect(screen.getByRole("heading", { level: 1, name: "アカウント" })).toBeInTheDocument();
  expect(screen.getByRole("note")).toHaveTextContent("デモ");
  expect(m.create).not.toHaveBeenCalled(); expect(m.load).not.toHaveBeenCalled();
  expect(await generateMetadata()).toEqual({ title: "アカウント（デモ）| Campus Link" });
  m.mode = "supabase"; expect(await generateMetadata()).toEqual({ title: "アカウント | Campus Link" });
});
it.each(["active", "deactivated", "suspended"])("a %s account reaches the live screen", async (accountStatus) => {
  m.load.mockResolvedValue({ status: "ok", accountStatus }); render(await Page());
  expect(screen.getByText(`live ${accountStatus}`)).toBeInTheDocument();
});
it.each([["incomplete", "/onboarding"], ["unauthenticated", "/login?next=%2Fsettings%2Faccount"]])("redirects %s", async (status, path) => {
  m.load.mockResolvedValue({ status }); await expect(Page()).rejects.toThrow(path);
});
it.each(["deleted", "unavailable", "throw", "client-throw"])("%s gets a fixed alert", async (status) => {
  m.load.mockResolvedValue({ status });
  if (status === "throw") m.load.mockRejectedValue(Error("secret"));
  if (status === "client-throw") m.create.mockRejectedValue(Error("secret"));
  render(await Page());
  expect(screen.getByRole("alert")).toHaveTextContent("現在表示できません。時間をおいて再度お試しください。");
  expect(document.body.textContent).not.toMatch(/secret|live/);
});
it("the completion page is static and links only to the public welcome page", () => {
  render(<DeletedPage />);
  expect(metadata.title).toBe("退会の手続きが完了しました | Campus Link");
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("退会の手続きが完了しました");
  expect(screen.getByText("ログアウトしました。")).toBeInTheDocument();
  expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/welcome"]);
});
