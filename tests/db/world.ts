// Generated fictional worlds for the oracle comparison (docs/04_DATABASE.md §13.1): seeded, reproducible.
import type { PGlite } from "@electric-sql/pglite";
import { createMasters, createUser, type Masters, type Purpose, type UserSpec } from "./fixtures";

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One missing condition each (docs/04 NT-05). */
export const DEFECTS: Record<string, (today: Date) => Partial<UserSpec>> = {
  suspended: () => ({ status: "suspended" }),
  deactivated: () => ({ status: "deactivated" }),
  deleted: () => ({ status: "deleted" }),
  incomplete: () => ({ completed: false }),
  no_photo: () => ({ photos: 0, removedPhotos: 1 }),
  age_unverified: () => ({ ageVerified: false }),
  age_revoked: () => ({ ageRevoked: true }),
  under_18: (today) => ({ birthDate: `${today.getUTCFullYear() - 17}-01-01` }),
  affiliation_unconfirmed: () => ({ affiliation: "unconfirmed" }),
  affiliation_pending: () => ({ affiliation: "pending" }),
  affiliation_rejected: () => ({ affiliation: "rejected" }),
  affiliation_expired: () => ({ affiliation: "expired" }),
  affiliation_missing: () => ({ affiliation: "none" }),
};

export interface World {
  masters: Masters;
  users: string[];
}

export async function generateWorld(db: PGlite, seed: number, size: number): Promise<World> {
  const random = rng(seed);
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
  const masters = await createMasters(db, `w${seed}`);
  const defects = Object.keys(DEFECTS);
  const users: string[] = [];
  for (let i = 0; i < size; i += 1) {
    const cls = pick(masters.classes);
    const hidden: UserSpec["hidden"] = { schools: [], departments: [], classes: [] };
    const hiddenCount = random() < 0.5 ? 0 : 1 + Math.floor(random() * 2);
    for (let h = 0; h < hiddenCount; h += 1) {
      const kind = pick(["schools", "departments", "classes"] as const);
      const id = kind === "schools" ? pick(masters.schools)
        : kind === "departments" ? pick(masters.departments).id : pick(masters.classes).id;
      if (!hidden[kind]!.includes(id)) hidden[kind]!.push(id);
    }
    const spec: UserSpec = {
      cls,
      gender: pick(["female", "male", "other"] as const),
      birthDate: `${1990 + Math.floor(random() * 17)}-${String(1 + Math.floor(random() * 12)).padStart(2, "0")}-${String(1 + Math.floor(random() * 28)).padStart(2, "0")}`,
      purposes: pick<Purpose[]>([[], ["friends"], ["partner", "talk"]]),
      photos: 1 + Math.floor(random() * 3),
      removedPhotos: random() < 0.3 ? 1 : 0,
      settings: random() < 0.1 ? null : {
        hide_same_class: random() < 0.6,
        hide_same_department: random() < 0.25,
        hide_same_school: random() < 0.1,
        show_department: random() < 0.5,
        show_class: random() < 0.5,
      },
      hidden,
      ...(random() < 0.25 ? DEFECTS[pick(defects)](new Date()) : {}),
    };
    users.push(await createUser(db, spec));
  }
  const blocks: string[] = [];
  for (const a of users) {
    for (const b of users) {
      if (a !== b && random() < 0.05) blocks.push(`('${a}', '${b}')`);
    }
  }
  if (blocks.length) await db.exec(`insert into public.blocks (blocker_id, blocked_id) values ${blocks.join(", ")}`);
  return { masters, users };
}
