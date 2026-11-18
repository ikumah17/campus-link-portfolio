// RETENTION-006 (order 31, docs/04_DATABASE.md §9, §11): the document upload cap counts only unnamed objects and
// objects of open submissions; objects of the caller's decided uploads no longer count. The order-28 path, folder and
// synthetic-mode cases run against the newest schema in removed-photo-retention.test.ts. Order 32 (RETENTION-007)
// adds withdrawn and superseded to the decided set (withdrawn-superseded-documents.test.ts); the frame tests below
// compare orders 30 and 31 exactly.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaff, createUser } from "./fixtures";
import { asUser, freshDb, MIGRATIONS_DIR, migrationFiles, owner, raised, user } from "./harness";

const ORDER_30 = "20261116120030_last_admin_acting.sql";
const ORDER_31 = "20261116120031_document_cap_open_only.sql";

type Status = "submitted" | "in_review" | "approved" | "rejected" | "revoked" | "withdrawn" | "superseded";

describe("RETENTION-006 order 31", () => {
  it("is order 31", () => {
    expect(migrationFiles()[30]).toBe(ORDER_31);
    expect(migrationFiles().length).toBeGreaterThanOrEqual(31);   // order 32 (RETENTION-007) follows
  });
});

describe("RETENTION-006 the document upload cap in upload mode", () => {
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
  /** A submission row naming `refs`, as the reviewer and withdraw/affiliation flows leave it. */
  const submission = (me: string, status: Status, refs: string[], options: { kind?: "age" | "enrollment"; intake?: "upload" | "synthetic" } = {}) => {
    const kind = options.kind ?? (status === "superseded" ? "enrollment" : "age");
    const staffed = ["in_review", "approved", "rejected", "revoked"].includes(status);
    const decided = !["submitted", "in_review"].includes(status);
    return owner<{ id: string }>(db, `
      insert into public.verification_submissions
        (user_id, kind, status, intake_mode, document_refs, affiliation_snapshot, reviewer_id, claimed_at, decided_at, decision_reason)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [me, kind, status, options.intake ?? "upload", refs, kind === "enrollment" ? "{}" : null, staffed ? staffer : null,
      staffed ? new Date().toISOString() : null, decided ? new Date().toISOString() : null,
      status === "superseded" ? "affiliation_changed" : status === "rejected" ? "unreadable" : null]);
  };
  const allowed = async (me: string) => {
    const object = name(me);
    await upload(me, object);
    expect((await owner<{ n: number }>(db, "select count(*)::int as n from storage.objects where name = $1", [object]))[0].n).toBe(1);
  };
  const refused = async (me: string) => {
    const [count] = await owner<{ n: number }>(db, "select count(*)::int as n from storage.objects");
    expect(await raised(() => upload(me, name(me)))).toMatch(/row-level security/);
    expect((await owner<{ n: number }>(db, "select count(*)::int as n from storage.objects"))[0]).toEqual(count);
  };

  beforeAll(async () => {
    db = await freshDb();
    await owner(db, "update private.app_settings set value = 'upload' where key = 'verification_intake'");
    staffer = await createStaff(db, ["reviewer"]);
  });
  afterAll(async () => { await db?.close(); });

  it("16 objects of decided submissions and nothing else: a new upload is allowed", async () => {
    const me = await createUser(db);
    for (const status of ["approved", "rejected", "rejected", "revoked"] as const) await submission(me, status, await store(me, 4));
    await allowed(me);
  });

  it("16 unnamed objects: refused", async () => {
    const me = await createUser(db);
    await store(me, 16);
    await refused(me);
  });

  it("12 unnamed objects and 4 of an open submission: refused, whether submitted or in review", async () => {
    for (const status of ["submitted", "in_review"] as const) {
      const me = await createUser(db);
      await store(me, 12);
      await submission(me, status, await store(me, 4));
      await refused(me);
    }
  });

  it("15 counted objects and 10 decided: allowed once, then refused", async () => {
    const me = await createUser(db);
    await store(me, 7);
    await submission(me, "submitted", await store(me, 4), { kind: "age" });
    await submission(me, "in_review", await store(me, 4), { kind: "enrollment" });
    for (const [status, count] of [["approved", 4], ["rejected", 4], ["revoked", 2]] as const) {
      await submission(me, status, await store(me, count));
    }
    await allowed(me);
    await refused(me);
  });

  it("an object named by both a decided and an open submission counts", async () => {
    const me = await createUser(db);
    await store(me, 15);
    const [shared] = await store(me, 1);
    await submission(me, "rejected", [shared]);
    await submission(me, "submitted", [shared]);
    await refused(me);
    // the open row names it even when it belongs to another user
    const other = await createUser(db);
    const own = await createUser(db);
    await store(own, 15);
    const [mine] = await store(own, 1);
    await submission(own, "approved", [mine]);
    await submission(other, "in_review", [mine]);
    await refused(own);
  });

  it("objects of synthetic rows or another user's decision still count", async () => {
    // withdrawn and superseded objects no longer count from order 32 (withdrawn-superseded-documents.test.ts)
    for (const add of [
      (me: string, refs: string[]) => submission(me, "approved", refs, { intake: "synthetic" }),
      async (_me: string, refs: string[]) => submission(await createUser(db), "rejected", refs),
    ]) {
      const me = await createUser(db);
      await store(me, 12);
      await add(me, await store(me, 4));
      await refused(me);
    }
  });

  it("a decided object frees a place as soon as the decision is stored; another folder's objects never count", async () => {
    const me = await createUser(db);
    const other = await createUser(db);
    await store(me, 12);
    await store(other, 16);
    const refs = await store(me, 4);
    const [{ id }] = await submission(me, "submitted", refs);
    await refused(me);
    await owner(db, "update public.verification_submissions set status = 'in_review', reviewer_id = $2, claimed_at = now(), version = version + 1 where id = $1", [id, staffer]);
    await refused(me);
    await owner(db, "update public.verification_submissions set status = 'rejected', decided_at = now(), decision_reason = 'unreadable', version = version + 1 where id = $1", [id]);
    // only the 12 unnamed objects count now, so four more fit
    for (let i = 0; i < 4; i += 1) await allowed(me);
    await refused(me);
  });

  it("synthetic mode still refuses every insert, even with only decided objects", async () => {
    const me = await createUser(db);
    await submission(me, "approved", await store(me, 4));
    await owner(db, "update private.app_settings set value = 'synthetic' where key = 'verification_intake'");
    try { await refused(me); } finally {
      await owner(db, "update private.app_settings set value = 'upload' where key = 'verification_intake'");
    }
  });
});

/** shim and orders 1 to `last` */
async function upTo(last: string): Promise<PGlite> {
  const target = await PGlite.create();
  const root = join(MIGRATIONS_DIR, "..", "..");
  const all = migrationFiles();
  const files = all.slice(0, all.indexOf(last) + 1);
  expect(files.at(-1)).toBe(last);
  for (const file of [join(root, "tests", "db", "shim.sql"), ...files.map((f) => join(MIGRATIONS_DIR, f))]) {
    const sql = readFileSync(file, "utf8");
    await target.transaction((tx) => tx.exec(sql));
  }
  return target;
}

describe("RETENTION-006 the function's frame", () => {
  let old: PGlite;
  let db: PGlite;
  const frame = (target: PGlite) => owner(target, `
    select p.prosecdef as definer, p.proconfig as config, p.provolatile::text as volatility, (select l.lanname from pg_language l where l.oid = p.prolang)::text as lang,
           pg_get_function_result(p.oid) as result, pg_get_function_arguments(p.oid) as args, p.proowner::regrole::text as owner,
           array(select r.role from unnest(array['anon', 'authenticated', 'service_role']) as r(role)
                 where has_function_privilege(r.role, p.oid, 'EXECUTE')) as executors,
           coalesce(p.proacl::text[], '{}') as acl
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'rls_document_upload_allowed'`);

  beforeAll(async () => {
    // shim and orders 1-30: the database before order 31; then the same with order 31
    old = await upTo(ORDER_30);
    db = await upTo(ORDER_31);
  });
  afterAll(async () => { await old?.close(); await db?.close(); });

  it("keeps the signature, definer, search_path, volatility, owner and grants of order 28", async () => {
    const before = await frame(old);
    const after = await frame(db);
    expect(before).toHaveLength(1);
    expect(after).toEqual(before);
    expect(after[0]).toMatchObject({ definer: true, config: ['search_path=""'], volatility: "s", lang: "sql",
      result: "boolean", args: "p_object_name text", executors: ["authenticated"] });
  });

  it("changes only the count, and the insert policy still calls it", async () => {
    const body = async (target: PGlite) => (await owner<{ body: string }>(target, `
      select p.prosrc as body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname = 'rls_document_upload_allowed'`))[0].body;
    const [before, after] = [await body(old), await body(db)];
    expect(after).not.toBe(before);
    expect(after).toContain("d.status in ('approved', 'rejected', 'revoked')");
    expect(after).toContain("o.status in ('submitted', 'in_review')");
    expect(after).toContain("limit 16) n) < 16");
    // every order-28 line other than the count stays
    const head = (text: string) => text.slice(0, text.indexOf("and so.name like"));
    expect(head(after)).toBe(head(before));
    const policies = async (target: PGlite) => owner(target, `
      select policyname, cmd, roles::text[] as roles, qual, with_check from pg_policies
      where schemaname = 'storage' and tablename = 'objects' order by policyname`);
    expect(await policies(db)).toEqual(await policies(old));
  });
});
