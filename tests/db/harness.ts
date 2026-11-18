// BE-001 PGlite harness: test shim -> supabase/migrations (orders 1-10) -> supabase/seed.sql.
// Every user call runs in its own transaction as role authenticated with request.jwt.claims set,
// like one PostgREST request; results are then checked from a separate owner transaction.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{14}_[a-z_]+\.sql$/.test(name))
    .sort();
}

export async function applySchema(db: PGlite, options: { seed?: boolean } = {}): Promise<void> {
  const files = [join(ROOT, "tests", "db", "shim.sql"), ...migrationFiles().map((f) => join(MIGRATIONS_DIR, f))];
  if (options.seed !== false) files.push(join(ROOT, "supabase", "seed.sql"));
  for (const file of files) {
    const sql = readFileSync(file, "utf8");
    await db.transaction((tx) => tx.exec(sql));
  }
}

export const SEED_FILE = join(ROOT, "supabase", "seed.sql");

/**
 * The seed in its form before order 34 (DB-LIKES-001), for suites that build an older schema: the friends bio column
 * and one friends mode per demo user instead of bio and purposes. Everything else is the current seed unchanged.
 */
export function seedSqlBefore34(): string {
  const sql = readFileSync(SEED_FILE, "utf8").replace(/\r\n/g, "\n");
  const header = "insert into public.profiles (user_id, display_name, gender, bio, purposes, hobbies) values";
  if (!sql.includes(header)) throw new Error("seed profiles header changed");
  return sql
    .replace(header, "insert into public.profiles (user_id, display_name, gender, bio_friends, hobbies) values")
    .replace(/('架空のデモ用プロフィールです。'), '\{[a-z,]*\}',\s*/g, "$1, ")
    + "\ninsert into public.profile_modes (user_id, mode)\n"
    + "select id, 'friends' from auth.users where email like 'demo-user-%@example.invalid';\n";
}

/** The seed for a database built up to the given order file. */
export function seedSqlFor(lastOrder: string): string {
  const files = migrationFiles();
  const index = files.indexOf(lastOrder);
  if (index < 0) throw new Error(`unknown order ${lastOrder}`);
  return index < files.findIndex((f) => f.endsWith("_likes_single_mode.sql")) ? seedSqlBefore34() : readFileSync(SEED_FILE, "utf8");
}

let base: Promise<PGlite> | undefined;

/** A fresh database with shim, migrations and seed applied (cloned from one base per worker). */
export async function freshDb(): Promise<PGlite> {
  base ??= (async () => {
    const db = await PGlite.create();
    await applySchema(db);
    return db;
  })();
  return (await base).clone() as Promise<PGlite>;
}

export interface Session {
  sub?: string;
  aal?: "aal1" | "aal2";
  isAnonymous?: boolean;
  /** omit the is_anonymous claim entirely */
  omitAnonymousClaim?: boolean;
  /** omit the sub claim entirely */
  omitSub?: boolean;
}

export function claimsOf(session: Session): Record<string, unknown> {
  const claims: Record<string, unknown> = { role: "authenticated", aal: session.aal ?? "aal1" };
  if (!session.omitSub && session.sub) claims.sub = session.sub;
  if (!session.omitAnonymousClaim) claims.is_anonymous = session.isAnonymous ?? false;
  return claims;
}

export const user = (sub: string): Session => ({ sub });
export const staff = (sub: string): Session => ({ sub, aal: "aal2" });

type Role = "authenticated" | "anon" | "service_role";

/** One committed transaction as an API role. Throws (and rolls back) on any error. */
export async function asRole<T>(
  db: PGlite,
  role: Role,
  session: Session | null,
  sql: string,
  params: unknown[] = [],
  options: { isolation?: "repeatable read" | "serializable" } = {},
): Promise<T[]> {
  return db.transaction(async (tx) => {
    if (options.isolation) await tx.query(`set transaction isolation level ${options.isolation}`);
    await tx.query(`set local role ${role}`);
    if (session) {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claimsOf(session))]);
    }
    return (await tx.query<T>(sql, params)).rows;
  });
}

export function asUser<T>(db: PGlite, session: Session, sql: string, params: unknown[] = [],
  options: { isolation?: "repeatable read" | "serializable" } = {}): Promise<T[]> {
  return asRole<T>(db, "authenticated", session, sql, params, options);
}

/** Owner (postgres) query in its own transaction: preparation SQL and persistent-state checks. */
export async function owner<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

export interface Outcome {
  ok: boolean;
  code: string;
  ref: string | null;
}

function call(fn: string, args: unknown[], casts: string[] = []): string {
  const list = args.map((_, i) => `$${i + 1}${casts[i] ? `::${casts[i]}` : ""}`).join(", ");
  return `public.${fn}(${list})`;
}

/** Calls a state-changing RPC in its own committed transaction and returns its rpc_outcome. */
export async function rpc(db: PGlite, session: Session, fn: string, args: unknown[] = [], casts: string[] = []): Promise<Outcome> {
  const rows = await asUser<Outcome>(db, session, `select * from ${call(fn, args, casts)}`, args);
  return rows[0];
}

/** Calls a set-returning RPC in its own transaction. */
export function rpcRows<T>(db: PGlite, session: Session, fn: string, args: unknown[] = [], casts: string[] = [],
  options: { isolation?: "repeatable read" | "serializable" } = {}): Promise<T[]> {
  return asUser<T>(db, session, `select * from ${call(fn, args, casts)}`, args, options);
}

/** The error message of a call that must raise, or "" when it did not raise. */
export async function raised(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (error as Error).message;
  }
  return "";
}

/** Hash of every row of every table in public, private and auth: proves "no row changed".
 *  `exclude` names tables ("schema.table") whose expected change the caller checks itself. */
export async function fingerprint(db: PGlite, exclude: string[] = []): Promise<string> {
  const tables = await owner<{ t: string }>(db, `
    select format('%I.%I', schemaname, tablename) as t from pg_tables
    where schemaname in ('public', 'private', 'auth') and format('%I.%I', schemaname, tablename) <> all ($1::text[])
    order by 1`, [exclude]);
  const parts = tables.map(({ t }) =>
    `select '${t}' as t, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from ${t} x`);
  const rows = await owner<{ t: string; h: string }>(db, parts.join(" union all "));
  return rows.map((r) => `${r.t}:${r.h}`).join(",");
}

export const OUTCOME_OK = { ok: true, code: "ok" } as const;
export const deny = (code: string): Outcome => ({ ok: false, code, ref: null });
