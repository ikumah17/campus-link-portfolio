import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SEC-005 L-2: the interstitial after a confirmation link shows which account it signed in, and nothing without one.
const m = vi.hoisted(() => ({ mode: vi.fn(), create: vi.fn(), getUser: vi.fn(), rpc: vi.fn(), decline: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: m.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: m.create }));
vi.mock("@/server/auth-actions", () => ({ declineConfirmedAction: m.decline, signOutAction: vi.fn(), signOutEverywhereAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); },
  notFound: () => { throw new Error("NOT_FOUND"); },
}));
import Page, { dynamic } from "@/app/auth/confirmed/page";

const email = "fiction@example.invalid";
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  m.mode.mockReturnValue("supabase");
  m.create.mockResolvedValue({ auth: { getUser: m.getUser }, rpc: m.rpc });
  m.getUser.mockResolvedValue({ data: { user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email, is_anonymous: false } }, error: null });
  m.rpc.mockResolvedValue({ data: [{ account_status: "active" }], error: null });
  m.decline.mockResolvedValue({ status: "unavailable" });
});
afterEach(() => { cleanup(); expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
const props = (next?: string | string[]) => ({ searchParams: Promise.resolve(next === undefined ? {} : { next }) });

describe("/auth/confirmed", () => {
  it("is rendered per request, never stored", () => {
    expect(dynamic).toBe("force-dynamic");
  });
  it("shows the signed-in address and both choices", async () => {
    const { container } = render(await Page(props("/talk")));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("このアカウントでログインしました");
    expect(screen.getByText(email)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "続ける" })).toHaveAttribute("href", "/talk");
    expect(screen.getByRole("button", { name: "自分のアカウントではありません" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(m.rpc).toHaveBeenCalledExactlyOnceWith("my_account", {});
    expect(container.querySelectorAll("a")).toHaveLength(1);
  });
  it.each([undefined, ["/talk", "/mypage"], "//evil.example", "https://evil.example", "/\\evil", "/%2f%2fevil", "/has space"])("continues only to a safe next or /onboarding %#", async (next) => {
    render(await Page(props(next)));
    expect(screen.getByRole("link", { name: "続ける" })).toHaveAttribute("href", "/onboarding");
  });
  it("declines with the local sign-out action", async () => {
    render(await Page(props()));
    await userEvent.setup({ delay: null }).click(screen.getByRole("button", { name: "自分のアカウントではありません" }));
    await waitFor(() => expect(m.decline).toHaveBeenCalledOnce());
  });
  it.each([
    ["no session", () => m.getUser.mockResolvedValue({ data: { user: null }, error: { name: "AuthSessionMissingError", message: "private" } })],
    ["no user", () => m.getUser.mockResolvedValue({ data: { user: null }, error: null })],
    ["anonymous", () => m.getUser.mockResolvedValue({ data: { user: { id: "x", email, is_anonymous: true } }, error: null })],
    ["no address", () => m.getUser.mockResolvedValue({ data: { user: { id: "x", email: "", is_anonymous: false } }, error: null })],
    ["getUser throw", () => m.getUser.mockRejectedValue(new Error("private"))],
    ["client throw", () => m.create.mockRejectedValue(new Error("private"))],
    ["deleted account", () => m.rpc.mockResolvedValue({ data: [{ account_status: "deleted" }], error: null })],
    ["unreadable account", () => m.rpc.mockResolvedValue({ data: null, error: { message: "private" } })],
    ["account rows", () => m.rpc.mockResolvedValue({ data: [], error: null })],
    ["account throw", () => m.rpc.mockRejectedValue(new Error("private"))],
  ])("sends %s to /login and shows nothing", async (_name, arrange) => {
    arrange();
    await expect(Page(props("/talk"))).rejects.toThrow(/^REDIRECT:\/login$/);
    expect(m.decline).not.toHaveBeenCalled();
  });
  it("returns 404 in demo mode without a client", async () => {
    m.mode.mockReturnValue("demo");
    await expect(Page(props())).rejects.toThrow("NOT_FOUND");
    expect(m.create).not.toHaveBeenCalled();
  });
});
