// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminAccountUsable, adminNextPath, adminSession, callerStaffRoles, requireAdminSession } from "@/server/admin-gate";

const mocks = vi.hoisted(() => ({ create: vi.fn(), claims: vi.fn(), session: vi.fn(), redirect: vi.fn(), rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: mocks.create }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
const client = { auth: { getClaims: mocks.claims, getSession: mocks.session }, rpc: mocks.rpc };
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  mocks.create.mockResolvedValue(client);
  mocks.claims.mockResolvedValue({ data: { claims: { aal: "aal2" } }, error: null });
  mocks.redirect.mockImplementation((path: string) => { throw new Error(`REDIRECT:${path}`); });
  mocks.rpc.mockResolvedValue({ data: [{ account_status: "active" }], error: null });
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); expect(mocks.session).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

describe("verified session screen gate", () => {
  it.each([
    [{ aal: "aal2" }, "aal2"], [{ aal: "aal1" }, "needs_mfa"],
    [{ aal: "aal2", is_anonymous: true }, "unauthenticated"],
    [{}, "unavailable"], [{ aal: "aal3" }, "unavailable"],
  ])("maps claims %#", async (claims, expected) => {
    mocks.claims.mockResolvedValue({ data: { claims }, error: null });
    expect(await adminSession(client as never)).toBe(expected);
    expect(mocks.claims).toHaveBeenCalledWith();
  });
  it.each([null, {}])("handles missing claims %#", async (data) => {
    mocks.claims.mockResolvedValue({ data, error: null });
    expect(await adminSession(client as never)).toBe("unauthenticated");
  });
  it.each([
    [{ name: "AuthSessionMissingError" }, "unauthenticated"],
    [{ code: "session_not_found" }, "unauthenticated"],
    [{ code: "session_expired" }, "unauthenticated"],
    [{ code: "refresh_token_not_found" }, "unauthenticated"],
    [{ code: "refresh_token_already_used" }, "unauthenticated"],
    [{ code: "bad_jwt" }, "unavailable"], [{ status: 503 }, "unavailable"],
  ])("fails closed for error %#", async (error, expected) => {
    mocks.claims.mockResolvedValue({ data: null, error });
    expect(await adminSession(client as never)).toBe(expected);
  });
  it("handles thrown errors without logging", async () => {
    const log = vi.spyOn(console, "error");
    mocks.claims.mockRejectedValue(new Error("private provider detail"));
    expect(await adminSession(client as never)).toBe("unavailable");
    expect(log).not.toHaveBeenCalled();
  });
  it.each([
    [null, "/login?next=%2Fadmin%2Fverifications"],
    [{ aal: "aal1" }, "/admin/mfa?next=%2Fadmin%2Fverifications"],
  ])("redirects the page for %#", async (claims, target) => {
    mocks.claims.mockResolvedValue({ data: claims ? { claims } : null, error: null });
    await expect(requireAdminSession("/admin/verifications")).rejects.toThrow(`REDIRECT:${target}`);
  });
  it("returns only the aal2 client, or null on either kind of outage", async () => {
    expect(await requireAdminSession("/admin")).toBe(client);
    mocks.claims.mockResolvedValue({ data: { claims: {} }, error: null });
    expect(await requireAdminSession("/admin")).toBeNull();
    mocks.create.mockRejectedValue(new Error("private"));
    expect(await requireAdminSession("/admin")).toBeNull();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe("deleted account at the admin gate", () => {
  it.each([
    [{ data: [{ account_status: "active" }], error: null }, true],
    [{ data: [{ account_status: "deactivated" }], error: null }, true],
    [{ data: [{ account_status: "suspended" }], error: null }, true],
    [{ data: [{ account_status: null }], error: null }, true],
    [{ data: [{ account_status: "deleted" }], error: null }, false],
    [{ data: [], error: null }, false],
    [{ data: [{}], error: null }, false],
    [{ data: [{ account_status: "active" }, { account_status: "active" }], error: null }, false],
    [{ data: null, error: { code: "P0001", message: "forbidden" } }, false],
    [{ data: null, error: { code: "PGRST301", message: "private" } }, false],
  ])("reads my_account once and fails closed %#", async (result, usable) => {
    mocks.rpc.mockResolvedValue(result);
    expect(await adminAccountUsable(client as never)).toBe(usable);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("my_account", {});
  });
  it("returns no client for a deleted account at aal2, and does not ask at aal1 or signed out", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ account_status: "deleted" }], error: null });
    expect(await requireAdminSession("/admin")).toBeNull();
    mocks.rpc.mockRejectedValue(new Error("private"));
    expect(await requireAdminSession("/admin")).toBeNull();
    mocks.rpc.mockClear();
    mocks.claims.mockResolvedValue({ data: { claims: { aal: "aal1" } }, error: null });
    await expect(requireAdminSession("/admin")).rejects.toThrow("REDIRECT:/admin/mfa?next=%2Fadmin");
    mocks.claims.mockResolvedValue({ data: null, error: null });
    await expect(requireAdminSession("/admin")).rejects.toThrow("REDIRECT:/login?next=%2Fadmin");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("the caller's own staff roles", () => {
  it.each([
    [{ data: [{ role: "admin" }], error: null }, ["admin"]],
    [{ data: [{ role: "reviewer" }, { role: "moderator" }, { role: "admin" }], error: null }, ["reviewer", "moderator", "admin"]],
    [{ data: [{ role: "reviewer" }, { role: "reviewer" }], error: null }, ["reviewer"]],
    [{ data: [], error: null }, []],
    [{ data: [{ role: "owner" }], error: null }, null],
    [{ data: [{ role: "admin" }, {}], error: null }, null],
    [{ data: [null], error: null }, null],
    [{ data: [{ role: ["admin"] }], error: null }, null],
    [{ data: { ok: true, code: "ok", ref: null }, error: null }, null],
    [{ data: null, error: null }, null],
    [{ data: null, error: { code: "P0001", message: "forbidden" } }, null],
    [{ data: null, error: { code: "PGRST202", message: "private" }, status: 404 }, null],
    [{ data: null, error: { code: "PGRST301", message: "private" } }, null],
  ])("reads my_staff_roles once and fails closed %#", async (result, roles) => {
    mocks.rpc.mockResolvedValue(result);
    expect(await callerStaffRoles(client as never)).toEqual(roles);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("my_staff_roles", {});
  });
  it("is null when the call throws", async () => {
    mocks.rpc.mockRejectedValue(new Error("private"));
    expect(await callerStaffRoles(client as never)).toBeNull();
  });
});

describe("admin destinations", () => {
  it.each(["/admin", "/admin/verifications", "/admin/reports?filter=open#top"])("accepts %s", (raw) => {
    expect(adminNextPath(raw)).toBe(raw);
  });
  it.each([undefined, ["/admin"], "//x", "/adminx", "/login", "/admin/mfa", "/admin/mfa/", "/admin/mfa/x", "/admin/mfa?next=/admin", "/admin/mfa#x", "/admin/../login", "/admin/x/../mfa", "/admin/%2e%2e/login", "/admin/%6dfa", "/admin/%256dfa/x", "/admin/%2f..%2f..%2flogin", "/admin/%5cevil", "/admin/%zz", "/admin/has space"])("rejects unsafe destination %#", (raw) => {
    expect(adminNextPath(raw)).toBe("/admin");
  });
});
