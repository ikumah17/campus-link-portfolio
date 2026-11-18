// RETENTION-001 (docs/04_DATABASE.md §11): the retention candidates and the rate-limit purge, against the real migrations.
// RETENTION-003 (order 26): orphan photo objects, compared with the order-25 output on the same fixture.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaff, createUser, type AccountStatus } from "./fixtures";
import { asRole, asUser, freshDb, MIGRATIONS_DIR, migrationFiles, owner, seedSqlFor, raised, rpc, user } from "./harness";

interface Candidate {
  kind: "document" | "account" | "orphan_photo" | "skipped_reviewer";
  user_id: string;
  submission_id: string | null;
  storage_path: string | null;
}

const DAY = 86400_000;
/** a fixed sweep time in the past, so every boundary is exact */
const T = new Date(Math.floor((Date.now() - 60 * DAY) / 1000) * 1000);
const at = (offsetMs: number) => new Date(T.getTime() + offsetMs).toISOString();
const DUE = -30 * DAY;

let db: PGlite;
let reviewer: string;

const candidates = (now: string | null = T.toISOString(), target = db) =>
  asRole<Candidate>(target, "service_role", null, "select * from public.service_retention_candidates($1::timestamptz)", [now]);

async function storeObject(bucket: "profile-photos" | "verification-documents", name: string, target = db) {
  await owner(target, "insert into storage.objects (bucket_id, name) values ($1, $2)", [bucket, name]);
}

/** an uploaded submission with stored objects; decided ones get a reviewer and decided_at */
async function submission(userId: string, status: string, decidedAt: string | null,
  options: { refs?: string[]; store?: boolean } = {}): Promise<{ id: string; refs: string[] }> {
  const id = randomUUID();
  const refs = options.refs ?? [`${userId}/${randomUUID()}.webp`, `${userId}/doc/${randomUUID()}.webp`];
  const staffed = !["submitted", "withdrawn"].includes(status);
  await owner(db, `
    insert into public.verification_submissions
      (id, user_id, kind, status, intake_mode, document_refs, reviewer_id, claimed_at, decided_at, decision_reason)
    values ($1, $2, 'age', $3, 'upload', $4, $5, $6, $7, $8)`,
  [id, userId, status, refs, staffed ? reviewer : null, staffed ? at(-90 * DAY) : null, decidedAt,
    status === "rejected" ? "unreadable" : null]);
  if (options.store !== false) for (const ref of refs) await storeObject("verification-documents", ref);
  return { id, refs };
}

async function photoPaths(userId: string, store = true): Promise<string[]> {
  const rows = await owner<{ storage_path: string }>(db,
    "select storage_path from public.profile_photos where user_id = $1 order by storage_path", [userId]);
  if (store) for (const r of rows) await storeObject("profile-photos", r.storage_path);
  return rows.map((r) => r.storage_path);
}

async function deletedUser(deletedAt: string, photos = 1): Promise<string> {
  const id = await createUser(db, { status: "deleted", photos, removedPhotos: 1 });
  await owner(db, "update public.profiles set deleted_at = $2 where user_id = $1", [id, deletedAt]);
  return id;
}

const docRows = (userId: string, s: { id: string; refs: string[] }, kind: Candidate["kind"] = "document"): Candidate[] =>
  s.refs.map((ref) => ({ kind, user_id: userId, submission_id: s.id, storage_path: ref }));

function sorted(rows: Candidate[]): Candidate[] {
  const key = (r: Candidate) => [r.kind, r.user_id, r.submission_id ?? "", r.storage_path ?? ""].join("|");
  return [...rows].sort((a, b) => key(a).localeCompare(key(b)));
}

beforeAll(async () => {
  db = await freshDb();
  reviewer = await createStaff(db, ["reviewer"]);
});
afterAll(async () => { await db?.close(); });

describe("RETENTION-001 service_retention_candidates", () => {
  let expected: Candidate[];
  let deletedDue: string;
  let deletedYoung: string;
  let decidedOwner: string;
  let kept: { id: string; refs: string[] }[];

  beforeAll(async () => {
    expected = [];
    kept = [];
    // documents: decided at or before T - 30 days are due; the submission row stays
    decidedOwner = await createUser(db);
    const due = [
      await submission(decidedOwner, "approved", at(DUE)),
      await submission(decidedOwner, "rejected", at(DUE - 1)),
      await submission(decidedOwner, "revoked", at(DUE - DAY)),
    ];
    for (const s of due) expected.push(...docRows(decidedOwner, s));
    kept.push(await submission(decidedOwner, "approved", at(DUE + 1)));
    kept.push(await submission(decidedOwner, "rejected", at(-DAY)));
    // a withdrawn upload decided long ago is due as well (order 32)
    expected.push(...docRows(decidedOwner, await submission(decidedOwner, "withdrawn", at(-90 * DAY))));
    // open submissions are never listed, however old
    kept.push(await submission(await createUser(db), "submitted", null));
    kept.push(await submission(await createUser(db), "in_review", null));
    // a stored ref outside the owner's folder, or without a Storage object, is never listed
    const stray = await createUser(db);
    kept.push(await submission(stray, "approved", at(DUE - DAY), { refs: [`${decidedOwner}/${randomUUID()}.webp`] }));
    kept.push(await submission(stray, "approved", at(DUE - DAY), { refs: [`${stray}/${randomUUID()}.webp`], store: false }));

    // accounts: deleted at or before T - 30 days, with every photo (active and removed) and uploaded document
    deletedDue = await deletedUser(at(DUE));
    expected.push({ kind: "account", user_id: deletedDue, submission_id: null, storage_path: null });
    for (const path of await photoPaths(deletedDue)) {
      expected.push({ kind: "account", user_id: deletedDue, submission_id: null, storage_path: path });
    }
    expected.push(...docRows(deletedDue, await submission(deletedDue, "submitted", null), "account"));
    expected.push(...docRows(deletedDue, await submission(deletedDue, "approved", at(-DAY)), "account"));
    expected.push(...docRows(deletedDue, await submission(deletedDue, "revoked", at(DUE - DAY)), "account"));

    // a deleted account 1 ms younger than 30 days: not listed, but its own due documents still are
    deletedYoung = await deletedUser(at(DUE + 1));
    await photoPaths(deletedYoung);
    kept.push(await submission(deletedYoung, "submitted", null));
    expected.push(...docRows(deletedYoung, await submission(deletedYoung, "approved", at(DUE))));

    // other statuses are never listed, however old the profile
    for (const status of ["active", "deactivated", "suspended"] as AccountStatus[]) {
      const id = await createUser(db, { status, photos: 2, removedPhotos: 1 });
      await owner(db, "update public.profiles set created_at = $2 where user_id = $1", [id, at(-365 * DAY)]);
      await photoPaths(id);
    }
  });

  it("lists exactly the due documents and accounts, with the stored paths", async () => {
    const rows = await candidates();
    expect(sorted(rows)).toEqual(sorted(expected));
    expect(new Set(rows.map((r) => JSON.stringify(r))).size).toBe(rows.length);
    for (const r of rows.filter((x) => x.storage_path)) expect(r.storage_path!.startsWith(`${r.user_id}/`)).toBe(true);
  });

  it("orders accounts first, each account's own row after its objects, so a cut listing ends at most one account early", async () => {
    const rows = await candidates();
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toEqual([...kinds].sort());
    const own = rows.filter((r) => r.kind === "account");
    expect(own.length).toBeGreaterThan(1);
    expect(own.at(-1)).toEqual({ kind: "account", user_id: deletedDue, submission_id: null, storage_path: null });
    // a cut anywhere inside the account's rows leaves out its own row
    for (let cut = 1; cut < own.length; cut += 1) {
      expect(own.slice(0, cut).some((r) => r.storage_path === null)).toBe(false);
    }
  });

  it("never lists a kept submission, an open submission or an account in another status", async () => {
    const rows = await candidates();
    const listed = new Set(rows.map((r) => r.submission_id));
    for (const s of kept) expect(listed.has(s.id), s.id).toBe(false);
    const users = new Set(rows.filter((r) => r.kind === "account").map((r) => r.user_id));
    expect([...users]).toEqual([deletedDue]);
  });

  it("an earlier sweep time lists less; a later one than now() is refused", async () => {
    // 1 ms earlier: the approval at exactly DUE and the account deleted at exactly DUE are not yet due,
    // so that account's old revoked document falls back to the document rule
    const earlier = await candidates(at(-1));
    expect(earlier.filter((r) => r.kind === "account")).toEqual([]);
    expect(earlier.filter((r) => r.user_id === decidedOwner)).toHaveLength(6);
    expect(earlier.filter((r) => r.user_id === deletedDue).map((r) => r.kind)).toEqual(["document", "document"]);
    expect(earlier.filter((r) => r.user_id === deletedYoung)).toEqual([]);
    expect(await raised(() => candidates(new Date(Date.now() + DAY).toISOString()))).toBe("validation");
    expect(await raised(() => candidates(null))).toBe("validation");
    const now = await asRole<Candidate>(db, "service_role", null, "select * from public.service_retention_candidates()");
    expect(now.some((r) => r.user_id === deletedYoung && r.kind === "account")).toBe(true);   // 60 days ago at now()
  });

  it("keeps an expired former reviewer and decision history", async () => {
    const own = (await db.clone()) as PGlite;
    try {
      await owner(own, "insert into public.profiles (user_id, display_name, gender, account_status) values ($1, 'Synthetic reviewer', 'female', 'deleted')", [reviewer]);
      await owner(own, "update public.profiles set deleted_at = $2 where user_id = $1", [reviewer, at(DUE)]);
      const rows = await candidates(T.toISOString(), own);
      expect(rows.filter((r) => r.user_id === reviewer)).toEqual([
        { kind: "skipped_reviewer", user_id: reviewer, submission_id: null, storage_path: null },
      ]);
      expect(await raised(() => owner(own, "delete from auth.users where id = $1", [reviewer])))
        .toMatch(/foreign key/);
      expect((await owner<{ n: number }>(own,
        "select count(*)::int as n from public.verification_submissions where reviewer_id = $1", [reviewer]))[0].n)
        .toBeGreaterThan(0);
    } finally { await own.close(); }
  });

  it("a re-run after the objects are gone lists only the account, and nothing after the Auth delete", async () => {
    const own = (await db.clone()) as PGlite;
    try {
      await owner(own, "delete from storage.objects");
      expect(await candidates(T.toISOString(), own))
        .toEqual([{ kind: "account", user_id: deletedDue, submission_id: null, storage_path: null }]);
      await owner(own, "delete from auth.users where id = $1", [deletedDue]);
      expect(await candidates(T.toISOString(), own)).toEqual([]);
      // the decided submissions and their decisions stay
      const [row] = await owner<{ n: number }>(own,
        "select count(*)::int as n from public.verification_submissions where user_id = $1 and intake_mode = 'upload' and decided_at is not null", [decidedOwner]);
      expect(row.n).toBe(6);
    } finally { await own.close(); }
  });
});

describe("RETENTION-001 account deletion time", () => {
  it("request_account_deletion stamps deleted_at once; other moves leave it null", async () => {
    const me = await createUser(db);
    const other = await createUser(db);
    const read = async (id: string) => (await owner<{ deleted_at: Date | null; status: string }>(db,
      "select deleted_at, account_status::text as status from public.profiles where user_id = $1", [id]))[0];
    expect((await rpc(db, user(other), "deactivate_account")).ok).toBe(true);
    expect(await read(other)).toEqual({ deleted_at: null, status: "deactivated" });
    const before = Date.now();
    expect((await rpc(db, user(me), "request_account_deletion")).ok).toBe(true);
    const stamped = await read(me);
    expect(stamped.status).toBe("deleted");
    expect(stamped.deleted_at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(stamped.deleted_at!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    await owner(db, "update public.profiles set bio = '架空の更新' where user_id = $1", [me]);
    expect((await read(me)).deleted_at).toEqual(stamped.deleted_at);
  });

  it("deleted_at exists exactly for deleted accounts", async () => {
    const active = await createUser(db);
    expect(await raised(() => owner(db, "update public.profiles set deleted_at = now() where user_id = $1", [active])))
      .toMatch(/profiles_deleted_at_check/);
    const gone = await createUser(db, { status: "deleted" });
    expect(await raised(() => owner(db, "update public.profiles set deleted_at = null where user_id = $1", [gone])))
      .toMatch(/profiles_deleted_at_check/);
  });

  it("the migration backfills accounts deleted before it from updated_at", async () => {
    const fresh = await PGlite.create();
    try {
      const root = join(MIGRATIONS_DIR, "..", "..");
      const all = migrationFiles();
      const files = all.slice(0, all.findIndex((f) => f.endsWith("_retention.sql")) + 1);   // orders 1-16; later ones are not needed
      expect(files.at(-1)).toMatch(/_retention\.sql$/);
      for (const file of [join(root, "tests", "db", "shim.sql"), ...files.slice(0, -1).map((f) => join(MIGRATIONS_DIR, f))]) {
        await fresh.exec(readFileSync(file, "utf8"));
      }
      const id = randomUUID();
      await fresh.exec(`
        insert into auth.users (id, email, email_confirmed_at) values ('${id}', 'backfill-${id}@example.invalid', now());
        insert into public.profiles (user_id, display_name, gender, account_status, updated_at)
          values ('${id}', '架空', 'female', 'deleted', '${at(-5 * DAY)}');`);
      await fresh.exec(readFileSync(join(MIGRATIONS_DIR, files.at(-1)!), "utf8"));
      const [row] = await owner<{ deleted_at: Date }>(fresh, "select deleted_at from public.profiles where user_id = $1", [id]);
      expect(row.deleted_at.toISOString()).toBe(at(-5 * DAY));
    } finally { await fresh.close(); }
  });
});

describe("RETENTION-001 service_purge_rate_limits", () => {
  it("deletes only records older than 7 days and returns the count", async () => {
    const own = (await db.clone()) as PGlite;
    try {
      await owner(own, "delete from private.rate_limit_events");
      const who = randomUUID();
      for (const [label, offset] of [["old", -8 * DAY], ["just-old", -7 * DAY - 1], ["edge", -7 * DAY], ["recent", -DAY], ["later", DAY]] as const) {
        await owner(own, "insert into private.rate_limit_events (user_id, action, created_at) values ($1, $2, $3)", [who, label, at(offset)]);
      }
      const purge = (now: string) => asRole<{ n: number }>(own, "service_role", null,
        "select public.service_purge_rate_limits($1::timestamptz) as n", [now]);
      expect(await purge(T.toISOString())).toEqual([{ n: 2 }]);
      expect((await owner<{ action: string }>(own, "select action from private.rate_limit_events order by created_at")).map((r) => r.action))
        .toEqual(["edge", "recent", "later"]);
      expect(await purge(T.toISOString())).toEqual([{ n: 0 }]);
      expect(await raised(() => purge(new Date(Date.now() + DAY).toISOString()))).toBe("validation");
      // at now() the T-relative records are all older than 7 days
      expect(await asRole(own, "service_role", null, "select public.service_purge_rate_limits() as n")).toEqual([{ n: 3 }]);
    } finally { await own.close(); }
  });
});

describe("RETENTION-001 only service_role may call the maintenance RPCs", () => {
  const calls = ["select * from public.service_retention_candidates()", "select public.service_purge_rate_limits()"];

  it("authenticated and anon are refused (permission denied) and nothing changes", async () => {
    const me = await createUser(db);
    const [events] = await owner<{ n: number }>(db, "select count(*)::int as n from private.rate_limit_events");
    for (const sql of calls) {
      expect(await raised(() => asUser(db, user(me), sql)), sql).toMatch(/permission denied/);
      expect(await raised(() => asRole(db, "anon", null, sql)), sql).toMatch(/permission denied/);
    }
    expect((await owner<{ n: number }>(db, "select count(*)::int as n from private.rate_limit_events"))[0]).toEqual(events);
  });

  it("execute is granted to service_role alone", async () => {
    const rows = await owner<{ fn: string; role: string; ok: boolean }>(db, `
      select p.proname as fn, r.role, has_function_privilege(r.role, p.oid, 'EXECUTE') as ok
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join unnest(array['anon', 'authenticated', 'service_role']) as r(role)
      where n.nspname = 'public' and p.proname in ('service_retention_candidates', 'service_purge_rate_limits')
      order by 1, 2`);
    expect(rows.filter((r) => r.ok).map((r) => `${r.fn}:${r.role}`))
      .toEqual(["service_purge_rate_limits:service_role", "service_retention_candidates:service_role"]);
  });
});

describe("RETENTION-003 orphan photo objects (order 26)", () => {
  const ORDER_25 = "20261115120025_signup_rate_limit.sql";
  const ORDER_26 = "20261115120026_orphan_photo_retention.sql";
  const HOUR = 3600_000;
  const AGE = -24 * HOUR;
  let old: PGlite;
  let before: Candidate[];
  let after: Candidate[];
  let expectedOrphans: Candidate[];
  let edge: string;
  const notListed: string[] = [];

  const put = (bucket: string, name: string | null, createdAt: string | null) =>
    owner(old, "insert into storage.objects (bucket_id, name, created_at) values ($1, $2, $3)", [bucket, name, createdAt]);

  beforeAll(async () => {
    // shim, orders 1-25 and the seed: a database before order 26
    old = await PGlite.create();
    const root = join(MIGRATIONS_DIR, "..", "..");
    const all = migrationFiles();
    const upTo25 = all.slice(0, all.indexOf(ORDER_25) + 1);
    expect(upTo25.at(-1)).toBe(ORDER_25);
    for (const file of [join(root, "tests", "db", "shim.sql"), ...upTo25.map((f) => join(MIGRATIONS_DIR, f))]) {
      const sql = readFileSync(file, "utf8");
      await old.transaction((tx) => tx.exec(sql));
    }
    const seed = seedSqlFor(ORDER_25);
    await old.transaction((tx) => tx.exec(seed));

    // every earlier kind: a due account with photos and a document, due documents, a kept former reviewer
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
    await owner(old, "insert into public.profiles (user_id, display_name, gender, account_status) values ($1, 'Synthetic reviewer', 'female', 'deleted')", [staffer]);
    await owner(old, "update public.profiles set deleted_at = $2 where user_id = $1", [staffer, at(DUE)]);

    // registered photos (active and removed), stored long ago: never orphans
    const owner1 = await createUser(old, { photos: 2, removedPhotos: 1 });
    for (const id of [gone, owner1]) {
      const rows = await owner<{ storage_path: string }>(old, "select storage_path from public.profile_photos where user_id = $1", [id]);
      for (const r of rows) {
        await put("profile-photos", r.storage_path, at(-90 * DAY));
        if (id === owner1) notListed.push(r.storage_path);
      }
    }

    // orphans: 24 hours or older, in a uuid folder, under the path rule, with no row
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
      await put("profile-photos", path, createdAt);
      expectedOrphans.push({ kind: "orphan_photo", user_id: userId, submission_id: null, storage_path: path });
    }
    // never listed: younger than 24 hours, no creation time, another bucket, or a name outside the path rule
    const young = `${owner1}/${randomUUID()}.webp`;
    await put("profile-photos", young, at(AGE + 1));
    const undated = `${owner1}/${randomUUID()}.webp`;
    await put("profile-photos", undated, null);
    const elsewhere = `${owner1}/${randomUUID()}.webp`;
    await put("verification-documents", elsewhere, at(-90 * DAY));
    const bad = [
      `${owner1.toUpperCase()}/${randomUUID()}.webp`,
      `not-a-uuid/${randomUUID()}.webp`,
      `${owner1.slice(0, 35)}/${randomUUID()}.webp`,
      `${owner1}x/${randomUUID()}.webp`,
      `${owner1}/${randomUUID()}.png`,
      `${owner1}/${randomUUID()}.webp.png`,
      `${owner1}/../${randomUUID()}.webp`,
      `${owner1}/${"a".repeat(65)}.webp`,
      `${owner1}//${randomUUID()}.webp`,
      `${owner1}/.webp`,
      `${owner1}/`,
      `${randomUUID()}.webp`,
      `/${owner1}/${randomUUID()}.webp`,
    ];
    for (const name of bad) await put("profile-photos", name, at(-90 * DAY));
    await put("profile-photos", null, at(-90 * DAY));
    notListed.push(young, undated, elsewhere, ...bad);

    before = await candidates(T.toISOString(), old);
    const sql = readFileSync(join(MIGRATIONS_DIR, ORDER_26), "utf8");
    await old.transaction((tx) => tx.exec(sql));
    after = await candidates(T.toISOString(), old);
  });
  afterAll(async () => { await old?.close(); });

  it("is order 26", () => {
    expect(migrationFiles()[25]).toBe(ORDER_26);
    expect(migrationFiles().length).toBeGreaterThanOrEqual(26);   // order 27 (RETENTION-004) follows
  });

  it("lists exactly the orphans 24 hours or older; every other row is the order-25 output, in the same order", () => {
    expect(new Set(before.map((r) => r.kind))).toEqual(new Set(["account", "document", "skipped_reviewer"]));
    expect(after.filter((r) => r.kind !== "orphan_photo")).toEqual(before);
    expect(sorted(after.filter((r) => r.kind === "orphan_photo"))).toEqual(sorted(expectedOrphans));
    const kinds = after.map((r) => r.kind);
    expect(kinds).toEqual([...kinds].sort());
    expect(new Set(after.map((r) => JSON.stringify(r))).size).toBe(after.length);
  });

  it("never lists a registered, younger, undated, other-bucket or badly named object", () => {
    const paths = new Set(after.map((r) => r.storage_path));
    for (const name of notListed) expect(paths.has(name), name).toBe(false);
    for (const r of after.filter((x) => x.kind === "orphan_photo")) {
      expect(r.storage_path!.startsWith(`${r.user_id}/`)).toBe(true);
      expect(r.submission_id).toBeNull();
    }
  });

  it("measures the 24 hours against p_now, and a re-run after the deletes lists no orphan", async () => {
    const earlier = await candidates(at(-1), old);
    expect(earlier.some((r) => r.storage_path === edge)).toBe(false);
    expect(earlier.filter((r) => r.kind === "orphan_photo")).toHaveLength(expectedOrphans.length - 1);
    const own = (await old.clone()) as PGlite;
    try {
      await owner(own, "delete from storage.objects where bucket_id = 'profile-photos' and name = any($1::text[])",
        [expectedOrphans.map((r) => r.storage_path)]);
      expect(await candidates(T.toISOString(), own)).toEqual(before);
    } finally { await own.close(); }
  });

  it("keeps the signature, definer, search_path and service_role-only execute", async () => {
    const [fn] = await owner<{ definer: boolean; config: string[]; volatility: string; result: string; args: string }>(old, `
      select p.prosecdef as definer, p.proconfig as config, p.provolatile::text as volatility,
             pg_get_function_result(p.oid) as result, pg_get_function_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'service_retention_candidates'`);
    expect(fn).toEqual({ definer: true, config: ['search_path=""'], volatility: "s",
      result: "TABLE(kind text, user_id uuid, submission_id uuid, storage_path text)",
      args: "p_now timestamp with time zone DEFAULT now()" });
    const grants = await owner<{ role: string; ok: boolean }>(old, `
      select r.role, has_function_privilege(r.role, 'public.service_retention_candidates(timestamptz)', 'EXECUTE') as ok
      from unnest(array['anon', 'authenticated', 'service_role']) as r(role) order by 1`);
    expect(grants.filter((g) => g.ok).map((g) => g.role)).toEqual(["service_role"]);
    const me = await createUser(old);
    const sql = "select * from public.service_retention_candidates()";
    expect(await raised(() => asUser(old, user(me), sql))).toMatch(/permission denied/);
    expect(await raised(() => asRole(old, "anon", null, sql))).toMatch(/permission denied/);
  });
});
