// @vitest-environment node
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDb, asUser, user } from "./db/harness";
import { createMasters, createUser } from "./db/fixtures";
vi.mock("server-only", () => ({}));
import { loadMyPage } from "@/server/mypage-data";
let db: PGlite;
const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("network"));
beforeAll(async () => { db = await freshDb(); }, 180000);
afterAll(async () => { expect(network).not.toHaveBeenCalled(); await db?.close(); });
function client(id: string) {
  return { rpc: async () => ({ data: await asUser(db, user(id), "select * from public.my_account()"), error: null }), from: () => ({ select: () => ({ limit: async () => ({ data: await asUser(db, user(id), "select display_name from public.profiles limit 2"), error: null }) }) }) } as never;
}
it("reads each real session's own name and account status under RLS", async () => {
  const master = await createMasters(db, "mypage");
  for (const [name, spec, expected] of [
    ["Verified", {}, { ageVerified: true, affiliation: "confirmed", eligible: true, accountStatus: "active" }],
    ["Unverified", { ageVerified: false, affiliation: "unconfirmed" as const }, { ageVerified: false, affiliation: "unconfirmed", eligible: false, accountStatus: "active" }],
    ["Suspended", { status: "suspended" as const }, { ageVerified: true, affiliation: "confirmed", eligible: false, accountStatus: "suspended" }],
  ] as const) {
    const id = await createUser(db, { cls: master.classes[0], displayName: name, ...spec });
    expect(await loadMyPage(client(id))).toEqual({ status: "ok", page: { name, ...expected } });
  }
}, 180000);
