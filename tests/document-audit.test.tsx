// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createStaff, createUser } from "./db/fixtures";
import { asUser, freshDb, owner, rpc, staff, type Session } from "./db/harness";

const mocks = vi.hoisted(() => ({ create: vi.fn(), service: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: () => "supabase" }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: mocks.create }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.service }));
import { GET } from "@/app/admin/documents/[submissionId]/[n]/route";

let db: PGlite;
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeAll(async () => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  db = await freshDb();
}, 180_000);
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); expect(mocks.service).not.toHaveBeenCalled(); });
afterAll(async () => { await db?.close(); vi.restoreAllMocks(); });

it("audits each authorized route request with the caller's real aal2 session and refuses after release", async () => {
  const student = await createUser(db, { completed: false, ageVerified: false, photos: 0 });
  const assigned = await createStaff(db, ["reviewer"]);
  const different = await createStaff(db, ["reviewer"]);
  const noRole = await createStaff(db, []);
  const submitted = await rpc(db, { sub: student }, "submit_verification", ["age", ["synthetic:sample-3"]],
    ["public.verification_kind", "text[]"]);
  expect(submitted.code).toBe("ok");
  const id = submitted.ref!;
  expect((await rpc(db, staff(assigned), "admin_claim_submission", [id])).code).toBe("ok");
  let session: Session = staff(assigned);
  const sessionRpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    expect(name).toBe("admin_authorize_document_view"); expect(args).toEqual({ p_id: id });
    try {
      return { data: await asUser(db, session, "select * from public.admin_authorize_document_view($1)", [args.p_id]), error: null };
    } catch (error) {
      return { data: null, error: { code: (error as { code?: string }).code, message: (error as Error).message } };
    }
  });
  // ACCOUNT-003: the route reads the caller's own my_account first, from the same real database.
  const accountRpc = vi.fn(async () => ({ data: await asUser(db, session, "select * from public.my_account()"), error: null }));
  mocks.create.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: session.sub, is_anonymous: false } }, error: null }) },
    rpc: (name: string, args: Record<string, unknown>) => name === "my_account" ? accountRpc() : sessionRpc(name, args),
  });
  const get = (n = "1") => GET(new Request(`https://campus.example/admin/documents/${id}/${n}`),
    { params: Promise.resolve({ submissionId: id, n }) });
  const audit = () => owner<{ actor: string; target: string }>(db,
    "select actor_id::text as actor, target_id as target from private.audit_log where action = 'authorize_document_view' order by id");
  const expected: { actor: string; target: string }[] = [];
  for (let i = 0; i < 2; i++) {
    const response = await get();
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain("架空のサンプル資料 3");
    expected.push({ actor: assigned, target: id });
    expect(await audit()).toEqual(expected);
    expect(sessionRpc).toHaveBeenCalledTimes(i + 1);
  }
  for (const deniedSession of [staff(different), { sub: assigned, aal: "aal1" } as Session, staff(noRole)]) {
    session = deniedSession;
    const response = await get();
    expect(response.status).toBe(404); expect([...response.headers]).toEqual([["cache-control", "no-store"]]);
    expect(await response.text()).toBe(""); expect(await audit()).toEqual(expected);
  }
  session = staff(assigned);
  // Authorization is still audited when the assigned reviewer requests a missing document number.
  expect((await get("4")).status).toBe(404);
  expected.push({ actor: assigned, target: id }); expect(await audit()).toEqual(expected);
  expect((await rpc(db, staff(assigned), "admin_release_submission", [id])).code).toBe("ok");
  const released = await get();
  expect(released.status).toBe(404); expect([...released.headers]).toEqual([["cache-control", "no-store"]]);
  expect(await released.text()).toBe(""); expect(await audit()).toEqual(expected);
  expect(sessionRpc).toHaveBeenCalledTimes(7);
  expect(accountRpc).toHaveBeenCalledTimes(7);
  // A deleted staff account (its Auth user and role kept until retention) is refused before authorization, unaudited.
  expect((await rpc(db, staff(different), "admin_claim_submission", [id])).code).toBe("ok");
  await owner(db, "insert into public.profiles (user_id, display_name, gender, account_status, deleted_at) values ($1, '架空', 'other', 'deleted', now())", [different]);
  session = staff(different);
  const gone = await get();
  expect(gone.status).toBe(404); expect([...gone.headers]).toEqual([["cache-control", "no-store"]]);
  expect(await gone.text()).toBe(""); expect(await audit()).toEqual(expected);
  expect(sessionRpc).toHaveBeenCalledTimes(7);
}, 120_000);
