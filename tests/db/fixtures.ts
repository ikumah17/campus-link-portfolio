// Fictional fixtures built with owner SQL ("所有者の準備SQL", docs/04 §13.1). Nothing here is real data.
import { randomUUID } from "node:crypto";
import type { PGlite, Transaction } from "@electric-sql/pglite";

export type Purpose = "friends" | "partner" | "hobby" | "study" | "talk";
export type Gender = "female" | "male" | "other";
export type AccountStatus = "active" | "deactivated" | "suspended" | "deleted";
export type AffiliationState = "confirmed" | "unconfirmed" | "pending" | "rejected" | "expired" | "none";
export type StaffRole = "reviewer" | "moderator" | "admin";

export interface ClassRef {
  id: string;
  departmentId: string;
  schoolId: string;
}

export interface Masters {
  schools: string[];
  departments: { id: string; schoolId: string }[];
  classes: ClassRef[];
}

/** 2 schools x 2 departments x 2 classes with fictional, unique names. */
export async function createMasters(db: PGlite, label: string): Promise<Masters> {
  const masters: Masters = { schools: [], departments: [], classes: [] };
  await db.transaction(async (tx) => {
    for (let s = 1; s <= 2; s += 1) {
      const schoolId = randomUUID();
      await tx.query("insert into public.schools (id, name) values ($1, $2)", [schoolId, `試験校${label}-${s}（架空）`]);
      masters.schools.push(schoolId);
      for (let d = 1; d <= 2; d += 1) {
        const departmentId = randomUUID();
        await tx.query("insert into public.departments (id, school_id, name) values ($1, $2, $3)",
          [departmentId, schoolId, `試験学科${s}-${d}（架空）`]);
        masters.departments.push({ id: departmentId, schoolId });
        for (let c = 1; c <= 2; c += 1) {
          const classId = randomUUID();
          await tx.query("insert into public.classes (id, department_id, name) values ($1, $2, $3)",
            [classId, departmentId, `試験クラス${s}-${d}-${c}（架空）`]);
          masters.classes.push({ id: classId, departmentId, schoolId });
        }
      }
    }
  });
  return masters;
}

const reviewers = new WeakMap<PGlite, string>();

/** An auth user that only appears as reviewer_id on fixture decisions (no staff role). */
async function fixtureReviewer(db: PGlite): Promise<string> {
  let id = reviewers.get(db);
  if (!id) {
    id = randomUUID();
    await db.query("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())",
      [id, `fixture-reviewer-${id}@example.invalid`]);
    reviewers.set(db, id);
  }
  return id;
}

export interface UserSpec {
  cls?: ClassRef;
  affiliation?: AffiliationState;
  displayName?: string;
  gender?: Gender;
  birthDate?: string;
  status?: AccountStatus;
  completed?: boolean;
  ageVerified?: boolean;
  ageRevoked?: boolean;
  bio?: string | null;
  purposes?: Purpose[];
  photos?: number;
  removedPhotos?: number;
  settings?: Partial<Record<"hide_same_class" | "hide_same_department" | "hide_same_school" | "show_department" | "show_class", boolean>> | null;
  hidden?: { schools?: string[]; departments?: string[]; classes?: string[] };
  emailConfirmed?: boolean;
  anonymous?: boolean;
  /** false: only the auth.users row (before onboarding) */
  profile?: boolean;
  /** a database before order 34 only: the two old bios and the modes (defaults: both bios, both modes) */
  legacyBios?: { romance?: string | null; friends?: string | null };
  legacyModes?: ("romance" | "friends")[];
}

const order34 = new WeakMap<PGlite, boolean>();

/** Whether the database has order 34 (profiles.purposes); suites that build an older schema get the old columns. */
async function hasOrder34(db: PGlite): Promise<boolean> {
  let known = order34.get(db);
  if (known === undefined) {
    known = (await db.query<{ v: boolean }>(`select exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles' and column_name = 'purposes') as v`)).rows[0].v;
    order34.set(db, known);
  }
  return known;
}

let counter = 0;

/** Creates one fictional user; defaults make the user fully eligible. */
export async function createUser(db: PGlite, spec: UserSpec = {}): Promise<string> {
  const id = randomUUID();
  const reviewer = await fixtureReviewer(db);
  const current = await hasOrder34(db);
  counter += 1;
  await db.transaction(async (tx) => {
    await tx.query(
      "insert into auth.users (id, email, email_confirmed_at, is_anonymous) values ($1, $2, $3, $4)",
      [id, `fixture-${id}@example.invalid`, spec.emailConfirmed === false ? null : new Date().toISOString(), spec.anonymous ?? false]);
    if (spec.profile === false) return;
    if (current) {
      await tx.query(
        `insert into public.profiles (user_id, display_name, gender, bio, purposes, account_status, profile_completed_at)
         values ($1, $2, $3, $4, $5, $6, case when $7 then now() end)`,
        [id, spec.displayName ?? `架空${counter}`, spec.gender ?? "female",
          spec.bio === undefined ? "架空の自己紹介" : spec.bio, spec.purposes ?? ["friends"],
          spec.status ?? "active", spec.completed ?? true]);
    } else {
      const bios = spec.legacyBios ?? {};
      await tx.query(
        `insert into public.profiles (user_id, display_name, gender, bio_romance, bio_friends, account_status, profile_completed_at)
         values ($1, $2, $3, $4, $5, $6, case when $7 then now() end)`,
        [id, spec.displayName ?? `架空${counter}`, spec.gender ?? "female",
          bios.romance === undefined ? "架空の恋愛向け紹介" : bios.romance,
          bios.friends === undefined ? "架空の友達向け紹介" : bios.friends,
          spec.status ?? "active", spec.completed ?? true]);
      for (const mode of spec.legacyModes ?? ["romance", "friends"]) {
        await tx.query("insert into public.profile_modes (user_id, mode) values ($1, $2)", [id, mode]);
      }
    }
    await tx.query("insert into private.user_private (user_id, birth_date) values ($1, $2)", [id, spec.birthDate ?? "2000-05-05"]);
    if (spec.settings !== null) {
      const s = spec.settings ?? {};
      await tx.query(
        `insert into public.privacy_settings (user_id, hide_same_class, hide_same_department, hide_same_school, show_department, show_class)
         values ($1, $2, $3, $4, $5, $6)`,
        [id, s.hide_same_class ?? true, s.hide_same_department ?? false, s.hide_same_school ?? false,
          s.show_department ?? false, s.show_class ?? false]);
    }
    let position = 0;
    for (let i = 0; i < (spec.photos ?? 1); i += 1) {
      const photo = randomUUID();
      await tx.query("insert into public.profile_photos (id, user_id, storage_path, position) values ($1, $2, $3, $4)",
        [photo, id, `${id}/${photo}.webp`, position]);
      position += 1;
    }
    for (let i = 0; i < (spec.removedPhotos ?? 0); i += 1) {
      const photo = randomUUID();
      await tx.query("insert into public.profile_photos (id, user_id, storage_path, position, status) values ($1, $2, $3, $4, 'removed')",
        [photo, id, `${id}/${photo}.webp`, i % 6]);
    }
    await tx.query("insert into public.account_verifications (user_id) values ($1)", [id]);
    if (spec.ageVerified ?? true) {
      const sub = await insertSubmission(tx, id, "age", spec.ageRevoked ? "revoked" : "approved", reviewer, null);
      await tx.query(
        `update public.account_verifications set age_verified_at = now(), age_submission_id = $2,
           age_revoked_at = case when $3 then now() end where user_id = $1`,
        [id, sub, spec.ageRevoked ?? false]);
      await tx.query("update private.user_private set birth_date_locked_at = now() where user_id = $1", [id]);
    }
    const state = spec.affiliation ?? "confirmed";
    if (state !== "none" && spec.cls) {
      await insertAffiliation(tx, id, spec.cls, state, reviewer);
    }
    for (const school of spec.hidden?.schools ?? []) {
      await tx.query("insert into public.hidden_affiliations (user_id, school_id) values ($1, $2)", [id, school]);
    }
    for (const department of spec.hidden?.departments ?? []) {
      await tx.query("insert into public.hidden_affiliations (user_id, department_id) values ($1, $2)", [id, department]);
    }
    for (const cls of spec.hidden?.classes ?? []) {
      await tx.query("insert into public.hidden_affiliations (user_id, class_id) values ($1, $2)", [id, cls]);
    }
  });
  return id;
}

async function insertSubmission(tx: Transaction, userId: string, kind: "age" | "enrollment", status: string,
  reviewer: string, cls: ClassRef | null): Promise<string> {
  const id = randomUUID();
  const decided = status === "submitted" ? null : new Date().toISOString();
  await tx.query(
    `insert into public.verification_submissions
       (id, user_id, kind, status, intake_mode, document_refs, affiliation_snapshot, reviewer_id, decided_at, valid_until)
     values ($1, $2, $3, $4, 'synthetic', '{synthetic:sample-1}', $5, $6, $7, $8)`,
    [id, userId, kind, status,
      cls ? JSON.stringify({ school_id: cls.schoolId, department_id: cls.departmentId, class_id: cls.id }) : null,
      status === "submitted" ? null : reviewer, decided,
      kind === "enrollment" && status === "approved" ? new Date(Date.now() + 365 * 86400_000).toISOString() : null]);
  return id;
}

async function insertAffiliation(tx: Transaction, userId: string, cls: ClassRef, state: AffiliationState, reviewer: string) {
  let status = state;
  let until: string | null = null;
  let by: string | null = null;
  if (state === "confirmed" || state === "expired") {
    status = "confirmed";
    by = await insertSubmission(tx, userId, "enrollment", "approved", reviewer, cls);
    until = state === "expired"
      ? new Date(Date.now() - 86400_000).toISOString()
      : new Date(Date.now() + 365 * 86400_000).toISOString();
  } else if (state === "pending") {
    await insertSubmission(tx, userId, "enrollment", "submitted", reviewer, cls);
  }
  await tx.query(
    `insert into public.affiliations (user_id, school_id, department_id, class_id, status, confirmed_until, confirmed_by_submission)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, cls.schoolId, cls.departmentId, cls.id, status, until, by]);
}

/**
 * An active connection and conversation as a match makes them (owner SQL): no request, no mode (order 34). On a
 * database before order 34 it is an accepted friends request with its connection, as the request flow made them.
 */
export async function connect(db: PGlite, a: string, b: string) {
  const connection = randomUUID();
  const conversation = randomUUID();
  const current = await hasOrder34(db);
  await db.transaction(async (tx) => {
    let request: string | null = null;
    if (!current) {
      request = randomUUID();
      await tx.query(
        `insert into public.connection_requests (id, requester_id, recipient_id, mode, status, closed_at)
         values ($1, $2, $3, 'friends', 'accepted', now())`, [request, a, b]);
    }
    await tx.query(
      `insert into public.connections (id, user_low, user_high, origin_request_id, mode)
       values ($1, least($2::uuid, $3::uuid), greatest($2::uuid, $3::uuid), $4, $5)`,
      [connection, a, b, request, request ? "friends" : null]);
    await tx.query("insert into public.conversations (id, connection_id) values ($1, $2)", [conversation, connection]);
  });
  return { connection, conversation };
}

/** A like a -> b as owner SQL (no rate event, no visibility check): preparation only. */
export async function like(db: PGlite, a: string, b: string, at?: string): Promise<void> {
  await db.query("insert into public.likes (liker_id, liked_id, created_at) values ($1, $2, coalesce($3::timestamptz, now()))",
    [a, b, at ?? null]);
}

/** A closed connection request from before order 34 (history only; the table refuses pending rows). */
export async function legacyRequest(db: PGlite, requester: string, recipient: string,
  options: { status?: "declined" | "cancelled" | "invalidated" | "accepted"; message?: string | null } = {}): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into public.connection_requests (id, requester_id, recipient_id, mode, message, status, closed_at)
     values ($1, $2, $3, 'friends', $4, $5, now())`,
    [id, requester, recipient, options.message ?? null, options.status ?? "declined"]);
  return id;
}

/**
 * A staff account (no student profile) holding the given roles; written under the exclusive staff lock.
 * SEC-013: by default it first gets the verified TOTP factor its roles are granted with (order 29);
 * totp: false leaves a role row without any factor.
 */
export async function createStaff(db: PGlite, roles: StaffRole[], options: { totp?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query("select private.lock_staff_roles(true)");
    await tx.query("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())",
      [id, `fixture-staff-${id}@example.invalid`]);
    if (options.totp ?? true) {
      await tx.query("insert into auth.mfa_factors (id, user_id, factor_type, status) values ($1, $2, 'totp', 'verified')",
        [randomUUID(), id]);
    }
    for (const role of roles) {
      await tx.query("insert into private.staff_roles (user_id, role) values ($1, $2)", [id, role]);
    }
  });
  return id;
}

/** An Auth TOTP factor of the user (SEC-003: admin_grant_role requires a verified one). */
export async function addTotpFactor(db: PGlite, user: string, status: "verified" | "unverified" = "verified"): Promise<string> {
  const id = randomUUID();
  await db.query("insert into auth.mfa_factors (id, user_id, factor_type, status) values ($1, $2, 'totp', $3)", [id, user, status]);
  return id;
}

export const missingId = (): string => randomUUID();
