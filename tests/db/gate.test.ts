// BE-001 first gate (docs/04_DATABASE.md §13.1, docs/25 方式): prove that PGlite
// supports every Postgres feature the accepted design relies on before any
// migration is written. Each capability is its own test so pass/fail is exact.
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(`
    create role gate_user nologin;
    create schema gate;
    grant usage on schema gate to gate_user;
    create table gate.notes (owner text not null, body text not null, secret text);
    insert into gate.notes values ('a', 'note-a', 's-a'), ('b', 'note-b', 's-b');
  `);
});

afterAll(async () => {
  await db?.close();
});

async function errorOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (error as Error).message;
  }
  return "";
}

describe("PGlite capability gate", () => {
  it("reports the Postgres server version", async () => {
    const { rows } = await db.query<{ server_version: string }>("show server_version");
    expect(rows[0].server_version).toMatch(/^\d+/);
    console.info(`[gate] PGlite server_version=${rows[0].server_version}`);
  });

  it("create role / set role: a non-superuser role is really denied", async () => {
    const message = await errorOf(() =>
      db.transaction(async (tx) => {
        await tx.query("set local role gate_user");
        await tx.query("select * from gate.notes");
      }),
    );
    expect(message).toMatch(/permission denied/);
    const { rows } = await db.transaction(async (tx) => {
      await tx.query("set local role gate_user");
      return tx.query<{ current_user: string }>("select current_user");
    });
    expect(rows[0].current_user).toBe("gate_user");
  });

  it("row level security filters rows by a policy for the role", async () => {
    await db.exec(`
      alter table gate.notes enable row level security;
      grant select on gate.notes to gate_user;
      create policy notes_own on gate.notes for select to gate_user
        using (owner = current_setting('gate.owner', true));
    `);
    const { rows } = await db.transaction(async (tx) => {
      await tx.query("set local role gate_user");
      await tx.query("select set_config('gate.owner', 'a', true)");
      return tx.query<{ body: string }>("select body from gate.notes order by body");
    });
    expect(rows.map((r) => r.body)).toEqual(["note-a"]);
    await db.exec("revoke select on gate.notes from gate_user");
  });

  it("security definer function runs with owner rights and search_path=''", async () => {
    await db.exec(`
      create function gate.count_notes() returns bigint
      language sql stable security definer set search_path = '' as $$
        select count(*) from gate.notes
      $$;
      revoke all on function gate.count_notes() from public;
      grant execute on function gate.count_notes() to gate_user;
    `);
    const { rows } = await db.transaction(async (tx) => {
      await tx.query("set local role gate_user");
      return tx.query<{ n: number }>("select gate.count_notes()::int as n");
    });
    expect(rows[0].n).toBe(2);
    const config = await db.query<{ proconfig: string[] }>(
      "select proconfig from pg_proc where proname = 'count_notes'",
    );
    expect(config.rows[0].proconfig).toContain('search_path=""');
  });

  it("column level GRANT allows listed columns only", async () => {
    await db.exec(`
      alter table gate.notes disable row level security;
      grant select (owner, body) on gate.notes to gate_user;
    `);
    const ok = await db.transaction(async (tx) => {
      await tx.query("set local role gate_user");
      return tx.query<{ owner: string }>("select owner, body from gate.notes");
    });
    expect(ok.rows).toHaveLength(2);
    const message = await errorOf(() =>
      db.transaction(async (tx) => {
        await tx.query("set local role gate_user");
        await tx.query("select secret from gate.notes");
      }),
    );
    expect(message).toMatch(/permission denied/);
    const privileges = await db.query<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
       where grantee = 'gate_user' and table_name = 'notes' order by column_name`,
    );
    expect(privileges.rows.map((r) => r.column_name)).toEqual(["body", "owner"]);
  });

  it("statement level BEFORE TRUNCATE trigger rejects truncate (owner too)", async () => {
    await db.exec(`
      create table gate.append_only (id int);
      insert into gate.append_only values (1);
      create function gate.deny() returns trigger language plpgsql as $$
      begin raise exception 'append only'; end $$;
      create trigger deny_truncate before truncate on gate.append_only
        for each statement execute function gate.deny();
    `);
    const message = await errorOf(() => db.exec("truncate gate.append_only"));
    expect(message).toMatch(/append only/);
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from gate.append_only");
    expect(rows[0].n).toBe(1);
  });

  it("hashtextextended returns a stable bigint key", async () => {
    const { rows } = await db.query<{ a: string; b: string }>(
      "select hashtextextended('pair:x:y', 0)::text as a, hashtextextended('pair:x:y', 0)::text as b",
    );
    expect(rows[0].a).toMatch(/^-?\d+$/);
    expect(rows[0].a).toBe(rows[0].b);
  });

  it("exclusive and shared transaction advisory locks are taken and released at commit", async () => {
    const held = await db.transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtextextended('gate:x', 0))");
      await tx.query("select pg_advisory_xact_lock_shared(hashtextextended('gate:y', 0))");
      // re-entrant in the same transaction (still one pg_locks row per lock)
      await tx.query("select pg_advisory_xact_lock(hashtextextended('gate:x', 0))");
      return tx.query<{ mode: string }>(
        "select mode from pg_locks where locktype = 'advisory' and granted order by mode",
      );
    });
    expect(held.rows.map((r) => r.mode)).toEqual(["ExclusiveLock", "ShareLock"]);
    const after = await db.query("select 1 from pg_locks where locktype = 'advisory'");
    expect(after.rows).toHaveLength(0);
  });

  it("current_setting('transaction_isolation') reflects the isolation level", async () => {
    const readCommitted = await db.transaction((tx) =>
      tx.query<{ level: string }>("select current_setting('transaction_isolation') as level"),
    );
    expect(readCommitted.rows[0].level).toBe("read committed");
    const repeatable = await db.transaction(async (tx) => {
      await tx.query("set transaction isolation level repeatable read");
      return tx.query<{ level: string }>("select current_setting('transaction_isolation') as level");
    });
    expect(repeatable.rows[0].level).toBe("repeatable read");
  });

  it("unique nulls not distinct treats NULLs as equal", async () => {
    await db.exec(`
      create table gate.classes (dept int not null, name text not null, year smallint,
        unique nulls not distinct (dept, name, year));
      insert into gate.classes values (1, 'A', null);
    `);
    const message = await errorOf(() => db.exec("insert into gate.classes values (1, 'A', null)"));
    expect(message).toMatch(/duplicate key/);
  });

  it("a function can return a composite rpc_outcome type", async () => {
    await db.exec(`
      create type gate.outcome_code as enum ('ok', 'not_available');
      create type gate.rpc_outcome as (ok boolean, code gate.outcome_code, ref text);
      create function gate.try_it(p_ok boolean) returns gate.rpc_outcome
      language plpgsql security definer set search_path = '' as $$
      begin
        if p_ok then return (true, 'ok', 'ref-1')::gate.rpc_outcome; end if;
        return (false, 'not_available', null)::gate.rpc_outcome;
      end $$;
    `);
    const { rows } = await db.query<{ ok: boolean; code: string; ref: string | null }>(
      "select * from gate.try_it(true) union all select * from gate.try_it(false)",
    );
    expect(rows).toEqual([
      { ok: true, code: "ok", ref: "ref-1" },
      { ok: false, code: "not_available", ref: null },
    ]);
    const type = await db.query<{ t: string }>(
      "select prorettype::regtype::text as t from pg_proc where proname = 'try_it'",
    );
    expect(type.rows[0].t).toBe("gate.rpc_outcome");
  });

  // Supporting features used by the shim and the accepted design (recorded, not in the §13.1 list).
  it("supports request.jwt.claims GUCs, Asia/Tokyo time zone and gen_random_uuid", async () => {
    const { rows } = await db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', '{"sub":"x","aal":"aal1"}', true)`);
      return tx.query<{ sub: string; tokyo: string; uuid: string }>(
        `select current_setting('request.jwt.claims', true)::jsonb ->> 'sub' as sub,
                (timestamptz '2026-01-01 00:00:00+00' at time zone 'Asia/Tokyo')::text as tokyo,
                gen_random_uuid()::text as uuid`,
      );
    });
    expect(rows[0].sub).toBe("x");
    expect(rows[0].tokyo).toBe("2026-01-01 09:00:00");
    expect(rows[0].uuid).toMatch(/^[0-9a-f-]{36}$/);
    const outside = await db.query<{ claims: string | null }>(
      "select current_setting('request.jwt.claims', true) as claims",
    );
    expect(outside.rows[0].claims ?? "").toBe("");
  });
});
