// Independent TypeScript oracle for the visibility rules (docs/03_ARCHITECTURE.md §5.1, §6.1;
// docs/04_DATABASE.md §13.1). It reads raw rows only and never calls the SQL judgment functions.
import type { PGlite } from "@electric-sql/pglite";

interface Profile { user_id: string; account_status: string; completed: boolean }
interface Affiliation { user_id: string; school_id: string; department_id: string; class_id: string; status: string; confirmed_until: string | null }
interface Settings { user_id: string; hide_same_class: boolean; hide_same_department: boolean; hide_same_school: boolean }
interface Hidden { user_id: string; school_id: string | null; department_id: string | null; class_id: string | null }
interface Photo { id: string; user_id: string; status: string }

export interface Snapshot {
  now: number;
  profiles: Map<string, Profile>;
  birth: Map<string, string>;
  age: Map<string, { verified: boolean; revoked: boolean }>;
  affiliations: Map<string, Affiliation>;
  settings: Map<string, Settings>;
  hidden: Hidden[];
  photos: Photo[];
  /** "liker>liked"; absent means no likes */
  likes?: Set<string>;
  /** ignored since order 34 (one mode) and empty from snapshot(); tests/e2e-hosted/14-visibility still fills it until
   * HOSTED-E2E-LIKES */
  modes: Map<string, Set<string>>;
  blocks: Set<string>;
  connections: { id: string; low: string; high: string; ended: boolean }[];
  conversations: Map<string, string>;
}

export async function snapshot(db: PGlite): Promise<Snapshot> {
  const q = async <T>(sql: string) => (await db.query<T>(sql)).rows;
  const [{ now }] = await q<{ now: string }>("select (extract(epoch from now()) * 1000)::text as now");
  const snap: Snapshot = {
    now: Number(now),
    profiles: new Map(), birth: new Map(), age: new Map(), affiliations: new Map(), settings: new Map(),
    hidden: [], photos: [], likes: new Set(), modes: new Map(), blocks: new Set(), connections: [], conversations: new Map(),
  };
  for (const p of await q<Profile>("select user_id, account_status::text, profile_completed_at is not null as completed from public.profiles")) {
    snap.profiles.set(p.user_id, p);
  }
  for (const u of await q<{ user_id: string; birth: string }>("select user_id, birth_date::text as birth from private.user_private")) {
    snap.birth.set(u.user_id, u.birth);
  }
  for (const v of await q<{ user_id: string; verified: boolean; revoked: boolean }>(
    "select user_id, age_verified_at is not null as verified, age_revoked_at is not null as revoked from public.account_verifications")) {
    snap.age.set(v.user_id, v);
  }
  for (const a of await q<Affiliation>(
    `select user_id, school_id, department_id, class_id, status::text,
            (extract(epoch from confirmed_until) * 1000)::text as confirmed_until from public.affiliations`)) {
    snap.affiliations.set(a.user_id, a);
  }
  for (const s of await q<Settings>("select user_id, hide_same_class, hide_same_department, hide_same_school from public.privacy_settings")) {
    snap.settings.set(s.user_id, s);
  }
  snap.hidden = await q<Hidden>("select user_id, school_id, department_id, class_id from public.hidden_affiliations");
  snap.photos = await q<Photo>("select id, user_id, status from public.profile_photos");
  for (const l of await q<{ liker_id: string; liked_id: string }>("select liker_id, liked_id from public.likes")) {
    snap.likes!.add(`${l.liker_id}>${l.liked_id}`);
  }
  for (const b of await q<{ blocker_id: string; blocked_id: string }>("select blocker_id, blocked_id from public.blocks")) {
    snap.blocks.add(`${b.blocker_id}>${b.blocked_id}`);
  }
  snap.connections = (await q<{ id: string; low: string; high: string; ended: boolean }>(
    "select id, user_low as low, user_high as high, ended_at is not null as ended from public.connections"));
  for (const c of await q<{ id: string; connection_id: string }>("select id, connection_id from public.conversations")) {
    snap.conversations.set(c.id, c.connection_id);
  }
  return snap;
}

// --- dates (Asia/Tokyo is UTC+9 without daylight saving) ---
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

export function jstToday(nowMs: number): string {
  const d = new Date(nowMs + 9 * 3600_000);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** n-th birthday; a Feb 29 birth reaches it on Mar 1 in a common year */
export function anniversary(birth: string, years: number): string {
  const [y, m, d] = birth.split("-").map(Number);
  const year = y + years;
  if (m === 2 && d === 29 && !isLeap(year)) return `${pad(year, 4)}-03-01`;
  return `${pad(year, 4)}-${pad(m)}-${pad(d)}`;
}

export const adultFrom = (birth: string) => anniversary(birth, 18);

export function ageYears(birth: string, today: string): number {
  const years = Number(today.slice(0, 4)) - Number(birth.slice(0, 4));
  return anniversary(birth, years) > today ? years - 1 : years;
}

// --- rules ---
export class Oracle {
  constructor(private readonly s: Snapshot) {}

  eligible(u: string): boolean {
    const p = this.s.profiles.get(u);
    const birth = this.s.birth.get(u);
    const age = this.s.age.get(u);
    const a = this.s.affiliations.get(u);
    if (!p || !birth || !age || !a) return false;
    return p.account_status === "active"
      && p.completed
      && age.verified && !age.revoked
      && adultFrom(birth) <= jstToday(this.s.now)
      && a.status === "confirmed" && a.confirmed_until !== null && Number(a.confirmed_until) > this.s.now
      && this.s.photos.some((ph) => ph.user_id === u && ph.status === "active");
  }

  /** owner's settings exclude other; without both affiliations the pair is excluded */
  hides(owner: string, other: string): boolean {
    const ao = this.s.affiliations.get(owner);
    const ax = this.s.affiliations.get(other);
    if (!ao || !ax) return true;
    const st = this.s.settings.get(owner);
    const hideClass = st ? st.hide_same_class : true;
    const hideDepartment = st ? st.hide_same_department : false;
    const hideSchool = st ? st.hide_same_school : false;
    if (hideClass && ao.class_id === ax.class_id) return true;
    if (hideDepartment && ao.department_id === ax.department_id) return true;
    if (hideSchool && ao.school_id === ax.school_id) return true;
    return this.s.hidden.some((h) => h.user_id === owner
      && (h.school_id === ax.school_id || h.department_id === ax.department_id || h.class_id === ax.class_id));
  }

  blocked(a: string, b: string): boolean {
    return this.s.blocks.has(`${a}>${b}`) || this.s.blocks.has(`${b}>${a}`);
  }

  pairVisible(a: string, b: string): boolean {
    return a !== b && this.eligible(a) && this.eligible(b) && !this.blocked(a, b)
      && !this.hides(a, b) && !this.hides(b, a);
  }

  /** order 34: one mode, so a profile is viewable exactly when the pair is visible (a former mode argument is ignored) */
  canViewProfile(viewer: string, target: string, _formerMode?: string): boolean {
    return this.pairVisible(viewer, target);
  }

  liked(liker: string, liked: string): boolean {
    return this.s.likes?.has(`${liker}>${liked}`) ?? false;
  }

  activeConnection(a: string, b: string): boolean {
    const [low, high] = a < b ? [a, b] : [b, a];
    return this.s.connections.some((k) => !k.ended && k.low === low && k.high === high);
  }

  canSeeIdentity(viewer: string, target: string): boolean {
    return this.pairVisible(viewer, target);
  }

  canViewPhoto(viewer: string, owner: string): boolean {
    return viewer === owner || this.canSeeIdentity(viewer, owner);
  }

  photoDeliveryAllowed(viewer: string, photoId: string): boolean {
    const photo = this.s.photos.find((ph) => ph.id === photoId);
    return !!photo && photo.status === "active" && this.canViewPhoto(viewer, photo.user_id);
  }

  canAccessConversation(u: string, conversation: string): boolean {
    const connectionId = this.s.conversations.get(conversation);
    const k = this.s.connections.find((c) => c.id === connectionId);
    return !!k && !k.ended && (k.low === u || k.high === u) && this.pairVisible(k.low, k.high);
  }

  ageOf(u: string): number {
    return ageYears(this.s.birth.get(u)!, jstToday(this.s.now));
  }
}
