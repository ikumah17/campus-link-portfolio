import { request } from "node:https";
import { credentials, environment, readState, saveState, type User } from "./state";
import { totp } from "./totp";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const codes = new Set(["ok", "invalid_state", "not_available", "already_pending", "already_connected", "rate_limited", "mfa_required"]);
export function safeCode(value: unknown): string | null {
  return typeof value === "string" ? codes.has(value) || /^[A-Z0-9]{5}$/.test(value) ? value : "unclassified_provider_error" : null;
}
type Wire = { status: number; body: unknown; startedAt: number; sentAt: number; finishedAt: number; port: number };
export type Result = Omit<Wire, "body"> & { ok: boolean; code: string | null; ref: string | null; data: unknown };
export function summary(value: Result) {
  return { status: value.status, ok: value.ok, code: value.code, startedAt: value.startedAt,
    sentAt: value.sentAt, finishedAt: value.finishedAt };
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// Every request owns a new TCP/TLS connection (agent:false), including both
// participants in a race. No shared SDK queue, HTTP/2 stream or browser page.
// Provider errors, Auth responses and request headers never escape as errors.
async function wire(path: string, method: string, body?: unknown, jwt?: string): Promise<Wire> {
  const env = environment();
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!key) throw new Error("Missing hosted public credential");
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let sentAt = 0;
    let port = 0;
    const req = request(new URL(path, env.NEXT_PUBLIC_SUPABASE_URL), {
      method, agent: false, headers: { apikey: key, ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}), "Content-Type": "application/json" },
    }, res => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { data += chunk; if (data.length > 4_000_000) req.destroy(); });
      res.on("error", () => reject(new Error("Hosted concurrency response failed (details suppressed)")));
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data || "null"), startedAt, sentAt, finishedAt: Date.now(), port }); }
        catch { reject(new Error("Hosted concurrency response was not JSON (details suppressed)")); }
      });
    });
    req.on("finish", () => { sentAt = Date.now(); });
    req.on("socket", socket => socket.on("connect", () => { port = socket.localPort ?? 0; }));
    req.on("error", () => reject(new Error("Hosted concurrency transport failed (details suppressed)")));
    req.setTimeout(30_000, () => req.destroy());
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
function result(value: Wire): Result {
  const row = object(value.body);
  const httpOK = value.status >= 200 && value.status < 300;
  return { status: value.status, startedAt: value.startedAt, sentAt: value.sentAt, finishedAt: value.finishedAt, port: value.port,
    ok: httpOK && row.ok !== false, code: safeCode(row.code ?? row.error_code),
    ref: typeof row.ref === "string" && uuid.test(row.ref) ? row.ref : null, data: httpOK ? value.body : null };
}
function runUser(index: number) {
  const state = readState();
  const user = state.users[index];
  if (!/^[a-f0-9]{12}$/.test(state.runId) || !user || !uuid.test(user.id) || user.email !== `e2e-${state.runId}-${index}@example.invalid`) {
    throw new Error("Concurrency action ownership mismatch");
  }
  return user;
}

const rpcNames = new Set(["start_onboarding", "set_affiliation", "submit_verification", "my_account",
  "admin_list_staff", "admin_grant_role_by_email", "admin_revoke_role", "admin_list_submissions", "admin_get_submission",
  "admin_claim_submission", "admin_decide_submission", "admin_revoke_verification",
  // HOSTED-E2E-LIKES: the likes group's simultaneous like and its read-backs.
  "like_user", "get_like_state", "list_my_likes"]);
const targetRpcs = new Set(["like_user", "get_like_state"]);
// HOSTED-E2E-004: a verification revoke may only target a submission a run
// session itself created in this process.
const ownedSubmissions = new Set<string>();

export class Session {
  #jwt: string;
  readonly id: string;
  private constructor(jwt: string, id: string) { this.#jwt = jwt; this.id = id; }

  static async signIn(index: number | "admin", aal2 = false) {
    const local = index === "admin" ? credentials() : null;
    const user: User = local ? local.admin : runUser(index as number);
    const login = await wire("/auth/v1/token?grant_type=password", "POST", { email: user.email, password: user.password });
    const data = object(login.body);
    const identity = object(data.user);
    if (login.status !== 200 || identity.email !== user.email || typeof identity.id !== "string" || !uuid.test(identity.id) ||
      (index !== "admin" && identity.id !== user.id) || typeof data.access_token !== "string") {
      throw new Error("Hosted concurrency sign-in failed (details suppressed)");
    }
    const session = new Session(data.access_token, identity.id);
    if (aal2) {
      let secret = local?.adminTotpSecret;
      let factor: string;
      if (local) {
        if (!secret) throw new Error("Concurrency requires the existing administrator TOTP enrollment");
        const factors = await wire("/auth/v1/user", "GET", undefined, session.#jwt);
        const list = object(factors.body).factors;
        const rows = Array.isArray(list) ? list : [];
        const verified = rows.map(object).filter(row => row.factor_type === "totp" && row.status === "verified");
        if (factors.status !== 200 || verified.length !== 1 || typeof verified[0].id !== "string") throw new Error("Administrator TOTP factor unavailable");
        factor = verified[0].id;
        // The default hosted flows may just have consumed the current code.
        await new Promise(resolve => setTimeout(resolve, 30_000 - Date.now() % 30_000 + 500));
      } else {
        const enrolled = await wire("/auth/v1/factors", "POST", { factor_type: "totp", friendly_name: "NT-19 fictional run" }, session.#jwt);
        const enrollment = object(enrolled.body);
        secret = object(enrollment.totp).secret as string;
        if (enrolled.status !== 200 || typeof enrollment.id !== "string" || typeof secret !== "string" || !/^[A-Z2-7]+$/.test(secret)) {
          throw new Error("Run-user TOTP enrollment failed (details suppressed)");
        }
        factor = enrollment.id;
      }
      if (!uuid.test(factor)) throw new Error("Invalid TOTP factor identity");
      const challenge = await wire(`/auth/v1/factors/${factor}/challenge`, "POST", {}, session.#jwt);
      const challengeId = object(challenge.body).id;
      if (challenge.status !== 200 || typeof challengeId !== "string" || !uuid.test(challengeId)) throw new Error("TOTP challenge failed (details suppressed)");
      const verified = await wire(`/auth/v1/factors/${factor}/verify`, "POST", { challenge_id: challengeId, code: totp(secret) }, session.#jwt);
      const token = object(verified.body).access_token;
      if (verified.status !== 200 || typeof token !== "string") throw new Error("TOTP verification failed (details suppressed)");
      try {
        const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
        if (claims.aal !== "aal2" || claims.sub !== session.id) throw new Error();
      } catch { throw new Error("TOTP session identity or assurance mismatch"); }
      session.#jwt = token;
    }
    return session;
  }

  async rpc(name: string, body: Record<string, unknown> = {}): Promise<Result> {
    if (!rpcNames.has(name)) throw new Error("RPC outside concurrency allowlist");
    // Every role target must be an exact ledger user or the configured admin.
    if (name === "admin_grant_role_by_email" || name === "admin_revoke_role") {
      const state = readState();
      const admin = credentials().admin;
      const users = state.users.map((_, index) => runUser(index));
      const target = name === "admin_grant_role_by_email" ? body.p_email : body.p_user;
      // admin.id is optional in the legacy local credentials. The authenticated
      // identity is registered before role mutations, without any session token.
      const allowed = name === "admin_grant_role_by_email" ? [admin.email, ...users.map(user => user.email)]
        : [state.concurrency?.adminId, ...users.map(user => user.id)];
      if (!allowed.includes(target as string) || !["reviewer", "admin"].includes(body.p_role as string)) throw new Error("Role target ownership mismatch");
    }
    if (name === "admin_revoke_verification" && !ownedSubmissions.has(body.p_submission as string)) throw new Error("Submission ownership mismatch");
    // A like may only name another user of this run.
    if (targetRpcs.has(name) && !readState().users.some((_, index) => runUser(index).id === body.p_target)) throw new Error("Like target ownership mismatch");
    const value = result(await wire(`/rest/v1/rpc/${name}`, "POST", body, this.#jwt));
    if (name === "submit_verification" && value.ok && value.ref) ownedSubmissions.add(value.ref);
    return value;
  }

}

export function registerConcurrency(admin: Session, indices: number[]) {
  for (const index of indices) runUser(index);
  const state = readState();
  // Later NT-19 files add their users to the same ledger; teardown cleans all of them.
  const previous = state.concurrency;
  if (previous && previous.adminId !== admin.id) throw new Error("Concurrency admin ledger mismatch");
  saveState({ ...state, concurrency: { adminId: admin.id, roleUsers: [...new Set([...(previous?.roleUsers ?? []), ...indices])] } });
}

export type Staff = { user_id: string; roles: string[]; is_me: boolean };
export async function staff(session: Session): Promise<Staff[]> {
  const value = await session.rpc("admin_list_staff");
  if (!value.ok || !Array.isArray(value.data) || !value.data.every(row => uuid.test(row.user_id) && Array.isArray(row.roles))) {
    throw new Error("Staff read-back refused or malformed");
  }
  return value.data.map(row => ({ user_id: row.user_id, roles: row.roles, is_me: row.is_me }));
}
// SEC-003 order-20 marker. Grants reviewer to a ledger run user that has no TOTP factor: hosted with order 20
// refuses it (mfa_required, no role); a success means order 20 is not applied yet (until HOSTED-008), and the
// role is revoked again before returning. The user must be in the concurrency ledger first, so a failed revoke
// is still cleaned up by cleanupConcurrencyRoles.
export async function grantWithoutTotp(admin: Session, index: number): Promise<"refused" | "order_20_missing"> {
  const user = runUser(index);
  if (!readState().concurrency?.roleUsers.includes(index)) throw new Error("Register the run user before the order-20 marker grant");
  const value = await admin.rpc("admin_grant_role_by_email", { p_email: user.email, p_role: "reviewer" });
  const holds = async () => (await staff(admin)).some(row => row.user_id === user.id);
  if (value.status === 200 && !value.ok && value.code === "mfa_required") {
    if (await holds()) throw new Error("A refused grant left a role");
    return "refused";
  }
  if (value.status === 200 && value.ok && value.code === "ok") {
    const revoked = await admin.rpc("admin_revoke_role", { p_user: user.id, p_role: "reviewer" });
    if (!revoked.ok || await holds()) throw new Error("Order-20 marker role cleanup failed; ledger retained");
    return "order_20_missing";
  }
  throw new Error("Unexpected answer to a grant without TOTP");
}
export const ORDER_20_MISSING = "Order 20 (grant_requires_totp) is not applied to hosted yet: a grant to a run user without TOTP succeeded and was revoked again. The refusal step skips until HOSTED-008.";

export function isAdmin(rows: Staff[], id: string) { return rows.some(row => row.user_id === id && row.roles.includes("admin")); }
export function adminCount(rows: Staff[]) { return rows.filter(row => row.roles.includes("admin")).length; }

// Called before ANY storage/Auth deletion, including recovery of a prior run.
// Never bootstrap with a server key or delete the only surviving run admin.
export async function cleanupConcurrencyRoles() {
  const state = readState();
  if (!state.concurrency) return;
  let admin: Session;
  try {
    admin = await Session.signIn("admin", true);
    if (admin.id !== state.concurrency.adminId || !isAdmin(await staff(admin), admin.id)) throw new Error();
  } catch { throw new Error("e2e-admin admin not restored; run users retained for coordinator recovery"); }
  for (const index of state.concurrency.roleUsers) {
    const user = runUser(index);
    const roles = (await staff(admin)).find(row => row.user_id === user.id)?.roles ?? [];
    if (roles.some(role => role === "reviewer" || role === "admin")) {
      // Authenticate the exact ledger email/password/UUID before modifying its
      // roles, just as lifecycle verifies Auth identity before deleting a user.
      if ((await Session.signIn(index)).id !== user.id) throw new Error("Role cleanup ownership mismatch");
    }
    for (const role of ["reviewer", "admin"]) if (roles.includes(role)) {
      const revoked = await admin.rpc("admin_revoke_role", { p_user: user.id, p_role: role });
      if (!revoked.ok) throw new Error("Concurrency role cleanup failed; ledger retained");
    }
    if ((await staff(admin)).some(row => row.user_id === user.id && row.roles.some(role => role === "reviewer" || role === "admin"))) {
      throw new Error("Concurrency role cleanup verification failed");
    }
  }
  if (!isAdmin(await staff(admin), admin.id)) throw new Error("e2e-admin admin not restored; run users retained for coordinator recovery");
}

export async function race(left: () => Promise<Result>, right: () => Promise<Result>, reverse = false) {
  // Both promises are constructed before awaiting either. Alternate submission
  // order, without delaying either call until its competitor has completed.
  // Settle BOTH before recovery/teardown even if one request loses its response.
  const settled = await Promise.allSettled(reverse ? [right(), left()] : [left(), right()]);
  if (settled.some(value => value.status === "rejected")) throw new Error("Concurrency request failed; both requests settled (details suppressed)");
  const results = settled.map(value => (value as PromiseFulfilledResult<Result>).value);
  if (reverse) results.reverse();
  const [a, b] = results;
  return { left: a, right: b, concurrent: a.port > 0 && b.port > 0 && a.port !== b.port &&
    Math.max(a.sentAt, b.sentAt) < Math.min(a.finishedAt, b.finishedAt),
    overlapMs: Math.min(a.finishedAt, b.finishedAt) - Math.max(a.sentAt, b.sentAt) };
}
