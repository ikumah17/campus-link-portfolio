// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createUser } from "./db/fixtures";
import { asRole, asUser, freshDb, owner, rpc, user, type Outcome } from "./db/harness";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: () => "supabase" }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: mocks.create }));
import { refreshOnboardingPhotos } from "@/server/onboarding-actions";

let db: PGlite;
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeAll(async () => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  db = await freshDb();
}, 180_000);
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); });
afterAll(async () => { await db?.close(); vi.restoreAllMocks(); });

it("reads the real persisted order after remove_photo leaves a gap and service_register_photo fills it", async () => {
  const me = await createUser(db, { completed: false, photos: 0 });
  const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const c = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const register = async (id: string) => {
    expect((await asRole<Outcome>(db, "service_role", null,
      "select * from public.service_register_photo($1, $2)", [me, `${me}/${id}.webp`]))[0])
      .toEqual({ ok: true, code: "ok", ref: id });
  };
  // Exercise the real listMyPhotos through its session-client query boundary.
  const order = vi.fn(async () => ({
    data: await asUser(db, user(me), "select id, position from public.profile_photos where status = 'active' order by position"),
    error: null,
  }));
  const eq = vi.fn(() => ({ order }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  mocks.create.mockResolvedValue({ from });
  const persisted = async () => (await owner<{ id: string; position: number }>(db,
    "select id, position from public.profile_photos where user_id = $1 and status = 'active' order by position", [me]));

  await register(a); await register(b);
  expect(await refreshOnboardingPhotos()).toEqual([a, b]);
  expect((await rpc(db, user(me), "remove_photo", [a])).code).toBe("ok");
  expect(await persisted()).toEqual([{ id: b, position: 1 }]);
  await register(c);
  expect(await persisted()).toEqual([{ id: c, position: 0 }, { id: b, position: 1 }]);
  expect(await refreshOnboardingPhotos()).toEqual((await persisted()).map(({ id }) => id));
  expect(from).toHaveBeenCalledWith("profile_photos");
  expect(select).toHaveBeenCalledWith("id,position");
  expect(eq).toHaveBeenCalledWith("status", "active");
  expect(order).toHaveBeenCalledWith("position");
}, 120_000);
