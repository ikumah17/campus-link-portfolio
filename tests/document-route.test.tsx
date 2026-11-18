// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ mode: vi.fn(), create: vi.fn(), user: vi.fn(), rpc: vi.fn(), account: vi.fn(), read: vi.fn(),
  synthetic: vi.fn(), service: vi.fn(), from: vi.fn(), download: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: mocks.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: mocks.create }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.service }));
vi.mock("@/lib/supabase/config", () => ({ supabasePublicConfig: () => ({ url: "https://synthetic.supabase.co" }) }));
vi.mock("@/server/storage/document-read", () => ({ readDocument: mocks.read }));
vi.mock("@/server/synthetic-documents", () => ({ syntheticDocument: mocks.synthetic }));
import { GET, dynamic } from "@/app/admin/documents/[submissionId]/[n]/route";
const actualRead = await vi.importActual<typeof import("@/server/storage/document-read")>("@/server/storage/document-read");
const actualSynthetic = await vi.importActual<typeof import("@/server/synthetic-documents")>("@/server/synthetic-documents");
const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const row = { n: 1, document_ref: "synthetic:sample-2" };
const stored = `${other}/submission/document.webp`;
// my_account (ACCOUNT-003) is its own mock, so mocks.rpc sees only the authorization RPC.
const client = { auth: { getUser: mocks.user },
  rpc: (name: string, args: Record<string, unknown>) => name === "my_account" ? mocks.account(name, args) : mocks.rpc(name, args) };
const bytes = new TextEncoder().encode("synthetic webp").buffer;
const get = (submissionId = id, n = "1") => GET(new Request(`https://campus.example/admin/documents/${encodeURIComponent(submissionId)}/${encodeURIComponent(n)}?path=ignored&bucket=ignored&document_ref=ignored`),
  { params: Promise.resolve({ submissionId, n }) });
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_fake");
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  mocks.mode.mockReturnValue("supabase"); mocks.create.mockResolvedValue(client);
  mocks.user.mockResolvedValue({ data: { user: { id: other, is_anonymous: false } }, error: null });
  mocks.rpc.mockResolvedValue({ data: [row], error: null });
  mocks.account.mockResolvedValue({ data: [{ account_status: "active" }], error: null });
  mocks.read.mockImplementation(actualRead.readDocument); mocks.synthetic.mockImplementation(actualSynthetic.syntheticDocument);
  mocks.service.mockReturnValue({ storage: { from: mocks.from } }); mocks.from.mockReturnValue({ download: mocks.download });
  mocks.download.mockResolvedValue({ data: { arrayBuffer: async () => bytes }, error: null });
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const fingerprint = async (response: Response) => ({ status: response.status, headers: [...response.headers], bytes: [...new Uint8Array(await response.arrayBuffer())] });
const denied = { status: 404, headers: [["cache-control", "no-store"]], bytes: [] };
const headers = (contentType: string) => ({ "content-type": contentType, "cache-control": "no-store",
  "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin" });
function noReaders() {
  expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.synthetic).not.toHaveBeenCalled();
  expect(mocks.service).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
}

describe("document delivery authorization per request", () => {
  it("returns the exact synthetic headers and only the authorized sample without a service key", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", undefined);
    expect(dynamic).toBe("force-dynamic");
    const response = await get();
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toEqual(headers("image/svg+xml; charset=utf-8"));
    expect(await response.text()).toBe(actualSynthetic.syntheticDocument(row.document_ref));
    expect(mocks.synthetic).toHaveBeenCalledExactlyOnceWith(row.document_ref);
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.service).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("admin_authorize_document_view", { p_id: id });
    expect(mocks.user.mock.invocationCallOrder[0]).toBeLessThan(mocks.rpc.mock.invocationCallOrder[0]);
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(mocks.synthetic.mock.invocationCallOrder[0]);
  });
  it("selects the requested integer n and delivers E-2 bytes from only the authorized reference", async () => {
    mocks.rpc.mockResolvedValue({ data: [row, { n: 3, document_ref: stored }], error: null });
    const response = await get(id, "3");
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toEqual(headers("image/webp"));
    expect(await response.arrayBuffer()).toEqual(bytes);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("admin_authorize_document_view", { p_id: id });
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(stored);
    expect(mocks.from).toHaveBeenCalledExactlyOnceWith("verification-documents");
    expect(mocks.download).toHaveBeenCalledExactlyOnceWith(stored);
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(mocks.read.mock.invocationCallOrder[0]);
  });
  it("calls the audit RPC exactly once for each request, including a repeated request after access is lost", async () => {
    expect((await get()).status).toBe(200); expect((await get()).status).toBe(200);
    mocks.rpc.mockResolvedValueOnce({ data: [], error: null });
    expect(await fingerprint(await get())).toEqual(denied);
    expect(mocks.rpc.mock.calls).toEqual(Array.from({ length: 3 }, () => ["admin_authorize_document_view", { p_id: id }]));
    expect(mocks.synthetic).toHaveBeenCalledTimes(2); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("creates no client in demo mode", async () => {
    mocks.mode.mockReturnValue("demo");
    expect(await fingerprint(await get())).toEqual(denied);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled(); noReaders();
  });
  it.each(["x", id.toUpperCase(), `${id}\n`, `../${id}`, ""])("refuses malformed submission ids %# before creating a client", async (value) => {
    expect(await fingerprint(await get(value))).toEqual(denied); expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled(); noReaders();
  });
  it.each(["0", "5", "01", "1.0", "1\n", "", "-1", "2 "])("refuses malformed n %# without an RPC", async (n) => {
    expect(await fingerprint(await get(id, n))).toEqual(denied); expect(mocks.rpc).not.toHaveBeenCalled(); noReaders();
  });
  it.each([
    { data: { user: null }, error: null },
    { data: { user: { is_anonymous: true } }, error: null },
    { data: { user: {} }, error: null },
    { data: { user: { is_anonymous: false } }, error: { message: "private" } },
  ])("refuses missing, anonymous or invalid sessions identically %#", async (result) => {
    mocks.user.mockResolvedValue(result);
    expect(await fingerprint(await get())).toEqual(denied); expect(mocks.rpc).not.toHaveBeenCalled(); noReaders();
  });
  it.each([
    { data: [], error: null }, { data: [null], error: null },
    { data: [{ ...row, n: 2 }], error: null }, { data: [{ ...row, n: "1" }], error: null },
    { data: [row, row], error: null }, { data: [row, { n: 1 }], error: null },
    { data: [{ n: 1 }], error: null }, { data: [{ n: 1, document_ref: null }], error: null },
    { data: { ok: true, code: "ok", ref: id }, error: null },
    { data: null, error: { code: "P0001", message: "forbidden" } }, // no role or aal1
    { data: [row], error: { message: "private" } }, { data: [row], error: null, status: 500 },
    { data: null, error: { status: 401 } },
  ])("never reads without one authorized matching row %#", async (result) => {
    mocks.rpc.mockResolvedValue(result);
    expect(await fingerprint(await get())).toEqual(denied); expect(mocks.rpc).toHaveBeenCalledTimes(1); noReaders();
  });
  it.each(["synthetic:sample-4", "synthetic:sample-1\n", "../secret", `${other}/../secret.webp`, "unrecognised"])("refuses unrecognized references %# without Storage", async (document_ref) => {
    mocks.rpc.mockResolvedValue({ data: [{ n: 1, document_ref }], error: null });
    expect(await fingerprint(await get())).toEqual(denied);
    expect(mocks.service).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  });
  it.each(["create", "user", "rpc", "read"] as const)("uses the identical refusal for a thrown %s error without logging", async (operation) => {
    const log = vi.spyOn(console, "error"); const warn = vi.spyOn(console, "warn");
    if (operation === "read") mocks.rpc.mockResolvedValue({ data: [{ n: 1, document_ref: stored }], error: null });
    mocks[operation].mockRejectedValue(new Error("private provider error"));
    expect(await fingerprint(await get())).toEqual(denied);
    expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
    if (operation !== "read") noReaders();
  });
  it.each([null, "active", "deactivated", "suspended"])("reads the caller's own account before authorizing (status %s, null: staff without a profile)", async (status) => {
    mocks.account.mockResolvedValue({ data: [{ account_status: status }], error: null });
    expect((await get()).status).toBe(200);
    expect(mocks.account).toHaveBeenCalledExactlyOnceWith("my_account", {});
    expect(mocks.user.mock.invocationCallOrder[0]).toBeLessThan(mocks.account.mock.invocationCallOrder[0]);
    expect(mocks.account.mock.invocationCallOrder[0]).toBeLessThan(mocks.rpc.mock.invocationCallOrder[0]);
  });
  it("refuses a deleted staff account identically, before the authorization RPC and any read (ACCOUNT-003)", async () => {
    mocks.account.mockResolvedValue({ data: [{ account_status: "deleted" }], error: null });
    expect(await fingerprint(await get())).toEqual(denied);
    expect(mocks.rpc).not.toHaveBeenCalled(); noReaders();
  });
  it.each([
    { data: [], error: null }, { data: [{ account_status: "active" }, { account_status: "active" }], error: null },
    { data: [{}], error: null }, { data: [null], error: null }, { data: null, error: { code: "P0001", message: "forbidden" } },
    { data: null, error: { message: "private" } }, { data: null, error: { status: 401 } }, "throw",
  ])("fails closed when the caller's account cannot be read %#", async (result) => {
    if (result === "throw") mocks.account.mockRejectedValue(new Error("private provider error"));
    else mocks.account.mockResolvedValue(result);
    expect(await fingerprint(await get())).toEqual(denied);
    expect(mocks.rpc).not.toHaveBeenCalled(); noReaders();
  });
  it("uses the identical refusal for download failure", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ n: 1, document_ref: stored }], error: null });
    mocks.download.mockResolvedValue({ data: null, error: { message: "private" } });
    expect(await fingerprint(await get())).toEqual(denied);
  });
});
