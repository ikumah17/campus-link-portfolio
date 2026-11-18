// @vitest-environment node
import { beforeAll, afterAll, beforeEach, it, expect, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDb, asUser, user, owner } from "./db/harness";
import { createMasters, createUser, connect, type Masters } from "./db/fixtures";
const m = vi.hoisted(() => ({ create: vi.fn(), signOut: vi.fn(), redirect: vi.fn((path: string) => { throw Error("redirect:" + path); }) }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: () => "supabase" }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: m.create }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: m.redirect }));
import { deleteAccount, pauseAccount, resumeAccount } from "@/server/account-actions";
import { loadAccountState } from "@/server/account-data";
import { profileGate } from "@/server/profile-gate";
import { loadMyPage } from "@/server/mypage-data";
import { DELETE_CONFIRMATION } from "@/server/account-rules";
let db: PGlite, master: Masters;
const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("network"));
beforeAll(async () => { db = await freshDb(); master = await createMasters(db, "account"); }, 180000);
afterAll(async () => { expect(network).not.toHaveBeenCalled(); await db?.close(); });
beforeEach(() => { m.signOut.mockReset().mockResolvedValue({ error: null }); m.redirect.mockClear(); });
// The real migrations under the caller's own claims; table RPCs return rows, outcome RPCs one composite.
function client(id: string) {
  return {
    rpc: async (name: string) => {
      try {
        const rows = await asUser(db, user(id), `select * from public.${name}()`);
        return { data: ["my_account"].includes(name) ? rows : rows[0], error: null };
      } catch (e) { const error = e as { code: string; message: string }; return { data: null, error: { code: error.code, message: error.message } }; }
    },
    from: () => ({ select: () => ({ limit: async () => ({ data: await asUser(db, user(id), "select display_name from public.profiles limit 2"), error: null }) }) }),
    auth: { signOut: m.signOut },
  };
}
const as = (id: string) => { m.create.mockResolvedValue(client(id)); };
async function discovers(viewer: string, target: string) {
  return (await asUser<{ user_id: string }>(db, user(viewer), "select * from public.discover_profiles(p_limit => 50)")).some((r) => r.user_id === target);
}
async function talks(viewer: string, conversation: string) {
  return (await asUser<{ conversation_id: string }>(db, user(viewer), "select * from public.list_my_conversations()")).some((r) => r.conversation_id === conversation);
}

it("pause hides the account from discovery and chats, keeps the settings page reachable, and resume restores it", async () => {
  const a = await createUser(db, { cls: master.classes[0] }), b = await createUser(db, { cls: master.classes[4] }), d = await createUser(db, { cls: master.classes[4] });
  const { conversation, connection } = await connect(db, a, b);
  expect(await discovers(d, a)).toBe(true); expect(await talks(b, conversation)).toBe(true);
  as(a);
  expect(await pauseAccount()).toEqual({ status: "ok" });
  expect(await loadAccountState(client(a))).toEqual({ status: "ok", accountStatus: "deactivated" });
  expect(await profileGate(client(a))).toBe("completed");
  expect(await loadMyPage(client(a) as never)).toMatchObject({ status: "ok", page: { accountStatus: "deactivated", eligible: false } });
  for (const [viewer, target] of [[d, a], [a, d]]) expect(await discovers(viewer, target)).toBe(false);
  for (const viewer of [a, b]) expect(await talks(viewer, conversation)).toBe(false);
  expect(await owner(db, "select ended_at from public.connections where id = $1", [connection])).toEqual([{ ended_at: null }]);
  expect(await pauseAccount()).toEqual({ status: "invalid_state" });
  expect(await resumeAccount()).toEqual({ status: "ok" });
  expect(await loadAccountState(client(a))).toEqual({ status: "ok", accountStatus: "active" });
  expect(await discovers(d, a)).toBe(true); expect(await talks(b, conversation)).toBe(true);
  expect(await resumeAccount()).toEqual({ status: "invalid_state" });
  expect(m.signOut).not.toHaveBeenCalled();
}, 180000);

it("deletion needs the word, ends connections and deletes likes, signs out, and every gate then refuses the account", async () => {
  const a = await createUser(db, { cls: master.classes[0] }), b = await createUser(db, { cls: master.classes[4] }), c = await createUser(db, { cls: master.classes[4] });
  const { connection } = await connect(db, a, b);
  expect(await discovers(c, a)).toBe(true);
  await owner(db, "insert into public.likes (liker_id, liked_id) values ($1, $2), ($2, $1)", [c, a]);
  as(a);
  expect(await deleteAccount("退会")).toEqual({ status: "invalid" });
  expect(await owner(db, "select account_status from public.profiles where user_id = $1", [a])).toEqual([{ account_status: "active" }]);
  await expect(deleteAccount(DELETE_CONFIRMATION)).rejects.toThrow("redirect:/settings/account/deleted");
  expect(m.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "global" });
  expect(await owner(db, "select account_status from public.profiles where user_id = $1", [a])).toEqual([{ account_status: "deleted" }]);
  expect(await owner(db, "select ended_reason from public.connections where id = $1", [connection])).toEqual([{ ended_reason: "account_deleted" }]);
  expect(await owner(db, "select count(*)::int as n from public.likes where $1 in (liker_id, liked_id)", [a])).toEqual([{ n: 0 }]);
  expect(await discovers(c, a)).toBe(false);
  expect(await profileGate(client(a))).toBe("unavailable");
  expect(await loadMyPage(client(a) as never)).toEqual({ status: "unavailable" });
  expect(await loadAccountState(client(a))).toEqual({ status: "deleted" });
  m.signOut.mockClear();
  for (const action of [pauseAccount, resumeAccount, () => deleteAccount(DELETE_CONFIRMATION)]) expect(await action()).toEqual({ status: "forbidden" });
  expect(m.signOut).not.toHaveBeenCalled();
  // The Auth user stays for the retention job.
  expect(await owner(db, "select count(*)::int as n from auth.users where id = $1", [a])).toEqual([{ n: 1 }]);
}, 180000);

it("a suspended account cannot pause or resume but may still leave", async () => {
  const s = await createUser(db, { cls: master.classes[0], status: "suspended" });
  as(s);
  expect(await loadAccountState(client(s))).toEqual({ status: "ok", accountStatus: "suspended" });
  expect(await pauseAccount()).toEqual({ status: "forbidden" });
  expect(await resumeAccount()).toEqual({ status: "forbidden" });
  await expect(deleteAccount(DELETE_CONFIRMATION)).rejects.toThrow("redirect:/settings/account/deleted");
}, 180000);
