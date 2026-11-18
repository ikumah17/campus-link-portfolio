// @vitest-environment node
// MOD-001: the report detail's photo route authorizes every request through admin_authorize_report_photo (order 33).
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ mode: vi.fn(), create: vi.fn(), user: vi.fn(), rpc: vi.fn(), account: vi.fn(), service: vi.fn(), from: vi.fn(), download: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: mocks.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: mocks.create }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.service }));
vi.mock("@/lib/supabase/config", () => ({ supabasePublicConfig: () => ({ url: "https://synthetic.supabase.co" }) }));
import { GET, dynamic } from "@/app/admin/reports/[id]/photos/[photoId]/route";
const report = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", owner = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", photo = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const client = { auth: { getUser: mocks.user },
  rpc: (name: string, args: Record<string, unknown>) => name === "my_account" ? mocks.account(name, args) : mocks.rpc(name, args) };
const bytes = new TextEncoder().encode("synthetic webp").buffer;
const get = (id = report, photoId = photo) => GET(new Request(`https://campus.example/admin/reports/${encodeURIComponent(id)}/photos/${encodeURIComponent(photoId)}?path=ignored`),
  { params: Promise.resolve({ id, photoId }) });
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_fake");
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  mocks.mode.mockReturnValue("supabase"); mocks.create.mockResolvedValue(client);
  mocks.user.mockResolvedValue({ data: { user: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", is_anonymous: false } }, error: null });
  mocks.account.mockResolvedValue({ data: [{ account_status: "active" }], error: null });
  mocks.rpc.mockResolvedValue({ data: [{ photo_id: photo, storage_path: `${owner}/${photo}.webp` }], error: null });
  mocks.service.mockReturnValue({ storage: { from: mocks.from } }); mocks.from.mockReturnValue({ download: mocks.download });
  mocks.download.mockResolvedValue({ data: { arrayBuffer: async () => bytes }, error: null });
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const refused = async (response: Response) => {
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.arrayBuffer()).byteLength).toBe(0);
};

it("serves an authorized photo uncached with only the stored path, after the per-request RPC", async () => {
  expect(dynamic).toBe("force-dynamic");
  const response = await get();
  expect(response.status).toBe(200);
  expect(Object.fromEntries(response.headers)).toEqual({ "content-type": "image/webp", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin" });
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("admin_authorize_report_photo", { p_id: report, p_photo: photo });
  expect(mocks.from).toHaveBeenCalledWith("profile-photos");
  expect(mocks.download).toHaveBeenCalledExactlyOnceWith(`${owner}/${photo}.webp`);
});

it("refuses bad ids, demo, anonymous, deleted staff and any unauthorized or malformed answer before storage", async () => {
  for (const [id, photoId] of [["bad", photo], [report, "bad"], [report.toUpperCase(), photo], [report, `${photo}\n`]]) await refused(await get(id, photoId));
  expect(mocks.create).not.toHaveBeenCalled();
  mocks.mode.mockReturnValue("demo"); await refused(await get()); mocks.mode.mockReturnValue("supabase");
  mocks.user.mockResolvedValueOnce({ data: { user: { id: owner, is_anonymous: true } }, error: null }); await refused(await get());
  mocks.account.mockResolvedValueOnce({ data: [{ account_status: "deleted" }], error: null }); await refused(await get());
  for (const data of [[], [{ photo_id: report, storage_path: `${owner}/${photo}.webp` }], [{ photo_id: photo, storage_path: "../x.webp" }], [{ photo_id: photo }], null]) {
    mocks.rpc.mockResolvedValueOnce({ data, error: null }); await refused(await get());
  }
  mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "forbidden" } }); await refused(await get());
  mocks.rpc.mockResolvedValueOnce({ data: [{ photo_id: photo, storage_path: `${owner}/${photo}.webp` }, { photo_id: photo, storage_path: `${owner}/${photo}.webp` }], error: null });
  await refused(await get());
  expect(mocks.download).not.toHaveBeenCalled();
  mocks.download.mockResolvedValueOnce({ data: null, error: { message: "missing" } }); await refused(await get());
  mocks.create.mockRejectedValueOnce(Error("secret")); await refused(await get());
});
