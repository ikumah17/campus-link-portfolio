import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Dashboard from "@/app/admin/page";
import Verifications from "@/app/admin/verifications/page";
import Reports from "@/app/admin/reports/page";
import Affiliations from "@/app/admin/affiliations/page";
import AdminLayout from "@/app/admin/layout";
import MfaPage, { dynamic } from "@/app/admin/mfa/page";
import { AdminMfa } from "@/components/admin-mfa";
import { AdminProvider } from "@/lib/admin-demo";
import { ADMIN_NOTICE } from "@/lib/admin-gateway";

const mocks = vi.hoisted(() => ({ mode: vi.fn(), create: vi.fn(), claims: vi.fn(), list: vi.fn(), rpc: vi.fn(), redirect: vi.fn(), notFound: vi.fn(), push: vi.fn(), refresh: vi.fn(), account: vi.fn(), roles: vi.fn() }));
// my_account answers the deleted-account check and my_staff_roles the /admin staff check; mocks.rpc sees only the page RPCs.
const rpc = (name: string, args: unknown) => name === "my_account" ? mocks.account()
  : name === "my_staff_roles" ? mocks.roles(args) : mocks.rpc(name, args);
const allRoles = { data: [{ role: "reviewer" }, { role: "moderator" }, { role: "admin" }], error: null };
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: mocks.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: mocks.create }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: mocks.notFound, useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }) }));
const pages = [["/admin", Dashboard], ["/admin/verifications", Verifications], ["/admin/reports", Reports], ["/admin/affiliations", Affiliations]] as const;
let fetchSpy: ReturnType<typeof vi.spyOn>;
let allowsListRpc: false | "submissions" | "reports" | "affiliations" = false;
beforeEach(() => {
  vi.resetAllMocks();
  allowsListRpc = false;
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  mocks.mode.mockReturnValue("supabase");
  mocks.create.mockResolvedValue({ auth: { getClaims: mocks.claims, mfa: { listFactors: mocks.list } }, rpc });
  mocks.account.mockResolvedValue({ data: [{ account_status: "active" }], error: null });
  mocks.roles.mockResolvedValue(allRoles);
  mocks.claims.mockResolvedValue({ data: { claims: { aal: "aal2", sub: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } }, error: null });
  mocks.rpc.mockResolvedValue({ data: [], error: null });
  mocks.list.mockResolvedValue({ data: { all: [] }, error: null });
  mocks.redirect.mockImplementation((path: string) => { throw new Error(`REDIRECT:${path}`); });
  mocks.notFound.mockImplementation(() => { throw new Error("NOT_FOUND"); });
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  if (allowsListRpc === "affiliations") expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("admin_list_affiliations", {});
  else if (allowsListRpc) expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(allowsListRpc === "reports" ? "admin_list_reports" : "admin_list_submissions", { p_status: allowsListRpc === "reports" ? "open" : "submitted" });
  else expect(mocks.rpc).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
const mfaPage = (next?: unknown) => MfaPage({ searchParams: Promise.resolve({ next } as never) });

describe("admin pages in supabase mode", () => {
  it("returns children directly without the demo provider", () => {
    const child = <p>live child</p>;
    expect(AdminLayout({ children: child })).toBe(child);
  });
  it.each(pages)("%s redirects aal1 to its own MFA return path", async (path, Page) => {
    mocks.claims.mockResolvedValue({ data: { claims: { aal: "aal1" } }, error: null });
    await expect(Page()).rejects.toThrow(`REDIRECT:/admin/mfa?next=${encodeURIComponent(path)}`);
    expect(mocks.roles).not.toHaveBeenCalled();
  });
  it.each(pages)("%s redirects unauthenticated sessions to login", async (path, Page) => {
    mocks.claims.mockResolvedValue({ data: null, error: null });
    await expect(Page()).rejects.toThrow(`REDIRECT:/login?next=${encodeURIComponent(path)}`);
  });
  it.each(pages)("%s at aal2 shows the live shell", async (path, Page) => {
    allowsListRpc = path === "/admin/verifications" ? "submissions" : path === "/admin/reports" ? "reports" : path === "/admin/affiliations" ? "affiliations" : false;
    const { container } = render(AdminLayout({ children: await Page() }));
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(screen.getByRole("link", { name: "管理画面へ戻る" })).toHaveAttribute("href", "/admin");
    expect(container).not.toHaveTextContent(ADMIN_NOTICE);
    expect(container).not.toHaveTextContent(/デモ|架空|fictional|sample|件/);
    if (path === "/admin") {
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("管理画面");
      expect(screen.getByRole("link", { name: "学生認証審査" })).toHaveAttribute("href", "/admin/verifications");
      expect(screen.getByRole("link", { name: "通報" })).toHaveAttribute("href", "/admin/reports");
      expect(screen.getByRole("link", { name: "学校・学科・クラス" })).toHaveAttribute("href", "/admin/affiliations");
      expect(screen.getByRole("link", { name: "担当者と役割" })).toHaveAttribute("href", "/admin/staff");
      expect(screen.getByRole("link", { name: "停止中のアカウント" })).toHaveAttribute("href", "/admin/accounts");
    } else if (path === "/admin/verifications") {
      expect(screen.getByText("この状態の提出はありません。")).toBeInTheDocument();
      expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("admin_list_submissions", { p_status: "submitted" });
    } else if (path === "/admin/reports") {
      expect(screen.getByText("この状態の通報はありません。")).toBeInTheDocument();
      expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("admin_list_reports", { p_status: "open" });
    } else expect(screen.getByText("学校はまだありません。")).toBeInTheDocument();
    if (path === "/admin") expect(mocks.rpc).not.toHaveBeenCalled();
    if (path === "/admin") expect(mocks.roles).toHaveBeenCalledExactlyOnceWith({});
    else expect(mocks.roles).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it.each(pages)("%s shows the fixed unavailable view on an outage", async (_path, Page) => {
    mocks.claims.mockRejectedValue(new Error("private provider detail"));
    render(await Page());
    expect(screen.getByRole("alert")).toHaveTextContent("現在表示できません。時間をおいて再度お試しください。");
    expect(screen.queryByText(/private|デモ/)).not.toBeInTheDocument();
  });
  it.each(pages.flatMap(([path, Page]) => ([
    [path, Page, { data: [{ account_status: "deleted" }], error: null }],
    [path, Page, { data: [], error: null }],
    [path, Page, { data: null, error: { code: "P0001", message: "forbidden" } }],
  ] as const)))("%s refuses a deleted or unreadable account at aal2 before any admin RPC %#", async (_path, Page, account) => {
    mocks.account.mockResolvedValue(account);
    render(await Page());
    expect(screen.getByRole("alert")).toHaveTextContent("現在表示できません。時間をおいて再度お試しください。");
    expect(mocks.account).toHaveBeenCalledOnce();
    expect(mocks.roles).not.toHaveBeenCalled();
  });
});

const entryNames = ["学生認証審査", "通報", "学校・学科・クラス", "担当者と役割", "停止中のアカウント"];
const linkNames = () => screen.queryAllByRole("link").map((link) => link.textContent).filter((name) => entryNames.includes(name ?? ""));
describe("/admin shows the dashboard to staff only (ADMIN-005)", () => {
  it.each([
    ["admin", [{ role: "admin" }], ["学校・学科・クラス", "担当者と役割", "停止中のアカウント"]],
    ["reviewer only", [{ role: "reviewer" }], ["学生認証審査"]],
    ["moderator only", [{ role: "moderator" }], ["通報"]],
    ["reviewer and moderator", [{ role: "moderator" }, { role: "reviewer" }], ["学生認証審査", "通報"]],
    ["every role", allRoles.data, entryNames],
  ])("%s sees the entries its roles can use", async (_label, roles, expected) => {
    mocks.roles.mockResolvedValue({ data: roles, error: null });
    render(await Dashboard());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("管理画面");
    expect(linkNames()).toEqual(expected);
    for (const link of screen.getAllByRole("link")) expect(link.getAttribute("href")).toMatch(/^\/admin(\/(verifications|reports|affiliations|staff|accounts))?$/);
    expect(mocks.account).toHaveBeenCalledOnce();
    expect(mocks.roles).toHaveBeenCalledExactlyOnceWith({});
  });
  it("a staff member without a profile sees the dashboard", async () => {
    mocks.account.mockResolvedValue({ data: [{ account_status: null }], error: null });
    mocks.roles.mockResolvedValue({ data: [{ role: "reviewer" }], error: null });
    render(await Dashboard());
    expect(linkNames()).toEqual(["学生認証審査"]);
  });
  it.each([
    ["no staff role", { data: [], error: null }],
    ["a forbidden answer", { data: null, error: { code: "P0001", message: "forbidden" } }],
    ["a missing RPC", { data: null, error: { code: "PGRST202", message: "private" }, status: 404 }],
    ["an expired token", { data: null, error: { code: "PGRST301", message: "private" }, status: 401 }],
    ["an unknown role", { data: [{ role: "owner" }], error: null }],
    ["a malformed row", { data: [{ role: "admin" }, { user_id: "x" }], error: null }],
    ["a non-row answer", { data: { ok: true, code: "ok", ref: null }, error: null }],
    ["an empty answer", { data: null, error: null }],
  ])("a caller at aal2 with %s gets the not-found page", async (_label, answer) => {
    mocks.roles.mockResolvedValue(answer);
    await expect(Dashboard()).rejects.toThrow("NOT_FOUND");
    expect(mocks.roles).toHaveBeenCalledOnce();
  });
  it("a thrown roles call gets the not-found page", async () => {
    mocks.roles.mockRejectedValue(new Error("private provider detail"));
    await expect(Dashboard()).rejects.toThrow("NOT_FOUND");
  });
  it("a deleted staff member is refused before the roles are read", async () => {
    mocks.account.mockResolvedValue({ data: [{ account_status: "deleted" }], error: null });
    render(await Dashboard());
    expect(screen.getByRole("alert")).toHaveTextContent("現在表示できません。時間をおいて再度お試しください。");
    expect(linkNames()).toEqual([]);
    expect(mocks.roles).not.toHaveBeenCalled();
  });
});

describe("demo admin stays unchanged", () => {
  it.each(pages)("%s renders its existing component with the provider", async (_path, Page) => {
    mocks.mode.mockReturnValue("demo");
    const element = AdminLayout({ children: await Page() });
    expect(element).toHaveProperty("type", AdminProvider);
    render(element);
    expect(screen.getByRole("main")).toHaveTextContent("デモ");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("server MFA page", () => {
  it("is dynamic and unavailable in demo mode without creating a client", async () => {
    expect(dynamic).toBe("force-dynamic");
    mocks.mode.mockReturnValue("demo");
    await expect(mfaPage()).rejects.toThrow("NOT_FOUND");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("sends signed-out users to login with only the MFA return path", async () => {
    mocks.claims.mockResolvedValue({ data: null, error: null });
    await expect(mfaPage("//evil.invalid")).rejects.toThrow("REDIRECT:/login?next=%2Fadmin%2Fmfa");
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it.each([["/admin/verifications", "/admin/verifications"], ["/login", "/admin"], ["/admin/mfa/x", "/admin"], [["/admin/reports"], "/admin"]])("aal2 redirects only to sanitized next %#", async (next, expected) => {
    await expect(mfaPage(next)).rejects.toThrow(`REDIRECT:${expected}`);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it.each([[[], "enroll"], [[{ factor_type: "totp", status: "unverified" }], "enroll"], [[{ factor_type: "phone", status: "verified" }], "enroll"], [[{ factor_type: "totp", status: "verified" }], "challenge"]])("aal1 chooses a mode from the server factors %#", async (factors, mode) => {
    mocks.claims.mockResolvedValue({ data: { claims: { aal: "aal1" } }, error: null });
    mocks.list.mockResolvedValue({ data: { all: factors }, error: null });
    const element = await mfaPage("/admin/reports");
    expect(element.type).toBe(AdminMfa);
    expect(element.props).toEqual({ mode, next: "/admin/reports" });
  });
  it.each([[{ data: [{ account_status: "deleted" }], error: null }], [{ data: [], error: null }]])("aal1 refuses a deleted or unreadable account before listing factors %#", async (account) => {
    mocks.claims.mockResolvedValue({ data: { claims: { aal: "aal1" } }, error: null });
    mocks.account.mockResolvedValue(account);
    render(await mfaPage("/admin/reports"));
    expect(screen.getByRole("alert")).toHaveTextContent("現在表示できません。時間をおいて再度お試しください。");
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("lets a staff account without a profile through the account check", async () => {
    mocks.claims.mockResolvedValue({ data: { claims: { aal: "aal1" } }, error: null });
    mocks.account.mockResolvedValue({ data: [{ account_status: null }], error: null });
    expect((await mfaPage("/admin/reports")).type).toBe(AdminMfa);
  });
  it.each(["client", "claims", "list-error", "list-throw", "list-empty"])("contains %s failures", async (kind) => {
    mocks.claims.mockResolvedValue({ data: { claims: { aal: "aal1" } }, error: null });
    if (kind === "client") mocks.create.mockRejectedValue(new Error("private"));
    if (kind === "claims") mocks.claims.mockRejectedValue(new Error("private"));
    if (kind === "list-error") mocks.list.mockResolvedValue({ error: { message: "private" }, data: null });
    if (kind === "list-throw") mocks.list.mockRejectedValue(new Error("private"));
    if (kind === "list-empty") mocks.list.mockResolvedValue({ error: null, data: null });
    render(await mfaPage());
    expect(screen.getByRole("alert")).toHaveTextContent("現在表示できません。時間をおいて再度お試しください。");
  });
});
