// RETENTION-004 (order 27, docs/04_DATABASE.md §11): orphan verification documents in the retention candidates,
// compared with the order-26 output on the same fixture, and the upload-mode document checks of submit_verification.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMasters, createStaff, createUser, type Masters } from "./fixtures";
import { asRole, asUser, fingerprint, freshDb, MIGRATIONS_DIR, migrationFiles, owner, seedSqlFor, raised, rpc, user } from "./harness";

interface Candidate {
  kind: string;
  user_id: string;
  submission_id: string | null;
  storage_path: string | null;
}

const ORDER_26 = "20261115120026_orphan_photo_retention.sql";
const ORDER_27 = "20261115120027_orphan_document_retention.sql";
const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** a fixed sweep time in the past, so every boundary is exact */
const T = new Date(Math.floor((Date.now() - 60 * DAY) / 1000) * 1000);
const at = (offsetMs: number) => new Date(T.getTime() + offsetMs).toISOString();
const DUE = -30 * DAY;
const AGE = -24 * HOUR;
const SUBMIT = ["public.verification_kind", "text[]"];

const candidates = (target: PGlite, now: string = T.toISOString()) =>
  asRole<Candidate>(target, "service_role", null, "select * from public.service_retention_candidates($1::timestamptz)", [now]);

function sorted(rows: Candidate[]): Candidate[] {
  const key = (r: Candidate) => [r.kind, r.user_id, r.submission_id ?? "", r.storage_path ?? ""].join("|");
  return [...rows].sort((a, b) => key(a).localeCompare(key(b)));
}

/** an uploaded submission naming refs; staffed statuses get a reviewer and claimed_at */
async function submission(target: PGlite, userId: string, status: string, decidedAt: string | null, refs: string[],
  reviewer: string, intake: "upload" | "synthetic" = "upload"): Promise<string> {
  const id = randomUUID();
  const staffed = !["submitted", "withdrawn"].includes(status);
  await owner(target, `
    insert into public.verification_submissions
      (id, user_id, kind, status, intake_mode, document_refs, reviewer_id, claimed_at, decided_at, decision_reason)
    values ($1, $2, 'age', $3, $4, $5, $6, $7, $8, $9)`,
  [id, userId, status, intake, refs, staffed ? reviewer : null, staffed ? at(-90 * DAY) : null, decidedAt,
    status === "rejected" ? "unreadable" : null]);
  return id;
}

describe("RETENTION-004 orphan document objects (order 27)", () => {
  let old: PGlite;
  let before: Candidate[];
  let after: Candidate[];
  let expectedOrphans: Candidate[];
  let edge: string;
  const notListed: string[] = [];

  const put = (bucket: string, name: string | null, createdAt: string | null) =>
    owner(old, "insert into storage.objects (bucket_id, name, created_at) values ($1, $2, $3)", [bucket, name, createdAt]);

  beforeAll(async () => {
    // shim, orders 1-26 and the seed: a database before order 27
    old = await PGlite.create();
    const root = join(MIGRATIONS_DIR, "..", "..");
    const all = migrationFiles();
    const upTo26 = all.slice(0, all.indexOf(ORDER_26) + 1);
    expect(upTo26.at(-1)).toBe(ORDER_26);
    for (const file of [join(root, "tests", "db", "shim.sql"), ...upTo26.map((f) => join(MIGRATIONS_DIR, f))]) {
      const sql = readFileSync(file, "utf8");
      await old.transaction((tx) => tx.exec(sql));
    }
    const seed = seedSqlFor(ORDER_26);
    await old.transaction((tx) => tx.exec(seed));

    // every earlier kind: a due account with photos and documents, due documents, an orphan photo, a kept reviewer
    const staffer = await createStaff(old, ["reviewer"]);
    const gone = await createUser(old, { status: "deleted", photos: 2, removedPhotos: 1 });
    await owner(old, "update public.profiles set deleted_at = $2 where user_id = $1", [gone, at(DUE)]);
    const decided = await createUser(old);
    for (const [userId, status, decidedAt] of [[gone, "submitted", null], [decided, "approved", at(DUE)], [decided, "rejected", at(DUE - DAY)]] as const) {
      const ref = `${userId}/${randomUUID()}.webp`;
      await submission(old, userId, status, decidedAt, [ref], staffer);
      await put("verification-documents", ref, at(-90 * DAY));
    }
    const photos = await owner<{ storage_path: string }>(old, "select storage_path from public.profile_photos where user_id = $1", [gone]);
    for (const r of photos) await put("profile-photos", r.storage_path, at(-90 * DAY));
    const owner1 = await createUser(old);
    await put("profile-photos", `${owner1}/${randomUUID()}.webp`, at(-90 * DAY));   // an orphan photo
    await owner(old, "insert into public.profiles (user_id, display_name, gender, account_status) values ($1, 'Synthetic reviewer', 'female', 'deleted')", [staffer]);
    await owner(old, "update public.profiles set deleted_at = $2 where user_id = $1", [staffer, at(DUE)]);

    // named by a submission in any status (decided recently, so the document kind does not list them either),
    // or by a synthetic-mode row: never an orphan, however old the object
    for (const status of ["submitted", "in_review", "approved", "rejected", "revoked", "withdrawn"]) {
      const ref = `${owner1}/${randomUUID()}.webp`;
      const open = ["submitted", "in_review"].includes(status);
      await submission(old, await createUser(old), status, open ? null : at(-DAY), [ref], staffer);
      // the ref is outside its submitter's folder, so only the orphan rule could list it
      await put("verification-documents", ref, at(-90 * DAY));
      notListed.push(ref);
    }
    const multi = [`${owner1}/${randomUUID()}.webp`, `${owner1}/m/${randomUUID()}.webp`];
    await submission(old, owner1, "rejected", at(-DAY), multi, staffer);
    for (const ref of multi) await put("verification-documents", ref, at(-90 * DAY));
    const synthetic = `${owner1}/${randomUUID()}.webp`;
    await submission(old, owner1, "withdrawn", at(-DAY), [synthetic], staffer, "synthetic");
    await put("verification-documents", synthetic, at(-90 * DAY));
    notListed.push(...multi, synthetic);

    // orphans: 24 hours or older, in a uuid folder, under the path rule, named by no submission
    edge = `${owner1}/${randomUUID()}.webp`;
    const stranger = randomUUID();
    const listed: [string, string, string][] = [
      [owner1, `${owner1}/${randomUUID()}.webp`, at(AGE - 1)],
      [owner1, edge, at(AGE)],
      [owner1, `${owner1}/nested/${randomUUID()}.webp`, at(-90 * DAY)],
      [gone, `${gone}/${randomUUID()}.webp`, at(-90 * DAY)],   // in a due account's folder: still an orphan row
      [stranger, `${stranger}/${randomUUID()}.webp`, at(-2 * DAY)],   // a folder no account owns
    ];
    expectedOrphans = [];
    for (const [userId, path, createdAt] of listed) {
      await put("verification-documents", path, createdAt);
      expectedOrphans.push({ kind: "orphan_document", user_id: userId, submission_id: null, storage_path: path });
    }
    // never listed: younger than 24 hours, no creation time, another bucket, or a name outside the path rule
    const young = `${owner1}/${randomUUID()}.webp`;
    await put("verification-documents", young, at(AGE + 1));
    const undated = `${owner1}/${randomUUID()}.webp`;
    await put("verification-documents", undated, null);
    const elsewhere = `${owner1}/${randomUUID()}.webp`;
    await put("profile-photos", elsewhere, at(-90 * DAY));   // an orphan photo, never an orphan document
    const bad = [
      `${owner1.toUpperCase()}/${randomUUID()}.webp`,
      `not-a-uuid/${randomUUID()}.webp`,
      `${owner1.slice(0, 35)}/${randomUUID()}.webp`,
      `${owner1}x/${randomUUID()}.webp`,
      `${owner1}/${randomUUID()}.pdf`,
      `${owner1}/${randomUUID()}.webp.png`,
      `${owner1}/../${randomUUID()}.webp`,
      `${owner1}/${"a".repeat(65)}.webp`,
      `${owner1}//${randomUUID()}.webp`,
      `${owner1}/.webp`,
      `${owner1}/`,
      `${randomUUID()}.webp`,
      `/${owner1}/${randomUUID()}.webp`,
    ];
    for (const name of bad) await put("verification-documents", name, at(-90 * DAY));
    await put("verification-documents", null, at(-90 * DAY));
    notListed.push(young, undated, ...bad);

    before = await candidates(old);
    const sql = readFileSync(join(MIGRATIONS_DIR, ORDER_27), "utf8");
    await old.transaction((tx) => tx.exec(sql));
    after = await candidates(old);
    expect(after.some((r) => r.kind === "orphan_photo" && r.storage_path === elsewhere)).toBe(true);
  });
  afterAll(async () => { await old?.close(); });

  it("is order 27", () => {
    expect(migrationFiles()[26]).toBe(ORDER_27);
    expect(migrationFiles().length).toBeGreaterThanOrEqual(27);   // order 28 (RETENTION-005) follows
  });

  it("lists exactly the orphan documents 24 hours or older; every other row is the order-26 output, in the same order", () => {
    expect(new Set(before.map((r) => r.kind))).toEqual(new Set(["account", "document", "orphan_photo", "skipped_reviewer"]));
    expect(after.filter((r) => r.kind !== "orphan_document")).toEqual(before);
    expect(sorted(after.filter((r) => r.kind === "orphan_document"))).toEqual(sorted(expectedOrphans));
    const kinds = after.map((r) => r.kind);
    expect(kinds).toEqual([...kinds].sort());
    expect(new Set(after.map((r) => JSON.stringify(r))).size).toBe(after.length);
  });

  it("never lists a named, younger, undated, other-bucket or badly named object as an orphan document", () => {
    const orphans = after.filter((r) => r.kind === "orphan_document");
    const paths = new Set(orphans.map((r) => r.storage_path));
    for (const name of notListed) expect(paths.has(name), name).toBe(false);
    for (const r of orphans) {
      expect(r.storage_path!.startsWith(`${r.user_id}/`)).toBe(true);
      expect(r.submission_id).toBeNull();
    }
    // the profile-photos object is listed only as an orphan photo
    const photoOrphans = new Set(after.filter((r) => r.kind === "orphan_photo").map((r) => r.storage_path));
    for (const r of orphans) expect(photoOrphans.has(r.storage_path)).toBe(false);
  });

  it("measures the 24 hours against p_now, and a re-run after the deletes lists no orphan document", async () => {
    const earlier = await candidates(old, at(-1));
    expect(earlier.some((r) => r.storage_path === edge)).toBe(false);
    expect(earlier.filter((r) => r.kind === "orphan_document")).toHaveLength(expectedOrphans.length - 1);
    const own = (await old.clone()) as PGlite;
    try {
      await owner(own, "delete from storage.objects where bucket_id = 'verification-documents' and name = any($1::text[])",
        [expectedOrphans.map((r) => r.storage_path)]);
      expect(await candidates(own)).toEqual(before);
    } finally { await own.close(); }
  });

  it("keeps both functions' signatures, definer, search_path and grants", async () => {
    const fns = await owner<{ name: string; definer: boolean; config: string[]; volatility: string; result: string; args: string }>(old, `
      select p.proname as name, p.prosecdef as definer, p.proconfig as config, p.provolatile::text as volatility,
             pg_get_function_result(p.oid) as result, pg_get_function_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('service_retention_candidates', 'submit_verification') order by 1`);
    expect(fns).toEqual([
      { name: "service_retention_candidates", definer: true, config: ['search_path=""'], volatility: "s",
        result: "TABLE(kind text, user_id uuid, submission_id uuid, storage_path text)",
        args: "p_now timestamp with time zone DEFAULT now()" },
      { name: "submit_verification", definer: true, config: ['search_path=""'], volatility: "v",
        result: "rpc_outcome", args: "p_kind verification_kind, p_document_refs text[]" },
    ]);
    const grants = await owner<{ fn: string; role: string }>(old, `
      select f.fn, r.role from unnest(array['public.service_retention_candidates(timestamptz)',
                                            'public.submit_verification(public.verification_kind, text[])']) as f(fn)
      cross join unnest(array['anon', 'authenticated', 'service_role']) as r(role)
      where has_function_privilege(r.role, f.fn, 'EXECUTE') order by 1, 2`);
    expect(grants).toEqual([
      { fn: "public.service_retention_candidates(timestamptz)", role: "service_role" },
      { fn: "public.submit_verification(public.verification_kind, text[])", role: "authenticated" },
    ]);
    const me = await createUser(old);
    const sql = "select * from public.service_retention_candidates()";
    expect(await raised(() => asUser(old, user(me), sql))).toMatch(/permission denied/);
    expect(await raised(() => asRole(old, "anon", null, sql))).toMatch(/permission denied/);
  });
});

describe("RETENTION-004 submit_verification in upload mode", () => {
  let db: PGlite;
  let m: Masters;
  let reviewer: string;

  const store = (bucket: string, name: string, age: string | null = "0 seconds") =>
    owner(db, `insert into storage.objects (bucket_id, name, created_at)
               values ($1, $2, case when $3::interval is null then null else now() - $3::interval end)`, [bucket, name, age]);
  const submit = (me: string, refs: string[], kind = "age") => rpc(db, user(me), "submit_verification", [kind, refs], SUBMIT);
  const setIntake = (value: "upload" | "synthetic") =>
    owner(db, "update private.app_settings set value = $1 where key = 'verification_intake'", [value]);
  const refused = async (me: string, refs: string[], kind = "age") => {
    const print = await fingerprint(db);
    const message = await raised(() => submit(me, refs, kind));
    expect(await fingerprint(db), refs.join()).toBe(print);
    return message;
  };

  beforeAll(async () => {
    db = await freshDb();
    m = await createMasters(db, "orphandoc");
    reviewer = await createStaff(db, ["reviewer"]);
    await setIntake("upload");
  });
  afterAll(async () => { await db?.close(); });

  it("a fresh own object gives ok and the submission names it", async () => {
    const me = await createUser(db, { ageVerified: false });
    const refs = [`${me}/${randomUUID()}.webp`, `${me}/doc/${randomUUID()}.webp`];
    await store("verification-documents", refs[0]);
    await store("verification-documents", refs[1], "11 hours 59 minutes");
    const result = await submit(me, refs);
    expect(result).toMatchObject({ ok: true, code: "ok" });
    const [row] = await owner<{ refs: string[]; intake: string; status: string }>(db,
      "select document_refs as refs, intake_mode as intake, status::text from public.verification_submissions where id = $1", [result.ref]);
    expect(row).toEqual({ refs, intake: "upload", status: "submitted" });
  });

  it("refuses with validation, writing nothing, a missing, 12-hour-old, undated or other-bucket object", async () => {
    const me = await createUser(db, { ageVerified: false });
    const missing = `${me}/${randomUUID()}.webp`;
    const stale = `${me}/${randomUUID()}.webp`;
    const older = `${me}/${randomUUID()}.webp`;
    const undated = `${me}/${randomUUID()}.webp`;
    const photo = `${me}/${randomUUID()}.webp`;
    const fresh = `${me}/${randomUUID()}.webp`;
    await store("verification-documents", stale, "12 hours");
    await store("verification-documents", older, "30 days");
    await store("verification-documents", undated, null);
    await store("profile-photos", photo);
    await store("verification-documents", fresh);
    for (const refs of [[missing], [stale], [older], [undated], [photo], [fresh, missing], [fresh, stale]]) {
      expect(await refused(me, refs), refs.join()).toBe("validation");
    }
    // another user's fresh object fails the existing folder rule
    const other = await createUser(db);
    const foreign = `${other}/${randomUUID()}.webp`;
    await store("verification-documents", foreign);
    expect(await refused(me, [foreign])).toBe("validation");
    // the fresh object alone is still accepted
    expect((await submit(me, [fresh])).ok).toBe(true);
  });

  it("refuses a ref an earlier submission already names, in any status or kind", async () => {
    for (const status of ["rejected", "withdrawn", "revoked", "approved"]) {
      const me = await createUser(db, { ageVerified: false });
      const ref = `${me}/${randomUUID()}.webp`;
      await store("verification-documents", ref);
      const staffed = status !== "withdrawn";
      await owner(db, `
        insert into public.verification_submissions
          (user_id, kind, status, intake_mode, document_refs, reviewer_id, claimed_at, decided_at, decision_reason)
        values ($1, 'age', $2, 'upload', $3, $4, $5, now(), $6)`,
      [me, status, [ref], staffed ? reviewer : null, staffed ? new Date().toISOString() : null,
        status === "rejected" ? "unreadable" : null]);
      expect(await refused(me, [ref]), status).toBe("validation");
      const other = `${me}/${randomUUID()}.webp`;
      await store("verification-documents", other);
      expect(await refused(me, [other, ref]), status).toBe("validation");
    }
    // the user's own open age submission: an enrollment naming the same object is refused, not merged
    const me = await createUser(db, { cls: m.classes[0], affiliation: "unconfirmed", ageVerified: false });
    const ref = `${me}/${randomUUID()}.webp`;
    await store("verification-documents", ref);
    expect((await submit(me, [ref])).ok).toBe(true);
    expect(await refused(me, [ref], "enrollment")).toBe("validation");
    const own = `${me}/${randomUUID()}.webp`;
    await store("verification-documents", own);
    expect((await submit(me, [own], "enrollment")).ok).toBe(true);
  });

  it("keeps the open-submission refusal for fresh, unnamed refs", async () => {
    const me = await createUser(db, { ageVerified: false });
    const first = `${me}/${randomUUID()}.webp`;
    const second = `${me}/${randomUUID()}.webp`;
    await store("verification-documents", first);
    await store("verification-documents", second);
    expect((await submit(me, [first])).ok).toBe(true);
    expect(await submit(me, [second])).toEqual({ ok: false, code: "invalid_state", ref: null });
  });

  it("synthetic mode behaves as before: sample refs need no object, upload refs are refused", async () => {
    await setIntake("synthetic");
    try {
      const me = await createUser(db, { ageVerified: false });
      const ref = `${me}/${randomUUID()}.webp`;
      await store("verification-documents", ref);
      expect(await refused(me, [ref])).toBe("validation");
      expect((await submit(me, ["synthetic:sample-1", "synthetic:sample-2"])).ok).toBe(true);
      // an identical sample ref already named by another submission is still accepted
      const other = await createUser(db, { ageVerified: false });
      expect((await submit(other, ["synthetic:sample-1"])).ok).toBe(true);
    } finally { await setIntake("upload"); }
  });
});
