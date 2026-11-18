// NT-04, NT-14, NT-26 (docs/04_DATABASE.md §4 "判定の適用範囲", §5.4, §6, §13.2): own-row direct reads, chat
// access, and the current session check on RPCs and on the messages direct read (r4, ARCH-R3-FINAL-01).
// The ineligible sessions are synthetic Auth states made with owner SQL and JWT claims (§13.1); they do not show
// that real Supabase Auth can reach them.
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { connect, createMasters, createUser, type Masters } from "./fixtures";
import { asUser, deny, fingerprint, freshDb, owner, raised, rpc, rpcRows, user, type Session } from "./harness";

let db: PGlite;
let m: Masters;

beforeAll(async () => {
  db = await freshDb();
  m = await createMasters(db, "chat");
});

const send = (from: Session | string, conversation: string, body: string, clientId: string = randomUUID()) =>
  rpc(db, typeof from === "string" ? user(from) : from, "send_message", [conversation, clientId, body]);

const read = (who: Session | string, conversation: string) =>
  asUser<{ id: string; sender: string; body: string }>(db, typeof who === "string" ? user(who) : who,
    "select m.id::text as id, m.sender_id::text as sender, m.body from public.list_messages($1, null, null) m order by m.id",
    [conversation]);

const directMessages = (who: Session | string) =>
  asUser<{ id: string; conv: string; sender: string }>(db, typeof who === "string" ? user(who) : who,
    "select m.id::text as id, m.conversation_id::text as conv, m.sender_id::text as sender from public.messages m order by m.id");

const markRead = (who: Session | string, conversation: string, message: string) =>
  rpc(db, typeof who === "string" ? user(who) : who, "mark_read", [conversation, message], ["uuid", "bigint"]);

const conversationsOf = async (who: string) =>
  (await rpcRows<{ conversation_id: string }>(db, user(who), "list_my_conversations")).map((r) => r.conversation_id);

const OWN_ROW_TABLES = ["profiles", "profile_photos", "affiliations", "privacy_settings",
  "hidden_affiliations", "account_verifications", "conversation_reads"];
const NO_GRANT_TABLES = ["public.connection_requests", "public.likes", "public.connections", "public.conversations", "public.reports",
  "public.blocks", "private.user_private", "private.staff_roles", "private.audit_log", "private.rate_limit_events",
  "private.app_settings", "private.report_evidence", "private.report_actions"];

describe("NT-04 direct reads return own rows only", () => {
  it("own-row tables, masters, tables without a grant and messages", async () => {
    const a = await createUser(db, { cls: m.classes[0], photos: 2, hidden: { classes: [m.classes[7].id] } });
    const b = await createUser(db, { cls: m.classes[4] });
    const c = await createUser(db, { cls: m.classes[5], hidden: { classes: [m.classes[3].id] } });
    const d = await createUser(db, { cls: m.classes[6] });
    const ab = await connect(db, a, b);
    const cd = await connect(db, c, d);
    for (const [who, conv] of [[a, ab.conversation], [b, ab.conversation], [c, cd.conversation], [d, cd.conversation]]) {
      const sent = await send(who, conv, "架空のメッセージ");
      expect(sent.ok).toBe(true);
      expect((await markRead(who, conv, sent.ref!)).ok).toBe(true);
    }
    await owner(db, `insert into public.schools (name, is_active) values ('無効の試験校（架空）', false)`);

    for (const table of OWN_ROW_TABLES) {
      const rows = await asUser<{ user_id: string }>(db, user(a), `select user_id::text as user_id from public.${table}`);
      expect(rows.length, table).toBeGreaterThan(0);
      expect([...new Set(rows.map((r) => r.user_id))], table).toEqual([a]);
      const [{ others }] = await owner<{ others: number }>(db,
        `select count(*)::int as others from public.${table} where user_id <> $1`, [a]);
      expect(others, `${table} holds other users' rows`).toBeGreaterThan(0);
    }
    const subs = await asUser<{ user_id: string }>(db, user(a), "select user_id::text as user_id from public.verification_submissions");
    expect([...new Set(subs.map((r) => r.user_id))]).toEqual([a]);

    const [{ inactive }] = await asUser<{ inactive: number }>(db, user(a),
      "select count(*) filter (where not is_active)::int as inactive from public.schools");
    expect(inactive).toBe(0);

    for (const table of NO_GRANT_TABLES) {
      expect(await raised(() => asUser(db, user(a), `select 1 from ${table} limit 1`)), table).toMatch(/permission denied/);
    }

    const visible = await directMessages(a);
    expect(visible.length).toBe(2);
    expect(new Set(visible.map((r) => r.conv))).toEqual(new Set([ab.conversation]));
  });
});

describe("NT-14 chat access", () => {
  it("participants send and read; a resend with the same client_msg_id stays one row", async () => {
    const a = await createUser(db, { cls: m.classes[0] });
    const b = await createUser(db, { cls: m.classes[4] });
    const c = await createUser(db, { cls: m.classes[5] });
    const { conversation } = await connect(db, a, b);
    const other = await connect(db, a, c);
    const clientId = randomUUID();
    const first = await send(a, conversation, "架空の最初の本文", clientId);
    expect(first).toMatchObject({ ok: true, code: "ok" });
    expect(await send(a, conversation, "架空の別の本文", clientId)).toEqual(first);
    const rows = await owner<{ body: string }>(db, "select body from public.messages where sender_id = $1 and client_msg_id = $2",
      [a, clientId]);
    expect(rows).toEqual([{ body: "架空の最初の本文" }]);
    // the same client id in another conversation is not silently mapped to the first row
    expect(await send(a, other.conversation, "架空の本文", clientId)).toEqual(deny("invalid_state"));
    expect(await read(a, other.conversation)).toEqual([]);

    expect(await read(b, conversation)).toEqual([{ id: first.ref, sender: a, body: "架空の最初の本文" }]);
    const [inbox] = await rpcRows<{ counterpart_id: string; counterpart_name: string; last_message_id: string; unread: boolean }>(
      db, user(b), "list_my_conversations");
    expect(inbox).toMatchObject({ counterpart_id: a, unread: true });
    expect(String(inbox.last_message_id)).toBe(first.ref);
    expect((await markRead(b, conversation, first.ref!)).ok).toBe(true);
    expect((await rpcRows<{ unread: boolean }>(db, user(b), "list_my_conversations"))[0].unread).toBe(false);
  });

  it("unread follows incoming messages above the read cursor, not the preview (BE-FINAL-02)", async () => {
    const a = await createUser(db, { cls: m.classes[0] });
    const b = await createUser(db, { cls: m.classes[4] });
    const { conversation } = await connect(db, a, b);
    type Inbox = { last_message_id: string; last_message_body: string; last_message_mine: boolean; unread: boolean };
    const inboxOf = async (who: string) => {
      const [row] = await rpcRows<Inbox>(db, user(who), "list_my_conversations");
      return { ...row, last_message_id: String(row.last_message_id) };
    };
    const cursorOf = async (who: string) => (await owner<{ id: string }>(db,
      "select last_read_message_id::text as id from public.conversation_reads where conversation_id = $1 and user_id = $2",
      [conversation, who]))[0]?.id ?? null;

    const b1 = (await send(b, conversation, "架空のBから1")).ref!;
    expect(await inboxOf(a)).toMatchObject({ last_message_id: b1, last_message_mine: false, unread: true });
    // receive -> own send before mark_read: the preview is A's message, B's message is still above A's cursor
    const a1 = (await send(a, conversation, "架空のAから1")).ref!;
    expect(await inboxOf(a)).toMatchObject({ last_message_id: a1, last_message_body: "架空のAから1",
      last_message_mine: true, unread: true });
    expect(await cursorOf(a)).toBeNull();
    expect(await inboxOf(b)).toMatchObject({ last_message_id: a1, last_message_mine: false, unread: true });
    expect((await markRead(a, conversation, b1)).ok).toBe(true);
    expect(await inboxOf(a)).toMatchObject({ last_message_id: a1, unread: false });   // own messages never count
    expect(await cursorOf(a)).toBe(b1);

    // partial cursor with an own latest message: reading b2 leaves b3 unread
    const b2 = (await send(b, conversation, "架空のBから2")).ref!;
    const b3 = (await send(b, conversation, "架空のBから3")).ref!;
    const a2 = (await send(a, conversation, "架空のAから2")).ref!;
    expect(await inboxOf(a)).toMatchObject({ last_message_id: a2, last_message_mine: true, unread: true });
    expect((await markRead(a, conversation, b2)).ok).toBe(true);
    expect(await cursorOf(a)).toBe(b2);
    expect(await inboxOf(a)).toMatchObject({ last_message_id: a2, unread: true });
    expect((await markRead(a, conversation, b3)).ok).toBe(true);
    expect(await inboxOf(a)).toMatchObject({ last_message_id: a2, last_message_body: "架空のAから2", unread: false });
    // an older mark_read never moves the cursor back
    expect((await markRead(a, conversation, b2)).ok).toBe(true);
    expect(await cursorOf(a)).toBe(b3);
    expect(await inboxOf(a)).toMatchObject({ unread: false });
    // B has read nothing: A's messages above B's (absent) cursor are unread for B
    expect(await cursorOf(b)).toBeNull();
    expect(await inboxOf(b)).toMatchObject({ last_message_id: a2, last_message_mine: false, unread: true });
    expect((await markRead(b, conversation, a2)).ok).toBe(true);
    expect(await inboxOf(b)).toMatchObject({ unread: false });
  });

  it("bodies are validated before any write: empty, 2001 characters, whitespace only", async () => {
    const a = await createUser(db, { cls: m.classes[0] });
    const b = await createUser(db, { cls: m.classes[4] });
    const { conversation } = await connect(db, a, b);
    const before = await fingerprint(db);
    for (const body of ["", "あ".repeat(2001), "   ", "\n\t 　"]) {
      expect(await raised(() => send(a, conversation, body)), JSON.stringify(body)).toBe("validation");
    }
    expect(await fingerprint(db)).toBe(before);
    expect((await send(a, conversation, "あ".repeat(2000))).ok).toBe(true);
  });

  it("non-participants and unknown conversations: 0 rows, not_available, no direct rows", async () => {
    const a = await createUser(db, { cls: m.classes[0] });
    const b = await createUser(db, { cls: m.classes[4] });
    const outsider = await createUser(db, { cls: m.classes[5] });
    const { conversation } = await connect(db, a, b);
    const sent = await send(a, conversation, "架空の本文");
    const before = await fingerprint(db);
    for (const conv of [conversation, randomUUID()]) {
      expect(await read(outsider, conv)).toEqual([]);
      expect(await send(outsider, conv, "架空の割込み")).toEqual(deny("not_available"));
      expect(await markRead(outsider, conv, sent.ref!)).toEqual(deny("not_available"));
    }
    expect(await directMessages(outsider)).toEqual([]);
    expect(await conversationsOf(outsider)).toEqual([]);
    expect(await fingerprint(db)).toBe(before);
  });

  // each change makes the conversation inaccessible to both sides at once, for the RPCs and the direct read
  const changes: [string, (a: string, b: string, connection: string) => Promise<void>, ((a: string, b: string) => Promise<void>) | null, boolean][] = [
    ["block by the other side", async (a, b) => {
      expect((await rpc(db, user(b), "block_user", [a])).ok).toBe(true);
    }, async (a, b) => {
      expect((await rpc(db, user(b), "unblock_user", [a])).ok).toBe(true);
    }, false],
    ["hiding setting applies", async (a, b) => {
      const [aff] = await owner<{ school: string }>(db, "select school_id::text as school from public.affiliations where user_id = $1", [a]);
      expect((await rpc(db, user(b), "update_privacy_settings",
        [true, false, false, false, false, [aff.school], [], []],
        ["boolean", "boolean", "boolean", "boolean", "boolean", "uuid[]", "uuid[]", "uuid[]"])).ok).toBe(true);
    }, async (_a, b) => {
      expect((await rpc(db, user(b), "update_privacy_settings", [true, false, false, false, false, [], [], []],
        ["boolean", "boolean", "boolean", "boolean", "boolean", "uuid[]", "uuid[]", "uuid[]"])).ok).toBe(true);
    }, true],
    ["eligibility lost", async (a) => {
      await owner(db, "update public.affiliations set confirmed_until = now() - interval '1 second' where user_id = $1", [a]);
    }, async (a) => {
      await owner(db, "update public.affiliations set confirmed_until = now() + interval '30 days' where user_id = $1", [a]);
    }, true],
    ["connection ended", async (a, _b, connection) => {
      expect((await rpc(db, user(a), "end_connection", [connection])).ok).toBe(true);
    }, null, false],
  ];

  for (const [label, change, undo, returns] of changes) {
    it(`${label}: list 0 rows, send/mark_read not_available, no direct rows, for both sides`, async () => {
      const a = await createUser(db, { cls: m.classes[0] });
      const b = await createUser(db, { cls: m.classes[4] });
      const { connection, conversation } = await connect(db, a, b);
      const fromA = await send(a, conversation, "架空のAから");
      const fromB = await send(b, conversation, "架空のBから");
      await change(a, b, connection);
      const [{ stored }] = await owner<{ stored: number }>(db,
        "select count(*)::int as stored from public.messages where conversation_id = $1", [conversation]);
      for (const [me, msg] of [[a, fromB.ref!], [b, fromA.ref!]]) {
        expect(await read(me, conversation)).toEqual([]);
        expect(await send(me, conversation, "架空の本文")).toEqual(deny("not_available"));
        expect(await markRead(me, conversation, msg)).toEqual(deny("not_available"));
        expect((await directMessages(me)).filter((r) => r.conv === conversation)).toEqual([]);
        expect(await conversationsOf(me)).not.toContain(conversation);
      }
      const [{ after }] = await owner<{ after: number }>(db,
        "select count(*)::int as after from public.messages where conversation_id = $1", [conversation]);
      expect(after).toBe(stored);
      if (undo) {
        await undo(a, b);
        expect((await read(a, conversation)).length > 0, "access after undo").toBe(returns);
        expect((await directMessages(b)).some((r) => r.conv === conversation)).toBe(returns);
      }
    });
  }
});

describe("NT-26 the current session check", () => {
  /** every public RPC except the service-only one, called with typed NULL arguments */
  async function publicCalls(): Promise<{ name: string; sql: string }[]> {
    const fns = await owner<{ name: string; args: string[] }>(db, `
      select p.proname as name,
             coalesce((select array_agg(format_type(t, null) order by o)
                       from unnest(p.proargtypes) with ordinality as a(t, o)), '{}') as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname not in ('service_register_photo', 'service_reserve_signin', 'service_reserve_signup', 'service_retention_candidates', 'service_purge_rate_limits')
      order by 1`);
    return fns.map((f) => ({ name: f.name, sql: `select public.${f.name}(${f.args.map((t) => `null::${t}`).join(", ")})` }));
  }

  const ownRowsBy = async (session: Session) => {
    const ids: string[] = [];
    for (const table of OWN_ROW_TABLES) {
      ids.push(...(await asUser<{ user_id: string }>(db, session, `select user_id::text as user_id from public.${table}`))
        .map((r) => r.user_id));
    }
    return ids;
  };

  it("fresh users: anonymous, unconfirmed, no-sub and unknown-sub sessions are forbidden on every public RPC", async () => {
    const anonymous = await createUser(db, { profile: false, anonymous: true });
    const unconfirmed = await createUser(db, { profile: false, emailConfirmed: false });
    const plain = await createUser(db, { profile: false });
    const sessions: [string, Session][] = [
      ["anonymous (JWT and auth.users)", { sub: anonymous, isAnonymous: true }],
      ["anonymous in auth.users, claim missing", { sub: anonymous, omitAnonymousClaim: true }],
      ["anonymous claim, auth.users not anonymous", { sub: plain, isAnonymous: true }],
      ["email not confirmed", { sub: unconfirmed }],
      ["no sub", { sub: plain, omitSub: true }],
      ["sub without an auth.users row", { sub: randomUUID() }],
    ];
    const calls = await publicCalls();
    expect(calls.length).toBeGreaterThan(40);
    const before = await fingerprint(db);
    for (const [label, session] of sessions) {
      for (const call of calls) {
        expect(await raised(() => asUser(db, session, call.sql)), `${label}: ${call.name}`).toBe("forbidden");
      }
      expect(await raised(() => rpc(db, session, "start_onboarding", ["架空", "female", "2000-01-01", true])), label)
        .toBe("forbidden");
      expect(await directMessages(session), label).toEqual([]);
      const own = await ownRowsBy(session);
      expect(own.filter((id) => id !== session.sub), label).toEqual([]);
    }
    expect(await fingerprint(db)).toBe(before);
    // control: the same fresh user with a valid session can onboard
    expect((await rpc(db, user(plain), "start_onboarding", ["架空", "female", "2000-01-01", true])).ok).toBe(true);
  });

  describe("an established user A with eligibility, an active conversation and B's messages (r4)", () => {
    let a: string;
    let b: string;
    let outsider: string;
    let conversation: string;
    let fromB: string;
    let initial: { id: string; sender: string; body: string }[];

    const setIntake = (value: "upload" | "synthetic") =>
      owner(db, "update private.app_settings set value = $1 where key = 'verification_intake'", [value]);
    const uploadAllowed = async (session: Session) => (await asUser<{ allowed: boolean }>(db, session,
      "select private.rls_document_upload_allowed($1) as allowed", [`${a}/submission/1.webp`]))[0].allowed;

    beforeAll(async () => {
      a = await createUser(db, { cls: m.classes[0] });
      b = await createUser(db, { cls: m.classes[4] });
      outsider = await createUser(db, { cls: m.classes[5] });
      ({ conversation } = await connect(db, a, b));
      fromB = (await send(b, conversation, "架空のBから1")).ref!;
      await send(b, conversation, "架空のBから2");
      await send(a, conversation, "架空のAから");
      initial = await read(a, conversation);
    });

    it("control: with a valid session A reads B's messages, the RPCs work and the upload self-check is true in upload mode", async () => {
      expect(initial.filter((r) => r.sender === b)).toHaveLength(2);
      expect((await directMessages(a)).filter((r) => r.sender === b)).toHaveLength(2);
      expect(await rpcRows(db, user(a), "get_profile", [b])).toHaveLength(1);
      await setIntake("upload");
      try {
        expect(await uploadAllowed(user(a))).toBe(true);
        expect(await uploadAllowed(user(b))).toBe(false);   // another user's folder
      } finally {
        await setIntake("synthetic");
      }
      expect(await uploadAllowed(user(a))).toBe(false);     // synthetic intake
    });

    const cases: [string, Session | (() => Session), string | null, string | null][] = [
      ["(i) email confirmation cleared", () => user(a),
        "update auth.users set email_confirmed_at = null where id = $1",
        "update auth.users set email_confirmed_at = now() where id = $1"],
      ["(ii) JWT is_anonymous true", () => ({ sub: a, isAnonymous: true }), null, null],
      ["(iii) JWT without sub", () => ({ sub: a, omitSub: true }), null, null],
      ["(iv) auth.users is_anonymous, claim false", () => user(a),
        "update auth.users set is_anonymous = true where id = $1", "update auth.users set is_anonymous = false where id = $1"],
      ["(iv) auth.users is_anonymous, claim missing", () => ({ sub: a, omitAnonymousClaim: true }),
        "update auth.users set is_anonymous = true where id = $1", "update auth.users set is_anonymous = false where id = $1"],
    ];

    for (const [label, makeSession, prepare, restore] of cases) {
      it(`${label}: RPCs forbidden, nothing changes, direct messages 0 rows, upload self-check false`, async () => {
        const session = typeof makeSession === "function" ? makeSession() : makeSession;
        await setIntake("upload");
        if (prepare) await owner(db, prepare, [a]);
        try {
          const before = await fingerprint(db);
          const calls: [string, () => Promise<unknown>][] = [
            ["list_my_conversations", () => rpcRows(db, session, "list_my_conversations")],
            ["list_messages", () => read(session, conversation)],
            ["send_message", () => send(session, conversation, "架空の本文")],
            ["mark_read", () => markRead(session, conversation, fromB)],
            ["get_profile", () => rpcRows(db, session, "get_profile", [b])],
            ["my_account", () => rpcRows(db, session, "my_account")],
          ];
          for (const [name, call] of calls) expect(await raised(call), name).toBe("forbidden");
          expect(await fingerprint(db)).toBe(before);
          expect(await directMessages(session)).toEqual([]);
          const own = await ownRowsBy(session);
          expect(own.filter((id) => id !== a)).toEqual([]);
          if (session.omitSub) expect(own).toEqual([]);
          expect(await uploadAllowed(session)).toBe(false);
        } finally {
          if (restore) await owner(db, restore, [a]);
          await setIntake("synthetic");
        }
      });
    }

    it("the check is sensitive: an r3-style messages policy on auth.uid() leaks B's messages under (i)", async () => {
      const r3 = await freshDb();
      await r3.exec(`
        create or replace function private.rls_conversation_member(p_conversation uuid) returns boolean
        language sql stable security definer set search_path = '' as $$
          select coalesce(auth.uid() is not null and private.can_access_conversation(auth.uid(), p_conversation), false)
        $$;`);
      const masters = await createMasters(r3, "r3");
      const x = await createUser(r3, { cls: masters.classes[0] });
      const y = await createUser(r3, { cls: masters.classes[4] });
      const link = await connect(r3, x, y);
      expect((await rpc(r3, user(y), "send_message", [link.conversation, randomUUID(), "架空の本文"])).ok).toBe(true);
      await owner(r3, "update auth.users set email_confirmed_at = null where id = $1", [x]);
      expect(await asUser(r3, user(x), "select sender_id::text as sender from public.messages")).toEqual([{ sender: y }]);
      await r3.close();
    });

    it("after restoring A, A and B read as before and the NT-14 negatives are unchanged", async () => {
      expect(await read(a, conversation)).toEqual(initial);
      expect(await read(b, conversation)).toEqual(initial);
      expect((await directMessages(a)).map((r) => r.id)).toEqual(initial.map((r) => r.id));
      expect((await markRead(a, conversation, fromB)).ok).toBe(true);
      expect((await send(a, conversation, "架空の再開")).ok).toBe(true);
      expect(await read(outsider, conversation)).toEqual([]);
      expect(await send(outsider, conversation, "架空の割込み")).toEqual(deny("not_available"));
      expect(await directMessages(outsider)).toEqual([]);
    });
  });
});
