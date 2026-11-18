import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ mode: vi.fn(), create: vi.fn(), claims: vi.fn(), rpc: vi.fn(), push: vi.fn(), refresh: vi.fn(), account: vi.fn() }));
// my_account answers the deleted-account check; m.rpc sees only the page RPCs.
const rpc = (name: string, args: unknown) => name === "my_account" ? m.account() : m.rpc(name, args);
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: m.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: m.create }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: m.push, refresh: m.refresh }),
  notFound: () => { throw Error("NOT_FOUND"); }, redirect: (path: string) => { throw Error(`REDIRECT:${path}`); },
}));
import Page, { dynamic } from "@/app/admin/accounts/page";
const me = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", target = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const row = { user_id: target, display_name: "架空停止", suspended_at: "2026-11-10T03:00:00+00:00", reason: "spam" };
let network: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks(); m.mode.mockReturnValue("supabase"); m.create.mockResolvedValue({ auth: { getClaims: m.claims }, rpc });
  m.account.mockResolvedValue({ data: [{ account_status: "active" }], error: null });
  m.claims.mockResolvedValue({ data: { claims: { sub: me, aal: "aal2" } }, error: null });
  m.rpc.mockResolvedValue({ data: [row], error: null });
  network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("network"));
});
afterEach(() => { expect(network).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
it("is dynamic and gives the demo the not-found page without a client", async () => {
  expect(dynamic).toBe("force-dynamic"); m.mode.mockReturnValue("demo");
  await expect(Page()).rejects.toThrow("NOT_FOUND"); expect(m.create).not.toHaveBeenCalled();
});
it.each([[null, "/login?next=%2Fadmin%2Faccounts"], [{ sub: me, aal: "aal1" }, "/admin/mfa?next=%2Fadmin%2Faccounts"], [{ sub: me, aal: "aal2", is_anonymous: true }, "/login?next=%2Fadmin%2Faccounts"]])("routes session %#", async (claims, path) => {
  m.claims.mockResolvedValue({ data: claims ? { claims } : null, error: null });
  await expect(Page()).rejects.toThrow(`REDIRECT:${path}`); expect(m.rpc).not.toHaveBeenCalled();
});
it("lists the suspended accounts at aal2 from one admin_list_suspended_accounts call", async () => {
  const { container } = render(await Page());
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("停止中のアカウント");
  expect(screen.getByRole("heading", { level: 2, name: "架空停止" })).toBeInTheDocument();
  expect(screen.getByText("ID #bbbbbbbb")).toBeInTheDocument();
  expect(screen.getByText("2026/11/10")).toBeInTheDocument();
  expect(screen.getByText("迷惑行為・スパム")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "停止を解除" })).toBeInTheDocument();
  expect(container.textContent).not.toContain(target);
  expect(container.textContent).not.toMatch(/デモ|private/);
  expect(m.rpc).toHaveBeenCalledExactlyOnceWith("admin_list_suspended_accounts", {});
});
it("shows the empty state", async () => {
  m.rpc.mockResolvedValue({ data: [], error: null });
  render(await Page());
  expect(screen.getByText("停止中のアカウントはありません。")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "停止を解除" })).not.toBeInTheDocument();
});
// The RPC refuses every caller without the admin role (moderators and reviewers included) with forbidden.
it.each([["P0001", "forbidden", "NOT_FOUND"], ["PGRST301", "private", "REDIRECT:/login?next=%2Fadmin%2Faccounts"]])("routes RPC refusal %s", async (code, message, route) => {
  m.rpc.mockResolvedValue({ data: null, error: { code, message } }); await expect(Page()).rejects.toThrow(route);
});
it.each(["client", "claims", "rpc", "missing", "malformed", "extra column", "bad reason", "duplicate"])("contains %s outages", async kind => {
  if (kind === "client") m.create.mockRejectedValue(Error("private"));
  if (kind === "claims") m.claims.mockRejectedValue(Error("private"));
  if (kind === "rpc") m.rpc.mockResolvedValue({ data: null, error: { message: "private" } });
  if (kind === "missing") m.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "private" }, status: 404 });
  if (kind === "malformed") m.rpc.mockResolvedValue({ data: [{}], error: null });
  if (kind === "extra column") m.rpc.mockResolvedValue({ data: [{ ...row, birth_date: "2000-01-01" }], error: null });
  if (kind === "bad reason") m.rpc.mockResolvedValue({ data: [{ ...row, reason: "<b>" }], error: null });
  if (kind === "duplicate") m.rpc.mockResolvedValue({ data: [row, row], error: null });
  render(await Page()); expect(screen.getByRole("alert")).toHaveTextContent("現在表示できません。時間をおいて再度お試しください。");
  expect(screen.queryByText(/private|架空停止/)).not.toBeInTheDocument();
});
it("refuses a deleted account before the list RPC", async () => {
  m.account.mockResolvedValue({ data: [{ account_status: "deleted" }], error: null });
  render(await Page()); expect(screen.getByRole("alert")).toHaveTextContent("現在表示できません。");
  expect(m.rpc).not.toHaveBeenCalled();
});
