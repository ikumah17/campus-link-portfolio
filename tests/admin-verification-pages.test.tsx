import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ mode: vi.fn(), create: vi.fn(), claims: vi.fn(), rpc: vi.fn(), push: vi.fn(), refresh: vi.fn(), redirect: vi.fn(), notFound: vi.fn(), account: vi.fn() }));
// my_account answers the deleted-account check; m.rpc sees only the page RPCs.
const rpc = (name: string, args: unknown) => name === "my_account" ? m.account() : m.rpc(name, args);
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: m.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: m.create }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: m.push, refresh: m.refresh }), redirect: m.redirect, notFound: m.notFound }));
import * as verificationData from "@/server/admin-verifications";
import ListPage, { dynamic as listDynamic } from "@/app/admin/verifications/page";
import DetailPage, { dynamic as detailDynamic } from "@/app/admin/verifications/[id]/page";
import { AdminProvider } from "@/lib/admin-demo";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", me = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const detail = { id, user_id: me, kind: "age", status: "in_review", version: 1, created_at: "2026-11-06T00:00:00Z", birth_date: "2000-01-01", school_name: null, department_name: null, class_name: null, document_refs: ["synthetic:sample-1"] };
const listPage = (query: { status?: string | string[]; notice?: string | string[] } = {}) => ListPage({ searchParams: Promise.resolve(query) });
const detailPage = (value = id) => DetailPage({ params: Promise.resolve({ id: value }) });
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks(); fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  m.mode.mockReturnValue("supabase"); m.create.mockResolvedValue({ auth: { getClaims: m.claims }, rpc });
  m.account.mockResolvedValue({ data: [{ account_status: "active" }], error: null });
  m.claims.mockResolvedValue({ data: { claims: { sub: me, aal: "aal2" } }, error: null }); m.rpc.mockResolvedValue({ data: [], error: null });
  m.redirect.mockImplementation((path: string) => { throw new Error(`REDIRECT:${path}`); }); m.notFound.mockImplementation(() => { throw new Error("NOT_FOUND"); });
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
it("is dynamic and calls the audit-writing list only once", async () => {
  expect(listDynamic).toBe("force-dynamic"); expect(detailDynamic).toBe("force-dynamic");
  render(await listPage()); expect(screen.getByText("この状態の提出はありません。")).toBeInTheDocument();
  expect(m.rpc).toHaveBeenCalledExactlyOnceWith("admin_list_submissions", { p_status: "submitted" });
});
it.each(["bad", "withdrawn", ["approved"]])("falls back to submitted for status %#", async status => {
  await listPage({ status }); expect(m.rpc).toHaveBeenCalledExactlyOnceWith("admin_list_submissions", { p_status: "submitted" });
});
it.each(["submitted", "in_review", "approved", "rejected", "revoked"])("passes filter %s once", async status => { await listPage({ status }); expect(m.rpc).toHaveBeenCalledExactlyOnceWith("admin_list_submissions", { p_status: status }); });
it("uses verified claims for identity and fixed notices only", async () => {
  const spy = vi.spyOn(verificationData, "listSubmissions");
  m.rpc.mockResolvedValue({ data: [{ id, user_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", kind: "age", status: "in_review", reviewer_id: me, claimed_at: null, version: 1, created_at: detail.created_at }], error: null });
  const element = await listPage({ status: "in_review", notice: "<provider detail>" });
  expect(spy).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ rpc }), "in_review", me);
  expect(element.props).not.toHaveProperty("currentUserId");
  expect(JSON.stringify(element.props)).not.toMatch(/user_id|reviewer_id|claimed_at/);
  expect(JSON.stringify(element.props)).not.toContain(me);
  expect(JSON.stringify(element.props)).not.toContain("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  expect(element.props.submissions[0].assignedToMe).toBe(true);
  expect(element.props.notice).toBeNull();
});
it.each(["decided", "released"])("allows only fixed notice %s", async notice => {
  render(await listPage({ notice })); expect(screen.getByRole("status")).toHaveTextContent(notice === "decided" ? "審査結果を保存しました。" : "担当を外しました。");
});
it.each(["list", "detail"])("%s routes aal1 to MFA before RPC", async page => {
  m.claims.mockResolvedValue({ data: { claims: { sub: me, aal: "aal1" } }, error: null });
  const path = page === "list" ? "/admin/verifications" : `/admin/verifications/${id}`;
  await expect(page === "list" ? listPage() : detailPage()).rejects.toThrow(`REDIRECT:/admin/mfa?next=${encodeURIComponent(path)}`); expect(m.rpc).not.toHaveBeenCalled();
});
it.each(["list", "detail"])("%s hides forbidden RPCs", async page => {
  m.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "forbidden" } }); await expect(page === "list" ? listPage() : detailPage()).rejects.toThrow("NOT_FOUND");
});
it("null detail gives notFound; valid detail is fetched once without raw refs", async () => {
  await expect(detailPage()).rejects.toThrow("NOT_FOUND"); m.rpc.mockClear(); m.rpc.mockResolvedValue({ data: [detail], error: null });
  const element = await detailPage(); expect(JSON.stringify(element.props)).not.toContain("synthetic:sample-1"); expect(m.rpc).toHaveBeenCalledExactlyOnceWith("admin_get_submission", { p_id: id });
});
it.each(["bad", id.toUpperCase(), `${id}\n`])("bad id does not call RPC %#", async value => {
  await expect(detailPage(value)).rejects.toThrow("NOT_FOUND"); expect(m.rpc).not.toHaveBeenCalled(); expect(m.create).not.toHaveBeenCalled();
});
it.each(["list", "detail"])("%s redirects expired RPC session", async page => {
  m.rpc.mockResolvedValue({ data: null, error: { code: "PGRST301", message: "private" } });
  const path = page === "list" ? "/admin/verifications" : `/admin/verifications/${id}`;
  await expect(page === "list" ? listPage() : detailPage()).rejects.toThrow(`REDIRECT:/login?next=${encodeURIComponent(path)}`);
});
it.each(["list", "detail"])("%s contains outages", async page => {
  m.rpc.mockRejectedValue(new Error("private provider")); render(await (page === "list" ? listPage() : detailPage())); expect(screen.getByRole("alert")).toHaveTextContent("現在表示できません。"); expect(screen.getByRole("alert")).not.toHaveTextContent("private");
});
it.each(["list", "detail"])("%s contains client failures", async page => {
  m.create.mockRejectedValue(new Error("private")); render(await (page === "list" ? listPage() : detailPage())); expect(screen.getByRole("alert")).toHaveTextContent("現在表示できません。"); expect(m.rpc).not.toHaveBeenCalled();
});
it("refuses missing verified identity before list RPC", async () => {
  m.claims.mockResolvedValue({ data: { claims: { aal: "aal2" } }, error: null }); render(await listPage()); expect(screen.getByRole("alert")).toBeInTheDocument(); expect(m.rpc).not.toHaveBeenCalled();
});
it("keeps demo list and refuses demo detail without clients", async () => {
  m.mode.mockReturnValue("demo"); render(<AdminProvider>{await listPage()}</AdminProvider>); expect(screen.getByRole("main")).toHaveTextContent("デモ");
  await expect(detailPage()).rejects.toThrow("NOT_FOUND"); expect(m.create).not.toHaveBeenCalled();
});
