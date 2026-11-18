// MOD-001 order 33 (docs/handoffs/MOD-001-hide-reported-content.md): a moderator at aal2 hides the content a report
// points at. Order 34 (DB-LIKES-001) makes the two bios one 'bio' item and freezes the requests, so request reports are
// old reports on closed requests (written as owner SQL, as submit_report no longer takes new ones). Every RPC call commits on its own; the persistent state is read back from a separate owner transaction.
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { connect, createMasters, createStaff, createUser, legacyRequest, missingId, type Masters } from "./fixtures";
import { asRole, asUser, deny, fingerprint, freshDb, owner, raised, rpc, rpcRows, staff, user } from "./harness";

const PLACEHOLDER = "この発言は運営により非表示になりました。";
const HIDE_CASTS = ["uuid", "text", "uuid"];
let db: PGlite;
let m: Masters;
let moderator: string;

beforeAll(async () => {
  db = await freshDb();
  m = await createMasters(db, "mod1");
  moderator = await createStaff(db, ["moderator"]);
});

const hide = (session: ReturnType<typeof staff>, report: string, item: string, photo: string | null = null) =>
  rpc(db, session, "admin_hide_reported_content", [report, item, photo], HIDE_CASTS);
const unhide = (session: ReturnType<typeof staff>, report: string, item: string) =>
  rpc(db, session, "admin_unhide_reported_content", [report, item], ["uuid", "text"]);
const content = (report: string, as = moderator) =>
  rpcRows<{ item: string; ref: string | null; photo_position: number | null; body: string | null; hidden: boolean; hidden_at: Date | null }>(
    db, staff(as), "admin_get_report_content", [report], ["uuid"]);
const audits = (report: string) => owner<{ actor_id: string; action: string; detail: Record<string, unknown> }>(db,
  "select actor_id::text, action, detail from private.audit_log where target_type = 'report' and target_id = $1 order by id", [report]);
/** every discovery page (50 at a time, keyset by user id) */
async function discovered(viewer: string): Promise<{ user_id: string; bio: string | null }[]> {
  const rows: { user_id: string; bio: string | null }[] = [];
  for (let after: string | null = null; ;) {
    const page: { user_id: string; bio: string | null }[] = await rpcRows<{ user_id: string; bio: string | null }>(db, user(viewer),
      "discover_profiles", [null, null, null, null, after, 50], ["int", "int", "text[]", "uuid[]", "uuid", "int"]);
    rows.push(...page);
    if (page.length < 50) return rows;
    after = page[page.length - 1].user_id;
  }
}
const reportOf = async (reporter: string, target: string, context: string, request: string | null, message: number | null) => {
  const r = await rpc(db, user(reporter), "submit_report", [target, context, "harassment", null, request, message],
    ["uuid", "public.report_context", "public.report_reason", "text", "uuid", "bigint"]);
  expect(r).toMatchObject({ ok: true });
  return r.ref!;
};

/** A and B connected, B's message reported by A. */
async function messageWorld(text = `架空の不適切な発言 ${randomUUID()}`) {
  const a = await createUser(db, { cls: m.classes[0] });
  const b = await createUser(db, { cls: m.classes[4] });
  const { conversation } = await connect(db, a, b);
  const sent = await rpc(db, user(b), "send_message", [conversation, randomUUID(), text], ["uuid", "uuid", "text"]);
  const message = Number(sent.ref);
  const report = await reportOf(a, b, "message", null, message);
  return { a, b, conversation, message, report, text };
}

/** Everything a participant can read about a conversation's messages. */
async function participantView(me: string, conversation: string) {
  return {
    messages: await rpcRows<{ id: number; body: string; hidden: boolean }>(db, user(me), "list_messages", [conversation], ["uuid"]),
    conversations: await rpcRows<{ conversation_id: string; last_message_body: string }>(db, user(me), "list_my_conversations"),
    table: await asUser<{ id: number; body: string }>(db, user(me), "select id, body from public.messages where conversation_id = $1", [conversation]),
  };
}

describe("messages", () => {
  it("a hidden message shows only the placeholder to both participants on every read path and keeps its evidence", async () => {
    const w = await messageWorld();
    expect((await participantView(w.a, w.conversation)).messages).toMatchObject([{ id: w.message, body: w.text, hidden: false }]);
    expect(await content(w.report)).toEqual([{ item: "message", ref: String(w.message), photo_position: null, body: w.text, hidden: false, hidden_at: null }]);

    expect(await hide(staff(moderator), w.report, "message")).toEqual({ ok: true, code: "ok", ref: w.report });
    for (const me of [w.a, w.b]) {
      const view = await participantView(me, w.conversation);
      expect(view.messages).toMatchObject([{ id: w.message, body: PLACEHOLDER, hidden: true }]);
      expect(view.conversations.find((c) => c.conversation_id === w.conversation)?.last_message_body).toBe(PLACEHOLDER);
      expect(view.table).toMatchObject([{ id: w.message, body: PLACEHOLDER }]);
      expect(JSON.stringify(view)).not.toContain(w.text);
    }
    // Realtime sends the stored row and, with replica identity default, only the key of the old one
    expect(await owner(db, "select body from public.messages where id = $1", [w.message])).toEqual([{ body: PLACEHOLDER }]);
    expect(await owner(db, "select relreplident from pg_class where oid = 'public.messages'::regclass")).toEqual([{ relreplident: "d" }]);
    expect(await owner(db, "select tablename from pg_publication_tables where pubname = 'supabase_realtime'")).toEqual([{ tablename: "messages" }]);

    expect(await owner(db, "select message_body from private.report_evidence where report_id = $1", [w.report])).toEqual([{ message_body: w.text }]);
    expect(await owner(db, "select original_body, report_id::text, hidden_by::text from private.hidden_messages where message_id = $1", [w.message]))
      .toEqual([{ original_body: w.text, report_id: w.report, hidden_by: moderator }]);
    expect(await content(w.report)).toMatchObject([{ item: "message", body: w.text, hidden: true }]);
    expect(await audits(w.report)).toContainEqual({ actor_id: moderator, action: "hide_reported_content",
      detail: { item: "message", ref: String(w.message), target: w.b } });
    expect(await hide(staff(moderator), w.report, "message")).toEqual(deny("invalid_state"));
  });

  it("undo restores the body for both participants, is audited and cannot repeat", async () => {
    const w = await messageWorld();
    expect(await hide(staff(moderator), w.report, "message")).toMatchObject({ ok: true });
    const other = await createStaff(db, ["moderator"]);
    expect(await unhide(staff(other), w.report, "message")).toEqual({ ok: true, code: "ok", ref: w.report });
    for (const me of [w.a, w.b]) {
      expect((await participantView(me, w.conversation)).messages).toMatchObject([{ id: w.message, body: w.text, hidden: false }]);
    }
    expect(await owner(db, "select count(*)::int as n from private.hidden_messages where message_id = $1", [w.message])).toEqual([{ n: 0 }]);
    expect((await audits(w.report)).filter((r) => r.action === "unhide_reported_content")).toEqual([{ actor_id: other, action: "unhide_reported_content",
      detail: { item: "message", ref: String(w.message), target: w.b, hidden_by_report: w.report, hidden_by: moderator } }]);
    expect(await unhide(staff(other), w.report, "message")).toEqual(deny("invalid_state"));
  });

  it("a later message in the room stays visible and the hidden row cascades with the conversation", async () => {
    const w = await messageWorld();
    await hide(staff(moderator), w.report, "message");
    await rpc(db, user(w.b), "send_message", [w.conversation, randomUUID(), "架空の次の発言"], ["uuid", "uuid", "text"]);
    expect((await participantView(w.a, w.conversation)).messages.map((r) => [r.body, r.hidden]))
      .toEqual([["架空の次の発言", false], [PLACEHOLDER, true]]);
    await owner(db, "delete from public.conversations where id = $1", [w.conversation]);
    expect(await owner(db, "select count(*)::int as n from private.hidden_messages where message_id = $1", [w.message])).toEqual([{ n: 0 }]);
  });
});

describe("who may hide", () => {
  it("refuses a student, an aal1 moderator, a reviewer, an admin, a moderator without TOTP and a party, before any write", async () => {
    const w = await messageWorld();
    const reviewer = await createStaff(db, ["reviewer"]);
    const admin = await createStaff(db, ["admin"]);
    const noTotp = await createStaff(db, ["moderator"], { totp: false });
    const before = await fingerprint(db);
    for (const session of [user(w.a), user(w.b), user(moderator), staff(reviewer), staff(admin), staff(noTotp)]) {
      expect(await raised(() => hide(session, w.report, "message"))).toBe("forbidden");
      expect(await raised(() => unhide(session, w.report, "message"))).toBe("forbidden");
      expect(await raised(() => rpcRows(db, session, "admin_get_report_content", [w.report], ["uuid"]))).toBe("forbidden");
      expect(await raised(() => rpcRows(db, session, "admin_authorize_report_photo", [w.report, missingId()], ["uuid", "uuid"]))).toBe("forbidden");
    }
    expect(await raised(() => asRole(db, "anon", null, "select public.admin_hide_reported_content($1, 'message', null)", [w.report]))).toMatch(/permission denied/);
    expect(await raised(() => asRole(db, "service_role", null, "select public.admin_hide_reported_content($1, 'message', null)", [w.report]))).toMatch(/permission denied/);
    expect(await fingerprint(db)).toBe(before);

    // a moderator who is the reporter or the target sees no report and changes nothing
    const party = await createStaff(db, ["moderator"]);
    await owner(db, `insert into public.profiles (user_id, display_name, gender) values ($1, '架空', 'other')`, [party]);
    const own = randomUUID();
    await owner(db, `insert into public.reports (id, reporter_id, target_user_id, context, message_id, reason)
                     values ($1, $2, $3, 'message', $4, 'spam')`, [own, party, w.b, w.message]);
    const auditsBefore = await fingerprint(db, ["private.audit_log"]);
    expect(await hide(staff(party), own, "message")).toEqual(deny("not_available"));
    expect(await unhide(staff(party), own, "message")).toEqual(deny("not_available"));
    expect(await content(own, party)).toEqual([]);
    expect(await fingerprint(db, ["private.audit_log"])).toBe(auditsBefore);
  });

  it("refuses a deleted moderator account on every order 33 RPC (order 17)", async () => {
    const w = await messageWorld();
    const deleted = await createStaff(db, ["moderator"]);
    await owner(db, "insert into public.profiles (user_id, display_name, gender, account_status, deleted_at) values ($1, '架空', 'other', 'deleted', now())", [deleted]);
    const before = await fingerprint(db);
    expect(await raised(() => hide(staff(deleted), w.report, "message"))).toBe("forbidden");
    expect(await raised(() => unhide(staff(deleted), w.report, "message"))).toBe("forbidden");
    expect(await raised(() => content(w.report, deleted))).toBe("forbidden");
    expect(await raised(() => rpcRows(db, staff(deleted), "admin_authorize_report_photo", [w.report, missingId()], ["uuid", "uuid"]))).toBe("forbidden");
    expect(await fingerprint(db)).toBe(before);
  });

  it("validates its arguments and refuses items that do not fit the report", async () => {
    const w = await messageWorld();
    for (const [item, photo] of [[null, null], ["bogus", null], ["photo", null], ["message", missingId()], ["bio", missingId()],
      ["bio_friends", null], ["bio_romance", null]]) {
      expect(await raised(() => hide(staff(moderator), w.report, item as string, photo))).toBe("validation");
    }
    expect(await raised(() => hide(staff(moderator), null as unknown as string, "message"))).toBe("validation");
    for (const item of ["bio", "bio_romance", "bio_friends", "photo", null]) {
      expect(await raised(() => unhide(staff(moderator), w.report, item as string))).toBe("validation");
    }
    expect(await raised(() => rpcRows(db, staff(moderator), "admin_get_report_content", [null], ["uuid"]))).toBe("validation");
    expect(await hide(staff(moderator), missingId(), "message")).toEqual(deny("not_available"));
    expect(await hide(staff(moderator), w.report, "request_message")).toEqual(deny("not_available"));
    expect(await hide(staff(moderator), w.report, "bio")).toEqual(deny("not_available"));
    expect(await unhide(staff(moderator), w.report, "request_message")).toEqual(deny("not_available"));
    expect(await unhide(staff(moderator), w.report, "message")).toEqual(deny("invalid_state"));   // nothing hidden yet
    expect(await content(missingId())).toEqual([]);
  });
});

describe("request messages (old reports on frozen requests)", () => {
  /** B's closed request to A and A's report on it, both from before order 34 */
  async function requestWorld(message: string | null, from: "target" | "reporter" = "target") {
    const a = await createUser(db, { cls: m.classes[0] });
    const b = await createUser(db, { cls: m.classes[4] });
    const request = from === "target" ? await legacyRequest(db, b, a, { status: "declined", message })
      : await legacyRequest(db, a, b, { status: "cancelled", message });
    const report = randomUUID();
    await owner(db, `insert into public.reports (id, reporter_id, target_user_id, context, request_id, reason)
                     values ($1, $2, $3, 'request', $4, 'harassment')`, [report, a, b, request]);
    return { a, b, request, report };
  }
  const requestRow = (id: string) => owner(db, "select status::text, message from public.connection_requests where id = $1", [id]);

  it("staff still read, hide and unhide an old request message; the request row never changes", async () => {
    const text = `架空の申請メッセージ ${randomUUID()}`;
    const w = await requestWorld(text);
    expect(await content(w.report)).toMatchObject([{ item: "request_message", ref: w.request, body: text, hidden: false }]);
    expect(await hide(staff(moderator), w.report, "request_message")).toEqual({ ok: true, code: "ok", ref: w.report });
    expect(await requestRow(w.request)).toEqual([{ status: "declined", message: text }]);
    expect(await content(w.report)).toMatchObject([{ item: "request_message", body: text, hidden: true }]);
    expect(await hide(staff(moderator), w.report, "request_message")).toEqual(deny("invalid_state"));
    expect(await audits(w.report)).toContainEqual({ actor_id: moderator, action: "hide_reported_content",
      detail: { item: "request_message", ref: w.request, target: w.b } });

    expect(await unhide(staff(moderator), w.report, "request_message")).toEqual({ ok: true, code: "ok", ref: w.report });
    expect(await content(w.report)).toMatchObject([{ item: "request_message", body: text, hidden: false }]);
    expect(await unhide(staff(moderator), w.report, "request_message")).toEqual(deny("invalid_state"));
    expect((await audits(w.report)).map((r) => r.action)).toContain("unhide_reported_content");
    expect(await requestRow(w.request)).toEqual([{ status: "declined", message: text }]);
    // participants have no read path to request messages any more
    const [{ gone }] = await owner<{ gone: string | null }>(db, "select to_regprocedure('public.list_my_requests()')::text as gone");
    expect(gone).toBeNull();
  });

  it("an empty request message has nothing to hide, and a request the target did not send is not its content", async () => {
    const empty = await requestWorld(null);
    expect(await content(empty.report)).toEqual([]);
    expect(await hide(staff(moderator), empty.report, "request_message")).toEqual(deny("invalid_state"));
    const own = await requestWorld("架空の自分の申請", "reporter");
    expect(await content(own.report)).toEqual([]);
    expect(await hide(staff(moderator), own.report, "request_message")).toEqual(deny("not_available"));
  });
});

describe("profiles", () => {
  async function profileWorld(photos = 2) {
    const a = await createUser(db, { cls: m.classes[0] });
    const b = await createUser(db, { cls: m.classes[4], photos });
    const ids = (await owner<{ id: string }>(db, "select id::text from public.profile_photos where user_id = $1 order by position", [b])).map((r) => r.id);
    return { a, b, photos: ids, report: await reportOf(a, b, "profile", null, null) };
  }
  const bioOf = async (viewer: string, target: string) =>
    (await rpcRows<{ bio: string | null }>(db, user(viewer), "get_profile", [target], ["uuid"]))[0]?.bio;
  const likedBio = async (viewer: string, target: string) => (await asUser<{ bio: string | null }>(db, user(viewer),
    "select (counterpart).bio from public.list_my_likes('received') where counterpart_id = $1", [target]))[0]?.bio;

  it("a hidden bio leaves every profile view until the owner writes a new one, and the text is kept", async () => {
    const w = await profileWorld();
    await owner(db, "insert into public.likes (liker_id, liked_id) values ($1, $2)", [w.b, w.a]);
    expect(await content(w.report)).toEqual([
      { item: "bio", ref: null, photo_position: null, body: "架空の自己紹介", hidden: false, hidden_at: null },
      { item: "photo", ref: w.photos[0], photo_position: 0, body: null, hidden: false, hidden_at: null },
      { item: "photo", ref: w.photos[1], photo_position: 1, body: null, hidden: false, hidden_at: null },
    ]);
    expect(await likedBio(w.a, w.b)).toBe("架空の自己紹介");
    expect(await hide(staff(moderator), w.report, "bio")).toEqual({ ok: true, code: "ok", ref: w.report });
    expect(await bioOf(w.a, w.b)).toBeNull();
    expect(await likedBio(w.a, w.b)).toBeNull();
    expect((await discovered(w.a)).find((r) => r.user_id === w.b)).toMatchObject({ bio: null });
    expect(await owner(db, "select bio from public.profiles where user_id = $1", [w.b])).toEqual([{ bio: null }]);
    expect(await owner(db, "select mode::text, original_text, report_id::text from private.hidden_bios where user_id = $1", [w.b]))
      .toEqual([{ mode: null, original_text: "架空の自己紹介", report_id: w.report }]);
    expect((await content(w.report))[0]).toMatchObject({ item: "bio", body: null, hidden: true });
    expect(await hide(staff(moderator), w.report, "bio")).toEqual(deny("invalid_state"));
    expect(await raised(() => unhide(staff(moderator), w.report, "bio"))).toBe("validation");
    expect(await audits(w.report)).toContainEqual({ actor_id: moderator, action: "hide_reported_content",
      detail: { item: "bio", ref: null, target: w.b } });

    expect(await rpc(db, user(w.b), "update_profile", ["架空", "female", "架空の新しい紹介", [], []],
      ["text", "text", "text", "text[]", "text[]"])).toMatchObject({ ok: true });
    expect(await bioOf(w.a, w.b)).toBe("架空の新しい紹介");
    expect(await hide(staff(moderator), w.report, "bio")).toMatchObject({ ok: true });
    expect(await owner(db, "select original_text from private.hidden_bios where user_id = $1 order by id", [w.b]))
      .toEqual([{ original_text: "架空の自己紹介" }, { original_text: "架空の新しい紹介" }]);
  });

  it("a hide recorded before order 34 (with its old mode) still gives the bio item its hidden_at", async () => {
    const w = await profileWorld();
    await owner(db, "update public.profiles set bio = null where user_id = $1", [w.b]);
    await owner(db, `insert into private.hidden_bios (user_id, mode, original_text, report_id, hidden_by, hidden_at)
                     values ($1, 'romance', '架空の古い紹介', $2, $3, '2026-11-01 00:00:00+00')`, [w.b, w.report, moderator]);
    const [bio] = await content(w.report);
    expect(bio).toMatchObject({ item: "bio", body: null, hidden: true });
    expect(bio.hidden_at?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(await hide(staff(moderator), w.report, "bio")).toEqual(deny("invalid_state"));
  });

  it("a hidden photo is removed for good; the last one too, which takes the profile out of view", async () => {
    const w = await profileWorld();
    const delivered = (viewer: string, photo: string) => rpcRows(db, user(viewer), "authorize_photo_delivery", [[photo]], ["uuid[]"]);
    expect(await rpcRows(db, staff(moderator), "admin_authorize_report_photo", [w.report, w.photos[0]], ["uuid", "uuid"]))
      .toEqual([{ photo_id: w.photos[0], storage_path: `${w.b}/${w.photos[0]}.webp` }]);
    expect(await hide(staff(moderator), w.report, "photo", w.photos[0])).toEqual({ ok: true, code: "ok", ref: w.report });
    expect(await owner(db, "select status from public.profile_photos where id = $1", [w.photos[0]])).toEqual([{ status: "removed" }]);
    expect(await delivered(w.a, w.photos[0])).toEqual([]);
    expect(await rpcRows(db, staff(moderator), "admin_authorize_report_photo", [w.report, w.photos[0]], ["uuid", "uuid"])).toEqual([]);
    expect((await rpcRows<{ photo_ids: string[] }>(db, user(w.a), "get_profile", [w.b], ["uuid"]))[0].photo_ids)
      .toEqual([w.photos[1]]);
    expect(await hide(staff(moderator), w.report, "photo", w.photos[0])).toEqual(deny("invalid_state"));
    expect(await hide(staff(moderator), w.report, "photo", missingId())).toEqual(deny("not_available"));
    expect((await content(w.report)).filter((r) => r.item === "photo").map((r) => r.ref)).toEqual([w.photos[1]]);

    expect(await hide(staff(moderator), w.report, "photo", w.photos[1])).toMatchObject({ ok: true });
    expect(await rpcRows(db, user(w.a), "get_profile", [w.b], ["uuid"])).toEqual([]);
    expect((await discovered(w.a)).map((r) => r.user_id)).not.toContain(w.b);
    expect(await rpcRows(db, user(w.b), "my_account")).toMatchObject([{ has_active_photo: false, eligible: false, profile_completed: true }]);
    expect((await audits(w.report)).filter((r) => r.action === "hide_reported_content").map((r) => r.detail))
      .toEqual([{ item: "photo", ref: w.photos[0], target: w.b }, { item: "photo", ref: w.photos[1], target: w.b }]);
    expect((await audits(w.report)).filter((r) => r.action === "view_report_photo")).toHaveLength(1);

    // order 28 sweeps the removed photos' objects after 24 hours
    for (const photo of w.photos) {
      await owner(db, "insert into storage.objects (bucket_id, name, created_at) values ('profile-photos', $1, now() - interval '2 days')", [`${w.b}/${photo}.webp`]);
    }
    const swept = await asRole<{ kind: string; storage_path: string }>(db, "service_role", null,
      "select kind, storage_path from public.service_retention_candidates() where user_id = $1", [w.b]);
    expect(swept.map((r) => [r.kind, r.storage_path]).sort()).toEqual(w.photos.map((p) => ["orphan_photo", `${w.b}/${p}.webp`]).sort());
  });

  it("photo views are limited to an active photo of the profile report's target", async () => {
    const w = await profileWorld();
    const other = await createUser(db, { cls: m.classes[5] });
    const [{ id: foreign }] = await owner<{ id: string }>(db, "select id::text from public.profile_photos where user_id = $1", [other]);
    expect(await rpcRows(db, staff(moderator), "admin_authorize_report_photo", [w.report, foreign], ["uuid", "uuid"])).toEqual([]);
    expect(await hide(staff(moderator), w.report, "photo", foreign)).toEqual(deny("not_available"));
    const msg = await messageWorld();
    expect(await rpcRows(db, staff(moderator), "admin_authorize_report_photo", [msg.report, w.photos[0]], ["uuid", "uuid"])).toEqual([]);
    expect(await raised(() => rpcRows(db, staff(moderator), "admin_authorize_report_photo", [w.report, null], ["uuid", "uuid"]))).toBe("validation");
    expect(await owner(db, "select status from public.profile_photos where id = $1", [foreign])).toEqual([{ status: "active" }]);
  });
});

describe("unchanged surfaces", () => {
  it("hiding neither changes the report's status nor writes report actions", async () => {
    const w = await messageWorld();
    await hide(staff(moderator), w.report, "message");
    expect(await owner(db, "select status::text from public.reports where id = $1", [w.report])).toEqual([{ status: "open" }]);
    expect(await owner(db, "select count(*)::int as n from private.report_actions where report_id = $1", [w.report])).toEqual([{ n: 0 }]);
    expect(await rpc(db, staff(moderator), "admin_update_report", [w.report, "triaged", null], ["uuid", "public.report_status", "text"]))
      .toMatchObject({ ok: true });
  });

  it("the new private tables are unreadable by every API role", async () => {
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      for (const table of ["hidden_messages", "hidden_request_messages", "hidden_bios"]) {
        expect(await raised(() => asRole(db, role, role === "authenticated" ? user(moderator) : null, `select 1 from private.${table}`)))
          .toMatch(/permission denied/);
      }
    }
  });
});
