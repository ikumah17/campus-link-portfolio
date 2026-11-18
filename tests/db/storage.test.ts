import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser } from "./fixtures";
import { asRole, asUser, freshDb, owner, user } from "./harness";

const migration = readFileSync(new URL("../../supabase/migrations/20261109120015_storage.sql", import.meta.url), "utf8");
const insert = "insert into storage.objects (bucket_id, name) values ($1, $2)";

describe("STORAGE-001 private Storage SQL boundary (test-only stand-in)", () => {
  let db: PGlite;
  let me: string;
  let other: string;
  beforeAll(async () => {
    db = await freshDb();
    me = await createUser(db);
    other = await createUser(db);
    // Nonempty fixtures ensure an empty SELECT is evidence of denial.
    for (const bucket of ["profile-photos", "verification-documents"]) {
      await owner(db, insert, [bucket, `${me}/fixture/1.webp`]);
    }
  });
  afterAll(async () => { await db?.close(); });

  it("creates exactly two private WebP buckets with bounded sizes, idempotently", async () => {
    const sql = "select id, name, public, file_size_limit::int, allowed_mime_types from storage.buckets order by id";
    const expected = [
      { id: "profile-photos", name: "profile-photos", public: false, file_size_limit: 2097152, allowed_mime_types: ["image/webp"] },
      { id: "verification-documents", name: "verification-documents", public: false, file_size_limit: 5242880, allowed_mime_types: ["image/webp"] },
    ];
    expect(await owner(db, sql)).toEqual(expected);
    const bucketInsert = migration.slice(migration.indexOf("insert into storage.buckets"), migration.indexOf("create policy"));
    await db.exec(bucketInsert);
    await db.exec(bucketInsert);
    expect(await owner(db, sql)).toEqual(expected);
  });

  it("has exactly the authenticated document INSERT policy and enables RLS", async () => {
    expect(await owner(db, `select policyname, cmd, roles, qual, with_check from pg_policies
      where schemaname = 'storage' and tablename = 'objects'`)).toEqual([{
      policyname: "verification_documents_insert", cmd: "INSERT", roles: ["authenticated"], qual: null,
      with_check: "((bucket_id = 'verification-documents'::text) AND private.rls_document_upload_allowed(name))",
    }]);
    expect(await owner(db, "select relrowsecurity from pg_class where oid = 'storage.objects'::regclass"))
      .toEqual([{ relrowsecurity: true }]);
  });

  it("denies photo inserts and synthetic document inserts even for an eligible owner", async () => {
    expect(await owner(db, "select value from private.app_settings where key = 'verification_intake'"))
      .toEqual([{ value: "synthetic" }]);
    for (const bucket of ["profile-photos", "verification-documents"]) {
      await expect(asUser(db, user(me), insert, [bucket, `${me}/submission/1.webp`])).rejects.toThrow(/row-level security/);
    }
  });

  it("permits upload-mode document INSERT only under the session owner's path", async () => {
    await owner(db, "update private.app_settings set value = 'upload' where key = 'verification_intake'");
    try {
      const path = `${me}/submission/1.webp`;
      // No RETURNING: INSERT does not grant SELECT.
      const sql = "insert into storage.objects (bucket_id, name) values ($1, $2)";
      await asUser(db, user(me), sql, ["verification-documents", path]);
      expect(await owner(db, "select name from storage.objects where name = $1", [path])).toEqual([{ name: path }]);
      await expect(asUser(db, user(other), sql, ["verification-documents", path])).rejects.toThrow(/row-level security/);
      await expect(asUser(db, user(me), sql, ["profile-photos", path])).rejects.toThrow(/row-level security/);
    } finally {
      await owner(db, "update private.app_settings set value = 'synthetic' where key = 'verification_intake'");
    }
  });

  it("hides existing objects and refuses mutation; RLS also denies mutations independently of grants", async () => {
    expect(await asUser(db, user(me), "select * from storage.objects")).toEqual([]);
    for (const sql of ["update storage.objects set name = 'changed' returning id", "delete from storage.objects returning id"]) {
      await expect(asUser(db, user(me), sql)).rejects.toThrow(/permission denied/);
    }
    const before = await owner(db, "select * from storage.objects order by id");
    // Isolate RLS from missing table privileges; roll back these test-only grants.
    await db.exec("begin; grant update, delete on storage.objects to authenticated;");
    try {
      await db.exec("set local role authenticated");
      expect((await db.query("update storage.objects set name = 'changed' returning id")).rows).toEqual([]);
      expect((await db.query("delete from storage.objects returning id")).rows).toEqual([]);
    } finally { await db.exec("rollback"); }
    expect(await owner(db, "select * from storage.objects order by id")).toEqual(before);
  });

  it("refuses every anon operation", async () => {
    for (const sql of [
      "select * from storage.objects",
      "insert into storage.objects (bucket_id, name) values ('verification-documents', 'anon/1.webp')",
      "update storage.objects set name = 'changed'",
      "delete from storage.objects",
    ]) await expect(asRole(db, "anon", null, sql)).rejects.toThrow(/permission denied/);
  });
});
