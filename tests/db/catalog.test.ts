// NT-01, NT-02, NT-03 and the NT-27 return-type check (docs/04_DATABASE.md §13.2): catalog against allowlists.
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AUTHENTICATED_PRIVATE_FUNCTIONS, AUTHENTICATED_SELECT_TABLES, PRIVATE_TABLES, PUBLIC_TABLES, READ_RPCS,
  REVOKE_VERIFICATION_ARGUMENTS, SERVICE_MAINTENANCE_RPCS, SERVICE_RPCS, STATE_CHANGING_RPCS, VERIFICATION_SUBMISSION_COLUMNS,
} from "./allowlist";
import { asRole, freshDb, owner, raised } from "./harness";

interface Fn {
  schema: string;
  name: string;
  definer: boolean;
  config: string[] | null;
  volatility: string;
  rettype: string;
  argtypes: string[];
}

const names = (rows: { name: string }[]) => rows.map((r) => r.name).sort();

function listFunctions(db: PGlite): Promise<Fn[]> {
  return owner<Fn>(db, `
    select n.nspname as schema, p.proname as name, p.prosecdef as definer,
           p.proconfig as config, p.provolatile::text as volatility, format_type(p.prorettype, null) as rettype,
           coalesce((select array_agg(format_type(t, null) order by o)
                     from unnest(p.proargtypes) with ordinality as a(t, o)), '{}') as argtypes
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
    order by 1, 2`);
}

function listTables(db: PGlite) {
  return owner<{ schema: string; name: string; rls: boolean }>(db, `
    select n.nspname as schema, c.relname as name, c.relrowsecurity as rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname in ('public', 'private')`);
}

async function executableBy(db: PGlite, role: string): Promise<string[]> {
  return names(await owner<{ name: string }>(db, `
    select n.nspname || '.' || p.proname as name
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and has_function_privilege($1, p.oid, 'EXECUTE')`, [role]));
}

/** table privileges of authenticated on public tables, as "table:PRIVILEGE" (table level and column level) */
async function authenticatedTableGrants(db: PGlite) {
  const rows = await owner<{ name: string; privilege: string; table_level: boolean; any_column: boolean }>(db, `
    select c.relname as name, p.privilege,
           has_table_privilege('authenticated', c.oid, p.privilege) as table_level,
           case when p.privilege in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                then has_any_column_privilege('authenticated', c.oid, p.privilege) else false end as any_column
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(privilege)
    where c.relkind = 'r' and n.nspname = 'public'`);
  return {
    tableLevel: rows.filter((r) => r.table_level).map((r) => `${r.name}:${r.privilege}`).sort(),
    columnOnly: rows.filter((r) => r.any_column && !r.table_level).map((r) => `${r.name}:${r.privilege}`).sort(),
  };
}

/** any privilege outside the authenticated allowlist: anon/service_role on public, anyone on private, sequences */
async function privilegeLeaks(db: PGlite): Promise<string[]> {
  const rows = await owner<{ leak: string }>(db, `
    select r.role || ':' || n.nspname || '.' || c.relname || ':' || p.privilege as leak
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['anon', 'authenticated', 'service_role']) as r(role)
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(privilege)
    where c.relkind = 'r' and n.nspname in ('public', 'private')
      and not (r.role = 'authenticated' and n.nspname = 'public')
      and (has_table_privilege(r.role, c.oid, p.privilege)
           or (p.privilege in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
               and has_any_column_privilege(r.role, c.oid, p.privilege)))
    union all
    select r.role || ':' || n.nspname || '.' || c.relname || ':' || p.privilege
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['anon', 'authenticated', 'service_role']) as r(role)
    cross join unnest(array['USAGE', 'SELECT', 'UPDATE']) as p(privilege)
    where c.relkind = 'S' and n.nspname in ('public', 'private')
      and has_sequence_privilege(r.role, c.oid, p.privilege)`);
  return rows.map((l) => l.leak).sort();
}

const AUTHENTICATED_EXECUTE = [
  ...STATE_CHANGING_RPCS.map((n) => `public.${n}`), ...READ_RPCS.map((n) => `public.${n}`),
  ...AUTHENTICATED_PRIVATE_FUNCTIONS.map((n) => `private.${n}`),
].sort();

let db: PGlite;
let functions: Fn[];

beforeAll(async () => {
  db = await freshDb();
  await owner(db, "create role probe_public nologin");   // holds nothing but what PUBLIC holds
  functions = await listFunctions(db);
});

describe("NT-01 anon", () => {
  it("cannot read any public or private table", async () => {
    for (const t of [...PUBLIC_TABLES.map((x) => `public.${x}`), ...PRIVATE_TABLES.map((x) => `private.${x}`)]) {
      const message = await raised(() => asRole(db, "anon", null, `select 1 from ${t} limit 1`));
      expect(message, t).toMatch(/permission denied/);
    }
  });

  it("cannot execute any public or private function", async () => {
    expect(functions.length).toBeGreaterThan(60);
    for (const f of functions) {
      const args = f.argtypes.map((t) => `null::${t}`).join(", ");
      const message = await raised(() => asRole(db, "anon", null, `select ${f.schema}.${f.name}(${args})`));
      expect(message, `${f.schema}.${f.name}`).toMatch(/permission denied/);
    }
  });
});

describe("NT-02 tables", () => {
  it("public and private tables are exactly the designed set, all with RLS", async () => {
    const tables = await listTables(db);
    expect(names(tables.filter((t) => t.schema === "public"))).toEqual(PUBLIC_TABLES);
    expect(names(tables.filter((t) => t.schema === "private"))).toEqual(PRIVATE_TABLES);
    expect(tables.filter((t) => !t.rls).map((t) => t.name)).toEqual([]);
  });

  it("authenticated has SELECT on the allowlist only, no write privilege anywhere", async () => {
    const grants = await authenticatedTableGrants(db);
    expect(grants.tableLevel).toEqual(AUTHENTICATED_SELECT_TABLES.map((t) => `${t}:SELECT`).sort());
    expect(grants.columnOnly).toEqual(["verification_submissions:SELECT"]);
    for (const none of ["blocks", "connection_requests", "connections", "conversations", "likes", "reports"]) {
      expect([...grants.tableLevel, ...grants.columnOnly].filter((g) => g.startsWith(`${none}:`))).toEqual([]);
    }
  });

  it("verification_submissions exposes exactly the 8 designed columns", async () => {
    const cols = await owner<{ name: string }>(db, `
      select a.attname as name from pg_attribute a
      where a.attrelid = 'public.verification_submissions'::regclass and a.attnum > 0 and not a.attisdropped
        and has_column_privilege('authenticated', a.attrelid, a.attnum, 'SELECT')`);
    expect(names(cols)).toEqual(VERIFICATION_SUBMISSION_COLUMNS);
  });

  it("anon and service_role hold no table privilege; nobody holds private tables or sequences", async () => {
    expect(await privilegeLeaks(db)).toEqual([]);
  });

  it("only authenticated may use the private schema", async () => {
    const [row] = await owner<{ a: boolean; b: boolean; c: boolean; d: boolean }>(db, `
      select has_schema_privilege('authenticated', 'private', 'USAGE') as a,
             has_schema_privilege('anon', 'private', 'USAGE') as b,
             has_schema_privilege('service_role', 'private', 'USAGE') as c,
             has_schema_privilege('probe_public', 'private', 'USAGE') as d`);
    expect(row).toEqual({ a: true, b: false, c: false, d: false });
  });
});

describe("NT-03 functions", () => {
  it("every public/private function pins search_path to '' (all SECURITY DEFINER ones included)", () => {
    const unpinned = functions.filter((f) => !(f.config ?? []).includes('search_path=""'));
    expect(unpinned.map((f) => `${f.schema}.${f.name}`)).toEqual([]);
    expect(functions.filter((f) => f.definer).length).toBeGreaterThan(50);
  });

  it("public functions are exactly the designed RPCs, all SECURITY DEFINER", () => {
    expect(names(functions.filter((f) => f.schema === "public")))
      .toEqual([...STATE_CHANGING_RPCS, ...READ_RPCS, ...SERVICE_RPCS, ...SERVICE_MAINTENANCE_RPCS].sort());
    for (const f of functions.filter((x) => x.schema === "public")) expect(f.definer, f.name).toBe(true);
  });

  it("PUBLIC and anon execute nothing; authenticated and service_role execute exactly their allowlists", async () => {
    expect(await executableBy(db, "probe_public")).toEqual([]);
    expect(await executableBy(db, "anon")).toEqual([]);
    const authenticated = await executableBy(db, "authenticated");
    expect(authenticated).toEqual(AUTHENTICATED_EXECUTE);
    for (const hidden of ["private.session_uid", "private.session_uid_any_status", "private.auth_account_ok", "private.photo_delivery_allowed"]) {
      expect(authenticated).not.toContain(hidden);
    }
    expect(await executableBy(db, "service_role")).toEqual([...SERVICE_RPCS, ...SERVICE_MAINTENANCE_RPCS].sort().map((n) => `public.${n}`));
  });

  it("state-changing RPCs (and only they) return rpc_outcome (NT-27)", () => {
    const outcome = functions.filter((f) => f.schema === "public" && f.rettype === "rpc_outcome");
    expect(names(outcome)).toEqual([...STATE_CHANGING_RPCS, ...SERVICE_RPCS].sort());
  });

  it("revoke has only the submission signature, with no callable user/kind overload", async () => {
    const revoke = functions.filter((f) => f.schema === "public" && f.name === "admin_revoke_verification");
    expect(revoke).toHaveLength(1);
    expect(revoke[0]).toMatchObject({ argtypes: REVOKE_VERIFICATION_ARGUMENTS, definer: true, volatility: "v", rettype: "rpc_outcome" });
    const [old] = await owner<{ signature: string | null }>(db,
      "select to_regprocedure('public.admin_revoke_verification(uuid,public.verification_kind,text)')::text as signature");
    expect(old.signature).toBeNull();
  });

  it("require_staff and lock_staff_roles are volatile (NT-17, r4)", () => {
    const byName = (n: string) => functions.find((f) => f.schema === "private" && f.name === n)!;
    expect(byName("require_staff").volatility).toBe("v");
    expect(byName("lock_staff_roles").volatility).toBe("v");
  });

  it("retention maintenance has exactly the intended definer signatures (RETENTION-001)", () => {
    for (const [name, rettype, volatility] of [
      ["service_retention_candidates", "record", "s"],
      ["service_purge_rate_limits", "integer", "v"],
    ] as const) {
      expect(functions.filter(f => f.schema === "public" && f.name === name))
        .toEqual([expect.objectContaining({ argtypes: ["timestamp with time zone"], rettype, definer: true, volatility, config: ['search_path=""'] })]);
    }
  });

  it("order 26 keeps the retention candidates' columns and adds the orphan_photo kind (RETENTION-003)", async () => {
    const [fn] = await owner<{ result: string; body: string }>(db, `
      select pg_get_function_result(p.oid) as result, p.prosrc as body
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'service_retention_candidates'`);
    expect(fn.result).toBe("TABLE(kind text, user_id uuid, submission_id uuid, storage_path text)");
    expect(fn.body).toContain("'orphan_photo'");
  });

  it("order 27 adds the orphan_document kind and keeps submit_verification's volatile definer signature (RETENTION-004)", async () => {
    const [fn] = await owner<{ body: string }>(db, `
      select p.prosrc as body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'service_retention_candidates'`);
    expect(fn.body).toContain("'orphan_document'");
    expect(functions.filter(f => f.schema === "public" && f.name === "submit_verification"))
      .toEqual([expect.objectContaining({ argtypes: ["verification_kind", "text[]"], rettype: "rpc_outcome", definer: true, volatility: "v", config: ['search_path=""'] })]);
  });

  it("order 28 lists removed photos and keeps the document upload check's stable definer signature (RETENTION-005)", async () => {
    const [fn] = await owner<{ body: string }>(db, `
      select p.prosrc as body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'service_retention_candidates'`);
    expect(fn.body).toContain("ph.status = 'active'");
    expect(functions.filter(f => f.schema === "private" && f.name === "rls_document_upload_allowed"))
      .toEqual([expect.objectContaining({ argtypes: ["text"], rettype: "boolean", definer: true, volatility: "s", config: ['search_path=""'] })]);
  });

  it("staff management has exactly the intended volatile definer signatures", async () => {
    for (const [name, argtypes, rettype] of [
      ["admin_list_staff", [], "record"],
      ["admin_grant_role_by_email", ["text", "staff_role"], "rpc_outcome"],
    ] as const) {
      expect(functions.filter(f => f.schema === "public" && f.name === name))
        .toEqual([expect.objectContaining({ argtypes: [...argtypes], rettype, definer: true, volatility: "v", config: ['search_path=""'] })]);
    }
    // order 35 (STAFF-001) adds acting, aligned with roles
    const [result] = await owner<{ result: string }>(db, `
      select pg_get_function_result(p.oid) as result from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'admin_list_staff'`);
    expect(result.result).toBe("TABLE(user_id uuid, display_name text, roles staff_role[], is_me boolean, acting boolean[])");
  });

  it("admin_grant_role keeps its volatile definer signature after order 20, and mfa_required is the only new outcome code (SEC-003)", async () => {
    expect(functions.filter(f => f.schema === "public" && f.name === "admin_grant_role"))
      .toEqual([expect.objectContaining({ argtypes: ["uuid", "staff_role"], rettype: "rpc_outcome", definer: true, volatility: "v", config: ['search_path=""'] })]);
    expect((await owner<{ label: string }>(db, `select e.enumlabel as label from pg_enum e
      where e.enumtypid = 'public.outcome_code'::regtype order by e.enumsortorder`)).map(r => r.label))
      .toEqual(["ok", "not_available", "invalid_state", "already_pending", "already_connected", "rate_limited", "mfa_required"]);
  });

  it("reserve_photo_upload has exactly the intended volatile definer signature and rate_policy stays a plain function (SEC-004)", () => {
    expect(functions.filter(f => f.schema === "public" && f.name === "reserve_photo_upload"))
      .toEqual([expect.objectContaining({ argtypes: [], rettype: "rpc_outcome", definer: true, volatility: "v", config: ['search_path=""'] })]);
    expect(functions.filter(f => f.schema === "private" && f.name === "rate_policy"))
      .toEqual([expect.objectContaining({ argtypes: ["text"], rettype: "record", definer: false, volatility: "i", config: ['search_path=""'] })]);
  });

  it("the sign-in and TOTP reservations have exactly the intended volatile definer signatures (SEC-006)", () => {
    for (const [name, argtypes] of [["service_reserve_signin", ["text", "text"]], ["reserve_mfa_attempt", []]] as const) {
      expect(functions.filter(f => f.schema === "public" && f.name === name))
        .toEqual([expect.objectContaining({ argtypes: [...argtypes], rettype: "rpc_outcome", definer: true, volatility: "v", config: ['search_path=""'] })]);
    }
    expect(functions.filter(f => f.schema === "private" && f.name === "signin_rate_key"))
      .toEqual([expect.objectContaining({ argtypes: ["text"], rettype: "uuid", definer: false, volatility: "s", config: ['search_path=""'] })]);
  });

  it("the sign-in reservation has one two-argument form and the IP key function is a plain stable function (SEC-008)", () => {
    expect(functions.filter(f => f.schema === "private" && f.name === "signin_ip_rate_key"))
      .toEqual([expect.objectContaining({ argtypes: ["text"], rettype: "uuid", definer: false, volatility: "s", config: ['search_path=""'] })]);
    expect(functions.filter(f => f.name === "service_reserve_signin").map(f => f.argtypes)).toEqual([["text", "text"]]);
  });

  it("the sign-up reservation has one two-argument volatile definer form (SEC-012)", () => {
    expect(functions.filter(f => f.name === "service_reserve_signup"))
      .toEqual([expect.objectContaining({ schema: "public", argtypes: ["text", "text"], rettype: "rpc_outcome", definer: true, volatility: "v", config: ['search_path=""'] })]);
  });

  it("my_staff_roles has exactly the intended stable definer signature (ADMIN-005)", () => {
    expect(functions.filter(f => f.schema === "public" && f.name === "my_staff_roles"))
      .toEqual([expect.objectContaining({ argtypes: [], rettype: "staff_role", definer: true, volatility: "s", config: ['search_path=""'] })]);
  });

  it("order 29 adds the effective-role helper and keeps require_staff and my_staff_roles' signatures (SEC-013)", () => {
    expect(functions.filter(f => f.name === "staff_role_effective"))
      .toEqual([expect.objectContaining({ schema: "private", argtypes: ["uuid", "staff_role"], rettype: "boolean", definer: true, volatility: "s", config: ['search_path=""'] })]);
    expect(functions.filter(f => f.name === "require_staff"))
      .toEqual([expect.objectContaining({ schema: "private", argtypes: ["staff_role", "boolean"], rettype: "uuid", definer: true, volatility: "v", config: ['search_path=""'] })]);
    expect(functions.filter(f => f.name === "my_staff_roles"))
      .toEqual([expect.objectContaining({ schema: "public", argtypes: [], rettype: "staff_role", definer: true, volatility: "s", config: ['search_path=""'] })]);
  });

  it("order 30 keeps admin_revoke_role's one volatile definer signature (SEC-014)", () => {
    expect(functions.filter(f => f.name === "admin_revoke_role"))
      .toEqual([expect.objectContaining({ schema: "public", argtypes: ["uuid", "staff_role"], rettype: "rpc_outcome", definer: true, volatility: "v", config: ['search_path=""'] })]);
  });

  it("order 31 counts only unnamed and open-submission documents and keeps the upload check's stable definer signature (RETENTION-006)", async () => {
    const [fn] = await owner<{ body: string }>(db, `
      select p.prosrc as body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname = 'rls_document_upload_allowed'`);
    expect(fn.body).toContain("o.status in ('submitted', 'in_review')");
    expect(functions.filter(f => f.name === "rls_document_upload_allowed"))
      .toEqual([expect.objectContaining({ schema: "private", argtypes: ["text"], rettype: "boolean", definer: true, volatility: "s", config: ['search_path=""'] })]);
  });

  it("order 32 lists withdrawn and superseded documents and keeps both functions' stable definer signatures (RETENTION-007)", async () => {
    const decided = "s.status in ('approved', 'rejected', 'revoked', 'withdrawn', 'superseded')";
    const [candidates] = await owner<{ body: string }>(db, `
      select p.prosrc as body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'service_retention_candidates'`);
    expect(candidates.body).toContain(decided);
    const [cap] = await owner<{ body: string }>(db, `
      select p.prosrc as body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname = 'rls_document_upload_allowed'`);
    expect(cap.body).toContain(`d.${decided.slice(2)}`);
    expect(functions.filter(f => f.name === "service_retention_candidates"))
      .toEqual([expect.objectContaining({ schema: "public", argtypes: ["timestamp with time zone"], rettype: "record", definer: true, volatility: "s", config: ['search_path=""'] })]);
    expect(functions.filter(f => f.name === "rls_document_upload_allowed"))
      .toEqual([expect.objectContaining({ schema: "private", argtypes: ["text"], rettype: "boolean", definer: true, volatility: "s", config: ['search_path=""'] })]);
  });

  it("order 33 adds the moderation content RPCs and keeps the changed read RPCs' arguments (MOD-001)", async () => {
    for (const [name, argtypes, rettype] of [
      ["admin_get_report_content", ["uuid"], "record"],
      ["admin_authorize_report_photo", ["uuid", "uuid"], "record"],
      ["admin_hide_reported_content", ["uuid", "text", "uuid"], "rpc_outcome"],
      ["admin_unhide_reported_content", ["uuid", "text"], "rpc_outcome"],
    ] as const) {
      expect(functions.filter(f => f.name === name))
        .toEqual([expect.objectContaining({ schema: "public", argtypes: [...argtypes], rettype, definer: true, volatility: "v", config: ['search_path=""'] })]);
    }
    expect(functions.filter(f => f.name === "list_messages"))
      .toEqual([expect.objectContaining({ schema: "public", argtypes: ["uuid", "bigint", "integer"], rettype: "record", definer: true, volatility: "s", config: ['search_path=""'] })]);
    const [result] = await owner<{ result: string }>(db, `
      select pg_get_function_result(p.oid) as result from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'list_messages'`);
    expect(result.result).toBe("TABLE(id bigint, sender_id uuid, body text, created_at timestamp with time zone, hidden boolean)");
  });

  it("order 34 replaces requests and modes with likes: signatures, results and the dropped functions (DB-LIKES-001)", async () => {
    for (const [name, argtypes, rettype, volatility] of [
      ["like_user", ["uuid"], "rpc_outcome", "v"],
      ["unlike_user", ["uuid"], "rpc_outcome", "v"],
      ["list_my_likes", ["text", "timestamp with time zone", "uuid", "integer"], "record", "s"],
      ["get_like_state", ["uuid"], "record", "s"],
      ["discover_profiles", ["integer", "integer", "text[]", "uuid[]", "uuid", "integer"], "profile_view", "s"],
      ["get_profile", ["uuid"], "profile_view", "s"],
      ["update_profile", ["text", "text", "text", "text[]", "text[]"], "rpc_outcome", "v"],
      ["my_account", [], "record", "s"],
    ] as const) {
      expect(functions.filter(f => f.schema === "public" && f.name === name), name)
        .toEqual([expect.objectContaining({ argtypes: [...argtypes], rettype, definer: true, volatility, config: ['search_path=""'] })]);
    }
    const results = await owner<{ name: string; result: string }>(db, `
      select p.proname as name, pg_get_function_result(p.oid) as result from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('get_like_state', 'list_my_likes', 'my_account') order by 1`);
    expect(results).toEqual([
      { name: "get_like_state", result: "TABLE(i_liked boolean, liked_me boolean, conversation_id uuid)" },
      { name: "list_my_likes", result: "TABLE(counterpart_id uuid, liked_at timestamp with time zone, counterpart profile_view)" },
      { name: "my_account", result: "TABLE(user_id uuid, has_profile boolean, account_status account_status, profile_completed boolean, age_verified boolean, adult boolean, affiliation_status affiliation_status, affiliation_confirmed boolean, has_active_photo boolean, eligible boolean, birth_date date)" },
    ]);
    const [view] = await owner<{ attrs: string }>(db, `
      select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ' order by a.attnum) as attrs
      from pg_attribute a where a.attrelid = 'public.profile_view'::regclass and a.attnum > 0`);
    expect(view.attrs).toBe("user_id uuid, display_name text, age integer, gender text, school_name text, department_name text, "
      + "class_name text, bio text, purposes text[], hobbies text[], photo_ids uuid[]");
    const gone = ["send_connection_request", "respond_connection_request", "cancel_connection_request", "list_my_requests",
      "set_modes", "can_view_profile", "expire_stale_requests", "request_retry_wait"];
    expect(functions.filter(f => gone.includes(f.name))).toEqual([]);
    expect(functions.filter(f => f.name === "profile_view_of"))
      .toEqual([expect.objectContaining({ schema: "private", argtypes: ["uuid"], rettype: "profile_view" })]);
    for (const name of ["purposes_ok", "purposes_sorted"]) {
      expect(functions.filter(f => f.name === name), name)
        .toEqual([expect.objectContaining({ schema: "private", argtypes: ["text[]"], definer: false, volatility: "i", config: ['search_path=""'] })]);
    }
    // no function body reads a dropped table or column (bodies are not dependency-tracked)
    const stale = await owner<{ name: string }>(db, `
      select n.nspname || '.' || p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private')
        and p.prosrc ~ '(profile_modes|bio_romance|bio_friends|purpose_romance|purpose_friends|can_view_profile|expire_stale_requests|request_retry_wait)'
      order by 1`);
    expect(stale).toEqual([]);
    const cols = await owner<{ name: string }>(db, `
      select attname as name from pg_attribute where attrelid = 'public.profiles'::regclass and attnum > 0 and not attisdropped
        and attname in ('bio', 'purposes', 'bio_romance', 'bio_friends', 'purpose_romance', 'purpose_friends') order by 1`);
    expect(names(cols)).toEqual(["bio", "purposes"]);
    const nullable = await owner<{ name: string; notnull: boolean }>(db, `
      select c.relname || '.' || a.attname as name, a.attnotnull as notnull from pg_attribute a join pg_class c on c.oid = a.attrelid
      where (c.relname = 'connections' and a.attname in ('origin_request_id', 'mode'))
         or (c.relname = 'hidden_bios' and a.attname = 'mode')
         or (c.relname = 'connection_requests' and a.attname = 'mode') order by 1`);
    expect(nullable).toEqual([
      { name: "connection_requests.mode", notnull: true }, { name: "connections.mode", notnull: false },
      { name: "connections.origin_request_id", notnull: false }, { name: "hidden_bios.mode", notnull: false }]);
    const checks = await owner<{ name: string; def: string }>(db, `
      select conname as name, pg_get_constraintdef(oid) as def from pg_constraint
      where conname in ('connection_requests_frozen', 'connections_origin_check') order by 1`);
    expect(checks).toEqual([
      { name: "connection_requests_frozen", def: "CHECK ((status <> 'pending'::request_status))" },
      { name: "connections_origin_check", def: "CHECK (((origin_request_id IS NULL) = (mode IS NULL)))" }]);
  });

  it("admin_list_suspended_accounts has exactly the intended volatile definer signature (ADMIN-006)", () => {
    expect(functions.filter(f => f.schema === "public" && f.name === "admin_list_suspended_accounts"))
      .toEqual([expect.objectContaining({ argtypes: [], rettype: "record", definer: true, volatility: "v", config: ['search_path=""'] })]);
  });
});

describe("the catalog checks detect drift", () => {
  it("report a stray grant, a new public function and a table without RLS", async () => {
    const drift = await freshDb();
    await drift.exec(`
      grant execute on function private.session_uid() to authenticated;
      grant select on public.blocks to authenticated;
      grant select on private.audit_log to service_role;
      create table public.drift_probe (id int);
      create function public.drift_fn() returns int language sql set search_path = '' as 'select 1';`);
    expect(await executableBy(drift, "authenticated")).toContain("private.session_uid");
    expect((await authenticatedTableGrants(drift)).tableLevel).toContain("blocks:SELECT");
    expect(await privilegeLeaks(drift)).toContain("service_role:private.audit_log:SELECT");
    expect((await listTables(drift)).find((t) => t.name === "drift_probe")?.rls).toBe(false);
    expect(names((await listFunctions(drift)).filter((f) => f.schema === "public"))).toContain("drift_fn");
    await drift.close();
  });
});
