import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { environment, evidence, localDir, readState, retentionMode, saveState, resetEvidence, type State, type RunRoom } from "./state";
import { cleanupConcurrencyRoles } from "./concurrency";

// Never return/log provider bodies or errors: they may contain credentials.
async function adminRequest(path: string, method = "GET", body?: unknown) {
  const env = environment();
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Missing hosted server credential");
  try {
    return await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}${path}`, {
      method, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
  } catch { throw new Error(`Hosted setup/cleanup transport failed (${method})`); }
}
export async function cleanup() {
  if (!existsSync(resolve(localDir, "run.json"))) return;
  const state = readState();
  if (!/^[a-f0-9]{12}$/.test(state.runId)) throw new Error("Invalid cleanup run identity");
  // A retention --apply that did not report back is the coordinator's to resolve: never clean around it.
  if (state.retention?.phase === "applying") throw new Error("Retention apply unresolved; ledger kept for the coordinator");
  // Refuse ALL deletion if the protected admin has not been restored. A run
  // admin may be the only remaining recovery route after a failed race.
  if (state.concurrency) {
    await cleanupConcurrencyRoles();
    evidence("concurrencyCleanup", { protectedAdminRestored: true, grantedRolesRemoved: true });
  }
  const deleted: string[] = [];
  for (const [index, user] of state.users.entries()) {
    if (!/^[a-f0-9-]{36}$/.test(user.id) || user.email !== `e2e-${state.runId}-${index}@example.invalid`) throw new Error("Cleanup ownership mismatch");
    const check = await adminRequest(`/auth/v1/admin/users/${user.id}`);
    const missing = check.status === 404;
    if (!missing && (!check.ok || (await check.json()).email !== user.email)) throw new Error("Cleanup refused an unowned user");
    // Uploads are flat userId/uuid.webp; refuse directories or unsafe object names.
    const list = async (): Promise<{ name: string; id: string | null }[]> => {
      const res = await adminRequest("/storage/v1/object/list/profile-photos", "POST", { prefix: `${user.id}/`, limit: 1000 });
      if (!res.ok) throw new Error(`Storage cleanup listing failed (${res.status})`);
      return res.json();
    };
    const objects = await list();
    if (objects.some(object => !object.id || !/^[a-f0-9-]+\.webp$/.test(object.name))) throw new Error("Unexpected run storage object; cleanup refused");
    if (objects.length) {
      const removed = await adminRequest("/storage/v1/object/profile-photos", "DELETE", { prefixes: objects.map(object => `${user.id}/${object.name}`) });
      if (!removed.ok) throw new Error(`Storage cleanup failed (${removed.status})`);
    }
    if ((await list()).length) throw new Error("Storage cleanup verification failed");
    if (!missing) {
      const removed = await adminRequest(`/auth/v1/admin/users/${user.id}`, "DELETE");
      if (!removed.ok) throw new Error(`User cleanup failed (${removed.status})`);
    }
    if ((await adminRequest(`/auth/v1/admin/users/${user.id}`)).status !== 404) throw new Error("User cleanup verification failed");
    deleted.push(user.id);
  }
  evidence("cleanup", { runId: state.runId, usersDeleted: deleted.length, storageEmpty: true, verified: true });
  unlinkSync(resolve(localDir, "run.json"));
}
export async function setup() {
  // Retention verify continues the prepared ledger: no cleanup, no new users.
  if (retentionMode() === "verify") {
    const state = existsSync(resolve(localDir, "run.json")) ? readState() : null;
    if (state?.retention?.phase !== "prepared" || state.users.length !== 2) throw new Error("Retention verify needs the prepared run ledger");
    ownedUser(state, 0); ownedUser(state, 1);
    return;
  }
  // Recover only the exact previous run ledger, never search/delete other users.
  await cleanup();
  const state: State = { runId: randomUUID().replace(/-/g, "").slice(0, 12), users: [] };
  saveState(state);
  resetEvidence(state.runId);
  try {
    await createRunUsers(2);
  } catch (error) { await cleanup(); throw error; }
}

// Retention prepare keeps U and K for the coordinator's backdate; verify cleans up only after a full pass.
export async function teardown() {
  const mode = retentionMode();
  if (mode && existsSync(resolve(localDir, "run.json"))) {
    const phase = readState().retention?.phase;
    if (mode === "prepare" ? phase === "prepared" : phase !== "verified") {
      evidence("retentionLedger", { kept: true, phase: phase ?? null });
      return;
    }
  }
  await cleanup();
}

export function ownedUser(state: State, index: number) {
  const user = state.users[index];
  if (!/^[a-f0-9]{12}$/.test(state.runId) || !user || !/^[a-f0-9-]{36}$/.test(user.id) ||
    user.email !== `e2e-${state.runId}-${index}@example.invalid`) throw new Error("Hosted action ownership mismatch");
  return user;
}

// FIX-005: a run password meets the sign-up rule that hosted Auth also enforces (lowercase, uppercase, digit and
// symbol): 32 random base64url characters, then one of each class.
export function runPassword() {
  return `${randomBytes(24).toString("base64url")}aZ7!`;
}

// TEST-018: hard bound on run users per invocation. The fullest opt-in runs need 10: setup A and B, 22-likes C and D,
// then three each for groups 11 and 11b (NT-19) or for the two NT-21 revocation cases.
const MAX_RUN_USERS = 10;

export async function createRunUsers(count: number) {
  const state = readState();
  if (!Number.isInteger(count) || count < 1 || state.users.length + count > MAX_RUN_USERS || !/^[a-f0-9]{12}$/.test(state.runId)) throw new Error("Invalid hosted user count or run");
  const end = state.users.length + count;
  for (let i = state.users.length; i < end; i++) {
      const email = `e2e-${state.runId}-${i}@example.invalid`;
      const password = runPassword();
      const id = randomUUID();
      // AdminUserAttributes accepts a caller-provided ID. Persist it before the
      // request so even a lost success response can be cleaned up by exact ID.
      state.users.push({ id, email, password, name: `E2E${String.fromCharCode(65 + i)}${state.runId.slice(0, 6)}` });
      saveState(state);
      const response = await adminRequest("/auth/v1/admin/users", "POST", { id, email, password, email_confirm: true });
      if (!response.ok) throw new Error(`Fictional user setup failed (${response.status})`);
      const data = await response.json();
      if (data.id !== id || data.email !== email) throw new Error("Fictional user setup identity mismatch");
  }
}

// Finite error codes only. Provider bodies (including successful Auth responses)
// can contain credentials or private data and never leave this Node boundary.
async function result(response: Response) {
  let code: string | null = null;
  if (!response.ok) {
    try {
      const data = await response.json();
      const candidate = data.code ?? data.error_code;
      code = typeof candidate === "string" && /^(?:[0-9A-Z]{5}|not_admin|user_not_found|validation_failed|unexpected_failure|over_request_rate_limit)$/.test(candidate)
        ? candidate : "unclassified_provider_error";
    } catch { code = "unclassified_provider_error"; }
  }
  return { status: response.status, ok: response.ok, code };
}

// Read-only server-key check of one ledger user: Auth status, exact identity and flat photo object names.
export async function readBackRunUser(index: number) {
  const user = ownedUser(readState(), index);
  const auth = await adminRequest(`/auth/v1/admin/users/${user.id}`);
  const identity = auth.ok ? await auth.json() : null;
  const listing = await adminRequest("/storage/v1/object/list/profile-photos", "POST", { prefix: `${user.id}/`, limit: 1000 });
  if (!listing.ok) throw new Error(`Storage read-back failed (${listing.status})`);
  const objects: { name: string; id: string | null }[] = await listing.json();
  if (objects.some(object => !object.id || !/^[a-f0-9-]+\.webp$/.test(object.name))) throw new Error("Unexpected run storage object");
  return { authStatus: auth.status, identity: identity?.id === user.id && identity?.email === user.email,
    photos: objects.map(object => object.name).sort() };
}

export async function insertRunMessage(room: RunRoom, sender: number) {
  const state = readState();
  const registered = state.revocationRooms?.some(value => value.path === room.path &&
    value.participants[0] === room.participants[0] && value.participants[1] === room.participants[1]);
  if (!registered || !/^\/talk\/[a-f0-9-]{36}$/.test(room.path) || !room.participants.includes(sender) ||
    room.participants[0] === room.participants[1]) throw new Error("Hosted message ownership mismatch");
  for (const index of room.participants) ownedUser(state, index);
  const response = await adminRequest("/rest/v1/messages", "POST", {
    conversation_id: room.path.split("/").at(-1), sender_id: ownedUser(state, sender).id,
    client_msg_id: randomUUID(), body: `NT-21 fictional probe ${state.runId}`,
  });
  return result(response);
}

// TEST-006: a one-time magic-link token for a ledger user, from the admin API (no email is sent). Only hashed_token
// leaves this function; the action_link and the rest of the body never do. The caller must not log or store it.
export async function confirmTokenHash(index: number) {
  const user = ownedUser(readState(), index);
  const response = await adminRequest("/auth/v1/admin/generate_link", "POST", { type: "magiclink", email: user.email });
  if (!response.ok) throw new Error(`Confirmation link setup failed (${response.status})`);
  let data: Record<string, unknown>;
  try { data = await response.json(); } catch { throw new Error("Confirmation link setup returned no JSON"); }
  const properties = (data.properties ?? data) as Record<string, unknown>;
  const owner = (data.user ?? data) as Record<string, unknown>;
  if (owner.id !== user.id || owner.email !== user.email) throw new Error("Hosted Auth ownership mismatch");
  const hash = properties.hashed_token;
  if (typeof hash !== "string" || !/^[a-f0-9]{20,128}$/.test(hash)) throw new Error("Confirmation link setup returned no usable token");
  return hash;
}

export async function clearRunEmailConfirmation(index: number) {
  const state = readState();
  const user = ownedUser(state, index);
  // Verify the provider's exact identity before changing even a ledger-owned ID.
  const check = await adminRequest(`/auth/v1/admin/users/${user.id}`);
  if (!check.ok) return { ...await result(check), cleared: false };
  const existing = await check.json();
  if (existing.id !== user.id || existing.email !== user.email) throw new Error("Hosted Auth ownership mismatch");
  const update = await adminRequest(`/auth/v1/admin/users/${user.id}`, "PUT", { email_confirm: false });
  const updated = await result(update);
  if (!updated.ok) return { ...updated, cleared: false };
  const verify = await adminRequest(`/auth/v1/admin/users/${user.id}`);
  if (!verify.ok) return { ...await result(verify), cleared: false };
  const data = await verify.json();
  if (data.id !== user.id || data.email !== user.email) throw new Error("Hosted Auth ownership mismatch");
  return { ...updated, cleared: data.email_confirmed_at === null || data.email_confirmed_at === undefined };
}
