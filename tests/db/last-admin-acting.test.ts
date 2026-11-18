// SEC-014 order 30 (SEC-013 edge): the last-admin rule of admin_revoke_role counts other admins whose role acts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { addTotpFactor, createMasters, createStaff, createUser } from "./fixtures";
import { MIGRATIONS_DIR, deny, fingerprint, freshDb, migrationFiles, owner, raised, rpc, rpcRows, staff } from "./harness";

const ORDER_30 = "20261116120030_last_admin_acting.sql";
const casts = ["uuid", "public.staff_role"];

const revoke = (db: PGlite, caller: string, target: string, role = "admin") =>
  rpc(db, staff(caller), "admin_revoke_role", [target, role], casts);
const acts = async (db: PGlite, id: string) =>
  await raised(() => rpcRows(db, staff(id), "admin_list_staff")) === "";
const activeAdmins = async (db: PGlite) => (await owner<{ user_id: string }>(db,
  "select user_id::text from private.staff_roles where role = 'admin' and revoked_at is null order by user_id")).map(r => r.user_id);
const auditRows = (db: PGlite) => owner<{ action: string; actor: string; target: string | null; role: string | null }>(db,
  "select action, actor_id::text as actor, target_id as target, detail ->> 'role' as role from private.audit_log order by id");

/** Admin rows that exist and are active but do not act (SEC-013 order 29). */
const nonActing: [string, (db: PGlite) => Promise<string>][] = [
  ["has no TOTP factor", db => createStaff(db, ["admin"], { totp: false })],
  ["gained a verified factor after its grant", async db => {
    const id = await createStaff(db, ["admin"]);
    const factor = await addTotpFactor(db, id);
    await db.query("update auth.mfa_factors set created_at = now() + interval '1 minute' where id = $1", [factor]);
    return id;
  }],
];

/** Runs `run` on its own database so the admin rows of other tests never count. */
async function own(run: (db: PGlite) => Promise<void>) {
  const db = await freshDb();
  try { await run(db); } finally { await db.close(); }
}

describe("SEC-014 order 30", () => {
  it("is order 30", () => {
    expect(migrationFiles()[29]).toBe(ORDER_30);
    expect(migrationFiles().length).toBeGreaterThanOrEqual(30);   // order 31 (RETENTION-006) follows
  });
});

describe("SEC-014 two acting admins", () => {
  for (const [label, caller, target] of [
    ["the first revokes the second", 0, 1], ["the second revokes the first", 1, 0],
    ["the first revokes their own", 0, 0], ["the second revokes their own", 1, 1],
  ] as const) {
    it(`${label}: allowed, one revoke_role audit row, and the other admin still acts`, async () => {
      await own(async (db) => {
        const admins = [await createStaff(db, ["admin"]), await createStaff(db, ["admin"])];
        expect(await acts(db, admins[0]) && await acts(db, admins[1])).toBe(true);
        const before = (await auditRows(db)).length;
        expect(await revoke(db, admins[caller], admins[target])).toEqual({ ok: true, code: "ok", ref: admins[target] });
        expect((await auditRows(db)).slice(before))
          .toEqual([{ action: "revoke_role", actor: admins[caller], target: admins[target], role: "admin" }]);
        expect(await activeAdmins(db)).toEqual([admins[1 - target]]);
        expect(await acts(db, admins[1 - target])).toBe(true);
      });
    });
  }
});

describe("SEC-014 one acting admin and an admin row that does not act", () => {
  for (const [label, make] of nonActing) {
    it(`(the other row ${label}) the acting admin cannot revoke their own admin; nothing is written`, async () => {
      await own(async (db) => {
        const acting = await createStaff(db, ["admin"]);
        const idle = await make(db);
        expect(await acts(db, acting)).toBe(true);
        expect(await acts(db, idle)).toBe(false);
        const before = await fingerprint(db);
        expect(await revoke(db, acting, acting)).toEqual(deny("invalid_state"));
        expect(await fingerprint(db)).toBe(before);   // no role row and no audit row changed
        expect(await acts(db, acting)).toBe(true);
      });
    });

    it(`(the other row ${label}) the acting admin can revoke the row that does not act, and then still not their own`, async () => {
      await own(async (db) => {
        const acting = await createStaff(db, ["admin"]);
        const idle = await make(db);
        const before = (await auditRows(db)).length;
        expect(await revoke(db, acting, idle)).toEqual({ ok: true, code: "ok", ref: idle });
        expect((await auditRows(db)).slice(before)).toEqual([{ action: "revoke_role", actor: acting, target: idle, role: "admin" }]);
        expect(await activeAdmins(db)).toEqual([acting]);
        expect(await revoke(db, acting, acting)).toEqual(deny("invalid_state"));
        expect(await activeAdmins(db)).toEqual([acting]);
      });
    });
  }

  it("the row that does not act cannot revoke anything (require_staff refuses first)", async () => {
    await own(async (db) => {
      const acting = await createStaff(db, ["admin"]);
      const idle = await nonActing[0][1](db);
      const before = await fingerprint(db);
      for (const target of [acting, idle]) expect(await raised(() => revoke(db, idle, target))).toBe("forbidden");
      expect(await fingerprint(db)).toBe(before);
    });
  });
});

describe("SEC-014 no sequence of revokes leaves zero acting admins", () => {
  it("a single admin cannot revoke itself (as before); nothing is written", async () => {
    await own(async (db) => {
      const only = await createStaff(db, ["admin"]);
      const before = await fingerprint(db);
      expect(await revoke(db, only, only)).toEqual(deny("invalid_state"));
      expect(await fingerprint(db)).toBe(before);
    });
  });

  it("a revoked admin with its factor intact does not count as another acting admin", async () => {
    await own(async (db) => {
      const [a, b] = [await createStaff(db, ["admin"]), await createStaff(db, ["admin"])];
      expect((await revoke(db, a, b)).ok).toBe(true);
      expect(await revoke(db, a, a)).toEqual(deny("invalid_state"));
      expect(await activeAdmins(db)).toEqual([a]);
    });
  });

  it("two acting admins and two rows that do not act: every revoke order ends with exactly one acting admin", async () => {
    await own(async (db) => {
      const [a, b] = [await createStaff(db, ["admin"]), await createStaff(db, ["admin"])];
      const idle = [await nonActing[0][1](db), await nonActing[1][1](db)];
      expect((await revoke(db, a, a)).ok).toBe(true);   // b still acts
      expect(await revoke(db, b, b)).toEqual(deny("invalid_state"));   // only idle rows remain besides b
      for (const id of idle) expect((await revoke(db, b, id)).ok).toBe(true);
      expect(await revoke(db, b, b)).toEqual(deny("invalid_state"));
      expect(await activeAdmins(db)).toEqual([b]);
      expect(await acts(db, b)).toBe(true);
    });
  });

  it("other roles are revoked as before, whether or not any other admin acts", async () => {
    await own(async (db) => {
      const only = await createStaff(db, ["admin", "moderator", "reviewer"]);
      expect((await revoke(db, only, only, "moderator")).ok).toBe(true);
      expect((await revoke(db, only, only, "reviewer")).ok).toBe(true);
      expect(await revoke(db, only, only, "reviewer")).toEqual(deny("invalid_state"));
      expect(await activeAdmins(db)).toEqual([only]);
    });
  });

  it("the reviewer release loop and its audit rows are unchanged", async () => {
    await own(async (db) => {
      const m = await createMasters(db, "sec014");
      const admin = await createStaff(db, ["admin"]);
      const former = await createStaff(db, ["reviewer"]);
      const u = await createUser(db, { cls: m.classes[0], affiliation: "pending" });
      const [{ id: sub }] = await owner<{ id: string }>(db,
        "select id::text from public.verification_submissions where user_id = $1 and status = 'submitted'", [u]);
      expect((await rpc(db, staff(former), "admin_claim_submission", [sub])).ok).toBe(true);
      const before = (await auditRows(db)).length;
      expect(await revoke(db, admin, former, "reviewer")).toEqual({ ok: true, code: "ok", ref: former });
      expect((await auditRows(db)).slice(before)).toEqual([
        { action: "revoke_role", actor: admin, target: former, role: "reviewer" },
        { action: "release_submission_on_role_revocation", actor: admin, target: sub, role: null },
      ]);
      expect((await owner(db, `select status::text, reviewer_id, claimed_at, version from public.verification_submissions
        where id = $1`, [sub]))[0]).toEqual({ status: "submitted", reviewer_id: null, claimed_at: null, version: 2 });
    });
  });
});

describe("SEC-014 surface", () => {
  it("admin_revoke_role keeps its signature, definer, search_path and grants", async () => {
    await own(async (db) => {
      expect((await owner(db, `
        select p.prosecdef as definer, p.provolatile::text as volatility, p.proconfig as config,
               format_type(p.prorettype, null) as rettype,
               array(select a.grantee::regrole::text || ':' || a.privilege_type from aclexplode(p.proacl) a order by 1) as acl
        from pg_proc p where p.oid = 'public.admin_revoke_role(uuid, public.staff_role)'::regprocedure`))[0]).toEqual({
        definer: true, volatility: "v", config: ['search_path=""'], rettype: "rpc_outcome",
        acl: ["authenticated:EXECUTE", "postgres:EXECUTE"],
      });
      expect((await owner(db, "select count(*)::int as n from pg_proc where proname = 'admin_revoke_role'"))[0]).toEqual({ n: 1 });
    });
  });

  it("the body is the order-10 body with only the last-admin check replaced", async () => {
    const body = (order: string) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, migrationFiles().find(f => f.endsWith(order))!), "utf8").replace(/\r\n/g, "\n");
      const open = sql.indexOf("$$", sql.indexOf("function public.admin_revoke_role(")) + 2;
      return sql.slice(open, sql.indexOf("$$", open));
    };
    const old = `     and (select count(*) from private.staff_roles s where s.role = 'admin' and s.revoked_at is null) <= 1 then
    return private.deny('invalid_state');   -- never zero active admins`;
    const now = `     and not exists (select 1 from private.staff_roles s
                     where s.role = 'admin' and s.revoked_at is null and s.user_id <> p_user
                       and private.staff_role_effective(s.user_id, 'admin')) then
    return private.deny('invalid_state');   -- never zero acting admins`;
    expect(body("_admin.sql").split(old)).toHaveLength(2);
    expect(body("_admin.sql").replace(old, now)).toBe(body(ORDER_30));
    await own(async (db) => {
      const [{ src }] = await owner<{ src: string }>(db, "select prosrc as src from pg_proc where proname = 'admin_revoke_role'");
      expect(src.replace(/\r\n/g, "\n")).toBe(body(ORDER_30));
    });
  });
});
