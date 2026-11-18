// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, fingerprint, freshDb, owner, raised, rpc, rpcRows, staff, user } from "./db/harness";
import { connect, createMasters, createStaff, createUser, type Masters } from "./db/fixtures";

// ACCOUNT-002 DB audit, updated for ACCOUNT-003 (order 17): what the real migrations give a deleted caller whose
// Auth user still exists before the retention sweep. Since order 17 the caller itself is refused everywhere but
// my_account; tests/db/deleted-account.test.ts compares every probe before and after order 17.
let db: PGlite, master: Masters;
let me: string, other: string, photo: string, otherPhoto: string, conversation: string, submission: string;
beforeAll(async () => {
  db = await freshDb(); master = await createMasters(db, "deleted");
  me = await createUser(db, { cls: master.classes[0] }); other = await createUser(db, { cls: master.classes[4] });
  ({ conversation } = await connect(db, me, other));
  await owner(db, "insert into public.blocks (blocker_id, blocked_id, blocked_name_snapshot) values ($1, $2, '架空')", [me, await createUser(db, { cls: master.classes[4] })]);
  await owner(db, "insert into public.reports (reporter_id, target_user_id, context, reason) values ($1, $2, 'profile', 'spam')", [me, other]);
  [{ id: photo }] = await owner<{ id: string }>(db, "select id from public.profile_photos where user_id = $1", [me]);
  [{ id: otherPhoto }] = await owner<{ id: string }>(db, "select id from public.profile_photos where user_id = $1", [other]);
  [{ id: submission }] = await owner<{ id: string }>(db, "select id from public.verification_submissions where user_id = $1 limit 1", [me]);
  expect(await rpc(db, user(me), "request_account_deletion")).toMatchObject({ ok: true });
}, 180000);
afterAll(async () => { await db?.close(); });

const writes: [string, unknown[], string[]?][] = [
  ["update_birth_date", ["2001-01-01"], ["date"]],
  ["update_profile", ["架空", "female", "", [], []], ["text", "text", "text", "text[]", "text[]"]],
  ["complete_profile", []],
  ["remove_photo", [], []],
  ["reorder_photos", [], []],
  ["submit_verification", ["age", ["synthetic:sample-1"]], ["public.verification_kind", "text[]"]],
  ["withdraw_verification", [], []],
  ["update_privacy_settings", [true, false, false, false, false, [], [], []], ["boolean", "boolean", "boolean", "boolean", "boolean", "uuid[]", "uuid[]", "uuid[]"]],
  ["deactivate_account", []], ["reactivate_account", []], ["request_account_deletion", []],
  ["like_user", ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"], ["uuid"]],
  ["unlike_user", ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"], ["uuid"]],
  ["end_connection", ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"], ["uuid"]],
  ["block_user", [], []], ["unblock_user", [], []],
  ["submit_report", [], []],
];

it("every write that checks private.require_account raises forbidden for a deleted caller, and changes nothing", async () => {
  const args: Record<string, [unknown[], string[]]> = {
    set_affiliation: [[master.classes[1].schoolId, master.classes[1].departmentId, master.classes[1].id], ["uuid", "uuid", "uuid"]],
    remove_photo: [[photo], ["uuid"]], reorder_photos: [[[photo]], ["uuid[]"]], withdraw_verification: [[submission], ["uuid"]],
    block_user: [[other], ["uuid"]], unblock_user: [[other], ["uuid"]],
    submit_report: [[other, "profile", "spam"], ["uuid", "public.report_context", "public.report_reason"]],
  };
  const before = await fingerprint(db);
  for (const [fn, list, casts] of [...writes, ["set_affiliation", [], []] as [string, unknown[], string[]]]) {
    const [a, c] = args[fn] ?? [list, casts ?? []];
    expect([fn, await raised(() => rpc(db, user(me), fn, a, c))]).toEqual([fn, "forbidden"]);
  }
  expect(await fingerprint(db)).toBe(before);
}, 180000);

it("writes without require_account refuse a deleted caller as a caller (order 17), not through eligibility or state", async () => {
  const before = await fingerprint(db, ["private.rate_limit_events"]);
  expect(await raised(() => rpc(db, user(me), "start_onboarding", ["架空", "female", "2000-05-05", true], ["text", "text", "date", "boolean"]))).toBe("forbidden");
  expect(await raised(() => rpc(db, user(me), "like_user", [other], ["uuid"]))).toBe("forbidden");
  expect(await raised(() => rpc(db, user(me), "send_message", [conversation, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "架空"], ["uuid", "uuid", "text"]))).toBe("forbidden");
  expect(await raised(() => rpc(db, user(me), "mark_read", [conversation, 1], ["uuid", "bigint"]))).toBe("forbidden");
  expect(await raised(() => rpc(db, user(me), "service_register_photo", [me, `${me}/${photo}.webp`], ["uuid", "text"]))).toMatch(/permission denied/);
  expect(await fingerprint(db, ["private.rate_limit_events"])).toBe(before);
  // like_user records no rate event first: require_user refuses before it
  expect(await owner(db, "select count(*)::int as n from private.rate_limit_events where user_id = $1", [me])).toEqual([{ n: 0 }]);
}, 180000);

it("reads: my_account still answers 'deleted'; every other read and own-row select refuses (order 17)", async () => {
  // order 18 (ACCOUNT-004): my_account tells a deleted caller only its id and 'deleted'
  expect(await rpcRows(db, user(me), "my_account")).toMatchObject([{ user_id: me, account_status: "deleted", profile_completed: false, birth_date: null }]);
  for (const [fn, args, casts] of [
    ["discover_profiles", [], []], ["get_profile", [other], ["uuid"]], ["get_like_state", [other], ["uuid"]],
    ["list_my_conversations", [], []], ["list_messages", [conversation], ["uuid"]],
    ["authorize_photo_delivery", [[otherPhoto]], ["uuid[]"]], ["authorize_photo_delivery", [[photo]], ["uuid[]"]],
    ["list_my_likes", ["received"], ["text"]], ["list_my_blocks", [], []], ["my_reports", [], []],
  ] as [string, unknown[], string[]][]) {
    expect([fn, await raised(() => rpcRows(db, user(me), fn, args, casts))]).toEqual([fn, "forbidden"]);
  }
  for (const table of ["profiles", "profile_photos", "account_verifications", "affiliations", "privacy_settings",
    "hidden_affiliations", "verification_submissions", "conversation_reads", "messages"]) {
    expect([table, (await asUser(db, user(me), `select 1 from public.${table}`)).length]).toEqual([table, 0]);
  }
}, 180000);

it("staff checks refuse a deleted staff account (order 17); my_account still reports it", async () => {
  const admin = await createStaff(db, ["admin"]);
  await owner(db, "insert into public.profiles (user_id, display_name, gender, account_status, deleted_at) values ($1, '架空', 'other', 'deleted', now())", [admin]);
  expect(await rpcRows(db, staff(admin), "my_account")).toMatchObject([{ account_status: "deleted" }]);
  expect(await raised(() => rpcRows(db, staff(admin), "admin_list_staff"))).toBe("forbidden");
  expect(await raised(() => rpcRows(db, staff(admin), "admin_authorize_document_view", [submission], ["uuid"]))).toBe("forbidden");
}, 180000);
