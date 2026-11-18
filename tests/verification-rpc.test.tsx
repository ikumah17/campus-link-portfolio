// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, expect, it, vi } from "vitest";
import { createUser } from "./db/fixtures";
import { asUser, freshDb, user, rpc } from "./db/harness";
const m = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: () => "supabase" }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: m.create }));
import { submitVerification, withdrawVerification } from "@/server/verification-actions";
import { loadMyVerification } from "@/server/verification-data";
let db: PGlite;
afterAll(async () => { await db?.close(); vi.restoreAllMocks(); });
it("uses real authenticated grants, RLS, submit and withdraw", async () => {
 const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("forbidden"));
 db = await freshDb(); const me = await createUser(db, { ageVerified: false }); const other = await createUser(db, { ageVerified: false });
 const foreign = await rpc(db, user(other), "submit_verification", ["age", ["synthetic:sample-1"]], ["public.verification_kind", "text[]"]);
 const client = {
 rpc: async (name: string, args: Record<string, unknown>) => ({ data: name === "my_account" ? await asUser(db, user(me), "select * from public.my_account()") : await rpc(db, user(me), name, name === "submit_verification" ? [args.p_kind, args.p_document_refs] : [args.p_id], name === "submit_verification" ? ["public.verification_kind", "text[]"] : ["uuid"]), error: null }),
 from: (table: string) => ({ select: (columns: string) => ({ order: async () => ({ data: JSON.parse(JSON.stringify(await asUser(db, user(me), `select ${columns} from public.${table} order by created_at desc`))), error: null }) }) })
 };
 m.create.mockResolvedValue(client);
 expect(await submitVerification("age", ["synthetic:sample-1"])).toEqual({ status: "ok" });
 const state = await loadMyVerification(client); expect(state.status).toBe("ok"); if(state.status !== "ok") throw new Error("failed load"); expect(state.age?.status).toBe("submitted"); expect(state.age?.id).not.toBe(foreign.ref); expect(JSON.stringify(state)).not.toContain("birth_date");
 expect(await withdrawVerification(foreign.ref)).toEqual({ status: "invalid_state" });
 expect(await withdrawVerification(state.age?.id)).toEqual({ status: "ok" });
 const next = await loadMyVerification(client); if(next.status !== "ok") throw new Error("failed reload"); expect(next.age?.status).toBe("withdrawn"); expect(fetchSpy).not.toHaveBeenCalled();
}, 120_000);
