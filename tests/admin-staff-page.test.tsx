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
import Page, { dynamic } from "@/app/admin/staff/page";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let network: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks(); m.mode.mockReturnValue("supabase"); m.create.mockResolvedValue({ auth: { getClaims: m.claims }, rpc });
  m.account.mockResolvedValue({ data: [{ account_status: "active" }], error: null });
  m.claims.mockResolvedValue({ data: { claims: { sub: id, aal: "aal2" } }, error: null });
  m.rpc.mockResolvedValue({ data: [{ user_id: id, display_name: "管理担当", roles: ["admin"], is_me: true, acting: [true] }], error: null });
  network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("network"));
});
afterEach(() => { expect(network).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
it("is dynamic, denies demo without a client", async () => {
  expect(dynamic).toBe("force-dynamic"); m.mode.mockReturnValue("demo");
  await expect(Page()).rejects.toThrow("NOT_FOUND"); expect(m.create).not.toHaveBeenCalled();
});
it.each([[null, "/login?next=%2Fadmin%2Fstaff"], [{ sub: id, aal: "aal1" }, "/admin/mfa?next=%2Fadmin%2Fstaff"], [{ sub: id, aal: "aal2", is_anonymous: true }, "/login?next=%2Fadmin%2Fstaff"]])("routes session %#", async (claims, path) => {
  m.claims.mockResolvedValue({ data: claims ? { claims } : null, error: null });
  await expect(Page()).rejects.toThrow(`REDIRECT:${path}`); expect(m.rpc).not.toHaveBeenCalled();
});
it("renders only a safe projection at aal2", async () => {
  const { container } = render(await Page());
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("担当者と役割");
  expect(container.innerHTML).not.toContain(id); expect(container.textContent).not.toMatch(/デモ|架空|private/);
  expect(m.rpc).toHaveBeenCalledExactlyOnceWith("admin_list_staff", {});
  expect(screen.queryByText("無効（要素の変更後）")).not.toBeInTheDocument();
  expect(screen.queryByText(/働いている管理者がいません/)).not.toBeInTheDocument();
});
it("marks a role that does not act", async () => {
  m.rpc.mockResolvedValue({ data: [
    { user_id: id, display_name: "管理担当", roles: ["admin"], is_me: true, acting: [true] },
    { user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", display_name: null, roles: ["moderator", "admin"], is_me: false, acting: [true, false] },
  ], error: null });
  const { container } = render(await Page());
  expect(screen.getAllByText("無効（要素の変更後）")).toHaveLength(1);
  expect(container.innerHTML).not.toContain("bbbbbbbb-bbbb");
});
it.each([["P0001", "forbidden", "NOT_FOUND"], ["PGRST301", "private", "REDIRECT:/login?next=%2Fadmin%2Fstaff"]])("routes RPC refusal %s", async (code, message, route) => {
  m.rpc.mockResolvedValue({ data: null, error: { code, message } }); await expect(Page()).rejects.toThrow(route);
});
it.each(["client", "claims", "rpc", "malformed"])("contains %s outages", async kind => {
  if (kind === "client") m.create.mockRejectedValue(Error("private"));
  if (kind === "claims") m.claims.mockRejectedValue(Error("private"));
  if (kind === "rpc") m.rpc.mockResolvedValue({ data: null, error: { message: "private" } });
  if (kind === "malformed") m.rpc.mockResolvedValue({ data: [{ user_id: id, display_name: null, roles: ["admin"], is_me: true }], error: null });
  render(await Page()); expect(screen.getByRole("alert")).toHaveTextContent("現在表示できません。時間をおいて再度お試しください。");
  expect(screen.queryByText(/private|デモ/)).not.toBeInTheDocument();
});
