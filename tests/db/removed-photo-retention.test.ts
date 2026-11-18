// RETENTION-005 (order 28, docs/04_DATABASE.md §9, §11): removed photos' objects in the retention candidates,
// compared with the order-27 output on the same fixture, and the path rule and folder cap of the document upload policy.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaff, createUser, type AccountStatus } from "./fixtures";
import { asRole, asUser, freshDb, MIGRATIONS_DIR, migrationFiles, owner, seedSqlFor, raised, user } from "./harness";

interface Candidate {
  kind: string;
  user_id: string;
  submission_id: string | null;
  storage_path: string | null;
}

const ORDER_27 = "20261115120027_orphan_document_retention.sql";
const ORDER_28 = "20261116120028_removed_photo_retention.sql";
const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** a fixed sweep time in the past, so every boundary is exact */
const T = new Date(Math.floor((Date.now() - 60 * DAY) / 1000) * 1000);
const at = (offsetMs: number) => new Date(T.getTime() + offsetMs).toISOString();
const DUE = -30 * DAY;
const AGE = -24 * HOUR;

const candidates = (target: PGlite, now: string = T.toISOString()) =>
  asRole<Candidate>(target, "service_role", null, "select * from public.service_retention_candidates($1::timestamptz)", [now]);

function sorted(rows: Candidate[]): Candidate[] {
  const key = (r: Candidate) => [r.kind, r.user_id, r.submission_id ?? "", r.storage_path ?? ""].join("|");
  return [...rows].sort((a, b) => key(a).localeCompare(key(b)));
}

describe("RETENTION-005 removed photos' objects (order 28)", () => {
  let old: PGlite;
  let before: Candidate[];
  let after: Candidate[];
  let expectedRemoved: Candidate[];
  let edge: string;
  let goneRemoved: string;
  const notListed: string[] = [];

  const put = (bucket: string, name: string, createdAt: string | null) =>
    owner(old, "insert into storage.objects (bucket_id, name, created_at) values ($1, $2, $3)", [bucket, name, createdAt]);
  const photos = (userId: string, status: "active" | "removed") =>
    owner<{ storage_path: string }>(old,
      "select storage_path from public.profile_photos where user_id = $1 and status = $2 order by storage_path", [userId, status])
      .then((rows) => rows.map((r) => r.storage_path));

  beforeAll(async () => {
    // shim, orders 1-27 and the seed: a database before order 28
    old = await PGlite.create();
    const root = join(MIGRATIONS_DIR, "..", "..");
    const all = migrationFiles();
    const upTo27 = all.slice(0, all.indexOf(ORDER_27) + 1);
    expect(upTo27.at(-1)).toBe(ORDER_27);
    for (const file of [join(root, "tests", "db", "shim.sql"), ...upTo27.map((f) => join(MIGRATIONS_DIR, f))]) {
      const sql = readFileSync(file, "utf8");
      await old.transaction((tx) => tx.exec(sql));
    }
    const seed = seedSqlFor(ORDER_27);
    await old.transaction((tx) => tx.exec(seed));

    // every earlier kind: a due account with active and removed photos and a document, due documents,
    // an orphan photo, an orphan document and a kept former reviewer
    const staffer = await createStaff(old, ["reviewer"]);
    const gone = await createUser(old, { status: "deleted", photos: 2, removedPhotos: 1 });
    await owner(old, "update public.profiles set deleted_at = $2 where user_id = $1", [gone, at(DUE)]);
    const decided = await createUser(old);
    for (const [userId, status, decidedAt] of [[gone, "submitted", null], [decided, "approved", at(DUE)], [decided, "rejected", at(DUE - DAY)]] as const) {
      const ref = `${userId}/${randomUUID()}.webp`;
      const staffed = status !== "submitted";
      await owner(old, `
        insert into public.verification_submissions
          (id, user_id, kind, status, intake_mode, document_refs, reviewer_id, claimed_at, decided_at, decision_reason)
        values ($1, $2, 'age', $3, 'upload', $4, $5, $6, $7, $8)`,
      [randomUUID(), userId, status, [ref], staffed ? staffer : null, staffed ? at(-90 * DAY) : null, decidedAt,
        status === "rejected" ? "unreadable" : null]);
      await put("verification-documents", ref, at(-90 * DAY));
    }
    for (const path of [...await photos(gone, "active"), ...await photos(gone, "removed")]) {
      await put("profile-photos", path, at(-90 * DAY));
    }
    [goneRemoved] = await photos(gone, "removed");
    notListed.push(...await photos(gone, "active"));
    const owner1 = await createUser(old, { photos: 2, removedPhotos: 4 });
    await put("profile-photos", `${owner1}/${randomUUID()}.webp`, at(-90 * DAY));   // an orphan photo with no row
    await put("verification-documents", `${owner1}/${randomUUID()}.webp`, at(-90 * DAY));   // an orphan document
    await owner(old, "insert into public.profiles (user_id, display_name, gender, account_status) values ($1, 'Synthetic reviewer', 'female', 'deleted')", [staffer]);
    await owner(old, "update public.profiles set deleted_at = $2 where user_id = $1", [staffer, at(DUE)]);

    // active photos, stored long ago: never listed
    for (const path of await photos(owner1, "active")) {
      await put("profile-photos", path, at(-90 * DAY));
      notListed.push(path);
    }
    // removed photos of owner1: 24 hours or older listed, younger or without an object not
    const [older, atEdge, young, missing] = await photos(owner1, "removed");
    edge = atEdge;
    await put("profile-photos", older, at(AGE - 1));
    await put("profile-photos", atEdge, at(AGE));
    await put("profile-photos", young, at(AGE + 1));
    notListed.push(young, missing);
    expectedRemoved = [older, atEdge].map((path) => ({ kind: "orphan_photo", user_id: owner1, submission_id: null, storage_path: path }));

    // removed photos of accounts in every other state, including deleted but not yet due, are listed for their owner
    for (const status of ["deactivated", "suspended", "deleted"] as AccountStatus[]) {
      const id = await createUser(old, { status, photos: 1, removedPhotos: 1 });
      if (status === "deleted") await owner(old, "update public.profiles set deleted_at = $2 where user_id = $1", [id, at(DUE + 1)]);
      for (const path of await photos(id, "active")) {
        await put("profile-photos", path, at(-90 * DAY));
        notListed.push(path);
      }
      for (const path of await photos(id, "removed")) {
        await put("profile-photos", path, at(-90 * DAY));
        expectedRemoved.push({ kind: "orphan_photo", user_id: id, submission_id: null, storage_path: path });
      }
    }

    before = await candidates(old);
    const sql = readFileSync(join(MIGRATIONS_DIR, ORDER_28), "utf8");
    await old.transaction((tx) => tx.exec(sql));
    after = await candidates(old);
  });
  afterAll(async () => { await old?.close(); });

  it("is order 28", () => {
    expect(migrationFiles()[27]).toBe(ORDER_28);
    expect(migrationFiles().length).toBeGreaterThanOrEqual(28);   // order 29 (SEC-013) follows
  });

  it("adds exactly the removed photos 24 hours or older; every other row is the order-27 output, in the same order", () => {
    expect(new Set(before.map((r) => r.kind)))
      .toEqual(new Set(["account", "document", "orphan_document", "orphan_photo", "skipped_reviewer"]));
    const added = new Set(expectedRemoved.map((r) => r.storage_path));
    for (const r of before) expect(added.has(r.storage_path), r.storage_path ?? r.kind).toBe(false);
    expect(after.filter((r) => !added.has(r.storage_path))).toEqual(before);
    expect(sorted(after.filter((r) => added.has(r.storage_path)))).toEqual(sorted(expectedRemoved));
    const kinds = after.map((r) => r.kind);
    expect(kinds).toEqual([...kinds].sort());
    expect(new Set(after.map((r) => JSON.stringify(r))).size).toBe(after.length);
  });

  it("never lists an active, younger or deleted-object photo; a due account's removed photo stays under account only", () => {
    const paths = new Set(after.filter((r) => r.kind === "orphan_photo").map((r) => r.storage_path));
    for (const name of notListed) expect(after.some((r) => r.storage_path === name && r.kind !== "account"), name).toBe(false);
    for (const name of notListed) expect(paths.has(name), name).toBe(false);
    expect(after.filter((r) => r.storage_path === goneRemoved).map((r) => r.kind)).toEqual(["account"]);
    // one path, one kind
    const byPath = new Map<string, Set<string>>();
    for (const r of after.filter((x) => x.storage_path !== null)) {
      byPath.set(r.storage_path!, (byPath.get(r.storage_path!) ?? new Set()).add(r.kind));
    }
    for (const [path, kinds] of byPath) expect(kinds.size, path).toBe(1);
    for (const r of after.filter((x) => x.kind === "orphan_photo")) {
      expect(r.storage_path!.startsWith(`${r.user_id}/`)).toBe(true);
      expect(r.submission_id).toBeNull();
    }
  });

  it("measures the 24 hours against p_now; a re-run after the deletes is the order-27 output and the rows stay", async () => {
    const earlier = await candidates(old, at(-1));
    expect(earlier.some((r) => r.storage_path === edge)).toBe(false);
    expect(earlier.some((r) => r.storage_path === expectedRemoved[0].storage_path)).toBe(true);
    const own = (await old.clone()) as PGlite;
    try {
      const listed = expectedRemoved.map((r) => r.storage_path);
      await owner(own, "delete from storage.objects where bucket_id = 'profile-photos' and name = any($1::text[])", [listed]);
      expect(await candidates(own)).toEqual(before);
      const [row] = await owner<{ n: number }>(own,
        "select count(*)::int as n from public.profile_photos where status = 'removed' and storage_path = any($1::text[])", [listed]);
      expect(row.n).toBe(listed.length);
    } finally { await own.close(); }
  });

  it("keeps both functions' signatures, definer, search_path, volatility and grants", async () => {
    const fns = await owner<{ name: string; definer: boolean; config: string[]; volatility: string; result: string; args: string }>(old, `
      select n.nspname || '.' || p.proname as name, p.prosecdef as definer, p.proconfig as config,
             p.provolatile::text as volatility, pg_get_function_result(p.oid) as result, pg_get_function_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where (n.nspname, p.proname) in (('public', 'service_retention_candidates'), ('private', 'rls_document_upload_allowed'))
      order by 1`);
    expect(fns).toEqual([
      { name: "private.rls_document_upload_allowed", definer: true, config: ['search_path=""'], volatility: "s",
        result: "boolean", args: "p_object_name text" },
      { name: "public.service_retention_candidates", definer: true, config: ['search_path=""'], volatility: "s",
        result: "TABLE(kind text, user_id uuid, submission_id uuid, storage_path text)",
        args: "p_now timestamp with time zone DEFAULT now()" },
    ]);
    const grants = await owner<{ fn: string; role: string }>(old, `
      select f.fn, r.role from unnest(array['private.rls_document_upload_allowed(text)',
                                            'public.service_retention_candidates(timestamptz)']) as f(fn)
      cross join unnest(array['anon', 'authenticated', 'service_role']) as r(role)
      where has_function_privilege(r.role, f.fn, 'EXECUTE') order by 1, 2`);
    expect(grants).toEqual([
      { fn: "private.rls_document_upload_allowed(text)", role: "authenticated" },
      { fn: "public.service_retention_candidates(timestamptz)", role: "service_role" },
    ]);
    const me = await createUser(old);
    const sql = "select * from public.service_retention_candidates()";
    expect(await raised(() => asUser(old, user(me), sql))).toMatch(/permission denied/);
    expect(await raised(() => asRole(old, "anon", null, sql))).toMatch(/permission denied/);
  });
});

describe("RETENTION-005 the document upload policy in upload mode", () => {
  let db: PGlite;
  const insert = "insert into storage.objects (bucket_id, name) values ($1, $2)";
  const upload = (me: string, name: string | null, bucket = "verification-documents") =>
    asUser(db, user(me), insert, [bucket, name]);
  const stored = async (name: string) =>
    (await owner<{ n: number }>(db, "select count(*)::int as n from storage.objects where name = $1", [name]))[0].n;
  const refused = async (me: string, name: string | null, bucket = "verification-documents") => {
    const [count] = await owner<{ n: number }>(db, "select count(*)::int as n from storage.objects");
    expect(await raised(() => upload(me, name, bucket)), String(name)).toMatch(/row-level security/);
    expect((await owner<{ n: number }>(db, "select count(*)::int as n from storage.objects"))[0]).toEqual(count);
  };
  const setIntake = (value: "upload" | "synthetic") =>
    owner(db, "update private.app_settings set value = $1 where key = 'verification_intake'", [value]);

  beforeAll(async () => {
    db = await freshDb();
    await setIntake("upload");
  });
  afterAll(async () => { await db?.close(); });

  it("allows a name under the path rule in the caller's own folder", async () => {
    const me = await createUser(db);
    for (const name of [`${me}/${randomUUID()}.webp`, `${me}/doc/${randomUUID()}.webp`, `${me}/${"a".repeat(64)}.webp`,
      `${me}/A_b-9/c/d.webp`]) {
      await upload(me, name);
      expect(await stored(name), name).toBe(1);
    }
  });

  it("refuses every name outside the path rule, another folder and another bucket, writing nothing", async () => {
    const me = await createUser(db);
    const other = await createUser(db);
    for (const name of [
      `${me}/scan.v2.webp`,
      `${me}/${"a".repeat(65)}.webp`,
      `${me}/doc/${"a".repeat(65)}/x.webp`,
      `${me}/${randomUUID()}.png`,
      `${me}/${randomUUID()}.webp.png`,
      `${me}/${randomUUID()}.WEBP`,
      `${me}/../${randomUUID()}.webp`,
      `${me}//${randomUUID()}.webp`,
      `${me}/.webp`,
      `${me}/`,
      `${me}/a b.webp`,
      `${me}/${randomUUID()}.webp/`,
      `${me.toUpperCase()}/${randomUUID()}.webp`,
      `${me}x/${randomUUID()}.webp`,
      `/${me}/${randomUUID()}.webp`,
      `${randomUUID()}.webp`,
      `${other}/${randomUUID()}.webp`,
      `${randomUUID()}/${randomUUID()}.webp`,
      null,
    ]) await refused(me, name);
    await refused(me, `${me}/${randomUUID()}.webp`, "profile-photos");
  });

  it("caps the caller's folder at 16 objects, counted before the new row", async () => {
    const me = await createUser(db);
    const other = await createUser(db);
    // a name outside the rule stored earlier still counts; another bucket, another folder or a longer prefix does not
    await owner(db, insert, ["verification-documents", `${me}/scan.v2.webp`]);
    await owner(db, insert, ["profile-photos", `${me}/${randomUUID()}.webp`]);
    await owner(db, insert, ["verification-documents", `${other}/${randomUUID()}.webp`]);
    await owner(db, insert, ["verification-documents", `${me}x/${randomUUID()}.webp`]);
    for (let i = 0; i < 14; i += 1) await upload(me, `${me}/${randomUUID()}.webp`);
    const sixteenth = `${me}/${randomUUID()}.webp`;
    await upload(me, sixteenth);
    expect(await stored(sixteenth)).toBe(1);
    const [row] = await owner<{ n: number }>(db,
      "select count(*)::int as n from storage.objects where bucket_id = 'verification-documents' and name like $1 || '/%'", [me]);
    expect(row.n).toBe(16);
    await refused(me, `${me}/${randomUUID()}.webp`);
    await refused(me, `${me}/doc/${randomUUID()}.webp`);
    // another user is not affected by this folder's count
    await upload(other, `${other}/${randomUUID()}.webp`);
    // once the sweep removes one, the folder takes one more
    await owner(db, "delete from storage.objects where bucket_id = 'verification-documents' and name = $1", [`${me}/scan.v2.webp`]);
    await upload(me, `${me}/${randomUUID()}.webp`);
    await refused(me, `${me}/${randomUUID()}.webp`);
  });

  it("synthetic mode still refuses every insert", async () => {
    await setIntake("synthetic");
    try {
      const me = await createUser(db);
      for (const name of [`${me}/${randomUUID()}.webp`, `${me}/doc/${randomUUID()}.webp`]) await refused(me, name);
    } finally { await setIntake("upload"); }
  });
});
