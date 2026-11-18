// FIX-010 (docs/39 P-3): the re-anchor of scripts/e2e-hosted/bootstrap.sql binds the test admin's roles only to its
// one and only verified factor, a TOTP created within the last 10 minutes; anything else changes nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { createUser } from "./fixtures";
import { fingerprint, freshDb, owner, raised, rpcRows, staff } from "./harness";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BOOTSTRAP = readFileSync(join(ROOT, "scripts", "e2e-hosted", "bootstrap.sql"), "utf8");
const ADMIN = "e2e-admin@example.invalid";
const ADMIN_ID = "00000000-0000-4000-8000-0000000e2e01";
const ALL_ACT = "admin=true,moderator=true,reviewer=true";
const NONE_ACT = "admin=false,moderator=false,reviewer=false";

interface Result {
  schools: number; departments: number; classes: number;
  admin_roles: string | null; factor_created_at: string | null; reanchor: string | null;
}

let db: PGlite | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

/** A fresh database with the confirmed test admin and no staff rows or factors. */
async function setup(): Promise<PGlite> {
  db = await freshDb();
  await owner(db, "insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [ADMIN_ID, ADMIN]);
  return db;
}

/** Runs the whole file as the SQL editor does (one message) and returns its result row. */
async function bootstrap(db: PGlite): Promise<Result> {
  const results = await db.exec(BOOTSTRAP);
  return results[results.length - 1].rows[0] as unknown as Result;
}

/** A factor of the test admin created `ago` before now (an interval), written by owner SQL like Auth would. */
async function addFactor(db: PGlite, ago: string, type = "totp", status = "verified"): Promise<void> {
  await owner(db, `insert into auth.mfa_factors (id, user_id, factor_type, status, created_at)
    values (gen_random_uuid(), $1, $2::auth.factor_type, $3::auth.factor_status, now() - $4::interval)`,
  [ADMIN_ID, type, status, ago]);
}

/** The first run (before any factor), with its grants moved an hour back so every factor added later is after them. */
async function grantedBeforeFactors(db: PGlite): Promise<void> {
  const first = await bootstrap(db);
  expect(first).toMatchObject({ admin_roles: NONE_ACT, factor_created_at: null, reanchor: "no_factor" });
  await owner(db, "update private.staff_roles set granted_at = now() - interval '1 hour' where user_id = $1", [ADMIN_ID]);
}

const rowsOf = (db: PGlite) => owner<{ role: string; active: boolean }>(db,
  "select role::text, revoked_at is null as active from private.staff_roles where user_id = $1 order by role, granted_at", [ADMIN_ID]);
const reanchorAudit = (db: PGlite) => owner<{ action: string; role: string }>(db, `select action, detail ->> 'role' as role
  from private.audit_log where target_id = $1 and detail ->> 'via' = 'reanchor' order by id`, [ADMIN_ID]);
const adminActs = async (db: PGlite) => raised(() => rpcRows(db, staff(ADMIN_ID), "admin_list_staff"));

/** A run that must refuse with `reason` and change no row anywhere. */
async function refuses(db: PGlite, reason: string): Promise<Result> {
  const before = await fingerprint(db);
  const result = await bootstrap(db);
  expect(result.reanchor).toBe(reason);
  expect(result.admin_roles).toBe(NONE_ACT);
  expect(await fingerprint(db)).toBe(before);
  expect(await reanchorAudit(db)).toEqual([]);
  expect(await adminActs(db)).toBe("forbidden");
  return result;
}

describe("FIX-010 bootstrap re-anchor", () => {
  it("one TOTP enrolled just now: re-anchored with audit rows, the roles act, and a re-run is idempotent", async () => {
    const db = await setup();
    await grantedBeforeFactors(db);
    await addFactor(db, "1 minute");
    expect(await adminActs(db)).toBe("forbidden");
    const second = await bootstrap(db);
    expect(second).toMatchObject({ schools: 2, departments: 4, classes: 8, admin_roles: ALL_ACT, reanchor: "done" });
    expect(second.factor_created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(second.factor_created_at).not.toContain(",");
    // the old rows stay as history
    expect(await rowsOf(db)).toEqual(["admin", "moderator", "reviewer"].flatMap(role =>
      [{ role, active: false }, { role, active: true }]));
    // the loop runs in staff_role enum order (reviewer, moderator, admin)
    expect(await reanchorAudit(db)).toEqual(["reviewer", "moderator", "admin"].flatMap(role =>
      [{ action: "revoke_role", role }, { action: "grant_role", role }]));
    expect(await adminActs(db)).toBe("");

    const before = await fingerprint(db);
    const third = await bootstrap(db);
    expect(third).toMatchObject({ admin_roles: ALL_ACT, reanchor: "none_needed", factor_created_at: second.factor_created_at });
    expect(await fingerprint(db)).toBe(before);
  });

  it("a TOTP enrolled 9 minutes ago is still re-anchored", async () => {
    const db = await setup();
    await grantedBeforeFactors(db);
    await addFactor(db, "9 minutes");
    expect(await bootstrap(db)).toMatchObject({ admin_roles: ALL_ACT, reanchor: "done" });
  });

  it("once the factor is older than 10 minutes, a re-run reports factor_too_old and the acting roles stay", async () => {
    const db = await setup();
    await grantedBeforeFactors(db);
    await addFactor(db, "1 minute");
    expect((await bootstrap(db)).reanchor).toBe("done");
    await owner(db, "update auth.mfa_factors set created_at = created_at - interval '20 minutes' where user_id = $1", [ADMIN_ID]);
    await owner(db, `update private.staff_roles set granted_at = granted_at - interval '20 minutes'
      where user_id = $1 and revoked_at is null`, [ADMIN_ID]);
    const before = await fingerprint(db);
    expect(await bootstrap(db)).toMatchObject({ admin_roles: ALL_ACT, reanchor: "factor_too_old" });
    expect(await fingerprint(db)).toBe(before);
    expect(await adminActs(db)).toBe("");
  });

  it("one TOTP created more than 10 minutes ago: refused, nothing changes", async () => {
    const db = await setup();
    await grantedBeforeFactors(db);
    await addFactor(db, "11 minutes");
    await refuses(db, "factor_too_old");
  });

  it.each([
    ["two verified TOTP factors, both new", ["totp", "totp"]],
    ["a new verified TOTP and a verified phone factor", ["totp", "phone"]],
    ["a new verified TOTP and a verified webauthn factor", ["totp", "webauthn"]],
  ])("%s: refused as several_factors, nothing changes", async (_, types) => {
    const db = await setup();
    await grantedBeforeFactors(db);
    for (const type of types) await addFactor(db, "1 minute", type);
    const result = await refuses(db, "several_factors");
    expect(result.factor_created_at?.split(",")).toHaveLength(2);
  });

  it("no verified TOTP (none, only unverified, or only another type): no_factor, nothing changes", async () => {
    const db = await setup();
    await grantedBeforeFactors(db);
    await refuses(db, "no_factor");
    await addFactor(db, "1 minute", "totp", "unverified");
    await refuses(db, "no_factor");
    await addFactor(db, "1 minute", "phone");
    await refuses(db, "no_factor");
  });

  it("another account's new factor is neither counted nor touched", async () => {
    const db = await setup();
    await grantedBeforeFactors(db);
    const other = await createUser(db);
    await owner(db, `insert into auth.mfa_factors (id, user_id, factor_type, status)
      values (gen_random_uuid(), $1, 'totp', 'verified')`, [other]);
    await refuses(db, "no_factor");
  });

  it("the result row carries no id or email", async () => {
    const db = await setup();
    await grantedBeforeFactors(db);
    await addFactor(db, "1 minute");
    const result = await bootstrap(db);
    expect(Object.keys(result).sort()).toEqual(["admin_roles", "classes", "departments", "factor_created_at", "reanchor", "schools"]);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(text).not.toContain("@");
  });
});
