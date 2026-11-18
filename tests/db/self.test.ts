// Onboarding and own-data RPCs: NT-10, NT-11, NT-22, photos, account states (docs/04_DATABASE.md §5.2, §13.2).
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { connect, createMasters, createUser, type Masters } from "./fixtures";
import { asRole, asUser, deny, fingerprint, freshDb, owner, raised, rpc, rpcRows, user } from "./harness";
import { adultFrom, ageYears, anniversary } from "./oracle";

let db: PGlite;
let m: Masters;

beforeAll(async () => {
  db = await freshDb();
  m = await createMasters(db, "self");
});

async function today(): Promise<string> {
  return (await owner<{ d: string }>(db, "select private.today_jst()::text as d"))[0].d;
}

function shiftYears(date: string, years: number): string {
  return `${String(Number(date.slice(0, 4)) + years).padStart(4, "0")}${date.slice(4)}`;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function newAuthUser(): Promise<string> {
  return createUser(db, { profile: false });
}

describe("NT-10 age boundaries", () => {
  it("adult_from / age_years at the 18th birthday, the day before, and Feb 29 births", async () => {
    const cases: [string, string, number][] = [
      ["2000-06-15", "2018-06-14", 17], ["2000-06-15", "2018-06-15", 18],
      ["2004-02-29", "2022-02-28", 17], ["2004-02-29", "2022-03-01", 18],
      ["2004-02-29", "2024-02-28", 19], ["2004-02-29", "2024-02-29", 20],
      ["1980-02-29", "2000-02-29", 20], ["2080-02-29", "2100-02-28", 19], ["2080-02-29", "2100-03-01", 20],
    ];
    for (const [birth, on, age] of cases) {
      const [row] = await owner<{ age: number; adult: string }>(db,
        "select private.age_years($1::date, $2::date) as age, private.adult_from($1::date)::text as adult", [birth, on]);
      expect(row.age, `${birth}@${on}`).toBe(age);
      expect(row.age, `${birth}@${on} oracle`).toBe(ageYears(birth, on));
      expect(row.adult).toBe(adultFrom(birth));
    }
    expect(adultFrom("2004-02-29")).toBe("2022-03-01");
    const [{ a }] = await owner<{ a: string }>(db, "select private.anniversary('2080-02-29', 20)::text as a");
    expect(a).toBe(anniversary("2080-02-29", 20));
  });

  it("age_years >= 18 <=> adult_from <= today over every birth date 2000-2009 and leap/common todays", async () => {
    const [{ bad, total }] = await owner<{ bad: number; total: number }>(db, `
      select count(*) filter (where (private.age_years(b, t) >= 18) <> (private.adult_from(b) <= t))::int as bad,
             count(*)::int as total
      from generate_series(date '2000-01-01', date '2009-12-31', interval '1 day') as g(b0)
      cross join lateral (select g.b0::date as b) bb
      cross join unnest(array[date '2024-02-28', date '2024-02-29', date '2024-03-01', date '2026-02-28',
                              date '2026-03-01', date '2027-12-31']) as t`);
    expect(total).toBeGreaterThan(20000);
    expect(bad).toBe(0);
  });

  it("start_onboarding accepts exactly 18 today and stores nothing for one day short", async () => {
    const t = await today();
    const exact = await newAuthUser();
    expect(await rpc(db, user(exact), "start_onboarding", ["架空太郎", "male", shiftYears(t, -18), true]))
      .toMatchObject({ ok: true, code: "ok", ref: exact });
    const young = await newAuthUser();
    const youngBirth = addDays(shiftYears(t, -18), 1);
    const before = await fingerprint(db);
    expect(await raised(() => rpc(db, user(young), "start_onboarding", ["架空次郎", "male", youngBirth, true]))).toBe("validation");
    expect(await fingerprint(db)).toBe(before);
    expect(await raised(() => rpc(db, user(young), "start_onboarding", ["架空次郎", "male", shiftYears(t, -30), false])))
      .toBe("validation");
    const rows = await owner(db, "select 1 from private.user_private where user_id = $1", [young]);
    expect(rows).toHaveLength(0);
    expect(await rpc(db, user(exact), "start_onboarding", ["架空太郎", "male", shiftYears(t, -18), true]))
      .toEqual(deny("invalid_state"));
  });
});

describe("onboarding to eligibility through the RPCs", () => {
  it("start -> affiliation -> profile (one bio, purposes) -> photo (E-1) -> complete -> submissions; no mode is needed", async () => {
    const me = await newAuthUser();
    const s = user(me);
    expect((await rpc(db, s, "start_onboarding", ["架空花子", "female", "2001-04-01", true])).ok).toBe(true);
    const cls = m.classes[3];
    expect(await raised(() => rpc(db, s, "set_affiliation", [cls.schoolId, m.classes[0].departmentId, cls.id]))).toBe("validation");
    expect((await rpc(db, s, "set_affiliation", [cls.schoolId, cls.departmentId, cls.id])).ok).toBe(true);
    expect((await rpc(db, s, "update_profile", ["架空花子", "female", "架空の自己紹介", ["talk", "friends"], ["読書"]],
      ["text", "text", "text", "text[]", "text[]"])).ok).toBe(true);
    expect(await owner(db, "select bio, purposes from public.profiles where user_id = $1", [me]))
      .toEqual([{ bio: "架空の自己紹介", purposes: ["friends", "talk"] }]);   // stored in the fixed order
    expect(await rpc(db, s, "complete_profile")).toEqual(deny("invalid_state"));   // no photo yet

    const photo = randomUUID();
    const register = (path: string, who = me) => asRole<{ ok: boolean; code: string; ref: string | null }>(db, "service_role", null,
      "select * from public.service_register_photo($1, $2)", [who, path]);
    expect(await raised(() => register(`${randomUUID()}/${photo}.webp`))).toBe("validation");
    expect(await raised(() => register(`${me}/../${photo}.webp`))).toBe("validation");
    expect((await register(`${me}/${photo}.webp`))[0]).toEqual({ ok: true, code: "ok", ref: photo });
    expect((await register(`${me}/${photo}.webp`))[0]).toEqual(deny("invalid_state"));
    // users cannot call the service-only RPC
    expect(await raised(() => asUser(db, s, "select * from public.service_register_photo($1, $2)", [me, `${me}/${randomUUID()}.webp`])))
      .toMatch(/permission denied/);

    expect((await rpc(db, s, "complete_profile")).ok).toBe(true);
    expect((await rpc(db, s, "submit_verification", ["age", ["synthetic:sample-1"]], ["public.verification_kind", "text[]"])).ok).toBe(true);
    expect((await rpc(db, s, "submit_verification", ["enrollment", ["synthetic:sample-2", "synthetic:sample-3"]],
      ["public.verification_kind", "text[]"])).ok).toBe(true);
    expect(await rpc(db, s, "submit_verification", ["age", ["synthetic:sample-1"]], ["public.verification_kind", "text[]"]))
      .toEqual(deny("invalid_state"));
    const [account] = await rpcRows<Record<string, unknown>>(db, s, "my_account");
    expect(account).toMatchObject({ user_id: me, has_profile: true, account_status: "active", profile_completed: true,
      age_verified: false, adult: true, affiliation_status: "pending", affiliation_confirmed: false,
      has_active_photo: true, eligible: false });
    expect(Object.keys(account)).not.toContain("has_mode");
    expect((account.birth_date as Date).toISOString().slice(0, 10)).toBe("2001-04-01");
    // own submissions: only the 8 granted columns
    const own = await asUser<Record<string, unknown>>(db, s,
      "select id, user_id, kind, status, created_at, decided_at, decision_reason, valid_until from public.verification_submissions");
    expect(own).toHaveLength(2);
    expect(await raised(() => asUser(db, s, "select reviewer_id from public.verification_submissions"))).toMatch(/permission denied/);
    expect(await raised(() => asUser(db, s, "select * from public.verification_submissions"))).toMatch(/permission denied/);
  });

  it("E-1 registration needs a confirmed account and a free position (max 6 active)", async () => {
    const unconfirmed = await createUser(db, { cls: m.classes[0], emailConfirmed: false });
    const register = (who: string) => asRole<{ ok: boolean; code: string }>(db, "service_role", null,
      "select * from public.service_register_photo($1, $2)", [who, `${who}/${randomUUID()}.webp`]);
    expect(await raised(() => register(unconfirmed))).toBe("forbidden");
    const full = await createUser(db, { cls: m.classes[0], photos: 5 });
    expect((await register(full))[0].ok).toBe(true);
    expect((await register(full))[0]).toEqual(deny("invalid_state"));
    const suspended = await createUser(db, { cls: m.classes[0], status: "suspended" });
    expect(await raised(() => register(suspended))).toBe("forbidden");
  });

  it("photos: last photo of a completed profile stays; reorder keeps ids and fills positions", async () => {
    const me = await createUser(db, { cls: m.classes[0], photos: 3 });
    const photos = (await owner<{ id: string }>(db,
      "select id::text as id from public.profile_photos where user_id = $1 order by position", [me])).map((r) => r.id);
    const other = await createUser(db, { cls: m.classes[0] });
    const [otherPhoto] = await owner<{ id: string }>(db, "select id::text as id from public.profile_photos where user_id = $1", [other]);
    expect(await rpc(db, user(me), "remove_photo", [otherPhoto.id])).toEqual(deny("not_available"));
    expect(await rpc(db, user(me), "reorder_photos", [[photos[0], photos[1]]], ["uuid[]"])).toEqual(deny("invalid_state"));
    const reversed = [...photos].reverse();
    expect((await rpc(db, user(me), "reorder_photos", [reversed], ["uuid[]"])).ok).toBe(true);
    const after = (await owner<{ id: string }>(db,
      "select id::text as id from public.profile_photos where user_id = $1 and status = 'active' order by position", [me])).map((r) => r.id);
    expect(after).toEqual(reversed);
    expect((await rpc(db, user(me), "remove_photo", [photos[0]])).ok).toBe(true);
    expect(await rpc(db, user(me), "remove_photo", [photos[0]])).toEqual(deny("invalid_state"));
    expect((await rpc(db, user(me), "remove_photo", [photos[1]])).ok).toBe(true);
    expect(await rpc(db, user(me), "remove_photo", [photos[2]])).toEqual(deny("invalid_state"));   // last one
  });

  it("account states: deactivate/reactivate, suspended and deleted are limited to my_account", async () => {
    const me = await createUser(db, { cls: m.classes[0] });
    expect(await rpc(db, user(me), "reactivate_account")).toEqual(deny("invalid_state"));
    expect((await rpc(db, user(me), "deactivate_account")).ok).toBe(true);
    expect((await rpc(db, user(me), "update_profile", ["新しい名前", "female", null, [], []],
      ["text", "text", "text", "text[]", "text[]"])).ok).toBe(true);   // own data while deactivated
    expect(await raised(() => rpc(db, user(me), "block_user", [randomUUID()]))).toBe("forbidden");
    expect((await rpc(db, user(me), "reactivate_account")).ok).toBe(true);

    const suspended = await createUser(db, { cls: m.classes[0], status: "suspended" });
    for (const [fn, args] of [["deactivate_account", []], ["reactivate_account", []], ["like_user", [randomUUID()]],
      ["block_user", [randomUUID()]]] as [string, unknown[]][]) {
      expect(await raised(() => rpc(db, user(suspended), fn, args)), fn).toBe("forbidden");
    }
    expect((await rpcRows<{ account_status: string }>(db, user(suspended), "my_account"))[0].account_status).toBe("suspended");

    const leaving = await createUser(db, { cls: m.classes[0] });
    const peer = await createUser(db, { cls: m.classes[4] });
    const { connection } = await connect(db, leaving, peer);
    expect((await rpc(db, user(leaving), "request_account_deletion")).ok).toBe(true);
    expect(await raised(() => rpc(db, user(leaving), "request_account_deletion"))).toBe("forbidden");
    expect(await raised(() => rpc(db, user(leaving), "reactivate_account"))).toBe("forbidden");
    const [k] = await owner<{ ended_reason: string }>(db, "select ended_reason::text from public.connections where id = $1", [connection]);
    expect(k.ended_reason).toBe("account_deleted");
    expect(await rpcRows(db, user(peer), "get_profile", [leaving])).toHaveLength(0);
  });
});

describe("update_profile: one bio and the purposes (order 34)", () => {
  const save = (me: string, bio: string | null, purposes: unknown) =>
    rpc(db, user(me), "update_profile", ["架空名", "other", bio, purposes, ["散歩"]], ["text", "text", "text", "text[]", "text[]"]);

  it("accepts the five codes in any order, stores them in the fixed order, and empty strings as no bio", async () => {
    const me = await createUser(db, { cls: m.classes[0] });
    expect((await save(me, "", ["talk", "study", "hobby", "partner", "friends"])).ok).toBe(true);
    expect(await owner(db, "select bio, purposes from public.profiles where user_id = $1", [me]))
      .toEqual([{ bio: null, purposes: ["friends", "partner", "hobby", "study", "talk"] }]);
    expect((await save(me, "あ".repeat(500), [])).ok).toBe(true);
    expect(await owner(db, "select char_length(bio) as n, purposes from public.profiles where user_id = $1", [me]))
      .toEqual([{ n: 500, purposes: [] }]);
  });

  it("refuses an unknown code, a duplicate, a null element, a null array or a 501-character bio with validation", async () => {
    const me = await createUser(db, { cls: m.classes[0] });
    const before = await fingerprint(db);
    for (const [bio, purposes] of [[null, ["romance"]], [null, ["friends", "friends"]], [null, ["friends", null]], [null, null],
      [null, ["FRIENDS"]], ["あ".repeat(501), []]] as [string | null, unknown][]) {
      expect(await raised(() => save(me, bio, purposes)), JSON.stringify(purposes)).toBe("validation");
    }
    expect(await fingerprint(db)).toBe(before);
    expect(await raised(() => owner(db, "update public.profiles set purposes = '{romance}' where user_id = $1", [me])))
      .toMatch(/profiles_purposes_check/);
  });

  it("complete_profile needs no mode, bio or purpose", async () => {
    const me = await newAuthUser();
    const s = user(me);
    expect((await rpc(db, s, "start_onboarding", ["架空次郎", "male", "2000-06-01", true])).ok).toBe(true);
    expect((await rpc(db, s, "set_affiliation", [m.classes[1].schoolId, m.classes[1].departmentId, m.classes[1].id])).ok).toBe(true);
    const photo = randomUUID();
    await asRole(db, "service_role", null, "select * from public.service_register_photo($1, $2)", [me, `${me}/${photo}.webp`]);
    expect((await rpc(db, s, "complete_profile")).ok).toBe(true);
    expect(await owner(db, "select bio, purposes from public.profiles where user_id = $1", [me])).toEqual([{ bio: null, purposes: [] }]);
  });
});

describe("NT-11 users cannot change state columns, roles or other rows", () => {
  it("direct writes are denied on every table, the state is not an update_profile argument", async () => {
    const me = await createUser(db, { cls: m.classes[0] });
    const s = user(me);
    const writes = [
      "update public.profiles set account_status = 'active' where user_id = auth.uid()",
      "update public.profiles set profile_completed_at = now() where user_id = auth.uid()",
      "update public.affiliations set status = 'confirmed' where user_id = auth.uid()",
      "update public.account_verifications set age_verified_at = now() where user_id = auth.uid()",
      "update public.verification_submissions set status = 'approved'",
      "insert into public.profile_photos (user_id, storage_path, position) values (auth.uid(), auth.uid()::text || '/x.webp', 5)",
      "delete from public.likes",
      "insert into public.likes (liker_id, liked_id) values (auth.uid(), gen_random_uuid())",
      "update public.privacy_settings set hide_same_class = false",
      "delete from public.blocks",
      "insert into public.connections (user_low, user_high, origin_request_id, mode) values (auth.uid(), auth.uid(), gen_random_uuid(), 'friends')",
      "insert into private.staff_roles (user_id, role) values (auth.uid(), 'admin')",
      "update private.app_settings set value = 'upload'",
      "update private.user_private set birth_date = '1990-01-01'",
      "truncate public.messages",
    ];
    for (const sql of writes) {
      expect(await raised(() => asUser(db, s, sql)), sql).toMatch(/permission denied/);
    }
    expect(await raised(() => asUser(db, s,
      "select * from public.update_profile('x', 'female', null, '{}', '{}', 'suspended')"))).toMatch(/does not exist/);
  });

  it("the birth date is fixed after age approval and admin RPCs are forbidden for students", async () => {
    const me = await createUser(db, { cls: m.classes[0], birthDate: "2000-01-01" });   // fixture: age approved and locked
    expect(await rpc(db, user(me), "update_birth_date", ["1999-01-01"])).toEqual(deny("invalid_state"));
    const [{ birth }] = await owner<{ birth: string }>(db, "select birth_date::text as birth from private.user_private where user_id = $1", [me]);
    expect(birth).toBe("2000-01-01");
    const open = await createUser(db, { cls: m.classes[0], ageVerified: false });
    expect((await rpc(db, user(open), "update_birth_date", ["1999-02-02"])).ok).toBe(true);
    for (const [fn, args] of [["admin_claim_submission", [randomUUID()]], ["admin_grant_role", [me, "admin"]],
      ["admin_set_account_status", [open, "suspended", null]], ["admin_list_submissions", [null]]] as [string, unknown[]][]) {
      expect(await raised(() => rpcRows(db, user(me), fn, args)), fn).toBe("forbidden");
    }
  });
});

describe("NT-22 synthetic intake only", () => {
  it("rejects non-synthetic references while intake is synthetic; users cannot change the setting", async () => {
    const me = await createUser(db, { cls: m.classes[0], ageVerified: false });
    const casts = ["public.verification_kind", "text[]"];
    for (const refs of [[`${me}/doc/1.webp`], ["synthetic:sample-4"], ["https://example.invalid/a.webp"], []]) {
      expect(await raised(() => rpc(db, user(me), "submit_verification", ["age", refs], casts)), refs.join()).toBe("validation");
    }
    expect((await rpc(db, user(me), "submit_verification", ["age", ["synthetic:sample-3"]], casts)).ok).toBe(true);
    expect(await raised(() => asUser(db, user(me), "select * from private.app_settings"))).toMatch(/permission denied/);
    const [{ allowed }] = await asUser<{ allowed: boolean }>(db, user(me),
      "select private.rls_document_upload_allowed($1) as allowed", [`${me}/sub/1.webp`]);
    expect(allowed).toBe(false);
  });
});
