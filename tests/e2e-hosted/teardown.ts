import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ownedUser, teardown } from "./lifecycle";
import { environment, evidence, localDir, readState, saveState, type StorageObject } from "./state";

// TEST-014: the storage gate's server-key Storage access (fixtures, cleanup, read-back only). Never return or log
// provider bodies, paths or errors.
export const BUCKETS: StorageObject["bucket"][] = ["profile-photos", "verification-documents"];
export async function storageAdmin(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  const env = environment();
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Missing hosted server credential");
  const bytes = body instanceof Uint8Array;
  try {
    return await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1${path}`, {
      method, signal: AbortSignal.timeout(30_000),
      headers: { apikey: key, Authorization: `Bearer ${key}`, ...(body === undefined || bytes ? {} : { "Content-Type": "application/json" }), ...headers },
      body: body === undefined ? undefined : bytes ? new Uint8Array(body) : JSON.stringify(body),
    });
  } catch { throw new Error(`Hosted storage fixture transport failed (${method})`); }
}
export type Listed = { name: string; id: string | null; metadata?: { eTag?: unknown; size?: unknown } | null };
export async function listFolder(bucket: StorageObject["bucket"], owner: string): Promise<Listed[]> {
  const response = await storageAdmin(`/object/list/${bucket}`, "POST", { prefix: `${owner}/`, limit: 1000 });
  if (!response.ok) throw new Error(`Storage fixture listing failed (${response.status})`);
  return response.json();
}

// Deletes exactly the ledger's recorded names, then requires every run user's folder in both buckets to be empty.
// Runs before the lifecycle cleanup (setup and teardown), so an interrupted storage run is cleaned by the next one.
export async function cleanupStorageFixtures() {
  if (!existsSync(resolve(localDir, "run.json"))) return;
  const state = readState();
  if (!state.storage) return;
  const owners = state.users.map((_, index) => ownedUser(state, index).id);
  if (!state.storage.objects.every(object => BUCKETS.includes(object.bucket) && /^[a-f0-9-]{36}\/[a-f0-9-]{36}\.webp$/.test(object.name) &&
    owners.includes(object.name.split("/")[0]))) throw new Error("Storage fixture ownership mismatch; ledger kept");
  for (const bucket of BUCKETS) {
    const names = state.storage.objects.filter(object => object.bucket === bucket).map(object => object.name);
    if (!names.length) continue;
    const removed = await storageAdmin(`/object/${bucket}`, "DELETE", { prefixes: names });
    if (!removed.ok) throw new Error(`Storage fixture cleanup failed (${removed.status}); ledger kept`);
  }
  let remaining = 0;
  for (const bucket of BUCKETS) for (const owner of owners) remaining += (await listFolder(bucket, owner)).length;
  if (remaining) throw new Error(`Storage fixture cleanup verification failed (${remaining} left); ledger kept`);
  const recorded = state.storage.objects.length;
  delete state.storage;
  saveState(state);
  evidence("storageCleanup", { recordedNames: recorded, foldersEmpty: true, buckets: BUCKETS.length, users: owners.length });
}

export default async function globalTeardown() {
  await cleanupStorageFixtures();
  await teardown();
}
