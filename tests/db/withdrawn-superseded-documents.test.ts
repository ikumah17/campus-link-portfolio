// RETENTION-007 (order 32, docs/04_DATABASE.md §9, §11): the retention document kind also lists the documents of
// withdrawn and superseded uploads decided 30 days or more ago, compared with the order-31 output on the same fixture,
// and the document upload cap no longer counts them. The order-31 cap cases run against the newest schema in
// document-cap-open-only.test.ts.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMasters, createStaff, createUser } from "./fixtures";
import { asRole, asUser, freshDb, MIGRATIONS_DIR, migrationFiles, owner, seedSqlFor, raised, rpc, user } from "./harness";

interface Candidate {
  kind: string;
  user_id: string;
  submission_id: string | null;
  storage_path: string | null;
}

type Status = "submitted" | "in_review" | "approved" | "rejected" | "revoked" | "withdrawn" | "superseded";

const ORDER_31 = "20261116120031_document_cap_open_only.sql";
const ORDER_32 = "20261116120032_withdrawn_superseded_documents.sql";
const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** a fixed sweep time in the past, so every boundary is exact */
const T = new Date(Math.floor((Date.now() - 60 * DAY) / 1000) * 1000);
const at = (offsetMs: number) => new Date(T.getTime() + offsetMs).toISOString();
const DUE = -30 * DAY;
const STATUSES: Status[] = ["submitted", "in_review", "approved", "rejected", "revoked", "withdrawn", "superseded"];
const DECIDED: Status[] = ["approved", "rejected", "revoked", "withdrawn", "superseded"];

const candidates = (target: PGlite, now: string | null = T.toISOString()) => now === null
  ? asRole<Candidate>(target, "service_role", null, "select * from public.service_retention_candidates()")
  : asRole<Candidate>(target, "service_role", null, "select * from public.service_retention_candidates($1::timestamptz)", [now]);

function sorted(rows: Candidate[]): Candidate[] {
  const key = (r: Candidate) => [r.kind, r.user_id, r.submission_id ?? "", r.storage_path ?? ""].join("|");
  return [...rows].sort((a, b) => key(a).localeCompare(key(b)));
}

/** shim, orders 1 to `last` and optionally the seed */
async function upTo(last: string, seed = false): Promise<PGlite> {
  const target = await PGlite.create();
  const root = join(MIGRATIONS_DIR, "..", "..");
  const all = migrationFiles();
  const files = all.slice(0, all.indexOf(last) + 1);
  expect(files.at(-1)).toBe(last);
  for (const file of [join(root, "tests", "db", "shim.sql"), ...files.map((f) => join(MIGRATIONS_DIR, f))]) {
    const sql = readFileSync(file, "utf8");
    await target.transaction((tx) => tx.exec(sql));
  }
  if (seed) {
    const sql = seedSqlFor(last);
    await target.transaction((tx) => tx.exec(sql));
  }
  return target;
}

/** A submission row naming `refs`, as the reviewer, withdraw and affiliation flows leave it. */
async function submission(target: PGlite, userId: string, status: Status, decidedAt: string | null, refs: string[],
  reviewer: string, intake: "upload" | "synthetic" = "upload"): Promise<string> {
  const id = randomUUID();
  const kind = status === "superseded" ? "enrollment" : "age";
  const staffed = ["in_review", "approved", "rejected", "revoked"].includes(status);
  await owner(target, `
    insert into public.verification_submissions
      (id, user_id, kind, status, intake_mode, document_refs, affiliation_snapshot, reviewer_id, claimed_at, decided_at, decision_reason)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
  [id, userId, kind, status, intake, refs, kind === "enrollment" ? "{}" : null, staffed ? reviewer : null,
    staffed ? at(-90 * DAY) : null, decidedAt,
    status === "superseded" ? "affiliation_changed" : status === "rejected" ? "unreadable" : null]);
  return id;
}

describe("RETENTION-007 order 32", () => {
  it("is order 32, followed only by order 33 (MOD-001), order 34 (DB-LIKES-001) and order 35 (STAFF-001)", () => {
    expect(migrationFiles()[31]).toBe(ORDER_32);
    expect(migrationFiles()).toHaveLength(35);
  });
});

describe("RETENTION-007 withdrawn and superseded documents in the retention candidates", () => {
  let old: PGlite;
  let before: Candidate[];
  let after: Candidate[];
  let expectedNew: Candidate[];
  let edge: string;
  let goneWithdrawn: string;
  let gone: string;
  const notListed: string[] = [];
  const openRefs: string[] = [];

  const put = (bucket: string, name: string, createdAt: string | null = at(-90 * DAY)) =>
    owner(old, "insert into storage.objects (bucket_id, name, created_at) values ($1, $2, $3)", [bucket, name, createdAt]);
  const stored = async (userId: string, count = 1, folder = userId) => {
    const refs = Array.from({ length: count }, (_, i) => `${folder}/${i % 2 ? "nested/" : ""}${randomUUID()}.webp`);
    for (const ref of refs) await put("verification-documents", ref);
    return refs;
  };

  beforeAll(async () => {
    // shim, orders 1-31 and the seed: a database before order 32
    old = await upTo(ORDER_31, true);

    // every earlier kind: a due account with active and removed photos and documents (one withdrawn), due documents,
    // an orphan photo, an orphan document, a removed photo's object and a kept former reviewer
    const staffer = await createStaff(old, ["reviewer"]);
    gone = await createUser(old, { status: "deleted", photos: 2, removedPhotos: 1 });
    await owner(old, "update public.profiles set deleted_at = $2 where user_id = $1", [gone, at(DUE)]);
    for (const r of await owner<{ storage_path: string }>(old, "select storage_path from public.profile_photos where user_id = $1", [gone])) {
      await put("profile-photos", r.storage_path);
    }
    await submission(old, gone, "submitted", null, await stored(gone), staffer);
    goneWithdrawn = await submission(old, gone, "withdrawn", at(DUE - DAY), await stored(gone, 2), staffer);
    const decided = await createUser(old, { photos: 1, removedPhotos: 1 });
    for (const r of await owner<{ storage_path: string }>(old, "select storage_path from public.profile_photos where user_id = $1", [decided])) {
      await put("profile-photos", r.storage_path);
    }
    for (const [status, decidedAt] of [["approved", at(DUE)], ["rejected", at(DUE - DAY)], ["revoked", at(DUE - 1)]] as const) {
      await submission(old, decided, status, decidedAt, await stored(decided, 2), staffer);
    }
    await put("profile-photos", `${decided}/${randomUUID()}.webp`);   // an orphan photo
    await put("verification-documents", `${decided}/${randomUUID()}.webp`);   // an orphan document
    await owner(old, "insert into public.profiles (user_id, display_name, gender, account_status) values ($1, 'Synthetic reviewer', 'female', 'deleted')", [staffer]);
    await owner(old, "update public.profiles set deleted_at = $2 where user_id = $1", [staffer, at(DUE)]);

    // due: withdrawn and superseded uploads decided 30 days or more before p_now, every stored ref in the folder
    const quitter = await createUser(old);
    expectedNew = [];
    edge = `${quitter}/${randomUUID()}.webp`;
    await put("verification-documents", edge);
    const due: [string, Status, string, string[]][] = [
      [quitter, "withdrawn", at(DUE), [edge]],
      [quitter, "withdrawn", at(DUE - DAY), await stored(quitter, 4)],
      [quitter, "superseded", at(DUE - 1), await stored(quitter, 2)],
      [quitter, "superseded", at(-90 * DAY), await stored(quitter, 1)],
    ];
    // a deleted account younger than 30 days is not purgeable: its own due documents fall to the document kind
    const young = await createUser(old, { status: "deleted" });
    await owner(old, "update public.profiles set deleted_at = $2 where user_id = $1", [young, at(DUE + 1)]);
    due.push([young, "withdrawn", at(DUE - DAY), await stored(young, 1)]);
    due.push([young, "superseded", at(DUE - DAY), await stored(young, 1)]);
    for (const [userId, status, decidedAt, refs] of due) {
      const id = await submission(old, userId, status, decidedAt, refs, staffer);
      for (const ref of refs) expectedNew.push({ kind: "document", user_id: userId, submission_id: id, storage_path: ref });
    }

    // never listed: decided less than 30 days before p_now, synthetic mode, a ref outside the folder,
    // a ref with no Storage object, or an open submission however old its objects
    const other = await createUser(old);
    for (const status of ["withdrawn", "superseded"] as const) {
      const fresh = await stored(other, 2);
      await submission(old, other, status, at(DUE + 1), fresh, staffer);
      const recent = await stored(other, 1);
      await submission(old, other, status, at(-DAY), recent, staffer);
      const synthetic = await stored(other, 1);
      await submission(old, other, status, at(-90 * DAY), synthetic, staffer, "synthetic");
      const foreign = await stored(other, 1, quitter);
      await submission(old, other, status, at(-90 * DAY), foreign, staffer);
      const missing = [`${other}/${randomUUID()}.webp`];
      await submission(old, other, status, at(-90 * DAY), missing, staffer);
      notListed.push(...fresh, ...recent, ...synthetic, ...foreign, ...missing);
    }
    for (const status of ["submitted", "in_review"] as const) {
      const refs = await stored(await createUser(old), 2);
      const owner1 = refs[0].split("/")[0];
      await submission(old, owner1, status, null, refs, staffer);
      openRefs.push(...refs);
    }

    before = await candidates(old);
    const sql = readFileSync(join(MIGRATIONS_DIR, ORDER_32), "utf8");
    await old.transaction((tx) => tx.exec(sql));
    after = await candidates(old);
  });
  afterAll(async () => { await old?.close(); });

  it("lists exactly the due withdrawn and superseded documents with their refs; every other row is the order-31 output, in the same order", () => {
    expect(new Set(before.map((r) => r.kind))).toEqual(new Set(["account", "document", "orphan_document", "orphan_photo", "skipped_reviewer"]));
    const added = new Set(expectedNew.map((r) => JSON.stringify(r)));
    expect(after.filter((r) => !added.has(JSON.stringify(r)))).toEqual(before);
    expect(sorted(after.filter((r) => added.has(JSON.stringify(r))))).toEqual(sorted(expectedNew));
    expect(after).toHaveLength(before.length + expectedNew.length);
    for (const kind of ["account", "orphan_document", "orphan_photo", "skipped_reviewer"]) {
      expect(after.filter((r) => r.kind === kind), kind).toEqual(before.filter((r) => r.kind === kind));
    }
    const kinds = after.map((r) => r.kind);
    expect(kinds).toEqual([...kinds].sort());
    expect(new Set(after.map((r) => JSON.stringify(r))).size).toBe(after.length);
    for (const r of after.filter((x) => x.storage_path)) expect(r.storage_path!.startsWith(`${r.user_id}/`)).toBe(true);
  });

  it("never lists a younger, synthetic, foreign-folder, missing or open submission's object", () => {
    const paths = new Set(after.map((r) => r.storage_path));
    for (const name of [...notListed, ...openRefs]) expect(paths.has(name), name).toBe(false);
  });

  it("a purgeable account's withdrawn documents stay under the account kind alone", () => {
    const rows = after.filter((r) => r.submission_id === goneWithdrawn);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === "account" && r.user_id === gone)).toBe(true);
  });

  it("measures the 30 days against p_now, and a re-run after the deletes lists only what is left", async () => {
    const earlier = await candidates(old, at(-1));
    expect(earlier.some((r) => r.storage_path === edge)).toBe(false);
    expect(earlier.filter((r) => added(r))).toHaveLength(expectedNew.length - 1);
    const own = (await old.clone()) as PGlite;
    try {
      await owner(own, "delete from storage.objects where bucket_id = 'verification-documents' and name = any($1::text[])",
        [expectedNew.map((r) => r.storage_path)]);
      expect(await candidates(own)).toEqual(before);
    } finally { await own.close(); }
    function added(r: Candidate) { return expectedNew.some((e) => JSON.stringify(e) === JSON.stringify(r)); }
  });
});

describe("RETENTION-007 a listed submission never becomes open, and an open submission's object is never listed", () => {
  let db: PGlite;
  let reviewer: string;
  const SUBMIT = ["public.verification_kind", "text[]"];
  const store = (name: string) =>
    owner(db, "insert into storage.objects (bucket_id, name, created_at) values ('verification-documents', $1, now())", [name]);
  const listedPaths = async () => new Set((await candidates(db, null)).map((r) => r.storage_path));
  /** decided rows dated by now(), since p_now may never be later than now() */
  const decidedLongAgo = async (me: string, status: Status, refs: string[]) => {
    const id = randomUUID();
    const kind = status === "superseded" ? "enrollment" : "age";
    const staffed = ["approved", "rejected", "revoked"].includes(status);
    await owner(db, `
      insert into public.verification_submissions
        (id, user_id, kind, status, intake_mode, document_refs, affiliation_snapshot, reviewer_id, claimed_at, decided_at, decision_reason)
      values ($1, $2, $3, $4, 'upload', $5, $6, $7, $8, now() - interval '31 days', $9)`,
    [id, me, kind, status, refs, kind === "enrollment" ? "{}" : null, staffed ? reviewer : null,
      staffed ? new Date(Date.now() - 40 * DAY).toISOString() : null,
      status === "superseded" ? "affiliation_changed" : status === "rejected" ? "unreadable" : null]);
    return id;
  };

  beforeAll(async () => {
    db = await freshDb();
    reviewer = await createStaff(db, ["reviewer"]);
    await owner(db, "update private.app_settings set value = 'upload' where key = 'verification_intake'");
  });
  afterAll(async () => { await db?.close(); });

  it("no update moves a row out of withdrawn or superseded (order 4 transitions)", async () => {
    for (const status of ["withdrawn", "superseded"] as const) {
      const me = await createUser(db);
      const ref = `${me}/${randomUUID()}.webp`;
      await store(ref);
      const id = await decidedLongAgo(me, status, [ref]);
      for (const next of STATUSES) {
        const staffed = ["in_review", "approved", "rejected", "revoked"].includes(next);
        expect(await raised(() => owner(db, `
          update public.verification_submissions
          set status = $2, reviewer_id = $3, claimed_at = $4, decided_at = $5, version = version + 1 where id = $1`,
        [id, next, staffed ? reviewer : null, staffed ? new Date().toISOString() : null,
          ["submitted", "in_review"].includes(next) ? null : new Date().toISOString()])), `${status}>${next}`)
          .toBe("transition_denied");   // a same-status update would re-date the decision: also refused
      }
      expect((await owner<{ status: string }>(db, "select status::text from public.verification_submissions where id = $1", [id]))[0])
        .toEqual({ status });
      expect((await listedPaths()).has(ref)).toBe(true);
    }
  });

  it("a withdrawn or superseded document's ref cannot be named again; the new open submission's object is never listed", async () => {
    const m = await createMasters(db, "retention7");
    for (const status of ["withdrawn", "superseded"] as const) {
      const me = await createUser(db, { cls: m.classes[0], affiliation: "unconfirmed", ageVerified: false });
      const kind = status === "superseded" ? "enrollment" : "age";
      const ref = `${me}/${randomUUID()}.webp`;
      await store(ref);
      await decidedLongAgo(me, status, [ref]);
      expect(await raised(() => rpc(db, user(me), "submit_verification", [kind, [ref]], SUBMIT)), status).toBe("validation");
      const fresh = `${me}/${randomUUID()}.webp`;
      await store(fresh);
      expect((await rpc(db, user(me), "submit_verification", [kind, [fresh]], SUBMIT)).ok).toBe(true);
      const listed = await listedPaths();
      expect(listed.has(ref), status).toBe(true);
      expect(listed.has(fresh), status).toBe(false);
    }
  });

  it("the real withdraw and affiliation-change flows leave rows the document kind lists once 30 days old", async () => {
    const m = await createMasters(db, "retention7flow");
    const me = await createUser(db, { cls: m.classes[0], affiliation: "unconfirmed", ageVerified: false });
    const age = `${me}/${randomUUID()}.webp`;
    const enrollment = `${me}/${randomUUID()}.webp`;
    await store(age);
    await store(enrollment);
    const ageSub = await rpc(db, user(me), "submit_verification", ["age", [age]], SUBMIT);
    const enrSub = await rpc(db, user(me), "submit_verification", ["enrollment", [enrollment]], SUBMIT);
    expect(await rpc(db, user(me), "withdraw_verification", [ageSub.ref])).toMatchObject({ ok: true });
    const next = m.classes[1];
    expect(await rpc(db, user(me), "set_affiliation", [next.schoolId, next.departmentId, next.id])).toMatchObject({ ok: true });
    const rows = await owner<{ id: string; status: string; decided: boolean }>(db,
      "select id, status::text, decided_at is not null as decided from public.verification_submissions where user_id = $1 order by status::text", [me]);
    expect(rows).toEqual([
      { id: enrSub.ref, status: "superseded", decided: true },
      { id: ageSub.ref, status: "withdrawn", decided: true },
    ]);
    // decided just now: not yet due
    let listed = await listedPaths();
    expect(listed.has(age) || listed.has(enrollment)).toBe(false);
    // 30 days later (dated back in a clone; the transition trigger refuses a re-dated decision)
    const own = (await db.clone()) as PGlite;
    try {
      await owner(own, "alter table public.verification_submissions disable trigger verification_submissions_transition");
      await owner(own, "update public.verification_submissions set decided_at = now() - interval '30 days' where user_id = $1", [me]);
      await owner(own, "alter table public.verification_submissions enable trigger verification_submissions_transition");
      const rows30 = (await candidates(own, null)).filter((r) => r.user_id === me);
      expect(sorted(rows30)).toEqual(sorted([
        { kind: "document", user_id: me, submission_id: ageSub.ref as string, storage_path: age },
        { kind: "document", user_id: me, submission_id: enrSub.ref as string, storage_path: enrollment },
      ]));
    } finally { await own.close(); }
    listed = await listedPaths();
    expect(listed.has(age) || listed.has(enrollment)).toBe(false);
  });
});

describe("RETENTION-007 the document upload cap matches the sweep", () => {
  let db: PGlite;
  let staffer: string;
  const insert = "insert into storage.objects (bucket_id, name) values ($1, $2)";
  const name = (me: string) => `${me}/${randomUUID()}.webp`;
  const upload = (me: string, object: string) => asUser(db, user(me), insert, ["verification-documents", object]);
  const store = async (me: string, count: number) => {
    const names = Array.from({ length: count }, () => name(me));
    for (const object of names) await owner(db, insert, ["verification-documents", object]);
    return names;
  };
  const submission = (me: string, status: Status, refs: string[], intake: "upload" | "synthetic" = "upload") => {
    const kind = status === "superseded" ? "enrollment" : "age";
    const staffed = ["in_review", "approved", "rejected", "revoked"].includes(status);
    const decided = DECIDED.includes(status);
    return owner<{ id: string }>(db, `
      insert into public.verification_submissions
        (user_id, kind, status, intake_mode, document_refs, affiliation_snapshot, reviewer_id, claimed_at, decided_at, decision_reason)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [me, kind, status, intake, refs, kind === "enrollment" ? "{}" : null, staffed ? staffer : null,
      staffed ? new Date().toISOString() : null, decided ? new Date(Date.now() - 31 * DAY).toISOString() : null,
      status === "superseded" ? "affiliation_changed" : status === "rejected" ? "unreadable" : null]);
  };
  const tryUpload = async (me: string) => {
    const [count] = await owner<{ n: number }>(db, "select count(*)::int as n from storage.objects");
    const object = name(me);
    const message = await raised(() => upload(me, object));
    const [now] = await owner<{ n: number }>(db, "select count(*)::int as n from storage.objects");
    return { allowed: now.n === count.n + 1, message };
  };

  beforeAll(async () => {
    db = await freshDb();
    await owner(db, "update private.app_settings set value = 'upload' where key = 'verification_intake'");
    staffer = await createStaff(db, ["reviewer"]);
  });
  afterAll(async () => { await db?.close(); });

  it("12 unnamed objects and 4 of a submission: allowed exactly for the statuses whose refs the document kind lists", async () => {
    for (const status of STATUSES) {
      const me = await createUser(db);
      await store(me, 12);
      const refs = await store(me, 4);
      await submission(me, status, refs);
      const listed = new Set((await candidates(db, null)).filter((r) => r.user_id === me).map((r) => r.storage_path));
      const sweeps = refs.every((ref) => listed.has(ref));
      expect(sweeps || refs.every((ref) => !listed.has(ref)), status).toBe(true);
      expect(sweeps, status).toBe(DECIDED.includes(status));
      const result = await tryUpload(me);
      expect(result.allowed, status).toBe(sweeps);
      if (!result.allowed) expect(result.message, status).toMatch(/row-level security/);
    }
  });

  it("16 objects of withdrawn and superseded submissions: a new upload is allowed", async () => {
    const me = await createUser(db);
    for (const status of ["withdrawn", "withdrawn", "superseded", "superseded"] as const) await submission(me, status, await store(me, 4));
    expect((await tryUpload(me)).allowed).toBe(true);
  });

  it("synthetic withdrawn or superseded rows, another user's, or a ref an open submission also names still count", async () => {
    for (const add of [
      (me: string, refs: string[]) => submission(me, "withdrawn", refs, "synthetic"),
      (me: string, refs: string[]) => submission(me, "superseded", refs, "synthetic"),
      async (_me: string, refs: string[]) => submission(await createUser(db), "withdrawn", refs),
      async (_me: string, refs: string[]) => submission(await createUser(db), "superseded", refs),
      async (me: string, refs: string[]) => { await submission(me, "withdrawn", refs); await submission(me, "submitted", refs); },
      async (me: string, refs: string[]) => { await submission(me, "superseded", refs); await submission(await createUser(db), "in_review", refs); },
    ]) {
      const me = await createUser(db);
      await store(me, 12);
      await add(me, await store(me, 4));
      const result = await tryUpload(me);
      expect(result.allowed).toBe(false);
      expect(result.message).toMatch(/row-level security/);
    }
  });
});

describe("RETENTION-007 the functions' frames", () => {
  let old: PGlite;
  let db: PGlite;
  const frame = (target: PGlite, schema: string, fn: string) => owner(target, `
    select p.prosecdef as definer, p.proconfig as config, p.provolatile::text as volatility, (select l.lanname from pg_language l where l.oid = p.prolang)::text as lang,
           pg_get_function_result(p.oid) as result, pg_get_function_arguments(p.oid) as args, p.proowner::regrole::text as owner,
           array(select r.role from unnest(array['anon', 'authenticated', 'service_role']) as r(role)
                 where has_function_privilege(r.role, p.oid, 'EXECUTE')) as executors,
           coalesce(p.proacl::text[], '{}') as acl
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = $1 and p.proname = $2`, [schema, fn]);
  const body = async (target: PGlite, schema: string, fn: string) => (await owner<{ body: string }>(target, `
    select p.prosrc as body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = $1 and p.proname = $2`, [schema, fn]))[0].body;

  beforeAll(async () => {
    old = await upTo(ORDER_31);
    db = await freshDb();
  });
  afterAll(async () => { await old?.close(); await db?.close(); });

  it("keeps both functions' signatures, definer, search_path, volatility, language, owner and grants of order 31", async () => {
    const cases = [
      ["public", "service_retention_candidates", { lang: "plpgsql", result: "TABLE(kind text, user_id uuid, submission_id uuid, storage_path text)",
        args: "p_now timestamp with time zone DEFAULT now()", executors: ["service_role"] }],
      ["private", "rls_document_upload_allowed", { lang: "sql", result: "boolean", args: "p_object_name text", executors: ["authenticated"] }],
    ] as const;
    for (const [schema, fn, expected] of cases) {
      const before = await frame(old, schema, fn);
      const after = await frame(db, schema, fn);
      expect(before, fn).toHaveLength(1);
      expect(after, fn).toEqual(before);
      expect(after[0], fn).toMatchObject({ definer: true, config: ['search_path=""'], volatility: "s", ...expected });
    }
  });

  it("changes only the two status lists, and the insert policy still calls the upload check", async () => {
    const was = "'approved', 'rejected', 'revoked')";
    const now = "'approved', 'rejected', 'revoked', 'withdrawn', 'superseded')";
    for (const [schema, fn] of [["public", "service_retention_candidates"], ["private", "rls_document_upload_allowed"]] as const) {
      const [before, after] = [await body(old, schema, fn), await body(db, schema, fn)];
      expect(before.split(was), fn).toHaveLength(2);
      expect(after.split(now), fn).toHaveLength(2);
      expect(after, fn).toBe(before.replace(was, now));
    }
    const policies = async (target: PGlite) => owner(target, `
      select policyname, cmd, roles::text[] as roles, qual, with_check from pg_policies
      where schemaname = 'storage' and tablename = 'objects' order by policyname`);
    expect(await policies(db)).toEqual(await policies(old));
  });
});
