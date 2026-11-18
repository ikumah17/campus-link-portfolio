// NT-05, NT-06, NT-07, NT-08 and the PG part of NT-20 (docs/04_DATABASE.md §13.2):
// DB judgment vs the independent TypeScript oracle over generated fictional worlds.
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { connect, createMasters, createUser, missingId, type Masters } from "./fixtures";
import { asUser, deny, freshDb, owner, raised, rpc, rpcRows, user } from "./harness";
import { Oracle, snapshot } from "./oracle";
import { DEFECTS, generateWorld, type World } from "./world";

const DISCOVER_CASTS = ["int", "int", "text[]", "uuid[]", "uuid", "int"];

async function visibleTargets(db: PGlite, viewer: string, targets: string[]) {
  const rows = await asUser<{ target: string; visible: boolean }>(db, user(viewer), `
    select t.id::text as target, exists (select 1 from public.get_profile(t.id)) as visible
    from unnest($1::uuid[]) as t(id)`, [targets]);
  return new Map(rows.map((r) => [r.target, r.visible]));
}

/** every page of list_my_likes in one direction (small pages exercise the keyset) */
async function likesAll(db: PGlite, viewer: string, direction: "sent" | "received", limit = 3) {
  const ids: string[] = [];
  let before: { at: string; id: string } | null = null;
  for (;;) {
    const rows: { counterpart_id: string; liked_at: string }[] = await asUser<{ counterpart_id: string; liked_at: string }>(
      db, user(viewer), "select counterpart_id::text, liked_at::text from public.list_my_likes($1, $2::timestamptz, $3::uuid, $4)",
      [direction, before?.at ?? null, before?.id ?? null, limit]);
    ids.push(...rows.map((r) => r.counterpart_id));
    if (rows.length < limit) break;
    const last = rows[rows.length - 1];
    before = { at: last.liked_at, id: last.counterpart_id };
  }
  return ids;
}

interface DiscoverFilters { minAge?: number; maxAge?: number; genders?: string[]; schools?: string[] }

async function discoverAll(db: PGlite, viewer: string, f: DiscoverFilters = {}, limit = 50) {
  const ids: string[] = [];
  let after: string | null = null;
  for (;;) {
    const rows: { user_id: string }[] = await rpcRows<{ user_id: string }>(db, user(viewer), "discover_profiles",
      [f.minAge ?? null, f.maxAge ?? null, f.genders ?? null, f.schools ?? null, after, limit], DISCOVER_CASTS);
    ids.push(...rows.map((r) => r.user_id));
    if (rows.length < limit) break;
    after = rows[rows.length - 1].user_id;
  }
  return ids;
}

describe("NT-05 each missing eligibility condition hides both ways", () => {
  let db: PGlite;
  let masters: Masters;
  beforeAll(async () => {
    db = await freshDb();
    masters = await createMasters(db, "nt05");
  });

  it("control: two eligible users in different schools see each other", async () => {
    const a = await createUser(db, { cls: masters.classes[0] });
    const b = await createUser(db, { cls: masters.classes[7] });
    expect(await rpcRows(db, user(a), "get_profile", [b])).toHaveLength(1);
    expect(await rpcRows(db, user(b), "get_profile", [a])).toHaveLength(1);
  });

  for (const [defect, make] of Object.entries(DEFECTS)) {
    it(`${defect}: neither side sees the other in detail or discover`, async () => {
      const a = await createUser(db, { cls: masters.classes[0] });
      const b = await createUser(db, { cls: masters.classes[7], ...make(new Date()) });
      expect(await rpcRows(db, user(a), "get_profile", [b]), `${defect} a->b`).toHaveLength(0);
      expect(await discoverAll(db, a)).not.toContain(b);
      expect(await rpcRows(db, user(a), "get_like_state", [b]), `${defect} like state`).toEqual([]);
      // the ineligible side cannot browse the eligible one either (a deleted account is no caller at all, ACCOUNT-003)
      const [{ ok }] = await owner<{ ok: boolean }>(db, "select private.pair_visible($1, $2) as ok", [b, a]);
      expect(ok).toBe(false);
      if (defect === "deleted") {
        expect(await raised(() => rpcRows(db, user(b), "get_profile", [a]))).toBe("forbidden");
        expect(await raised(() => discoverAll(db, b))).toBe("forbidden");
        return;
      }
      expect(await rpcRows(db, user(b), "get_profile", [a])).toHaveLength(0);
      expect(await discoverAll(db, b)).toEqual([]);
    });
  }
});

describe("NT-06 hiding is symmetric for every setting x relation x direction", () => {
  let db: PGlite;
  let m: Masters;
  beforeAll(async () => {
    db = await freshDb();
    m = await createMasters(db, "nt06");
  });

  // classes[0] is school0/dept0; [1] same dept; [2] same school other dept; [4] other school
  const relations = { same_class: 0, same_department: 1, same_school: 2, other_school: 4 } as const;
  type Setting = "none" | "hide_same_class" | "hide_same_department" | "hide_same_school"
    | "hidden_school" | "hidden_department" | "hidden_class" | "hidden_unrelated" | "no_settings_row";
  const settings: Setting[] = ["none", "hide_same_class", "hide_same_department", "hide_same_school",
    "hidden_school", "hidden_department", "hidden_class", "hidden_unrelated", "no_settings_row"];

  function expectedHidden(setting: Setting, relation: keyof typeof relations): boolean {
    switch (setting) {
      case "none": case "hidden_unrelated": return false;
      case "hide_same_class": case "no_settings_row": return relation === "same_class";
      case "hide_same_department": return relation === "same_class" || relation === "same_department";
      case "hide_same_school": return relation !== "other_school";
      default: return true;   // the owner hides exactly the other's school / department / class
    }
  }

  it("pair_visible(a,b) = pair_visible(b,a) = oracle = expected for all 72 cases", async () => {
    const off = { hide_same_class: false, hide_same_department: false, hide_same_school: false };
    const cases: { a: string; b: string; expected: boolean; label: string }[] = [];
    for (const [relation, index] of Object.entries(relations) as [keyof typeof relations, number][]) {
      const other = m.classes[index];
      for (const setting of settings) {
        for (const direction of ["a", "b"] as const) {
          const ownerHides = {
            settings: setting === "no_settings_row" ? null
              : setting.startsWith("hide_") ? { ...off, [setting]: true } : off,
            hidden: setting === "hidden_school" ? { schools: [direction === "a" ? other.schoolId : m.classes[0].schoolId] }
              : setting === "hidden_department" ? { departments: [direction === "a" ? other.departmentId : m.classes[0].departmentId] }
              : setting === "hidden_class" ? { classes: [direction === "a" ? other.id : m.classes[0].id] }
              : setting === "hidden_unrelated" ? { classes: [m.classes[7].id] } : undefined,
          };
          const plain = { settings: off };
          const a = await createUser(db, { cls: m.classes[0], ...(direction === "a" ? ownerHides : plain) });
          const b = await createUser(db, { cls: other, ...(direction === "b" ? ownerHides : plain) });
          cases.push({ a, b, expected: !expectedHidden(setting, relation), label: `${relation}/${setting}/${direction}` });
        }
      }
    }
    expect(cases).toHaveLength(72);
    const oracle = new Oracle(await snapshot(db));
    for (const c of cases) {
      const [row] = await owner<{ ab: boolean; ba: boolean }>(db,
        "select private.pair_visible($1, $2) as ab, private.pair_visible($2, $1) as ba", [c.a, c.b]);
      expect(row.ab, c.label).toBe(row.ba);
      expect(row.ab, c.label).toBe(oracle.pairVisible(c.a, c.b));
      expect(row.ab, c.label).toBe(c.expected);
    }
  });
});

describe("generated world: DB judgment equals the oracle (NT-06, NT-07, NT-20)", () => {
  let db: PGlite;
  let world: World;
  let oracle: Oracle;
  let all: string[];
  let deleted: Set<string>;

  beforeAll(async () => {
    db = await freshDb();
    world = await generateWorld(db, 20261027, 40);
    // ACCOUNT-003: a deleted viewer is refused as a caller (forbidden) instead of seeing nothing
    deleted = new Set((await owner<{ id: string }>(db, "select user_id as id from public.profiles where account_status = 'deleted'")).map((r) => r.id));
    // existing relations: a few active connections between visible pairs, and likes between any two users (visible
    // or not, one way or both) written as owner SQL, so the lists must filter them
    const pre = new Oracle(await snapshot(db));
    const visiblePairs = world.users.flatMap((a) => world.users.filter((b) => a < b && pre.pairVisible(a, b)).map((b) => [a, b]));
    for (const [a, b] of visiblePairs.slice(0, 3)) await connect(db, a, b);
    const likes: string[] = [];
    world.users.forEach((a, i) => world.users.forEach((b, j) => {
      if (a !== b && (i * 7 + j * 3) % 11 === 0) likes.push(`('${a}', '${b}', now() - interval '${(i + j) % 5} hours')`);
    }));
    for (const [a, b] of visiblePairs.slice(0, 2)) likes.push(`('${a}', '${b}', now())`);   // a stale like on a connected pair
    await db.exec(`insert into public.likes (liker_id, liked_id, created_at) values ${likes.join(", ")} on conflict do nothing`);
    oracle = new Oracle(await snapshot(db));
    all = (await owner<{ id: string }>(db, "select user_id as id from public.profiles")).map((r) => r.id);
  });

  it("the world has visible and hidden pairs, eligible and ineligible users", () => {
    const eligible = world.users.filter((u) => oracle.eligible(u)).length;
    const pairs = world.users.flatMap((a) => world.users.map((b) => oracle.pairVisible(a, b)));
    expect(eligible).toBeGreaterThan(15);
    expect(eligible).toBeLessThan(world.users.length);
    expect(pairs.filter(Boolean).length).toBeGreaterThan(50);
  });

  it("pair_visible and can_see_identity match the oracle for every pair (identity = pair_visible, order 34)", async () => {
    const rows = await owner<{ a: string; b: string; pv: boolean; identity: boolean }>(db, `
      select a.id::text as a, b.id::text as b, private.pair_visible(a.id, b.id) as pv,
             private.can_see_identity(a.id, b.id) as identity
      from unnest($1::uuid[]) as a(id) cross join unnest($1::uuid[]) as b(id)`, [world.users]);
    expect(rows).toHaveLength(world.users.length ** 2);
    const byPair = new Map(rows.map((r) => [`${r.a}>${r.b}`, r]));
    for (const r of rows) {
      expect(r.pv, `${r.a}>${r.b}`).toBe(oracle.pairVisible(r.a, r.b));
      expect(r.pv).toBe(byPair.get(`${r.b}>${r.a}`)!.pv);   // symmetric
      expect(r.identity).toBe(oracle.canSeeIdentity(r.a, r.b));
      expect(r.identity).toBe(r.pv);
    }
  });

  it("NT-07: get_profile returns a row exactly when the pair is visible, for every viewer x target", async () => {
    expect(deleted.size).toBeGreaterThan(0);
    for (const viewer of world.users) {
      if (deleted.has(viewer)) {
        expect(await raised(() => visibleTargets(db, viewer, all)), viewer).toBe("forbidden");
        continue;
      }
      const visible = await visibleTargets(db, viewer, all);
      for (const target of all) {
        expect(visible.get(target), `${viewer}>${target}`).toBe(oracle.canViewProfile(viewer, target));
      }
    }
  });

  it("NT-07: discover_profiles equals the oracle set minus self, connections and own likes, across pages", async () => {
    // people the viewer liked and connected people are excluded; people who liked the viewer stay
    const related = (v: string, t: string) => oracle.activeConnection(v, t) || oracle.liked(v, t);
    let nonEmpty = 0;
    let likedMeShown = 0;
    for (const viewer of world.users) {
      if (deleted.has(viewer)) {
        expect(await raised(() => discoverAll(db, viewer, {}, 3)), viewer).toBe("forbidden");
        continue;
      }
      const expected = all.filter((t) => oracle.canViewProfile(viewer, t) && !related(viewer, t)).sort();
      const got = await discoverAll(db, viewer, {}, 3);   // small pages exercise the keyset
      expect(got, viewer).toEqual(expected);
      if (got.length) nonEmpty += 1;
      likedMeShown += got.filter((t) => oracle.liked(t, viewer)).length;
    }
    expect(nonEmpty).toBeGreaterThan(10);
    expect(likedMeShown).toBeGreaterThan(0);
  });

  it("list_my_likes (both directions, across pages) and get_like_state equal the oracle for every viewer", async () => {
    let sentTotal = 0;
    let receivedTotal = 0;
    let filteredLikes = 0;
    for (const viewer of world.users) {
      if (deleted.has(viewer)) {
        expect(await raised(() => likesAll(db, viewer, "sent")), viewer).toBe("forbidden");
        continue;
      }
      const shown = (other: string) => oracle.pairVisible(viewer, other) && !oracle.activeConnection(viewer, other);
      const sent = all.filter((t) => oracle.liked(viewer, t) && shown(t));
      const received = all.filter((t) => oracle.liked(t, viewer) && shown(t));
      filteredLikes += all.filter((t) => oracle.liked(viewer, t) && !shown(t)).length;
      const gotSent = await likesAll(db, viewer, "sent");
      const gotReceived = await likesAll(db, viewer, "received");
      expect([...gotSent].sort(), `${viewer} sent`).toEqual([...sent].sort());
      expect([...gotReceived].sort(), `${viewer} received`).toEqual([...received].sort());
      sentTotal += gotSent.length;
      receivedTotal += gotReceived.length;
      const states = await asUser<{ target: string; i_liked: boolean; liked_me: boolean; has_conversation: boolean }>(db, user(viewer), `
        select t.id::text as target, s.i_liked, s.liked_me, s.conversation_id is not null as has_conversation
        from unnest($1::uuid[]) as t(id) cross join lateral public.get_like_state(t.id) s
        where t.id <> $2`, [all, viewer]);
      const byTarget = new Map(states.map((r) => [r.target, r]));
      for (const t of all.filter((x) => x !== viewer)) {
        const row = byTarget.get(t);
        if (!oracle.pairVisible(viewer, t)) {
          expect(row, `${viewer}>${t} invisible`).toBeUndefined();
          continue;
        }
        expect(row, `${viewer}>${t}`).toEqual({ target: t, i_liked: oracle.liked(viewer, t), liked_me: oracle.liked(t, viewer),
          has_conversation: oracle.activeConnection(viewer, t) });
      }
    }
    expect(sentTotal).toBeGreaterThan(5);
    expect(receivedTotal).toBe(sentTotal);
    expect(filteredLikes).toBeGreaterThan(0);
  });

  it("NT-07: discover filters only narrow (age, gender, school) and match the oracle", async () => {
    const rows = await owner<{ id: string; gender: string; school: string }>(db, `
      select p.user_id as id, p.gender, a.school_id as school
      from public.profiles p join public.affiliations a on a.user_id = p.user_id`);
    const info = new Map(rows.map((r) => [r.id, r]));
    const filters: Required<DiscoverFilters>[] = [
      { minAge: 20, maxAge: 26, genders: ["female", "other"], schools: [world.masters.schools[0]] },
      { minAge: 18, maxAge: 120, genders: ["male"], schools: world.masters.schools },
      { minAge: 25, maxAge: 40, genders: ["female", "male", "other"], schools: [world.masters.schools[1]] },
    ];
    for (const viewer of world.users.filter((u) => !deleted.has(u)).slice(0, 20)) {
      for (const f of filters) {
        const unfiltered = await discoverAll(db, viewer);
        const got = await discoverAll(db, viewer, f);
        const expected = unfiltered.filter((t) => {
          const age = oracle.ageOf(t);
          return age >= f.minAge && age <= f.maxAge && f.genders.includes(info.get(t)!.gender)
            && f.schools.includes(info.get(t)!.school);
        });
        expect(got).toEqual(expected);
      }
    }
  });

  it("profile_view carries only the designed fields with the owner's show settings", async () => {
    const pairs = world.users.flatMap((v) => world.users.filter((t) => oracle.canViewProfile(v, t)).map((t) => [v, t]));
    expect(pairs.length).toBeGreaterThan(5);
    for (const [viewer, target] of pairs.slice(0, 15)) {
      const [view] = await rpcRows<Record<string, unknown>>(db, user(viewer), "get_profile", [target]);
      expect(Object.keys(view).sort()).toEqual(["age", "bio", "class_name", "department_name", "display_name",
        "gender", "hobbies", "photo_ids", "purposes", "school_name", "user_id"]);
      const [expected] = await owner<{ show_department: boolean | null; show_class: boolean | null; photos: string[] }>(db, `
        select s.show_department, s.show_class,
               array(select id::text from public.profile_photos where user_id = $1 and status = 'active' order by position) as photos
        from (select $1::uuid as id) u left join public.privacy_settings s on s.user_id = u.id`, [target]);
      expect(view.age).toBe(oracle.ageOf(target));
      expect(view.department_name !== null).toBe(expected.show_department === true);
      expect(view.class_name !== null).toBe(expected.show_class === true);
      expect(view.photo_ids).toEqual(expected.photos);
      expect(view.bio).toBe("架空の自己紹介");
      const [{ purposes }] = await owner<{ purposes: string[] }>(db, "select purposes from public.profiles where user_id = $1", [target]);
      expect(view.purposes).toEqual(purposes);
    }
  });

  it("NT-20 (PG): authorize_photo_delivery returns exactly the oracle-allowed photos for every viewer", async () => {
    const photos = (await owner<{ id: string }>(db, "select id::text as id from public.profile_photos")).map((r) => r.id);
    const missing = Array.from({ length: 3 }, missingId);
    let allowedTotal = 0;
    for (const viewer of world.users) {
      for (let i = 0; i < photos.length; i += 57) {
        const batch = [...photos.slice(i, i + 57), ...missing];
        if (deleted.has(viewer)) {
          expect(await raised(() => rpcRows(db, user(viewer), "authorize_photo_delivery", [batch], ["uuid[]"])), viewer).toBe("forbidden");
          continue;
        }
        const got = (await rpcRows<{ photo_id: string }>(db, user(viewer), "authorize_photo_delivery", [batch], ["uuid[]"]))
          .map((r) => r.photo_id).sort();
        const expected = batch.filter((p) => oracle.photoDeliveryAllowed(viewer, p)).sort();
        expect(got, viewer).toEqual(expected);
        allowedTotal += got.length;
      }
    }
    expect(allowedTotal).toBeGreaterThan(50);
  });

  it("the comparison is sensitive: a hides() that ignores per-item hiding disagrees with the oracle", async () => {
    const broken = (await db.clone()) as PGlite;
    await broken.exec(`
      create or replace function private.hides(p_owner uuid, p_other uuid) returns boolean
      language sql stable security definer set search_path = '' as $$
        select coalesce((
          select (coalesce(s.hide_same_class, true) and ao.class_id = ax.class_id)
              or (coalesce(s.hide_same_department, false) and ao.department_id = ax.department_id)
              or (coalesce(s.hide_same_school, false) and ao.school_id = ax.school_id)
          from public.affiliations ao join public.affiliations ax on ax.user_id = p_other
          left join public.privacy_settings s on s.user_id = p_owner
          where ao.user_id = p_owner), true)
      $$;`);
    const rows = await owner<{ a: string; b: string; pv: boolean }>(broken, `
      select a.id::text as a, b.id::text as b, private.pair_visible(a.id, b.id) as pv
      from unnest($1::uuid[]) as a(id) cross join unnest($1::uuid[]) as b(id)`, [world.users]);
    expect(rows.filter((r) => r.pv !== oracle.pairVisible(r.a, r.b)).length).toBeGreaterThan(0);
    await broken.close();
  });
});

describe("NT-08 rejection reasons cannot be told apart", () => {
  let db: PGlite;
  let m: Masters;
  beforeAll(async () => {
    db = await freshDb();
    m = await createMasters(db, "nt08");
  });

  it("missing / blocked either way / hidden / ineligible: same 0 rows, same outcome, attempts recorded", async () => {
    const viewer = await createUser(db, { cls: m.classes[0], settings: { hide_same_school: true } });
    const visible = await createUser(db, { cls: m.classes[4] });
    const blockedByViewer = await createUser(db, { cls: m.classes[4] });
    const blockedViewer = await createUser(db, { cls: m.classes[5] });
    const hiddenByViewer = await createUser(db, { cls: m.classes[2] });   // same school, viewer hides same school
    const hidesViewer = await createUser(db, { cls: m.classes[6], hidden: { schools: [m.classes[0].schoolId] } });
    const ineligible = await createUser(db, { cls: m.classes[4], affiliation: "unconfirmed" });
    await owner(db, "insert into public.blocks (blocker_id, blocked_id) values ($1, $2), ($3, $1)",
      [viewer, blockedByViewer, blockedViewer]);
    const photoOf = async (u: string) =>
      (await owner<{ id: string }>(db, "select id::text as id from public.profile_photos where user_id = $1 limit 1", [u]))[0].id;

    // control: the visible target really is reachable
    expect(await rpcRows(db, user(viewer), "get_profile", [visible])).toHaveLength(1);
    expect(await rpcRows(db, user(viewer), "authorize_photo_delivery", [[await photoOf(visible)]], ["uuid[]"])).toHaveLength(1);

    const targets = { missing: missingId(), blockedByViewer, blockedViewer, hiddenByViewer, hidesViewer, ineligible };
    const before = (await owner<{ n: number }>(db,
      "select count(*)::int as n from private.rate_limit_events where user_id = $1 and action = 'like'", [viewer]))[0].n;
    const outcomes: unknown[] = [];
    for (const [label, target] of Object.entries(targets)) {
      expect(await rpcRows(db, user(viewer), "get_profile", [target]), label).toEqual([]);
      expect(await rpcRows(db, user(viewer), "get_like_state", [target]), label).toEqual([]);
      const photo = label === "missing" ? missingId() : await photoOf(target);
      expect(await rpcRows(db, user(viewer), "authorize_photo_delivery", [[photo]], ["uuid[]"]), label).toEqual([]);
      outcomes.push(await rpc(db, user(viewer), "like_user", [target]));
    }
    for (const outcome of outcomes) expect(outcome).toEqual(deny("not_available"));
    // separate transaction: no like row, exactly one recorded attempt per call
    const [{ likes }] = await owner<{ likes: number }>(db,
      "select count(*)::int as likes from public.likes where liker_id = $1", [viewer]);
    expect(likes).toBe(0);
    const after = (await owner<{ n: number }>(db,
      "select count(*)::int as n from private.rate_limit_events where user_id = $1 and action = 'like'", [viewer]))[0].n;
    expect(after - before).toBe(Object.keys(targets).length);
  });

  it("authorize_photo_delivery validates the batch size before anything else", async () => {
    const viewer = await createUser(db, { cls: m.classes[0] });
    for (const batch of [[], Array.from({ length: 61 }, missingId), [missingId(), null]]) {
      expect(await raised(() => rpcRows(db, user(viewer), "authorize_photo_delivery", [batch], ["uuid[]"]))).toBe("validation");
    }
  });
});
