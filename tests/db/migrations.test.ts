// Acceptance 2 (docs/25): shim -> all migrations -> seed apply cleanly to an empty database, every time.
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applySchema, migrationFiles, owner } from "./harness";

describe("migrations and seed", () => {
  it("are exactly docs/04 §12 orders 1-35 (complete) in order", () => {
    expect(migrationFiles().map((f) => f.replace(/^\d{14}_/, ""))).toEqual([
      "foundation.sql",
      "affiliation_master.sql",
      "accounts.sql",
      "verification.sql",
      "staff_audit.sql",
      "connections_chat_tables.sql",
      "visibility.sql",
      "connections_chat_rpc.sql",
      "safety.sql",
      "admin.sql",
      "admin_affiliations.sql",
      "realtime.sql",
      "revoke_by_submission.sql",
      "staff_management.sql",
      "storage.sql",
      "retention.sql",
      "deleted_account.sql",
      "my_account_deleted.sql",
      "my_staff_roles.sql",
      "grant_requires_totp.sql",
      "photo_rate_limit.sql",
      "auth_rate_limit.sql",
      "suspended_accounts.sql",
      "signin_ip_limit.sql",
      "signup_rate_limit.sql",
      "orphan_photo_retention.sql",
      "orphan_document_retention.sql",
      "removed_photo_retention.sql",
      "staff_totp_binding.sql",
      "last_admin_acting.sql",
      "document_cap_open_only.sql",
      "withdrawn_superseded_documents.sql",
      "hide_reported_content.sql",
      "likes_single_mode.sql",
      "staff_acting_column.sql",
    ]);
  });

  it("apply cleanly to two independent empty databases with the same resulting catalog", async () => {
    const catalogs: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const db = await PGlite.create();
      await applySchema(db);
      const [row] = await owner<{ objects: string }>(db, `
        select string_agg(n.nspname || '.' || c.relname || ':' || c.relkind::text, ',' order by n.nspname, c.relname) as objects
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'private')`);
      catalogs.push(row.objects);
      await db.close();
    }
    expect(catalogs[0]).toBe(catalogs[1]);
    expect(catalogs[0]).toContain("public.verification_submissions:r");
  });

  it("publishes exactly public.messages to Realtime", async () => {
    const db = await PGlite.create();
    try {
      await applySchema(db);
      expect(await owner(db, "select schemaname, tablename from pg_publication_tables where pubname = 'supabase_realtime' order by schemaname, tablename"))
        .toEqual([{ schemaname: "public", tablename: "messages" }]);
    } finally { await db.close(); }
  });

  it("the seed is fictional only", async () => {
    const db = await PGlite.create();
    await applySchema(db);
    const emails = await owner<{ email: string }>(db, "select email from auth.users");
    expect(emails.length).toBeGreaterThan(0);
    for (const { email } of emails) expect(email).toMatch(/@example\.invalid$/);
    const names = await owner<{ name: string }>(db, `
      select name from public.schools union all select name from public.departments
      union all select name from public.classes`);
    for (const { name } of names) expect(name).toMatch(/（架空）$/);
    const ages = await owner<{ adult: boolean }>(db,
      "select private.adult_from(birth_date) <= private.today_jst() as adult from private.user_private");
    expect(ages.every((r) => r.adult)).toBe(true);
    const refs = await owner<{ n: number }>(db, "select count(*)::int as n from public.verification_submissions");
    expect(refs[0].n).toBe(0);
    await db.close();
  });
});
